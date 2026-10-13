import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Room, rankPlayers, scoreFor, summarize } from '../src/game.js';
import { RoomManager } from '../src/rooms.js';
import { validateName, validateQuiz } from '../public/js/rules.js';
import { SAMPLE_QUIZ } from '../public/js/sample-quiz.js';

const quiz = () => validateQuiz(SAMPLE_QUIZ).quiz;

function makeRoom(names = ['Ana', 'Ben', 'Cai'], t = 1000) {
  const room = new Room({ code: '123456', quiz: quiz(), now: t });
  const players = names.map((n) => {
    const r = room.addPlayer(n, t);
    assert.ok(r.ok, `join ${n}`);
    r.player.connected = true;
    return r.player;
  });
  return { room, players };
}

function fakePlayers(scores) {
  return scores.map(([name, score, time = 0], i) => ({
    id: name, name, score, correctTimeMs: time, joinSeq: i, correctCount: 0, lastRound: null,
  }));
}

describe('quiz validation', () => {
  it('accepts the sample quiz', () => {
    const r = validateQuiz(SAMPLE_QUIZ);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.quiz.questions.length, 6);
  });

  it('requires exactly four distinct, non-empty choices and a correct answer', () => {
    const r = validateQuiz({
      title: '  ',
      questions: [
        { text: 'Q', choices: ['a', 'b', 'c'], correct: 1 },
        { text: 'Q2', choices: ['a', 'A', 'c', 'd'], correct: 7 },
        { text: '', choices: ['a', 'b', 'c', 'd'], correct: 0, timeLimit: 2 },
      ],
    });
    assert.equal(r.ok, false);
    const paths = r.errors.map((e) => e.path);
    assert.ok(paths.includes('title'));
    assert.ok(paths.includes('q.0.choice.3'), 'missing 4th choice');
    assert.ok(paths.includes('q.1.choice.1'), 'duplicate choice');
    assert.ok(paths.includes('q.1.correct'));
    assert.ok(paths.includes('q.2.text'));
    assert.ok(paths.includes('q.2.timeLimit'));
  });

  it('rejects empty quizzes and strips control characters', () => {
    assert.equal(validateQuiz({ title: 'x', questions: [] }).ok, false);
    assert.equal(validateQuiz(null).ok, false);
    const r = validateQuiz({ title: `Hi${String.fromCharCode(0x202e)}there\n`, questions: [{ text: 'Q', choices: ['a', 'b', 'c', 'd'], correct: 0 }] });
    assert.equal(r.quiz.title, 'Hi there');
    assert.equal(r.quiz.questions[0].timeLimit, 20);
  });

  it('validates display names', () => {
    assert.equal(validateName('   ').ok, false);
    assert.equal(validateName('x'.repeat(21)).ok, false);
    assert.deepEqual(validateName('  Sara   K '), { ok: true, name: 'Sara K' });
  });
});

describe('scoring', () => {
  it('awards 1000 for instant and 500 for last-moment correct answers', () => {
    assert.equal(scoreFor(0, 20000), 1000);
    assert.equal(scoreFor(20000, 20000), 500);
    assert.equal(scoreFor(10000, 20000), 750);
    assert.equal(scoreFor(99999, 20000), 500);
  });

  it('scores only at reveal, by speed, and only correct answers', () => {
    const { room, players: [a, b, c] } = makeRoom();
    assert.ok(room.startQuestion(1000).ok);
    const correct = room.question.correct;
    assert.ok(room.submitAnswer(a.id, 0, correct, 3000).ok); // 2s
    assert.ok(room.submitAnswer(b.id, 0, correct, 11000).ok); // 10s
    assert.ok(room.submitAnswer(c.id, 0, (correct + 1) % 4, 2000).ok);
    // All connected players answered.
    assert.equal(room.allConnectedAnswered(), true);
    assert.ok(room.lockQuestion(11000, 'all_answered').ok);
    assert.equal(a.score, 0, 'no score before reveal');
    assert.ok(room.reveal(12000).ok);
    assert.equal(a.score, 950);
    assert.equal(b.score, 750);
    assert.equal(c.score, 0);
    assert.deepEqual(room.distribution.reduce((x, y) => x + y), 3);
    assert.equal(c.lastRound.correct, false);
  });
});

