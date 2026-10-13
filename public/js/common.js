// Helpers shared by the player page and the host page.

export const LETTERS = ['A', 'B', 'C', 'D'];

export const ERRORS = {
  invalid_code: 'Room codes are six digits. Check the code on the host’s screen.',
  not_found: 'There’s no live room with that code. Check the code on the host’s screen.',
  locked: 'This room isn’t letting new players in right now. Ask the host to unlock it.',
  finished: 'This quiz has already ended. Ask the host for a new room code.',
  full: 'This room is full. Ask the host to start a new room.',
  name_taken: 'Someone in this room already uses that name. Try another.',
  invalid_name: 'Enter a display name.',
  session_expired: 'Your place in that room has expired. Join again with your name.',
  late: 'Time ran out before your answer reached the host.',
  duplicate: 'You already answered this question.',
  wrong_question: 'That question has closed.',
  not_open: 'The question hasn’t started yet.',
  invalid_choice: 'Pick one of the four answers.',
  rate_limited: 'Too many requests at once. Wait a moment and try again.',
  server_error: 'The server hit a problem. Try again.',
  server_full: 'The server is hosting too many rooms right now. Try again in a few minutes.',
  timeout: 'The server didn’t respond. Check your connection and try again.',
  invalid_quiz: 'Fix the highlighted fields, then create the room again.',
  not_host: 'This tab is no longer hosting the room.',
  bad_phase: 'That step isn’t available right now.',
  no_players: 'Wait for at least one player to join.',
  forbidden: 'This browser isn’t hosting that room.',
  unknown_player: 'That player has already left.',
  not_in_room: 'You’re not in a room any more. Join again.',
  unknown_action: 'That action isn’t supported.',
};

export function errorMessage(code, fallback = ERRORS.server_error) {
  return ERRORS[code] ?? fallback;
}

/* ---------- DOM ---------- */

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value') el.value = value;
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

/* ---------- Icons (static, trusted markup) ---------- */

const ICONS = {
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  cross: '<path d="M6 6l12 12M18 6L6 18"/>',
  alert: '<path d="M12 3.5l9 16.5H3z"/><path d="M12 10v4.5M12 17.4v.1"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.1"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.6-1.7"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 16V5M7 10l5-5 5 5M5 20h14"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a6.2 6.2 0 0 1 3.5 5.8"/>',
  wifiOff: '<path d="M3 3l18 18M8.6 16.4a5 5 0 0 1 6.8 0M5 12.6a10 10 0 0 1 4.2-2.4M19 12.6a10 10 0 0 0-3.1-2M2 9a15 15 0 0 1 4.6-2.9M22 9a15 15 0 0 0-10.4-3.9M12 20v.1"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  flag: '<path d="M5 21V4M5 4h12l-2.5 4L17 12H5"/>',
  leave: '<path d="M14 5h4a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-4M10 16l-4-4 4-4M6 12h10"/>',
  home: '<path d="M4 11l8-7 8 7M6 9.5V20h12V9.5"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>',
};

const SVG_NS = 'http://www.w3.org/2000/svg';

export function icon(name, label) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = ICONS[name] ?? '';
  svg.setAttribute('class', 'icon');
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
  }
  return svg;
}

/* ---------- Formatting ---------- */

export function ordinal(n) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th'}`;
}

export function placeText(rank, tied) {
  return tied ? `tied ${ordinal(rank)}` : ordinal(rank);
}

export function formatNumber(n) {
  return Number(n || 0).toLocaleString('en-US');
}

export function formatCode(code) {
  const c = String(code ?? '');
  return c.length === 6 ? `${c.slice(0, 3)} ${c.slice(3)}` : c;
}

export function initials(name) {
  return Array.from(String(name ?? '').trim())[0]?.toUpperCase() ?? '?';
}

export function plural(n, one, many = `${one}s`) {
  return `${formatNumber(n)} ${n === 1 ? one : many}`;
}

/* ---------- Storage (may be unavailable in private modes) ---------- */

export const store = {
  get(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable: reconnects won't survive a reload */
    }
  },
  del(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

/* ---------- Socket ---------- */

export function connectSocket({ banner, onConnect } = {}) {
  // eslint-disable-next-line no-undef
  const socket = io({ reconnectionDelayMax: 4000, timeout: 10000 });
  let bannerTimer = null;
  socket.on('connect', () => {
    clearTimeout(bannerTimer);
    if (banner) banner.hidden = true;
    onConnect?.();
  });
  const showBanner = () => {
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => {
      if (banner && !socket.connected) banner.hidden = false;
    }, 900);
  };
  socket.on('disconnect', showBanner);
  socket.on('connect_error', showBanner);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && socket.connected) socket.emit('sync', () => {});
  });
  return socket;
}

export function emitAck(socket, event, payload = {}, timeoutMs = 8000) {
  return new Promise((resolve) => {
    socket.timeout(timeoutMs).emit(event, payload, (err, res) => {
      if (err) resolve({ ok: false, error: 'timeout' });
      else resolve(res ?? { ok: false, error: 'server_error' });
    });
  });
}

/* ---------- Busy buttons and toasts ---------- */

