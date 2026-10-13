// Socket.IO wiring: turns client events into Room operations and pushes a
// tailored view of the room to the host and to every player.
import { ROOM_CODE_PATTERN, normalizeRoomCode, validateQuiz } from '../public/js/rules.js';
import { summarize } from './game.js';

const BROADCAST_COALESCE_MS = 120;
const RATE_WINDOW_MS = 2000;
const RATE_MAX_EVENTS = 40;

function reply(ack, payload) {
  if (typeof ack === 'function') ack(payload);
}

function playerChannel(code) {
  return `players:${code}`;
}

export function questionView(room, now) {
  const q = room.question;
  if (!q || room.phase === 'lobby' || room.phase === 'final') return null;
  const view = {
    index: room.qIndex,
    text: q.text,
    choices: q.choices,
    timeLimit: q.timeLimit,
    remainingMs: room.remainingMs(now),
  };
  // The correct answer only leaves the server once the host reveals it.
  if (room.phase === 'reveal' || room.phase === 'standings') view.correct = q.correct;
  return view;
}

function baseView(room, now, summary) {
  const status = room.joinStatus();
  const showAnswers = room.phase === 'question' || room.phase === 'locked';
  const showDistribution = room.phase === 'reveal' || room.phase === 'standings';
  return {
    code: room.code,
    title: room.quiz.title,
    phase: room.phase,
    locked: room.locked,
    accepting: status.accepting,
    notAcceptingReason: status.reason,
    questionCount: room.questionCount,
    qIndex: room.qIndex,
    isLast: room.isLastQuestion,
    playerCount: room.players.size,
    connectedCount: room.connectedPlayers().length,
    answeredCount: showAnswers || showDistribution ? room.answers.size : 0,
    lockReason: room.phase === 'locked' ? room.lockReason : null,
    hostConnected: room.hostConnected,
    question: questionView(room, now),
    distribution: showDistribution ? room.distribution : null,
    summary,
  };
}

function hostView(room, base, ranked) {
  const roster = [...room.players.values()]
    .sort((a, b) => a.joinSeq - b.joinSeq)
    .map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      answered: room.answers.has(p.id),
    }));
  const view = { ...base, role: 'host', joinUrl: room.joinUrl, roster };
  if (room.phase === 'final') {
    view.results = ranked.map((r) => ({
      id: r.player.id,
      name: r.player.name,
      rank: r.rank,
      tied: r.tied,
      score: r.player.score,
      correctCount: r.player.correctCount,
    }));
  }
  return view;
}

function meView(room, player, rankEntry) {
  const revealed = room.phase === 'reveal' || room.phase === 'standings' || room.phase === 'final';
  const answer = room.answers.get(player.id);
  const me = {
    id: player.id,
    name: player.name,
    score: player.score,
    correctCount: player.correctCount,
    answered: Boolean(answer),
    choice: answer ? answer.choice : null,
    rank: null,
    tied: false,
    prevRank: null,
    lastRound: null,
  };
  if (revealed && room.qIndex >= 0 && rankEntry) {
    me.rank = rankEntry.rank;
    me.tied = rankEntry.tied;
    me.prevRank = player.prevRank;
    if (player.lastRound && player.lastRound.qIndex === room.qIndex) me.lastRound = player.lastRound;
  }
  return me;
}

