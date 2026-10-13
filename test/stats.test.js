import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { io as connect } from 'socket.io-client';
import { createGroveServer } from '../src/server.js';
import { Stats } from '../src/stats.js';
import { SAMPLE_QUIZ } from '../public/js/sample-quiz.js';

const HOUR = 3600_000;

describe('Stats counters', () => {
  it('counts unique visitors, page views and hourly buckets', () => {
    let t = Date.UTC(2026, 9, 13, 10, 5);
    const stats = new Stats({ now: () => t });
    stats.recordPageView('1.1.1.1', 'phone');
    stats.recordPageView('1.1.1.1', 'phone');
    stats.recordPageView('2.2.2.2', 'laptop');
    t += HOUR;
    stats.recordPageView('1.1.1.1', 'phone');
    stats.record('playerJoined');
    stats.record('gameStarted');
    const snap = stats.snapshot({ playersOnline: 0 });
    assert.equal(snap.totals.pageViews, 4);
    assert.equal(snap.totals.uniqueVisitors, 2);
    assert.equal(snap.hourly.length, 24);
    const [prev, last] = snap.hourly.slice(-2);
    assert.deepEqual([prev.visitors, prev.pageViews], [2, 3]);
    assert.deepEqual([last.visitors, last.pageViews, last.playersJoined, last.gamesStarted], [1, 1, 1, 1]);
    assert.equal(snap.hourly[0].tracked, false, 'hours before start are marked untracked');
    assert.equal(prev.tracked, true);
  });

  it('keeps only 24 hours and tracks the peak', () => {
    let t = Date.UTC(2026, 9, 13, 0, 0);
    const stats = new Stats({ now: () => t });
    for (let i = 0; i < 30; i += 1) {
      stats.recordPageView(`10.0.0.${i}`, 'x');
      t += HOUR;
    }
    assert.ok(stats.hours.size <= 24);
    stats.observePlayersOnline(5);
    stats.observePlayersOnline(3);
    assert.equal(stats.snapshot({}).peak.players, 5);
    assert.throws(() => stats.record('nope'));
  });

  it('never exposes IP addresses or user agents', () => {
    const stats = new Stats();
    stats.recordPageView('203.0.113.9', 'SecretBrowser/1.0');
    const json = JSON.stringify(stats.snapshot({}));
    assert.ok(!json.includes('203.0.113.9'));
    assert.ok(!json.includes('SecretBrowser'));
  });
});

async function withServer(opts, fn) {
  const server = createGroveServer({ publicUrl: 'https://quiz.example.org', ...opts });
  const port = await server.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${port}`;
  const sockets = [];
  const client = () => {
    const s = connect(url, { transports: ['websocket'], forceNew: true, reconnection: false });
    sockets.push(s);
    return s;
  };
  try {
    await fn(url, client);
  } finally {
    sockets.forEach((s) => s.disconnect());
    await server.close();
  }
}

const ack = (s, ev, payload) => s.timeout(5000).emitWithAck(ev, payload);

describe('/api/stats', () => {
  it('reports live players, rooms, games and visits', async () => {
    await withServer({ statsKey: '' }, async (url, client) => {
      await fetch(`${url}/`);
      await fetch(`${url}/host`);
      await fetch(`${url}/stats`); // the stats page itself isn't counted
      const host = client();
      const { code } = await ack(host, 'host:create', { quiz: { title: 'S', questions: SAMPLE_QUIZ.questions.slice(0, 1) } });
      const players = [];
      for (const name of ['A', 'B', 'C']) {
        const s = client();
        assert.equal((await ack(s, 'player:join', { code, name })).ok, true);
        players.push(s);
      }
      await ack(host, 'host:action', { type: 'start' });
      await ack(players[0], 'player:answer', { qIndex: 0, choice: 1 });
      players[2].disconnect();
      await new Promise((r) => setTimeout(r, 150));

      const res = await fetch(`${url}/api/stats`);
      assert.equal(res.status, 200);
      const s = await res.json();
      assert.equal(s.totals.pageViews, 2);
      assert.equal(s.totals.uniqueVisitors, 1);
      assert.equal(s.totals.roomsCreated, 1);
      assert.equal(s.totals.playersJoined, 3);
      assert.equal(s.totals.gamesStarted, 1);
      assert.equal(s.totals.answers, 1);
      assert.equal(s.live.roomsOpen, 1);
      assert.equal(s.live.gamesInProgress, 1);
      assert.equal(s.live.playersOnline, 2);
      assert.equal(s.live.playersInRooms, 3);
      assert.equal(s.live.hostsOnline, 1);
      assert.equal(s.peak.players, 3);
      assert.ok(!JSON.stringify(s).includes(code), 'no room codes in stats');
    });
  });

  it('can be locked with STATS_KEY', async () => {
    await withServer({ statsKey: 's3cret-key' }, async (url) => {
      assert.equal((await fetch(`${url}/api/stats`)).status, 401);
      assert.equal((await fetch(`${url}/api/stats?key=wrong`)).status, 401);
      assert.equal((await fetch(`${url}/api/stats?key=s3cret-key`)).status, 200);
      assert.equal((await fetch(`${url}/api/stats`, { headers: { 'X-Stats-Key': 's3cret-key' } })).status, 200);
      assert.equal((await fetch(`${url}/stats`)).status, 200, 'the page shell loads and asks for the key');
    });
  });
});
