// Usage counters for the /stats page. Everything is in memory and aggregate:
// no names, no IP addresses. Visitors are counted by a salted hash of
// IP + browser, and the salt is random per process, so the hashes can't be
// linked to anyone and disappear on restart.
import crypto from 'node:crypto';

const HOUR = 60 * 60 * 1000;
const KEEP_HOURS = 24;
const MAX_VISITOR_IDS = 100_000;

export const HOURLY_METRICS = ['visitors', 'pageViews', 'playersJoined', 'gamesStarted'];

function hourStart(t) {
  return Math.floor(t / HOUR) * HOUR;
}

export class Stats {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.startedAt = now();
    this.salt = crypto.randomBytes(16);
    this.totals = {
      pageViews: 0,
      roomsCreated: 0,
      playersJoined: 0,
      gamesStarted: 0,
      gamesFinished: 0,
      answers: 0,
    };
    this.visitors = new Set();
    this.hours = new Map();
    this.peak = { players: 0, at: null };
  }

  bucket(t = this.now()) {
    const key = hourStart(t);
    let b = this.hours.get(key);
    if (!b) {
      b = { pageViews: 0, visitors: new Set(), playersJoined: 0, gamesStarted: 0 };
      this.hours.set(key, b);
      const oldest = key - (KEEP_HOURS - 1) * HOUR;
      for (const k of this.hours.keys()) if (k < oldest) this.hours.delete(k);
    }
    return b;
  }

  visitorId(ip, userAgent) {
    return crypto.createHash('sha256').update(this.salt).update(String(ip ?? '')).update('\n')
      .update(String(userAgent ?? '')).digest('base64url').slice(0, 16);
  }

  recordPageView(ip, userAgent) {
    const id = this.visitorId(ip, userAgent);
    const b = this.bucket();
    this.totals.pageViews += 1;
    b.pageViews += 1;
    b.visitors.add(id);
    if (this.visitors.size < MAX_VISITOR_IDS) this.visitors.add(id);
  }

  record(event) {
    switch (event) {
      case 'roomCreated':
        this.totals.roomsCreated += 1;
        break;
      case 'playerJoined':
        this.totals.playersJoined += 1;
        this.bucket().playersJoined += 1;
        break;
      case 'gameStarted':
        this.totals.gamesStarted += 1;
        this.bucket().gamesStarted += 1;
        break;
      case 'gameFinished':
        this.totals.gamesFinished += 1;
        break;
      case 'answer':
        this.totals.answers += 1;
        break;
      default:
        throw new Error(`Unknown stats event: ${event}`);
    }
  }

  observePlayersOnline(count) {
    if (count > this.peak.players) this.peak = { players: count, at: this.now() };
  }

  snapshot(live) {
    const t = this.now();
    const current = hourStart(t);
    const hourly = [];
    for (let i = KEEP_HOURS - 1; i >= 0; i -= 1) {
      const start = current - i * HOUR;
      const b = this.hours.get(start);
      hourly.push({
        start,
        // Hours before the server started have no data rather than zero.
        tracked: start + HOUR > this.startedAt,
        visitors: b ? b.visitors.size : 0,
        pageViews: b ? b.pageViews : 0,
        playersJoined: b ? b.playersJoined : 0,
        gamesStarted: b ? b.gamesStarted : 0,
      });
    }
    return {
      now: t,
      startedAt: this.startedAt,
      live,
      totals: { ...this.totals, uniqueVisitors: this.visitors.size },
      peak: this.peak,
      hourly,
    };
  }
}

/** Live numbers read straight from the room registry. */
export function liveCounts(manager) {
  let roomsInLobby = 0;
  let gamesInProgress = 0;
  let roomsFinished = 0;
  let playersOnline = 0;
  let playersInRooms = 0;
  let hostsOnline = 0;
  for (const room of manager.rooms.values()) {
    if (room.phase === 'lobby') roomsInLobby += 1;
    else if (room.phase === 'final') roomsFinished += 1;
    else gamesInProgress += 1;
    if (room.hostConnected) hostsOnline += 1;
    playersInRooms += room.players.size;
    for (const p of room.players.values()) if (p.connected) playersOnline += 1;
  }
  return {
    roomsOpen: manager.size,
    roomsInLobby,
    gamesInProgress,
    roomsFinished,
    playersOnline,
    playersInRooms,
    hostsOnline,
  };
}