describe('answer guards', () => {
  it('rejects duplicate, late, wrong-question and out-of-range answers', () => {
    const { room, players: [a, b, c] } = makeRoom();
    assert.equal(room.submitAnswer(a.id, 0, 1, 1000).error, 'wrong_question', 'before start');
    room.startQuestion(1000);
    assert.equal(room.submitAnswer(a.id, 0, 9, 1500).error, 'invalid_choice');
    assert.ok(room.submitAnswer(a.id, 0, 1, 1500).ok);
    assert.equal(room.submitAnswer(a.id, 0, 2, 1600).error, 'duplicate');
    assert.equal(room.submitAnswer(b.id, 1, 1, 1600).error, 'wrong_question');
    const deadline = room.deadline;
    assert.equal(room.submitAnswer(b.id, 0, 1, deadline + 1).error, 'late', 'after deadline but before timer fires');
    room.lockQuestion(deadline + 25);
    assert.equal(room.submitAnswer(c.id, 0, 1, deadline + 30).error, 'late');
    room.reveal(deadline + 40);
    assert.equal(room.submitAnswer(c.id, 0, room.question.correct, deadline + 50).error, 'late');
    assert.equal(c.score, 0);
  });

  it('enforces phase order and stops after the last question', () => {
    const { room, players } = makeRoom(['Solo']);
    assert.equal(room.reveal(1).ok, false);
    assert.equal(room.finish(1).ok, false);
    for (let i = 0; i < room.questionCount; i += 1) {
      assert.ok(room.startQuestion(1000 * i).ok, `start ${i}`);
      assert.equal(room.startQuestion(1000 * i).ok, false, 'cannot double start');
      room.submitAnswer(players[0].id, i, 0, 1000 * i + 10);
      assert.ok(room.lockQuestion(1000 * i + 20).ok);
      assert.ok(room.reveal(1000 * i + 30).ok);
      assert.ok(room.showStandings(1000 * i + 40).ok);
    }
    assert.equal(room.startQuestion(99999).ok, false, 'no question after the last');
    assert.ok(room.finish(100000).ok);
    assert.equal(room.joinStatus().reason, 'finished');
  });

  it('cannot start with no players', () => {
    const room = new Room({ code: '123456', quiz: quiz(), now: 0 });
    assert.equal(room.startQuestion(1).error, 'no_players');
  });
});

describe('joining', () => {
  it('rejects duplicate names case-insensitively and respects the lock', () => {
    const { room } = makeRoom(['Ana']);
    assert.equal(room.addPlayer('ana', 1).error, 'name_taken');
    assert.equal(room.addPlayer(' ANA ', 1).error, 'name_taken');
    room.setLocked(true);
    assert.equal(room.addPlayer('Zed', 1).error, 'locked');
    room.setLocked(false);
    assert.ok(room.addPlayer('Zed', 1).ok);
  });

  it('frees a name when a player is removed and authenticates tokens', () => {
    const { room, players: [a] } = makeRoom(['Ana']);
    assert.equal(room.authenticate(a.id, a.token), a);
    assert.equal(room.authenticate(a.id, 'nope'), null);
    room.removePlayer(a.id);
    assert.equal(room.authenticate(a.id, a.token), null);
    assert.ok(room.addPlayer('Ana', 2).ok);
  });
});

describe('standings', () => {
  it('gives equal ranks to exact ties and breaks score ties by speed', () => {
    const ranked = rankPlayers(fakePlayers([
      ['a', 900, 3000], ['b', 900, 2000], ['c', 500, 100], ['d', 500, 100], ['e', 0], ['f', 0],
    ]));
    assert.deepEqual(ranked.map((r) => r.player.id), ['b', 'a', 'c', 'd', 'e', 'f']);
    assert.deepEqual(ranked.map((r) => r.rank), [1, 2, 3, 3, 5, 5]);
    assert.deepEqual(ranked.map((r) => r.tied), [false, false, true, true, true, true]);
  });

  for (let n = 0; n <= 8; n += 1) {
    it(`never lists a player twice with ${n} players`, () => {
      const ranked = rankPlayers(fakePlayers(Array.from({ length: n }, (_, i) => [`p${i}`, (n - i) * 100])));
      const s = summarize(ranked);
      const ids = [...s.top, ...s.bottom].map((e) => e.id);
      assert.equal(new Set(ids).size, ids.length, 'no duplicates');
      assert.equal(s.top.length, Math.min(3, n));
      assert.equal(s.bottom.length, Math.max(0, Math.min(3, n - 3)));
      assert.equal(s.everyoneShown, n <= 6);
      if (n > 3) assert.equal(s.bottom.at(-1).id, `p${n - 1}`, 'last place is last');
    });
  }

  it('reports players hidden by a tie at the cut-off', () => {
    const ranked = rankPlayers(fakePlayers([
      ['a', 900], ['b', 800], ['c', 700], ['d', 700], ['e', 700], ['f', 300], ['g', 0], ['h', 0], ['i', 0], ['j', 0],
    ]));
    const s = summarize(ranked);
    assert.deepEqual(s.top.map((e) => e.id), ['a', 'b', 'c']);
    assert.equal(s.topTiedHidden, 2);
    assert.deepEqual(s.bottom.map((e) => e.id), ['h', 'i', 'j']);
    assert.equal(s.bottomTiedHidden, 1, 'g shares last place but is not shown');
  });
});

describe('room manager', () => {
  it('creates unique six-digit codes and expires idle rooms', () => {
    const m = new RoomManager({ idleMs: 1000, hostAwayMs: 10_000 });
    const r1 = m.create(quiz(), 0);
    const r2 = m.create(quiz(), 0);
    assert.match(r1.code, /^[1-9]\d{5}$/);
    assert.notEqual(r1.code, r2.code);
    r1.hostConnected = true;
    r2.hostConnected = true;
    r2.touch(1500);
    const removed = m.sweep(1600);
    assert.deepEqual(removed.map((r) => r.code), [r1.code]);
    assert.equal(m.get(r1.code), null);
  });
});
