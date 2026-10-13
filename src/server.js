// HTTP + Socket.IO server for Grove.
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import QRCode from 'qrcode';
import { Server } from 'socket.io';
import { ROOM_CODE_PATTERN } from '../public/js/rules.js';
import { attachRealtime } from './realtime.js';
import { RoomManager } from './rooms.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');

const SAFE_HOST = /^[a-z0-9.\-]+(:\d{1,5})?$|^\[[0-9a-f:]+\](:\d{1,5})?$/i;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

function cleanHost(value) {
  const host = String(value ?? '').split(',')[0].trim();
  return SAFE_HOST.test(host) ? host : 'localhost';
}

function cleanProto(value, fallback) {
  const proto = String(value ?? '').split(',')[0].trim().toLowerCase();
  return proto === 'https' || proto === 'http' ? proto : fallback;
}

export function lanUrls(port) {
  const urls = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) urls.push(`http://${a.address}:${port}`);
    }
  }
  return urls;
}

export function createGroveServer({ publicUrl = process.env.PUBLIC_URL, manager = new RoomManager(), sweepIntervalMs } = {}) {
  const configuredBase = publicUrl ? publicUrl.replace(/\/+$/, '') : null;

  const baseUrlFromParts = (proto, host) => configuredBase ?? `${proto}://${host}`;

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use((req, res, next) => {
    const host = cleanHost(req.get('host'));
    res.set({
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data:",
        "font-src 'self'",
        `connect-src 'self' ws://${host} wss://${host}`,
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join('; '),
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    next();
  });

  app.get('/healthz', (req, res) => {
    res.json({ ok: true, rooms: manager.size });
  });

  app.get('/api/rooms/:code', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const code = req.params.code;
    if (!ROOM_CODE_PATTERN.test(code)) return res.status(400).json({ ok: false, error: 'invalid_code' });
    const room = manager.get(code);
    if (!room) return res.status(404).json({ ok: false, error: 'not_found' });
    const status = room.joinStatus();
    return res.json({
      ok: true,
      code: room.code,
      title: room.quiz.title,
      phase: room.phase,
      accepting: status.accepting,
      reason: status.reason,
      playerCount: room.players.size,
    });
  });

  app.get('/api/rooms/:code/qr.svg', async (req, res, next) => {
    try {
      const room = ROOM_CODE_PATTERN.test(req.params.code) ? manager.get(req.params.code) : null;
      if (!room) return res.status(404).type('text/plain').send('Room not found');
      const base = baseUrlFromParts(req.protocol, cleanHost(req.get('host')));
      const svg = await QRCode.toString(`${base}/join/${room.code}`, {
        type: 'svg',
        errorCorrectionLevel: 'M',
        margin: 2,
        color: { dark: '#0b2a1b', light: '#ffffff' },
      });
      res.set('Cache-Control', 'private, max-age=300');
      return res.type('image/svg+xml').send(svg);
    } catch (err) {
      return next(err);
    }
  });

  // Helps a host running Grove on their own laptop: phones can't open
  // "localhost", so suggest the machine's network address instead.
  app.get('/api/info', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const host = cleanHost(req.get('host'));
    const isLocal = LOCAL_HOST.test(host);
    const port = host.split(':').at(-1);
    res.json({
      publicUrl: configuredBase,
      isLocalHost: isLocal && !configuredBase,
      lanUrls: isLocal && !configuredBase ? lanUrls(/^\d+$/.test(port) ? port : 80) : [],
    });
  });

  const sendPage = (file) => (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(publicDir, file));
  };
  app.get(['/', '/join', '/join/:code'], sendPage('index.html'));
  app.get('/host', sendPage('host.html'));

  app.use('/fonts', express.static(path.join(publicDir, 'fonts'), { maxAge: '7d', immutable: true }));
  app.use(express.static(publicDir, { index: false, maxAge: 0 }));

  app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'not_found' }));
  app.use((req, res) => {
    res.status(404).sendFile(path.join(publicDir, '404.html'));
  });
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[grove] request failed', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  });

  const httpServer = http.createServer(app);
  const io = new Server(httpServer, {
    maxHttpBufferSize: 200_000,
    pingInterval: 10_000,
    pingTimeout: 8_000,
    serveClient: true,
  });

  const realtime = attachRealtime(io, manager, {
    sweepIntervalMs,
    baseUrlForSocket(socket) {
      const headers = socket.handshake.headers;
      const proto = cleanProto(headers['x-forwarded-proto'], socket.handshake.secure ? 'https' : 'http');
      return baseUrlFromParts(proto, cleanHost(headers['x-forwarded-host'] ?? headers.host));
    },
  });

  return {
    app,
    io,
    httpServer,
    manager,
    listen(port = 0, host = '0.0.0.0') {
      return new Promise((resolve) => {
        httpServer.listen(port, host, () => resolve(httpServer.address().port));
      });
    },
    async close() {
      realtime.stop();
      io.close();
      await new Promise((resolve) => httpServer.close(() => resolve()));
    },
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '0.0.0.0';
  const server = createGroveServer();
  server.listen(port, host).then((actualPort) => {
    console.log(`Grove is running at http://localhost:${actualPort}`);
    if (process.env.PUBLIC_URL) {
      console.log(`Join links and QR codes use PUBLIC_URL: ${process.env.PUBLIC_URL}`);
    } else {
      for (const url of lanUrls(actualPort)) console.log(`On your network: ${url}  (open /host from this address so phones can scan the QR code)`);
    }
  });
  const shutdown = () => server.close().finally(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
