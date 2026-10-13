// Usage page: live players and rooms, totals since the server started, and
// an hourly traffic chart for the last 24 hours. Refreshes every 10 seconds.
import { brandMark, clear, formatNumber, h, icon, plural } from './common.js';

const REFRESH_MS = 10_000;
const SVG_NS = 'http://www.w3.org/2000/svg';

const METRICS = {
  visitors: { label: 'Visitors', one: 'visitor', many: 'visitors' },
  pageViews: { label: 'Page views', one: 'page view', many: 'page views' },
  playersJoined: { label: 'Players joined', one: 'player joined', many: 'players joined' },
  gamesStarted: { label: 'Games started', one: 'game started', many: 'games started' },
};

const root = document.getElementById('stats');
const meta = document.getElementById('meta');
document.getElementById('brand-mark').replaceWith(brandMark());

const key = new URLSearchParams(location.search).get('key');
const state = { data: null, metric: 'visitors', error: null, built: false, view: {} };

/* ---------- Formatting ---------- */

const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function ago(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'less than a minute';
  if (mins < 60) return plural(mins, 'minute');
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest ? `${plural(hours, 'hour')} ${plural(rest, 'minute')}` : plural(hours, 'hour');
}

function niceMax(max) {
  if (max <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (step * pow >= max) return step * pow;
  }
  return 10 * pow;
}

const compact = (n) => (n >= 1000 ? `${Math.round(n / 100) / 10}K` : String(n));

/* ---------- Loading ---------- */

async function load() {
  try {
    const res = await fetch(`/api/stats${key ? `?key=${encodeURIComponent(key)}` : ''}`, { cache: 'no-store' });
    if (res.status === 401) {
      renderLocked();
      return;
    }
    if (!res.ok) throw new Error(String(res.status));
    state.data = await res.json();
    state.error = null;
  } catch {
    state.error = 'Couldn’t reach the server. Showing the last numbers; retrying.';
  }
  if (state.data) render();
  else renderError();
}

function renderLocked() {
  root.removeAttribute('aria-busy');
  clear(root, h('div', { class: 'status-block' },
    h('h1', {}, 'Usage is locked'),
    h('p', { class: 'lead' }, 'This server has a stats key. Open this page with the key added to the address, like /stats?key=your-key.')));
}

function renderError() {
  root.removeAttribute('aria-busy');
  clear(root, h('div', { class: 'status-block' },
    h('h1', {}, 'Usage isn’t available'),
    h('p', { class: 'lead' }, state.error)));
}

/* ---------- Page ---------- */

function tile(label, value, note, extra = '') {
  return h('div', { class: `tile ${extra}` },
    h('dt', {}, label),
    h('dd', {}, h('span', { class: 'tile-value' }, value), note ? h('span', { class: 'tile-note' }, note) : null));
}

function build() {
  const v = state.view;
  v.lead = h('p', { class: 'lead' });
  v.error = h('div', { class: 'notice', role: 'status', hidden: true });
  v.now = h('dl', { class: 'tile-grid tile-grid-live' });
  v.totals = h('dl', { class: 'tile-grid' });
  v.peak = h('p', { class: 'help' });
  v.chart = h('div', { class: 'chart' });
  v.tip = h('div', { class: 'chart-tip', hidden: true, role: 'status', 'aria-live': 'polite' });
  v.chartTitle = h('h2', { id: 'chart-h' });
  v.chartSub = h('p', { class: 'help' });
  v.table = h('table', { class: 'results-table' });
  v.seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Chart metric' },
    Object.entries(METRICS).map(([id, m]) => h('button', {
      type: 'button',
      class: 'seg-btn',
      'aria-pressed': String(id === state.metric),
      dataset: { metric: id },
      onclick: () => {
        state.metric = id;
        v.seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.metric === id)));
        renderChart();
      },
    }, m.label)));

  root.removeAttribute('aria-busy');
  clear(root,
    h('div', { class: 'stage-title' }, h('h1', {}, 'Usage')),
    v.lead,
    v.error,
    h('section', { class: 'stats-section', 'aria-labelledby': 'now-h' },
      h('h2', { id: 'now-h' }, h('span', { class: 'live-dot', 'aria-hidden': 'true' }), 'Right now'),
      v.now),
    h('section', { class: 'stats-section', 'aria-labelledby': 'totals-h' },
      h('h2', { id: 'totals-h' }, 'Since the server started'),
      v.totals,
      v.peak),
    h('section', { class: 'stats-section', 'aria-labelledby': 'chart-h' },
      h('div', { class: 'chart-head' }, h('div', {}, v.chartTitle, v.chartSub), v.seg),
      h('div', { class: 'chart-wrap' }, v.chart, v.tip),
      h('details', { class: 'full-results' }, h('summary', {}, 'Show as a table'), v.table)),
    h('div', { class: 'notice notice-soft' }, icon('info'),
      h('span', {}, 'Counts start over whenever the server restarts or redeploys. On Render’s free plan it also sleeps after about 15 minutes with no visitors, so read these as “since it last woke up”. Visitors are counted by an anonymous browser fingerprint that is never stored with names or IP addresses.')));
  state.built = true;
}

