// End-to-end tests over real sockets: one host and 22 players in one room.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { io as connect } from 'socket.io-client';
import { createGroveServer } from '../src/server.js';
import { SAMPLE_QUIZ } from '../public/js/sample-quiz.js';

const PLAYER_COUNT = 22;
let server;
let url;
const sockets = [];

function client() {
  const s = connect(url, { transports: ['websocket'], forceNew: true, reconnection: false });
  sockets.push(s);
  return s;
}

function emit(socket, event, payload) {
  return socket.timeout(5000).emitWithAck(event, payload);
}

/** Resolves with the next state on `event` that satisfies `pred`. */
function waitFor(socket, event, pred = () => true, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onState);
      reject(new Error(`timed out waiting for ${event}`));
    }, timeout);
    function onState(state) {
      if (pred(state)) {
        clearTimeout(timer);
        socket.off(event, onState);
        resolve(state);
      }
    }
    socket.on(event, onState);
  });
}

function keepLatest(socket, event) {
  const box = { state: null };
  socket.on(event, (s) => {
    box.state = s;
  });
  return box;
}

const shortQuiz = {
  title: 'Integration quiz',
  questions: SAMPLE_QUIZ.questions.slice(0, 3).map((q, i) => ({ ...q, timeLimit: i === 2 ? 5 : 10 })),
};

before(async () => {
  server = createGroveServer({ publicUrl: 'https://quiz.example.org' });
  const port = await server.listen(0, '127.0.0.1');
  url = `http://127.0.0.1:${port}`;
});

after(async () => {
  for (const s of sockets) s.disconnect();
  await server.close();
});

