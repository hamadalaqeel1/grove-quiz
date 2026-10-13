// In-memory registry of live rooms, with code generation and expiry.
import crypto from 'node:crypto';
import { Room } from './game.js';

const HOUR = 60 * 60 * 1000;

export class RoomManager {
  constructor({
    maxRooms = 1000,
    idleMs = 3 * HOUR, // no activity at all
    finishedMs = 1 * HOUR, // after the final results
    hostAwayMs = 30 * 60 * 1000, // host disconnected and never came back
  } = {}) {
    this.rooms = new Map();
    this.maxRooms = maxRooms;
    this.idleMs = idleMs;
    this.finishedMs = finishedMs;
    this.hostAwayMs = hostAwayMs;
  }

  get size() {
    return this.rooms.size;
  }

  newCode() {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const code = String(crypto.randomInt(100000, 1000000));
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('Could not allocate a room code');
  }

  create(quiz, now = Date.now()) {
    if (this.rooms.size >= this.maxRooms) this.sweep(now);
    if (this.rooms.size >= this.maxRooms) return null;
    const room = new Room({ code: this.newCode(), quiz, now });
    this.rooms.set(room.code, room);
    return room;
  }

  get(code) {
    return this.rooms.get(String(code ?? '')) ?? null;
  }

  delete(code) {
    const room = this.rooms.get(code);
    if (!room) return null;
    this.rooms.delete(code);
    return room;
  }

  /** Removes expired rooms and returns them so callers can notify players. */
  sweep(now = Date.now()) {
    const removed = [];
    for (const room of this.rooms.values()) {
      const idle = now - room.lastActivity > this.idleMs;
      const finished = room.phase === 'final' && now - room.finishedAt > this.finishedMs;
      const abandoned = !room.hostConnected && now - room.hostLeftAt > this.hostAwayMs;
      if (idle || finished || abandoned) {
        this.rooms.delete(room.code);
        removed.push(room);
      }
    }
    return removed;
  }
}