function render() {
  if (!state.built) build();
  const d = state.data;
  const v = state.view;
  const live = d.live;
  const totals = d.totals;

  clear(meta, h('span', { class: 'pill' }, `Updated ${clock(d.now)}`));
  v.lead.textContent = `Counting since the server started at ${clock(d.startedAt)}, ${ago(d.now - d.startedAt)} ago.`;
  v.error.hidden = !state.error;
  if (state.error) clear(v.error, icon('wifiOff'), h('span', {}, state.error));

  clear(v.now,
    tile('Players online', formatNumber(live.playersOnline),
      live.playersInRooms > live.playersOnline ? `${formatNumber(live.playersInRooms - live.playersOnline)} more away` : null, 'tile-hero'),
    tile('Rooms open', formatNumber(live.roomsOpen), live.roomsInLobby ? `${formatNumber(live.roomsInLobby)} waiting to start` : null),
    tile('Games in progress', formatNumber(live.gamesInProgress)),
    tile('Hosts online', formatNumber(live.hostsOnline)));

  clear(v.totals,
    tile('Visitors', formatNumber(totals.uniqueVisitors), 'different people'),
    tile('Page views', formatNumber(totals.pageViews)),
    tile('Players joined', formatNumber(totals.playersJoined)),
    tile('Rooms created', formatNumber(totals.roomsCreated)),
    tile('Games finished', formatNumber(totals.gamesFinished), `${formatNumber(totals.gamesStarted)} started`),
    tile('Answers', formatNumber(totals.answers)));

  v.peak.textContent = d.peak.players
    ? `Most players online at once: ${formatNumber(d.peak.players)}, at ${clock(d.peak.at)}.`
    : 'No players have joined since the server started.';

  renderChart();
}

/* ---------- Chart ---------- */

function svg(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, val] of Object.entries(attrs)) el.setAttribute(k, String(val));
  return el;
}

// Column with a 4px rounded top and a square base.
function columnPath(x, y, w, hgt) {
  const r = Math.min(4, w / 2, hgt);
  const base = y + hgt;
  return `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${base}Z`;
}

function renderChart() {
  const v = state.view;
  const d = state.data;
  if (!d) return;
  const m = METRICS[state.metric];
  const hours = d.hourly;
  const values = hours.map((x) => x[state.metric]);
  const total = values.reduce((a, b) => a + b, 0);
  v.chartTitle.textContent = `${m.label} per hour`;
  v.chartSub.textContent = state.metric === 'visitors'
    ? 'Last 24 hours. Someone who visits in two different hours counts in both.'
    : `Last 24 hours, ${plural(total, m.one, m.many)} in total.`;

  const width = Math.max(300, v.chart.clientWidth || 640);
  const height = 220;
  const pad = { top: 12, right: 6, bottom: 26, left: 34 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = niceMax(Math.max(...values, 0));
  const band = innerW / hours.length;
  const barW = Math.min(24, Math.max(3, band - 2));
  const yOf = (val) => pad.top + innerH - (val / max) * innerH;

  const chart = svg('svg', {
    width, height, viewBox: `0 0 ${width} ${height}`, role: 'img',
    'aria-label': `${m.label} per hour for the last 24 hours. ${plural(total, m.one, m.many)} in total; the table below lists every hour.`,
  });

  for (const tick of [0, max / 2, max]) {
    const y = yOf(tick);
    chart.append(svg('line', { x1: pad.left, x2: width - pad.right, y1: y, y2: y, class: tick === 0 ? 'axis' : 'grid' }));
    const label = svg('text', { x: pad.left - 8, y: y + 4, class: 'tick', 'text-anchor': 'end' });
    label.textContent = compact(Math.round(tick * 10) / 10);
    chart.append(label);
  }

  const labelEvery = innerW < 420 ? 6 : 3;
  hours.forEach((hr, i) => {
    const x0 = pad.left + i * band;
    const val = values[i];
    if (hr.tracked && val > 0) {
      const top = yOf(val);
      chart.append(svg('path', { d: columnPath(x0 + (band - barW) / 2, top, barW, pad.top + innerH - top), class: 'bar' }));
    } else if (!hr.tracked) {
      chart.append(svg('line', { x1: x0 + band / 2 - 2, x2: x0 + band / 2 + 2, y1: pad.top + innerH - 3, y2: pad.top + innerH - 3, class: 'untracked' }));
    }
    if (i % labelEvery === 0 || i === hours.length - 1) {
      const t = svg('text', { x: x0 + band / 2, y: height - 8, class: 'tick', 'text-anchor': 'middle' });
      t.textContent = new Date(hr.start).getHours().toString().padStart(2, '0');
      chart.append(t);
    }
    // Generous hit area: the whole column of the band.
    const hit = svg('rect', { x: x0, y: pad.top, width: band, height: innerH, class: 'hit' });
    const show = () => {
      const from = clock(hr.start);
      const to = clock(hr.start + 3600000);
      v.tip.textContent = hr.tracked
        ? `${from} to ${to}: ${plural(val, m.one, m.many)}`
        : `${from} to ${to}: before the server started`;
      v.tip.hidden = false;
      const left = Math.min(Math.max(x0 + band / 2, 70), width - 70);
      v.tip.style.left = `${left}px`;
      v.tip.style.top = `${Math.max(0, (hr.tracked && val > 0 ? yOf(val) : pad.top + innerH) - 44)}px`;
      chart.querySelectorAll('.bar-active').forEach((el) => el.classList.remove('bar-active'));
      hit.classList.add('bar-active');
    };
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('pointerdown', show);
    chart.append(hit);
  });
  chart.addEventListener('pointerleave', () => {
    v.tip.hidden = true;
    chart.querySelectorAll('.bar-active').forEach((el) => el.classList.remove('bar-active'));
  });
  v.chart.replaceChildren(chart);

  clear(v.table,
    h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Hour'), h('th', { scope: 'col', class: 'num' }, m.label))),
    h('tbody', {}, [...hours].reverse().map((hr) => h('tr', {},
      h('td', {}, `${clock(hr.start)} to ${clock(hr.start + 3600000)}`),
      h('td', { class: 'num' }, hr.tracked ? formatNumber(hr[state.metric]) : 'not tracked')))));
}

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderChart, 150);
});

load();
setInterval(() => {
  if (document.visibilityState === 'visible') load();
}, REFRESH_MS);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') load();
});