export function attachRealtime(io, manager, { baseUrlForSocket, now = () => Date.now(), sweepIntervalMs = 60_000 } = {}) {
  const timers = new Map();
  const pending = new Map();

  function clearTimer(code) {
    const t = timers.get(code);
    if (t) clearTimeout(t);
    timers.delete(code);
  }

  function flush(room) {
    if (manager.get(room.code) !== room) return;
    const t = now();
    const ranked = room.ranked();
    const rankById = new Map(ranked.map((r) => [r.player.id, r]));
    const summary = room.phase === 'standings' || room.phase === 'final'
      ? summarize(ranked, { includeRound: room.phase === 'standings' })
      : null;
    const base = baseView(room, t, summary);
    if (room.hostSocketId) io.to(room.hostSocketId).emit('host:state', hostView(room, base, ranked));
    for (const player of room.players.values()) {
      if (!player.socketId) continue;
      io.to(player.socketId).emit('player:state', {
        ...base,
        role: 'player',
        me: meView(room, player, rankById.get(player.id)),
      });
    }
  }

  // Phase changes go out immediately; joins and answer counts are coalesced so
  // a burst of 20+ players doesn't cause a burst of full-room broadcasts.
  function broadcast(room, { immediate = true } = {}) {
    const existing = pending.get(room.code);
    if (immediate) {
      if (existing) clearTimeout(existing);
      pending.delete(room.code);
      flush(room);
      return;
    }
    if (existing) return;
    pending.set(room.code, setTimeout(() => {
      pending.delete(room.code);
      flush(room);
    }, BROADCAST_COALESCE_MS));
  }

  function lockNow(room, reason) {
    clearTimer(room.code);
    if (room.lockQuestion(now(), reason).ok) broadcast(room);
  }

  function scheduleLock(room) {
    clearTimer(room.code);
    const qIndex = room.qIndex;
    const delay = Math.max(0, room.deadline - now()) + 25;
    timers.set(room.code, setTimeout(() => {
      timers.delete(room.code);
      if (manager.get(room.code) === room && room.phase === 'question' && room.qIndex === qIndex) {
        lockNow(room, 'timer');
      }
    }, delay));
  }

  function closeRoom(room, reason) {
    clearTimer(room.code);
    const p = pending.get(room.code);
    if (p) clearTimeout(p);
    pending.delete(room.code);
    manager.delete(room.code);
    io.to(playerChannel(room.code)).emit('room:closed', { reason });
    io.in(playerChannel(room.code)).socketsLeave(playerChannel(room.code));
    for (const player of room.players.values()) {
      if (!player.socketId) continue;
      const s = io.sockets.sockets.get(player.socketId);
      if (s) s.data = {};
    }
    if (room.hostSocketId) {
      const hs = io.sockets.sockets.get(room.hostSocketId);
      if (hs) {
        hs.emit('room:closed', { reason });
        hs.data = {};
      }
    }
  }

  function detach(socket) {
    const { role, code, playerId } = socket.data ?? {};
    const room = code ? manager.get(code) : null;
    socket.data = {};
    if (!room) return;
    if (role === 'host' && room.hostSocketId === socket.id) {
      room.hostSocketId = null;
      room.hostConnected = false;
      room.hostLeftAt = now();
      broadcast(room, { immediate: false });
    } else if (role === 'player') {
      socket.leave(playerChannel(code));
      const player = room.players.get(playerId);
      if (player && player.socketId === socket.id) {
        player.socketId = null;
        player.connected = false;
        if (room.phase === 'question' && room.allConnectedAnswered()) lockNow(room, 'all_answered');
        else broadcast(room, { immediate: false });
      }
    }
  }

  function bindHost(socket, room) {
    if (room.hostSocketId && room.hostSocketId !== socket.id) {
      const old = io.sockets.sockets.get(room.hostSocketId);
      if (old) {
        old.data = {};
        old.emit('host:replaced');
      }
    }
    room.hostSocketId = socket.id;
    room.hostConnected = true;
    room.joinUrl = `${baseUrlForSocket(socket)}/join/${room.code}`;
    socket.data = { role: 'host', code: room.code };
  }

  function bindPlayer(socket, room, player) {
    if (player.socketId && player.socketId !== socket.id) {
      const old = io.sockets.sockets.get(player.socketId);
      if (old) {
        old.leave(playerChannel(room.code));
        old.data = {};
        old.emit('player:replaced');
      }
    }
    player.socketId = socket.id;
    player.connected = true;
    socket.data = { role: 'player', code: room.code, playerId: player.id };
    socket.join(playerChannel(room.code));
  }

  function hostRoom(socket) {
    const { role, code } = socket.data ?? {};
    if (role !== 'host') return null;
    const room = manager.get(code);
    return room && room.hostSocketId === socket.id ? room : null;
  }

  function playerContext(socket) {
    const { role, code, playerId } = socket.data ?? {};
    if (role !== 'player') return {};
    const room = manager.get(code);
    const player = room?.players.get(playerId);
    if (!room || !player || player.socketId !== socket.id) return {};
    return { room, player };
  }

  io.on('connection', (socket) => {
    socket.data = {};
    let windowStart = now();
    let eventCount = 0;

    socket.use((packet, next) => {
      const t = now();
      if (t - windowStart > RATE_WINDOW_MS) {
        windowStart = t;
        eventCount = 0;
      }
      eventCount += 1;
      if (eventCount > RATE_MAX_EVENTS) {
        reply(packet.at(-1), { ok: false, error: 'rate_limited' });
        return;
      }
      next();
    });

    const handle = (event, fn) => {
      socket.on(event, (payload, ack) => {
        if (typeof payload === 'function') {
          ack = payload;
          payload = {};
        }
        try {
          fn(payload && typeof payload === 'object' ? payload : {}, ack);
        } catch (err) {
          console.error(`[grove] ${event} failed`, err);
          reply(ack, { ok: false, error: 'server_error' });
        }
      });
    };

    handle('host:create', (payload, ack) => {
      const result = validateQuiz(payload.quiz);
      if (!result.ok) return reply(ack, { ok: false, error: 'invalid_quiz', errors: result.errors });
      const room = manager.create(result.quiz, now());
      if (!room) return reply(ack, { ok: false, error: 'server_full' });
      detach(socket);
      bindHost(socket, room);
      reply(ack, { ok: true, code: room.code, hostToken: room.hostToken, joinUrl: room.joinUrl });
      broadcast(room);
    });

    handle('host:rejoin', (payload, ack) => {
      const room = manager.get(normalizeRoomCode(payload.code));
      if (!room) return reply(ack, { ok: false, error: 'not_found' });
      if (!room.checkHostToken(payload.hostToken)) return reply(ack, { ok: false, error: 'forbidden' });
      if (socket.data.code !== room.code) detach(socket);
      bindHost(socket, room);
      room.touch(now());
      reply(ack, { ok: true, code: room.code, joinUrl: room.joinUrl });
      broadcast(room);
    });

    handle('host:action', (payload, ack) => {
      const room = hostRoom(socket);
      if (!room) return reply(ack, { ok: false, error: 'not_host' });
      const t = now();
      let result;
      switch (payload.type) {
        case 'start':
          result = room.startQuestion(t);
          if (result.ok) scheduleLock(room);
          break;
        case 'end_question':
          clearTimer(room.code);
          result = room.lockQuestion(t, 'host');
          break;
        case 'reveal':
          result = room.reveal(t);
          break;
        case 'standings':
          result = room.showStandings(t);
          break;
        case 'finish':
          result = room.finish(t);
          break;
        case 'lock':
          result = room.setLocked(Boolean(payload.locked));
          break;
        case 'kick': {
          const player = room.removePlayer(String(payload.playerId ?? ''));
          if (!player) {
            result = { ok: false, error: 'unknown_player' };
            break;
          }
          if (player.socketId) {
            const ps = io.sockets.sockets.get(player.socketId);
            if (ps) {
              ps.leave(playerChannel(room.code));
              ps.data = {};
              ps.emit('player:removed');
            }
          }
          result = { ok: true };
          if (room.phase === 'question' && room.allConnectedAnswered()) {
            reply(ack, result);
            lockNow(room, 'all_answered');
            return;
          }
          break;
        }
        case 'close':
          reply(ack, { ok: true });
          closeRoom(room, 'host_closed');
          return;
        default:
          result = { ok: false, error: 'unknown_action' };
      }
      reply(ack, result);
      if (result.ok) broadcast(room);
    });

    handle('player:join', (payload, ack) => {
      const code = normalizeRoomCode(payload.code);
      if (!ROOM_CODE_PATTERN.test(code)) return reply(ack, { ok: false, error: 'invalid_code' });
      const room = manager.get(code);
      if (!room) return reply(ack, { ok: false, error: 'not_found' });
      const result = room.addPlayer(payload.name, now());
      if (!result.ok) return reply(ack, result);
      detach(socket);
      bindPlayer(socket, room, result.player);
      reply(ack, {
        ok: true,
        code: room.code,
        playerId: result.player.id,
        token: result.player.token,
        name: result.player.name,
      });
      broadcast(room, { immediate: false });
      flushOne(room, result.player);
    });

    handle('player:rejoin', (payload, ack) => {
      const room = manager.get(normalizeRoomCode(payload.code));
      if (!room) return reply(ack, { ok: false, error: 'not_found' });
      const player = room.authenticate(String(payload.playerId ?? ''), payload.token);
      if (!player) return reply(ack, { ok: false, error: 'session_expired' });
      if (socket.data.playerId !== player.id) detach(socket);
      bindPlayer(socket, room, player);
      room.touch(now());
      reply(ack, { ok: true, code: room.code, playerId: player.id, name: player.name });
      broadcast(room, { immediate: false });
      flushOne(room, player);
    });

    handle('player:answer', (payload, ack) => {
      const { room, player } = playerContext(socket);
      if (!room) return reply(ack, { ok: false, error: 'not_in_room' });
      const result = room.submitAnswer(player.id, Number(payload.qIndex), Number(payload.choice), now());
      reply(ack, result);
      if (!result.ok) return;
      if (room.allConnectedAnswered()) lockNow(room, 'all_answered');
      else broadcast(room, { immediate: false });
    });

    handle('player:leave', (payload, ack) => {
      const { room, player } = playerContext(socket);
      if (!room) return reply(ack, { ok: true });
      room.removePlayer(player.id);
      socket.leave(playerChannel(room.code));
      socket.data = {};
      reply(ack, { ok: true });
      if (room.phase === 'question' && room.allConnectedAnswered()) lockNow(room, 'all_answered');
      else broadcast(room, { immediate: false });
    });

    handle('sync', (payload, ack) => {
      // Lets a client ask for a fresh copy of its view (e.g. after waking a phone).
      const host = hostRoom(socket);
      if (host) {
        broadcast(host);
        return reply(ack, { ok: true });
      }
      const { room, player } = playerContext(socket);
      if (room) flushOne(room, player);
      reply(ack, { ok: Boolean(room) });
    });

    socket.on('disconnect', () => detach(socket));
  });

  // Sends one player their view right away (used after join / rejoin so the
  // joining phone doesn't wait for the coalesced room broadcast).
  function flushOne(room, player) {
    if (!player.socketId) return;
    const ranked = room.ranked();
    const entry = ranked.find((r) => r.player.id === player.id);
    const summary = room.phase === 'standings' || room.phase === 'final'
      ? summarize(ranked, { includeRound: room.phase === 'standings' })
      : null;
    io.to(player.socketId).emit('player:state', {
      ...baseView(room, now(), summary),
      role: 'player',
      me: meView(room, player, entry),
    });
  }

  const sweeper = setInterval(() => {
    for (const room of manager.sweep(now())) closeRoom(room, 'expired');
  }, sweepIntervalMs);
  sweeper.unref?.();

  return {
    stop() {
      clearInterval(sweeper);
      for (const t of timers.values()) clearTimeout(t);
      for (const t of pending.values()) clearTimeout(t);
      timers.clear();
      pending.clear();
    },
  };
}
