# Grove: live multiplayer quizzes

Host a quiz on a big screen; players join from their phones with a QR code or a
six-digit room code and answer in real time. Points reward correct answers and
speed. Standings (top three and bottom three) show after every question and at
the end.

## Run it locally

Requires Node.js 20 or newer.

```bash
npm install
npm start               # http://localhost:3000
```

- Host: open `http://localhost:3000/host`. A sample quiz ("Green Planet",
  6 questions) is preloaded; press **Create room**.
- Players: scan the QR code, or open the site and type the room code.

### Letting phones join on the same Wi-Fi

Phones can't open `localhost`. When you start the server it prints your network
address, for example `http://192.168.1.20:3000`. Open `/host` from that address
(or use the "Move this screen to …" link shown in the lobby, which carries the
room with it) and the QR code will point to an address phones can reach. Your
computer's firewall must allow incoming connections on the port.

### Rehearse with bots

```bash
npm run bots -- http://localhost:3000 <ROOM_CODE> 20
```

Adds 20 simulated players who answer at random.

## How it works

| Piece | Where |
|---|---|
| Game rules (phases, scoring, late/duplicate guards, tie-aware standings) | `src/game.js` |
| Room registry, codes, expiry | `src/rooms.js` |
| Real-time events and per-viewer state | `src/realtime.js` |
| HTTP server, QR endpoint, security headers | `src/server.js` |
| Shared validation (used by browser and server) | `public/js/rules.js` |
| Player page / host page | `public/index.html` + `public/js/play.js`, `public/host.html` + `public/js/host.js` |

- **Real-time state** lives on the server (Socket.IO). Every host and player
  gets a view built for them; the correct answer is never sent to anyone
  (including the host's projector) until the host reveals it.
- **Flow**: lobby → question (countdown) → closed → reveal → standings → next
  question … → final results. The host controls every step. A question closes
  when the timer ends, when every connected player has answered, or when the
  host ends it early.
- **Scoring**: a correct answer earns 500 points plus up to 500 more for speed
  (1000 for an instant answer, 500 on the buzzer). The server timestamps each
  answer; answers after the deadline and second answers are rejected.
- **Ties**: equal scores are split by total time spent on correct answers;
  players still level share a rank. Top three and bottom three never list the
  same person twice; with fewer than six players everyone is shown once, and
  hidden ties at the cut-off are called out.
- **Reconnects**: players and the host keep a token in the browser, so a
  refresh, a dropped connection or a locked phone rejoins the same seat.
  Disconnected players keep their score and are marked "away".
- **Rooms**: up to 250 players each. The host can lock the room, remove
  players and close it. Rooms expire after 3 hours idle, 1 hour after the final
  results, or 30 minutes after the host leaves for good.

## Usage stats

Open `/stats` (for example `https://grove-quiz.onrender.com/stats`) to see
players online, open rooms, games in progress, visitors, page views, players
joined, games played and an hourly traffic chart for the last 24 hours. It
refreshes every 10 seconds and shows counts only: no player names, room codes
or IP addresses.

The page is public but unlinked. To lock it, set a `STATS_KEY` environment
variable on the server and open `/stats?key=<your key>`.

Counts live in memory, so they start over when the server restarts,
redeploys, or (on Render's free plan) sleeps after ~15 minutes without visitors.

## Tests

```bash
npm run check           # syntax check of all server and browser modules
npm test                # unit tests + socket tests with 22 concurrent players
npm run test:e2e        # browser test (Python Playwright + Chromium, opencv-python, numpy)
```

The browser test opens the host screen and four phone-sized browsers, decodes
the QR code from the screen and follows it, adds 18 bots (22 players) and plays
the whole quiz, checking joins, bad codes, duplicate names, room locking,
answer locking, reload-to-rejoin, reveal, standings and final results. Set
`SHOTS_DIR=/some/dir` to save screenshots of each step.

## Deploy

Grove is one Node process with in-memory rooms. Run **exactly one instance**
(no horizontal scaling without adding a shared store) on a host that supports
WebSockets. Behind HTTPS, set `PUBLIC_URL` if join links should use a domain
other than the one the host opens.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind |
| `PUBLIC_URL` | (request host) | Base URL used in join links and QR codes |
| `STATS_KEY` | (unset) | If set, `/stats` requires `?key=` with this value |

**Render**: push this folder to a Git repo, then in Render choose
New › Blueprint and select the repo (`render.yaml` is included). Or create a Web
Service with build `npm ci --omit=dev`, start `node src/server.js`, health
check `/healthz`, 1 instance.

**Fly.io**:

```bash
fly launch --no-deploy     # uses the Dockerfile; accept 1 machine
fly scale count 1
fly deploy
```

**Railway**: `railway init && railway up` (it detects `npm start`).

**Any Docker host**:

```bash
docker build -t grove-quiz .
docker run -p 3000:3000 -e PUBLIC_URL=https://quiz.example.org grove-quiz
```

Free tiers that sleep when idle will drop live rooms when they sleep; keep the
service awake during a game.

## Limits

- Rooms are held in memory: restarting the server ends live games.
- One server instance only (see above).
- Bot answers are random; they're for rehearsal and load testing, not scoring.