export function setBusy(button, busy, busyLabel) {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.dataset.label ?? button.innerHTML;
    button.disabled = true;
    button.classList.add('is-busy');
    button.setAttribute('aria-busy', 'true');
    clear(button, h('span', { class: 'spinner', 'aria-hidden': 'true' }), busyLabel ?? 'Working…');
  } else {
    button.disabled = false;
    button.classList.remove('is-busy');
    button.removeAttribute('aria-busy');
    if (button.dataset.label !== undefined) {
      button.innerHTML = button.dataset.label;
      delete button.dataset.label;
    }
  }
}

let toastRegion;
export function toast(message, ms = 3200) {
  if (!toastRegion) {
    toastRegion = h('div', { class: 'toast-region', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastRegion);
  }
  const t = h('div', { class: 'toast', text: message });
  toastRegion.append(t);
  setTimeout(() => t.remove(), ms);
}

/* ---------- Countdown ring ---------- */

const RING_R = 42;
const RING_C = 2 * Math.PI * RING_R;

export function createTimer({ totalMs, remainingMs, large = false, onExpire }) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('aria-hidden', 'true');
  const track = document.createElementNS(SVG_NS, 'circle');
  const fill = document.createElementNS(SVG_NS, 'circle');
  for (const c of [track, fill]) {
    c.setAttribute('cx', '50');
    c.setAttribute('cy', '50');
    c.setAttribute('r', String(RING_R));
    c.setAttribute('fill', 'none');
    c.setAttribute('stroke-width', '9');
  }
  track.setAttribute('class', 'track');
  fill.setAttribute('class', 'fill');
  fill.setAttribute('stroke-dasharray', String(RING_C));
  svg.append(track, fill);

  const num = h('span', { class: 'timer-num' });
  const announcer = h('span', { class: 'visually-hidden', 'aria-live': 'polite' });
  const el = h('div', { class: `timer${large ? ' timer-lg' : ''}`, role: 'timer', 'aria-label': 'Time left' }, svg, num, announcer);

  let deadline = performance.now() + remainingMs;
  let lastSecs = null;
  let frame = null;
  let expired = false;

  const tick = () => {
    const rem = Math.max(0, deadline - performance.now());
    const frac = totalMs > 0 ? rem / totalMs : 0;
    fill.setAttribute('stroke-dashoffset', String(RING_C * (1 - frac)));
    const secs = Math.ceil(rem / 1000);
    if (secs !== lastSecs) {
      lastSecs = secs;
      num.textContent = String(secs);
      el.setAttribute('aria-label', `${secs} seconds left`);
      el.classList.toggle('is-urgent', secs <= 5 && secs > 0);
      if ((secs === 10 && totalMs > 15000) || secs === 5) announcer.textContent = `${secs} seconds left`;
    }
    if (rem <= 0) {
      if (!expired) {
        expired = true;
        el.classList.remove('is-urgent');
        onExpire?.();
      }
      frame = null;
      return;
    }
    frame = requestAnimationFrame(tick);
  };
  tick();

  return {
    el,
    sync(ms) {
      const next = performance.now() + ms;
      if (Math.abs(next - deadline) > 300) {
        deadline = next;
        if (!frame && ms > 0) {
          expired = false;
          tick();
        }
      }
    },
    stop() {
      if (frame) cancelAnimationFrame(frame);
      frame = null;
    },
  };
}

/* ---------- Answer tiles ---------- */

/**
 * Static (non-interactive) tiles. Options:
 *  correct   index of the correct answer once revealed
 *  chosen    index the viewer picked
 *  counts    per-answer counts (shown when revealed)
 */
export function answerTiles(choices, { correct = null, chosen = null, counts = null, lockedIn = false } = {}) {
  const revealed = correct !== null && correct !== undefined;
  const total = counts ? counts.reduce((a, b) => a + b, 0) : 0;
  const list = h('ol', {
    class: `answers${revealed ? ' is-revealed' : ''}${lockedIn && !revealed ? ' is-locked' : ''}`,
  });
  choices.forEach((text, i) => {
    const isCorrect = revealed && i === correct;
    const isChosen = chosen === i;
    const flags = [];
    if (isCorrect) flags.push(h('span', { class: 'answer-flag' }, icon('check'), 'Correct'));
    if (isChosen && (!revealed || !isCorrect)) {
      flags.push(h('span', { class: 'answer-flag' }, revealed ? icon('cross') : icon('check'), 'Your answer'));
    } else if (isChosen && isCorrect) {
      flags.push(h('span', { class: 'visually-hidden' }, ', your answer'));
    }
    let count = null;
    if (revealed && counts) {
      const pct = total ? Math.round((counts[i] / total) * 100) : 0;
      const bar = h('span', { class: 'bar', 'aria-hidden': 'true' }, h('span'));
      bar.firstChild.style.width = `${pct}%`;
      count = h('span', { class: 'answer-count' },
        h('span', {}, formatNumber(counts[i]), h('span', { class: 'visually-hidden' }, counts[i] === 1 ? ' player' : ' players')),
        bar);
    }
    list.append(h('li', {},
      h('div', {
        class: `answer${isCorrect ? ' is-correct' : ''}${isChosen && !revealed ? ' is-selected' : ''}`,
        dataset: { letter: LETTERS[i] },
      },
      h('span', { class: 'letter', 'aria-hidden': 'true' }, LETTERS[i]),
      h('span', { class: 'answer-text' }, h('span', { class: 'visually-hidden' }, `${LETTERS[i]}: `), text),
      flags.length || count ? h('span', { class: 'answer-side' }, flags, count) : null)));
  });
  return list;
}