describe('HTTP endpoints', () => {
  it('serves pages, health check and friendly 404s', async () => {
    for (const p of ['/', '/host', '/join/123456', '/healthz', '/js/rules.js', '/socket.io/socket.io.min.js']) {
      const res = await fetch(url + p);
      assert.equal(res.status, 200, p);
    }
    assert.match((await fetch(`${url}/`)).headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal((await fetch(`${url}/api/rooms/999999`)).status, 404);
    assert.equal((await fetch(`${url}/api/rooms/abc`)).status, 400);
    assert.equal((await fetch(`${url}/nope`)).status, 404);
  });
});

describe('a live game with 22 players', () => {
  let host;
  let hostBox;
  let code;
  const players = [];

  it('rejects an invalid quiz with field errors', async () => {
    host = client();
    const res = await emit(host, 'host:create', { quiz: { title: '', questions: [{ text: 'x', choices: ['a', 'b'], correct: 0 }] } });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'invalid_quiz');
    assert.ok(res.errors.some((e) => e.path === 'title'));
  });

  it('creates a room with a join URL, QR code and lookup endpoint', async () => {
    hostBox = keepLatest(host, 'host:state');
    const res = await emit(host, 'host:create', { quiz: shortQuiz });
    assert.equal(res.ok, true);
    code = res.code;
    assert.match(code, /^[1-9]\d{5}$/);
    assert.equal(res.joinUrl, `https://quiz.example.org/join/${code}`);
    const qr = await fetch(`${url}/api/rooms/${code}/qr.svg`);
    assert.equal(qr.status, 200);
    assert.match(qr.headers.get('content-type'), /image\/svg\+xml/);
    assert.match(await qr.text(), /<svg/);
    const info = await (await fetch(`${url}/api/rooms/${code}`)).json();
    assert.equal(info.accepting, true);
    assert.equal(info.title, 'Integration quiz');
  });

  it('handles bad codes, blank names and duplicate names', async () => {
    const s = client();
    assert.equal((await emit(s, 'player:join', { code: '12', name: 'X' })).error, 'invalid_code');
    assert.equal((await emit(s, 'player:join', { code: '999999', name: 'X' })).error, code === '999999' ? 'invalid_name' : 'not_found');
    assert.equal((await emit(s, 'player:join', { code, name: '   ' })).error, 'invalid_name');
  });

  it(`lets ${PLAYER_COUNT} players join and the host sees all of them`, async () => {
    const joins = [];
    for (let i = 0; i < PLAYER_COUNT; i += 1) {
      const socket = client();
      const box = keepLatest(socket, 'player:state');
      const name = `Player ${String(i + 1).padStart(2, '0')}`;
      joins.push(emit(socket, 'player:join', { code, name }).then((res) => {
        assert.equal(res.ok, true, `${name}: ${res.error}`);
        players[i] = { socket, box, name, id: res.playerId, token: res.token };
      }));
    }
    await Promise.all(joins);
    const dup = client();
    assert.equal((await emit(dup, 'player:join', { code, name: 'player 01' })).error, 'name_taken');

    const state = await waitFor(host, 'host:state', (s) => s.roster.length === PLAYER_COUNT && s.connectedCount === PLAYER_COUNT);
    assert.equal(state.phase, 'lobby');
    await waitFor(players[0].socket, 'player:state', (s) => s.playerCount === PLAYER_COUNT).catch(() => {});
    assert.equal(players[0].box.state.phase, 'lobby');
  });

  it('blocks new players while the room is locked', async () => {
    assert.equal((await emit(host, 'host:action', { type: 'lock', locked: true })).ok, true);
    const late = client();
    assert.equal((await emit(late, 'player:join', { code, name: 'Latecomer' })).error, 'locked');
    const info = await (await fetch(`${url}/api/rooms/${code}`)).json();
    assert.equal(info.accepting, false);
    assert.equal(info.reason, 'locked');
    assert.equal((await emit(host, 'host:action', { type: 'lock', locked: false })).ok, true);
  });

  it('only lets the host control the game', async () => {
    const res = await emit(players[0].socket, 'host:action', { type: 'start' });
    assert.equal(res.error, 'not_host');
    const stranger = client();
    assert.equal((await emit(stranger, 'host:rejoin', { code, hostToken: 'wrong' })).error, 'forbidden');
  });

  it('sends every player the same question without the correct answer', async () => {
    const waits = players.map((p) => waitFor(p.socket, 'player:state', (s) => s.phase === 'question' && s.qIndex === 0));
    const hostWait = waitFor(host, 'host:state', (s) => s.phase === 'question');
    assert.equal((await emit(host, 'host:action', { type: 'start' })).ok, true);
    const states = await Promise.all(waits);
    const hostState = await hostWait;
    for (const s of states) {
      assert.equal(s.question.text, shortQuiz.questions[0].text);
      assert.deepEqual(s.question.choices, shortQuiz.questions[0].choices);
      assert.equal('correct' in s.question, false, 'correct answer must not leak to players');
      assert.ok(s.question.remainingMs > 8000 && s.question.remainingMs <= 10000);
    }
    assert.equal('correct' in hostState.question, false, 'host stage must not leak the answer either');
  });

  it('accepts one answer per player and rejects duplicates', async () => {
    const correct = shortQuiz.questions[0].correct;
    // 20 players answer (half right, half wrong), staggered so speed differs.
    for (let i = 0; i < 20; i += 1) {
      const choice = i % 2 === 0 ? correct : (correct + 1) % 4;
      const res = await emit(players[i].socket, 'player:answer', { qIndex: 0, choice });
      assert.equal(res.ok, true, `answer ${i}: ${res.error}`);
      if (i < 4) await new Promise((r) => setTimeout(r, 40));
    }
    const dupe = await emit(players[0].socket, 'player:answer', { qIndex: 0, choice: (correct + 2) % 4 });
    assert.equal(dupe.error, 'duplicate');
    const counted = await waitFor(host, 'host:state', (s) => s.answeredCount === 20);
    assert.equal(counted.phase, 'question', 'still open while 2 players have not answered');
    const mine = players[1].box.state;
    assert.equal(mine.me.answered, true);
    assert.equal(mine.me.lastRound, null, 'no correctness feedback before reveal');
  });

  it('locks early once every connected player has answered', async () => {
    const locked = waitFor(host, 'host:state', (s) => s.phase === 'locked');
    await emit(players[20].socket, 'player:answer', { qIndex: 0, choice: 3 });
    // Player 22 drops out instead of answering: everyone still connected has answered.
    players[21].socket.disconnect();
    const state = await locked;
    assert.equal(state.lockReason, 'all_answered');
    const late = await emit(players[20].socket, 'player:answer', { qIndex: 0, choice: 0 });
    assert.ok(['late', 'duplicate'].includes(late.error));
  });

  it('lets a disconnected player rejoin with their token and keep their place', async () => {
    const p = players[21];
    const socket = client();
    const box = keepLatest(socket, 'player:state');
    const res = await emit(socket, 'player:rejoin', { code, playerId: p.id, token: p.token });
    assert.equal(res.ok, true);
    assert.equal(res.name, p.name);
    const bad = await emit(client(), 'player:rejoin', { code, playerId: p.id, token: 'stolen' });
    assert.equal(bad.error, 'session_expired');
    Object.assign(p, { socket, box });
    await waitFor(socket, 'player:state', (s) => s.phase === 'locked').catch(() => {});
    assert.equal(box.state.phase, 'locked');
    const late = await emit(socket, 'player:answer', { qIndex: 0, choice: shortQuiz.questions[0].correct });
    assert.equal(late.error, 'late', 'cannot answer after the question closed');
  });

  it('reveals the answer, scores by speed and shows round standings', async () => {
    const correct = shortQuiz.questions[0].correct;
    const reveal = waitFor(players[0].socket, 'player:state', (s) => s.phase === 'reveal');
    assert.equal((await emit(host, 'host:action', { type: 'reveal' })).ok, true);
    const r = await reveal;
    assert.equal(r.question.correct, correct);
    assert.equal(r.me.lastRound.correct, true);
    assert.ok(r.me.lastRound.points > 900, 'fast correct answer earns close to 1000');
    assert.equal(r.distribution.reduce((a, b) => a + b), 21);

    const wrong = players[1].box.state;
    await waitFor(players[1].socket, 'player:state', (s) => s.phase === 'reveal').catch(() => {});
    assert.equal(players[1].box.state.me.lastRound.correct, false);
    assert.equal(players[1].box.state.me.score, 0);
    assert.ok(wrong);

    const standings = waitFor(host, 'host:state', (s) => s.phase === 'standings');
    assert.equal((await emit(host, 'host:action', { type: 'standings' })).ok, true);
    const s = await standings;
    const ids = [...s.summary.top, ...s.summary.bottom].map((e) => e.id);
    assert.equal(s.summary.top.length, 3);
    assert.equal(s.summary.bottom.length, 3);
    assert.equal(new Set(ids).size, 6, 'no one listed twice');
    assert.equal(s.summary.top[0].id, players[0].id, 'fastest correct answer leads');
    assert.ok(s.summary.top[0].score > s.summary.top[1].score);
    assert.equal(s.summary.bottom.at(-1).score, 0);
    assert.equal(s.summary.total, PLAYER_COUNT);
  });

  it('auto-locks when the timer runs out and rejects late answers', async () => {
    // Question 2: 10 seconds. Nobody answers except one player.
    assert.equal((await emit(host, 'host:action', { type: 'start' })).ok, true);
    await emit(players[5].socket, 'player:answer', { qIndex: 1, choice: shortQuiz.questions[1].correct });
    const ended = waitFor(host, 'host:state', (s) => s.phase === 'locked', 3000);
    assert.equal((await emit(host, 'host:action', { type: 'end_question' })).ok, true);
    assert.equal((await ended).lockReason, 'host');
    assert.equal((await emit(players[6].socket, 'player:answer', { qIndex: 1, choice: 0 })).error, 'late');
    await emit(host, 'host:action', { type: 'reveal' });
    await emit(host, 'host:action', { type: 'standings' });

    // Question 3 has a 5 second limit; let the server timer close it.
    const timedOutWait = waitFor(host, 'host:state', (s) => s.phase === 'locked', 8000);
    assert.equal((await emit(host, 'host:action', { type: 'start' })).ok, true);
    const timedOut = await timedOutWait;
    assert.equal(timedOut.lockReason, 'timer');
    assert.equal((await emit(players[7].socket, 'player:answer', { qIndex: 2, choice: 0 })).error, 'late');
  });

  it('shows final standings and stops accepting players', async () => {
    const revealWait = waitFor(host, 'host:state', (s) => s.phase === 'reveal');
    await emit(host, 'host:action', { type: 'reveal' });
    const standings = await revealWait;
    assert.equal(standings.isLast, true);
    await emit(host, 'host:action', { type: 'standings' });
    assert.equal((await emit(host, 'host:action', { type: 'start' })).ok, false, 'no question after the last one');
    const finalWait = waitFor(players[3].socket, 'player:state', (s) => s.phase === 'final');
    const hostFinal = waitFor(host, 'host:state', (s) => s.phase === 'final');
    assert.equal((await emit(host, 'host:action', { type: 'finish' })).ok, true);
    const f = await finalWait;
    const h = await hostFinal;
    assert.equal(f.summary.top.length, 3);
    assert.ok(f.me.rank >= 1 && f.me.rank <= PLAYER_COUNT);
    assert.equal(h.results.length, PLAYER_COUNT);
    assert.equal(h.results[0].id, f.summary.top[0].id);
    const late = client();
    assert.equal((await emit(late, 'player:join', { code, name: 'Too late' })).error, 'finished');
  });

  it('lets the host reconnect with the host token, then close the room', async () => {
    const res0 = host;
    const newHost = client();
    const replaced = new Promise((resolve) => res0.once('host:replaced', resolve));
    const res = await emit(newHost, 'host:rejoin', { code, hostToken: (await getHostToken()) });
    assert.equal(res.ok, true);
    await replaced;
    const closed = new Promise((resolve) => players[0].socket.once('room:closed', resolve));
    assert.equal((await emit(newHost, 'host:action', { type: 'close' })).ok, true);
    assert.deepEqual(await closed, { reason: 'host_closed' });
    assert.equal((await fetch(`${url}/api/rooms/${code}`)).status, 404);
  });

  async function getHostToken() {
    return server.manager.get(code).hostToken;
  }
});

