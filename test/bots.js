// Fills a room with simulated players for rehearsals and load tests.
// Usage: node test/bots.js <server-url> <room-code> [count=20] [prefix=Bot] [maxDelayMs]
// Bots answer at random after a random delay. They never see the correct
// answer (the server doesn't send it before the reveal), so scores vary.
import { io } from 'socket.io-client';

const [url = 'http://localhost:3000', code, countArg = '20', prefix = 'Bot', maxDelayArg] = process.argv.slice(2);
const count = Number(countArg);
const maxDelay = maxDelayArg ? Number(maxDelayArg) : null;

if (!/^\d{6}$/.test(code ?? '') || !Number.isInteger(count) || count < 1) {
  console.error('Usage: node test/bots.js <server-url> <room-code> [count=20] [prefix=Bot]');
  process.exit(2);
}

let joined = 0;
const sockets = [];

for (let i = 1; i <= count; i += 1) {
  const socket = io(url, { transports: ['websocket'], forceNew: true });
  sockets.push(socket);
  const name = `${prefix} ${String(i).padStart(2, '0')}`;
  const answeredFor = new Set();

  socket.on('connect', () => {
    socket.emit('player:join', { code, name }, (res) => {
      if (!res?.ok) {
        console.error(`${name}: could not join (${res?.error})`);
        socket.disconnect();
        return;
      }
      joined += 1;
      if (joined === count) console.log(`All ${count} bots joined room ${code}.`);
    });
  });

  socket.on('player:state', (state) => {
    if (state.phase !== 'question' || state.me.answered || answeredFor.has(state.qIndex)) return;
    answeredFor.add(state.qIndex);
    const window = maxDelay ?? Math.max(400, state.question.remainingMs * 0.7);
    const delay = 300 + Math.random() * window;
    setTimeout(() => {
      socket.emit('player:answer', { qIndex: state.qIndex, choice: Math.floor(Math.random() * 4) }, () => {});
    }, delay);
  });

  socket.on('room:closed', () => socket.disconnect());
}

const stop = () => {
  for (const s of sockets) s.disconnect();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