/* ---------- Standings ---------- */

function row(entry, { meId, showRound }) {
  const isMe = entry.id === meId;
  const sub = [];
  if (isMe) sub.push('You');
  if (entry.tied) sub.push('Tied');
  return h('li', { class: `row${isMe ? ' is-me' : ''}`, dataset: { playerId: entry.id } },
    h('span', { class: 'rank', 'aria-hidden': 'true' }, entry.rank),
    h('span', { class: 'row-name' },
      h('span', { class: 'visually-hidden' }, `${placeText(entry.rank, entry.tied)}: `),
      entry.name,
      sub.length ? h('small', {}, sub.join(', ')) : null),
    h('span', { class: 'row-score' },
      formatNumber(entry.score),
      h('span', { class: 'visually-hidden' }, ' points'),
      showRound && entry.roundPoints !== null && entry.roundPoints !== undefined
        ? h('small', {}, `+${formatNumber(entry.roundPoints)} this round`)
        : null));
}

export function standingsBoards(summary, { meId = null, showRound = true, showTop = true, bottomNote = null } = {}) {
  const wrap = h('div', { class: 'boards' });
  if (!summary || summary.total === 0) {
    wrap.append(h('div', { class: 'empty' }, h('strong', {}, 'No players in this room'), 'Standings appear once people join and answer.'));
    return wrap;
  }
  const top = h('section', { class: 'board board-top', 'aria-labelledby': 'board-top-h' },
    h('h2', { id: 'board-top-h' }, summary.top.length === 3 ? 'Top three' : `Top ${summary.top.length}`,
      summary.everyoneShown ? h('small', {}, `All ${plural(summary.total, 'player')} shown`) : null),
    h('ol', {}, summary.top.map((e) => row(e, { meId, showRound }))));
  if (summary.topTiedHidden > 0) {
    top.append(h('p', { class: 'board-note' },
      `${plural(summary.topTiedHidden, 'more player')} ${summary.topTiedHidden === 1 ? 'is' : 'are'} tied for ${ordinal(summary.top.at(-1).rank)}.`));
  }
  if (showTop) wrap.append(top);
  if (summary.bottom.length) {
    const label = summary.bottom.length === 3 ? 'Bottom three' : `Bottom ${summary.bottom.length}`;
    const bottom = h('section', { class: 'board board-bottom', 'aria-labelledby': 'board-bottom-h' },
      h('h2', { id: 'board-bottom-h' }, label, bottomNote ? h('small', {}, bottomNote) : null),
      h('ol', {}, summary.bottom.map((e) => row(e, { meId, showRound }))));
    if (summary.bottomTiedHidden > 0) {
      bottom.append(h('p', { class: 'board-note' },
        `${plural(summary.bottomTiedHidden, 'more player')} ${summary.bottomTiedHidden === 1 ? 'shares' : 'share'} ${ordinal(summary.bottom[0].rank)} place.`));
    }
    wrap.append(bottom);
  }
  return wrap;
}

export function podiumNote(summary) {
  if (!summary?.topTiedHidden) return null;
  const last = summary.top.at(-1);
  return h('p', { class: 'podium-note' },
    `${last.name} shares ${ordinal(last.rank)} place with ${plural(summary.topTiedHidden, 'other player')}.`);
}

export function podium(top) {
  const wrap = h('ol', { class: 'podium', 'aria-label': 'Podium' });
  const order = [1, 0, 2]; // second, first, third
  for (const idx of order) {
    const entry = top[idx];
    const place = idx + 1;
    if (!entry) {
      wrap.append(h('li', { class: 'podium-place is-empty', dataset: { place } },
        h('span', { class: 'podium-name', 'aria-hidden': 'true' }, ' '),
        h('span', { class: 'podium-block', 'aria-hidden': 'true' }, place)));
      continue;
    }
    wrap.append(h('li', { class: 'podium-place', dataset: { place } },
      h('span', { class: 'visually-hidden' }, `${placeText(entry.rank, entry.tied)}: `),
      h('span', { class: 'podium-name' }, entry.name),
      h('span', { class: 'podium-score' }, `${formatNumber(entry.score)} pts`),
      h('span', { class: 'podium-block', 'aria-hidden': 'true' }, entry.rank)));
  }
  return wrap;
}

export function brandMark() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = '<path fill="currentColor" d="M5 27C5 14 13 6 27.5 4.5 26.5 19 18 27 5 27z"/><path d="M6.5 25.5 19 13" stroke="#fff" stroke-width="2" stroke-linecap="round" fill="none" opacity=".75"/>';
  return svg;
}