describe('small rooms', () => {
  it('shows each of 4 players exactly once in the standings', async () => {
    const host = client();
    const { code } = await emit(host, 'host:create', { quiz: { title: 'Tiny', questions: [shortQuiz.questions[0]] } });
    const ps = [];
    for (const name of ['A', 'B', 'C', 'D']) {
      const s = client();
      const res = await emit(s, 'player:join', { code, name });
      ps.push({ s, id: res.playerId });
    }
    await emit(host, 'host:action', { type: 'start' });
    // Two players tie on zero by not answering.
    await emit(ps[0].s, 'player:answer', { qIndex: 0, choice: shortQuiz.questions[0].correct });
    await emit(ps[1].s, 'player:answer', { qIndex: 0, choice: (shortQuiz.questions[0].correct + 1) % 4 });
    await emit(host, 'host:action', { type: 'end_question' });
    await emit(host, 'host:action', { type: 'reveal' });
    const st = waitFor(host, 'host:state', (s) => s.phase === 'standings');
    await emit(host, 'host:action', { type: 'standings' });
    const { summary } = await st;
    assert.equal(summary.top.length, 3);
    assert.equal(summary.bottom.length, 1);
    assert.equal(summary.everyoneShown, true);
    const ids = [...summary.top, ...summary.bottom].map((e) => e.id);
    assert.equal(new Set(ids).size, 4);
    assert.equal(summary.top[0].rank, 1);
    assert.deepEqual(summary.top.slice(1).map((e) => e.rank).concat(summary.bottom.map((e) => e.rank)), [2, 2, 2]);
  });
});
