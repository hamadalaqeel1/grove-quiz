// Pure game logic for one quiz room. No sockets or timers in here: every
// method takes `now` so the rules can be unit-tested deterministically.
import crypto from 'node:crypto';
import { LIMITS, nameKey, validateName } from '../public/js/rules.js';

export const BASE_POINTS = 500;
export const SPEED_POINTS = 500;
export const SUMMARY_SIZE = 3;

// Phase flow: lobby -> question -> locked -> reveal -> standings -> question ... -> final
export const PHASES = Object.freeze(['lobby', 'question', 'locked', 'reveal', 'standings', 'final']);

export function newToken() {
  return crypto.randomBytes(18).toString('base64url');
}

function newId() {
  return crypto.randomBytes(6).toString('base64url');
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/**
 * Correct answers earn 500 points plus up to 500 more for speed: an instant
 * answer earns 1000, an answer on the buzzer earns 500. Wrong or missing
 * answers earn 0.
 */
export function scoreFor(elapsedMs, limitMs) {
  const fraction = Math.min(Math.max(elapsedMs / limitMs, 0), 1);
  return Math.round(BASE_POINTS + SPEED_POINTS * (1 - fraction));
}

/**
 * Orders players by score (high first). Equal scores are separated by the
 * total time spent on correct answers (faster first). Players with the same
 * score AND the same time share a rank (1, 2, 2, 4 ...); join order only
 * fixes their display order.
 */
export function rankPlayers(players) {
  const sorted = [...players].sort(
    (a, b) => b.score - a.score || a.correctTimeMs - b.correctTimeMs || a.joinSeq - b.joinSeq,
  );
  const ranked = [];
  sorted.forEach((p, i) => {
    const prev = ranked[i - 1];
    const sameAsPrev = prev && prev.player.score === p.score && prev.player.correctTimeMs === p.correctTimeMs;
    ranked.push({ player: p, rank: sameAsPrev ? prev.rank : i + 1, tied: false });
  });
  const counts = new Map();
  ranked.forEach((r) => counts.set(r.rank, (counts.get(r.rank) ?? 0) + 1));
  ranked.forEach((r) => {
    r.tied = counts.get(r.rank) > 1;
  });
  return ranked;
}

function publicEntry({ player, rank, tied }, includeRound) {
  return {
    id: player.id,
    name: player.name,
    score: player.score,
    rank,
    tied,
    correctCount: player.correctCount,
    roundPoints: includeRound && player.lastRound ? player.lastRound.points : null,
  };
}

/**
 * Top three and bottom three, never listing anyone twice. With fewer than six
 * players the bottom list only holds whoever isn't already in the top list.
 * `topTiedHidden` / `bottomTiedHidden` count players outside both lists who
 * share the rank of the last top entry / first bottom entry.
 */
export function summarize(ranked, { size = SUMMARY_SIZE, includeRound = true } = {}) {
  const total = ranked.length;
  const topCount = Math.min(size, total);
  const bottomCount = Math.min(size, total - topCount);
  const top = ranked.slice(0, topCount);
  const bottom = bottomCount > 0 ? ranked.slice(total - bottomCount) : [];
  const shown = new Set([...top, ...bottom].map((r) => r.player.id));
  const hidden = ranked.filter((r) => !shown.has(r.player.id));
  const topCut = top.at(-1)?.rank;
  const bottomCut = bottom[0]?.rank;
  return {
    total,
    top: top.map((r) => publicEntry(r, includeRound)),
    bottom: bottom.map((r) => publicEntry(r, includeRound)),
    topTiedHidden: topCut === undefined ? 0 : hidden.filter((r) => r.rank === topCut).length,
    bottomTiedHidden: bottomCut === undefined ? 0 : hidden.filter((r) => r.rank === bottomCut).length,
    everyoneShown: hidden.length === 0,
  };
}

export class Room {
  constructor({ code, quiz, now = Date.now() }) {
    this.code = code;
    this.quiz = quiz;
    this.hostToken = newToken();
    this.hostConnected = false;
    this.hostSocketId = null;
    this.hostLeftAt = now;
    this.phase = 'lobby';
    this.qIndex = -1;
    this.players = new Map();
    this.nameKeys = new Map();
    this.answers = new Map();
    this.locked = false;
    this.questionStartedAt = 0;
    this.deadline = 0;
    this.lockedAt = 0;
    this.lockReason = null;
    this.distribution = [0, 0, 0, 0];
    this.createdAt = now;
    this.lastActivity = now;
    this.finishedAt = 0;
    this.seq = 0;
  }

  get question() {
    return this.quiz.questions[this.qIndex] ?? null;
  }

  get questionCount() {
    return this.quiz.questions.length;
  }

  get isLastQuestion() {
    return this.qIndex >= this.quiz.questions.length - 1;
  }

  touch(now) {
    this.lastActivity = now;
  }

  checkHostToken(token) {
    return safeEqual(this.hostToken, token);
  }

  joinStatus() {
    if (this.phase === 'final') return { accepting: false, reason: 'finished' };
    if (this.locked) return { accepting: false, reason: 'locked' };
    if (this.players.size >= LIMITS.maxPlayers) return { accepting: false, reason: 'full' };
    return { accepting: true, reason: null };
  }

  addPlayer(rawName, now) {
    const status = this.joinStatus();
    if (!status.accepting) return { ok: false, error: status.reason };
    const valid = validateName(rawName);
    if (!valid.ok) return { ok: false, error: 'invalid_name', message: valid.error };
    const key = nameKey(valid.name);
    if (this.nameKeys.has(key)) return { ok: false, error: 'name_taken' };

    const player = {
      id: newId(),
      token: newToken(),
      name: valid.name,
      score: 0,
      correctCount: 0,
      correctTimeMs: 0,
      connected: false,
      socketId: null,
      joinSeq: this.seq++,
      joinedAt: now,
      lastRound: null,
      prevRank: null,
    };
    this.players.set(player.id, player);
    this.nameKeys.set(key, player.id);
    this.touch(now);
    return { ok: true, player };
  }

  authenticate(playerId, token) {
    const player = this.players.get(playerId);
    if (!player || !safeEqual(player.token, token)) return null;
    return player;
  }

  removePlayer(playerId) {
    const player = this.players.get(playerId);
    if (!player) return null;
    this.players.delete(playerId);
    this.nameKeys.delete(nameKey(player.name));
    this.answers.delete(playerId);
    return player;
  }

  setLocked(locked) {
    if (this.phase === 'final') return { ok: false, error: 'bad_phase' };
    this.locked = Boolean(locked);
    return { ok: true };
  }

  connectedPlayers() {
    return [...this.players.values()].filter((p) => p.connected);
  }

  remainingMs(now) {
    return this.phase === 'question' ? Math.max(0, this.deadline - now) : 0;
  }

  canStartQuestion() {
    if (this.phase === 'lobby') return this.players.size > 0;
    return this.phase === 'standings' && !this.isLastQuestion;
  }

  startQuestion(now) {
    if (this.phase === 'lobby' && this.players.size === 0) return { ok: false, error: 'no_players' };
    if (!this.canStartQuestion()) return { ok: false, error: 'bad_phase' };
    this.qIndex += 1;
    this.phase = 'question';
    this.questionStartedAt = now;
    this.deadline = now + this.question.timeLimit * 1000;
    this.lockedAt = 0;
    this.lockReason = null;
    this.answers.clear();
    this.distribution = [0, 0, 0, 0];
    this.touch(now);
    return { ok: true };
  }

  submitAnswer(playerId, qIndex, choice, now) {
    const player = this.players.get(playerId);
    if (!player) return { ok: false, error: 'unknown_player' };
    if (qIndex !== this.qIndex) return { ok: false, error: 'wrong_question' };
    if (this.answers.has(playerId)) return { ok: false, error: 'duplicate' };
    if (this.phase !== 'question') {
      return { ok: false, error: this.phase === 'lobby' ? 'not_open' : 'late' };
    }
    if (now > this.deadline) return { ok: false, error: 'late' };
    if (!Number.isInteger(choice) || choice < 0 || choice > 3) return { ok: false, error: 'invalid_choice' };
    this.answers.set(playerId, { choice, elapsedMs: Math.max(0, now - this.questionStartedAt) });
    this.touch(now);
    return { ok: true, choice };
  }

  allConnectedAnswered() {
    const connected = this.connectedPlayers();
    return connected.length > 0 && connected.every((p) => this.answers.has(p.id));
  }

  lockQuestion(now, reason = 'timer') {
    if (this.phase !== 'question') return { ok: false, error: 'bad_phase' };
    this.phase = 'locked';
    this.lockedAt = now;
    this.lockReason = reason;
    this.touch(now);
    return { ok: true };
  }

  // Scores are applied at reveal, so nothing sent while a question is open or
  // locked can hint at which answer was correct.
  reveal(now) {
    if (this.phase !== 'locked') return { ok: false, error: 'bad_phase' };
    const q = this.question;
    const limitMs = q.timeLimit * 1000;
    for (const r of rankPlayers(this.players.values())) r.player.prevRank = r.rank;
    this.distribution = [0, 0, 0, 0];
    for (const player of this.players.values()) {
      const answer = this.answers.get(player.id);
      const correct = Boolean(answer) && answer.choice === q.correct;
      const points = correct ? scoreFor(answer.elapsedMs, limitMs) : 0;
      if (answer) this.distribution[answer.choice] += 1;
      if (correct) {
        player.score += points;
        player.correctCount += 1;
        player.correctTimeMs += answer.elapsedMs;
      }
      player.lastRound = {
        qIndex: this.qIndex,
        answered: Boolean(answer),
        choice: answer ? answer.choice : null,
        correct,
        points,
        elapsedMs: answer ? answer.elapsedMs : null,
        joinedAfterClose: player.joinedAt > this.lockedAt,
      };
    }
    this.phase = 'reveal';
    this.touch(now);
    return { ok: true };
  }

  showStandings(now) {
    if (this.phase !== 'reveal') return { ok: false, error: 'bad_phase' };
    this.phase = 'standings';
    this.touch(now);
    return { ok: true };
  }

  finish(now) {
    if (this.phase !== 'standings') return { ok: false, error: 'bad_phase' };
    this.phase = 'final';
    this.finishedAt = now;
    this.touch(now);
    return { ok: true };
  }

  ranked() {
    return rankPlayers(this.players.values());
  }

  summary() {
    return summarize(this.ranked(), { includeRound: this.phase !== 'final' });
  }
}
