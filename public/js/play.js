// Participant page: join a room, answer questions, see results.
import {
  answerTiles, brandMark, clear, connectSocket, createTimer, emitAck, errorMessage, formatCode,
  formatNumber, h, icon, initials, LETTERS, ordinal, placeText, plural, podium, podiumNote, setBusy,
  standingsBoards, store, toast,
} from './common.js';
import { ROOM_CODE_PATTERN, validateName } from './rules.js';

const $ = (id) => document.getElementById(id);
const els = {
  joinView: $('view-join'),
  gameView: $('view-game'),
  form: $('join-form'),
  code: $('code'),
  name: $('name'),
  codeError: $('code-error'),
  nameError: $('name-error'),
  formError: $('form-error'),
  roomInfo: $('room-info'),
  notice: $('join-notice'),
  joinBtn: $('join-btn'),
  meta: $('meta'),
  conn: $('conn'),
};
$('brand-mark').replaceWith(brandMark());

const credKey = (code) => `grove:player:${code}`;

const app = {
  code: null,
  playerId: null,
  token: null,
  name: null,
  state: null,
  viewKey: null,
  timer: null,
  answering: false,
  stopped: false,
  view: {},
};

const socket = connectSocket({
  banner: els.conn,
  onConnect: () => {
    if (app.playerId && !app.stopped) rejoin();
  },
});

/* ---------- Join form ---------- */

function codeFromInput(value) {
  const text = String(value ?? '');
  const fromLink = text.match(/join\/(\d{6})/);
  if (fromLink) return fromLink[1];
  return text.replace(/\D/g, '').slice(0, 6);
}

function showFieldError(input, errorEl, message) {
  if (message) {
    clear(errorEl, icon('alert'), message);
    errorEl.hidden = false;
    input.setAttribute('aria-invalid', 'true');
  } else {
    errorEl.hidden = true;
    errorEl.replaceChildren();
    input.removeAttribute('aria-invalid');
  }
}

function showFormError(message) {
  if (message) {
    clear(els.formError, icon('alert'), message);
    els.formError.hidden = false;
  } else {
    els.formError.hidden = true;
  }
}

function showNotice(message) {
  if (message) {
    clear(els.notice, icon('info'), h('span', {}, message));
    els.notice.hidden = false;
  } else {
    els.notice.hidden = true;
  }
}

let lookupSeq = 0;
async function lookupRoom(code) {
  const seq = ++lookupSeq;
  els.roomInfo.hidden = true;
  if (!ROOM_CODE_PATTERN.test(code)) return null;
  try {
    const res = await fetch(`/api/rooms/${code}`, { cache: 'no-store' });
    const data = await res.json();
    if (seq !== lookupSeq) return null;
    if (!res.ok || !data.ok) {
      showFieldError(els.code, els.codeError, errorMessage(data.error ?? 'not_found'));
      return data;
    }
    if (!data.accepting) {
      showFieldError(els.code, els.codeError, errorMessage(data.reason));
      return data;
    }
    showFieldError(els.code, els.codeError, null);
    clear(els.roomInfo, icon('check'),
      h('span', {}, 'Room found: ', h('strong', {}, data.title), `. ${plural(data.playerCount, 'player')} in so far.`));
    els.roomInfo.hidden = false;
    return data;
  } catch {
    return null;
  }
}

let lookupTimer = null;
els.code.addEventListener('input', () => {
  const code = codeFromInput(els.code.value);
  const formatted = code.length > 3 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
  if (els.code.value !== formatted) els.code.value = formatted;
  showFieldError(els.code, els.codeError, null);
  showFormError(null);
  clearTimeout(lookupTimer);
  els.roomInfo.hidden = true;
  if (code.length === 6) lookupTimer = setTimeout(() => lookupRoom(code), 250);
});

els.name.addEventListener('input', () => {
  showFieldError(els.name, els.nameError, null);
  showFormError(null);
});

els.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  showFormError(null);
  showNotice(null);
  const code = codeFromInput(els.code.value);
  const nameCheck = validateName(els.name.value);
  let firstInvalid = null;
  if (!ROOM_CODE_PATTERN.test(code)) {
    showFieldError(els.code, els.codeError, code ? errorMessage('invalid_code') : 'Enter the six-digit room code.');
    firstInvalid = els.code;
  }
  if (!nameCheck.ok) {
    showFieldError(els.name, els.nameError, nameCheck.error);
    firstInvalid ??= els.name;
  }
  if (firstInvalid) {
    firstInvalid.focus();
    return;
  }
  if (!socket.connected) {
    showFormError('Not connected to the server yet. Check your connection; we’ll keep trying.');
    return;
  }
  setBusy(els.joinBtn, true, 'Joining…');
  const res = await emitAck(socket, 'player:join', { code, name: nameCheck.name });
  setBusy(els.joinBtn, false);
  if (!res.ok) {
    const message = res.message ?? errorMessage(res.error);
    if (['invalid_code', 'not_found', 'locked', 'finished', 'full'].includes(res.error)) {
      showFieldError(els.code, els.codeError, message);
      els.code.focus();
    } else if (['name_taken', 'invalid_name'].includes(res.error)) {
      showFieldError(els.name, els.nameError, message);
      els.name.focus();
    } else {
      showFormError(message);
    }
    return;
  }
  store.set('grove:lastName', res.name);
  startSession({ code: res.code, playerId: res.playerId, token: res.token, name: res.name });
});

function startSession({ code, playerId, token, name }) {
  Object.assign(app, { code, playerId, token, name, stopped: false });
  store.set(credKey(code), { playerId, token, name });
  if (location.pathname !== `/join/${code}`) history.replaceState(null, '', `/join/${code}`);
  showGame();
  if (!app.state) renderLoading('Joining the room…');
}

async function rejoin() {
  const res = await emitAck(socket, 'player:rejoin', { code: app.code, playerId: app.playerId, token: app.token });
  if (res.ok) return;
  if (res.error === 'timeout') return; // still offline; the next connect retries
  endSession();
  showJoin(errorMessage(res.error === 'not_found' ? 'not_found' : 'session_expired'));
}

function endSession() {
  if (app.code) store.del(credKey(app.code));
  app.timer?.stop();
  Object.assign(app, { playerId: null, token: null, state: null, viewKey: null, timer: null });
  els.meta.replaceChildren();
}

function showJoin(message) {
  els.gameView.hidden = true;
  els.joinView.hidden = false;
  document.title = 'Join a quiz | Grove';
  if (message) showNotice(message);
  if (app.code) els.code.value = formatCode(app.code);
  els.name.value ||= store.get('grove:lastName') ?? '';
  (els.code.value ? els.name : els.code).focus();
}

function showGame() {
  els.joinView.hidden = true;
  els.gameView.hidden = false;
}

/* ---------- Server events ---------- */

socket.on('player:state', (state) => {
  if (app.stopped) return;
  app.state = state;
  render(state);
});

socket.on('player:removed', () => {
  endSession();
  showJoin('The host removed you from this room. You can join again with a different name if the host allows it.');
});

socket.on('player:replaced', () => {
  app.stopped = true;
  app.timer?.stop();
  app.viewKey = null;
  showGame();
  clear(els.gameView, h('div', { class: 'status-block' },
    h('h1', { tabindex: '-1' }, 'Playing somewhere else'),
    h('p', { class: 'lead' }, 'You opened this game in another tab or on another device, so this one has paused.'),
    h('button', {
      class: 'btn btn-primary btn-lg',
      type: 'button',
      onclick: () => {
        app.stopped = false;
        renderLoading('Moving the game to this tab…');
        rejoin();
      },
    }, 'Play here instead')));
});

socket.on('room:closed', ({ reason } = {}) => {
  const code = app.code;
  endSession();
  app.code = code;
  showGame();
  clear(els.gameView, h('div', { class: 'status-block' },
    h('h1', { tabindex: '-1' }, reason === 'expired' ? 'This room has expired' : 'The host closed this room'),
    h('p', { class: 'lead' }, 'Thanks for playing. Ask the host for a new room code to play again.'),
    h('a', { class: 'btn btn-primary btn-lg', href: '/' }, 'Join another game')));
  els.gameView.querySelector('h1').focus();
});

/* ---------- Rendering ---------- */

function renderLoading(text) {
  app.viewKey = 'loading';
  clear(els.gameView, h('div', { class: 'status-block', 'aria-busy': 'true' },
    h('span', { class: 'spinner', 'aria-hidden': 'true' }),
    h('p', { class: 'lead', role: 'status' }, text)));
}

function renderMeta(state) {
  const items = [h('span', { class: 'pill' }, h('span', { class: 'hide-sm' }, 'Room '), h('strong', {}, formatCode(state.code)))];
  if (state.qIndex >= 0) {
    items.push(h('span', { class: 'pill' }, h('strong', {}, formatNumber(state.me.score)), ' pts'));
  }
  clear(els.meta, items);
}

function hostAwayNotice(state) {
  if (state.hostConnected) return null;
  return h('div', { class: 'notice notice-soft', role: 'status' }, icon('wifiOff'),
    h('span', {}, 'The host’s screen lost its connection. Stay here; the game continues when they’re back.'));
}

function progress(state) {
  const pct = ((state.qIndex + 1) / state.questionCount) * 100;
  const fill = h('div', { class: 'progress-fill' });
  fill.style.width = `${pct}%`;
  return h('div', {},
    h('p', { class: 'q-progress' }, `Question ${state.qIndex + 1} of ${state.questionCount}`),
    h('div', {
      class: 'progress-track',
      role: 'progressbar',
      'aria-label': 'Quiz progress',
      'aria-valuemin': '0',
      'aria-valuemax': String(state.questionCount),
      'aria-valuenow': String(state.qIndex + 1),
    }, fill));
}

function render(state) {
  showGame();
  renderMeta(state);
  document.title = `${state.title} | Grove`;
  const key = `${state.phase}:${state.qIndex}`;
  if (key !== app.viewKey) {
    app.timer?.stop();
    app.timer = null;
    app.view = {};
    app.answering = false;
    app.viewKey = key;
    const builders = { lobby: buildLobby, question: buildQuestion, locked: buildLocked, reveal: buildReveal, standings: buildStandings, final: buildFinal };
    (builders[state.phase] ?? buildLobby)(state);
    const heading = els.gameView.querySelector('h1');
    if (heading) {
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: false });
    }
  }
  update(state);
}

function update(state) {
  const v = app.view;
  if (v.hostAway) {
    const notice = hostAwayNotice(state);
    v.hostAway.replaceChildren(...(notice ? [notice] : []));
  }
  if (v.playerCount) v.playerCount.textContent = `${plural(state.playerCount, 'player')} in the room`;
  if (state.phase === 'question' && app.timer) app.timer.sync(state.question.remainingMs);
}

function buildLobby(state) {
  const v = app.view;
  v.hostAway = h('div');
  v.playerCount = h('p', { class: 'help', role: 'status' });
  clear(els.gameView, h('div', { class: 'player-view' },
    v.hostAway,
    h('div', { class: 'status-block' },
      h('h1', {}, 'You’re in!'),
      h('span', { class: 'name-tag' }, h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(state.me.name)), h('span', {}, state.me.name)),
      h('p', { class: 'lead' }, `Waiting for the host to start “${state.title}”.`),
      h('span', { class: 'waiting-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
      v.playerCount),
    h('div', { class: 'notice notice-soft' }, icon('info'),
      h('span', {}, 'Keep this page open. Each question appears here automatically, with four answers to tap.')),
    h('button', { class: 'btn btn-ghost', type: 'button', onclick: leave }, icon('leave'), 'Leave game')));
}

async function leave() {
  if (!window.confirm('Leave this game? Your score will be removed.')) return;
  await emitAck(socket, 'player:leave');
  const code = app.code;
  endSession();
  app.code = code;
  showJoin('You left the game.');
}

function buildQuestion(state) {
  const v = app.view;
  const q = state.question;
  v.hostAway = h('div');
  v.status = h('p', { class: 'answer-status', role: 'status', 'aria-live': 'polite' });
  app.timer = createTimer({
    totalMs: q.timeLimit * 1000,
    remainingMs: q.remainingMs,
    onExpire: () => {
      if (!v.locked) {
        lockButtons(null);
        setStatus('clock', 'Time’s up. Waiting for the host…');
      }
    },
  });

  const answered = state.me.answered;
  v.buttons = q.choices.map((text, i) => h('button', {
    class: 'answer',
    type: 'button',
    dataset: { letter: LETTERS[i] },
    'aria-label': `${LETTERS[i]}: ${text}`,
    onclick: () => submitAnswer(state, i),
  }, h('span', { class: 'letter', 'aria-hidden': 'true' }, LETTERS[i]), h('span', { class: 'answer-text' }, text)));
  v.list = h('ol', { class: 'answers' }, v.buttons.map((b) => h('li', {}, b)));

  clear(els.gameView, h('div', { class: 'player-view' },
    v.hostAway,
    h('div', { class: 'q-meta' }, progress(state), app.timer.el),
    h('h1', { class: 'q-text' }, q.text),
    v.list,
    v.status));

  if (answered) {
    lockButtons(state.me.choice);
    setStatus('check', `Answer ${LETTERS[state.me.choice]} locked in. Waiting for everyone else…`);
  } else {
    setStatus('clock', 'Tap an answer. Faster correct answers earn more points.');
  }
}

function setStatus(iconName, text) {
  clear(app.view.status, icon(iconName), h('span', {}, text));
}

function lockButtons(choice) {
  const v = app.view;
  v.locked = true;
  v.list.classList.add('is-locked');
  v.buttons.forEach((b, i) => {
    b.disabled = true;
    b.classList.toggle('is-selected', i === choice);
    if (i === choice) b.setAttribute('aria-label', `${b.getAttribute('aria-label')}, your answer`);
  });
}

function unlockButtons() {
  const v = app.view;
  v.locked = false;
  v.list.classList.remove('is-locked');
  v.buttons.forEach((b) => {
    b.disabled = false;
    b.classList.remove('is-selected');
    b.setAttribute('aria-label', b.getAttribute('aria-label').replace(', your answer', ''));
  });
}

async function submitAnswer(state, choice) {
  if (app.answering || app.view.locked) return;
  app.answering = true;
  const key = app.viewKey;
  lockButtons(choice);
  setStatus('clock', `Sending answer ${LETTERS[choice]}…`);
  const res = await emitAck(socket, 'player:answer', { qIndex: state.qIndex, choice }, 6000);
  if (app.viewKey !== key) return; // question already moved on
  app.answering = false;
  if (res.ok) {
    navigator.vibrate?.(30);
    setStatus('check', `Answer ${LETTERS[choice]} locked in. Waiting for everyone else…`);
  } else if (res.error === 'duplicate') {
    setStatus('check', 'You already answered this question.');
  } else if (res.error === 'late' || res.error === 'wrong_question') {
    lockButtons(null);
    setStatus('clock', errorMessage(res.error));
  } else {
    unlockButtons();
    setStatus('alert', `${errorMessage(res.error)} Tap an answer to try again.`);
  }
}

function buildLocked(state) {
  const v = app.view;
  const q = state.question;
  v.hostAway = h('div');
  const me = state.me;
  const message = me.answered
    ? h('p', { class: 'answer-status' }, icon('check'), h('span', {}, `Answer ${LETTERS[me.choice]} locked in. The host will reveal the answer next.`))
    : h('p', { class: 'answer-status' }, icon('clock'), h('span', {}, 'Time’s up. No answer from you this round.'));
  clear(els.gameView, h('div', { class: 'player-view' },
    v.hostAway,
    h('div', { class: 'q-meta' }, progress(state)),
    h('h1', { class: 'q-text' }, q.text),
    answerTiles(q.choices, { chosen: me.choice, lockedIn: true }),
    message));
}

function positionLine(state) {
  const me = state.me;
  if (!me.rank) return null;
  return h('dl', { class: 'stat-row' },
    h('div', { class: 'stat' }, h('dt', {}, 'Score'), h('dd', {}, formatNumber(me.score))),
    h('div', { class: 'stat' }, h('dt', {}, 'Position'),
      h('dd', {}, me.tied ? `Tied ${ordinal(me.rank)}` : ordinal(me.rank),
        h('small', { class: 'help' }, ` of ${state.playerCount}`))));
}

function buildReveal(state) {
  const v = app.view;
  const q = state.question;
  const r = state.me.lastRound;
  v.hostAway = h('div');
  let card;
  if (r && r.correct) {
    card = h('section', { class: 'result-card is-correct', 'aria-labelledby': 'result-h' },
      h('span', { class: 'icon' }, icon('check')),
      h('h1', { id: 'result-h' }, 'Correct!'),
      h('p', { class: 'points' }, `+${formatNumber(r.points)} points`),
      h('p', {}, `Answered in ${(r.elapsedMs / 1000).toFixed(1)} seconds.`));
  } else if (r && r.answered) {
    card = h('section', { class: 'result-card is-wrong', 'aria-labelledby': 'result-h' },
      h('span', { class: 'icon' }, icon('cross')),
      h('h1', { id: 'result-h' }, 'Not this time'),
      h('p', {}, `The answer was ${LETTERS[q.correct]}: ${q.choices[q.correct]}.`));
  } else {
    card = h('section', { class: 'result-card is-missed', 'aria-labelledby': 'result-h' },
      h('span', { class: 'icon' }, icon('clock')),
      h('h1', { id: 'result-h' }, 'No answer'),
      h('p', {}, r?.joinedAfterClose
        ? 'You joined after this question closed. You’re in for the next one.'
        : `The answer was ${LETTERS[q.correct]}: ${q.choices[q.correct]}.`));
  }
  clear(els.gameView, h('div', { class: 'player-view' },
    v.hostAway,
    card,
    positionLine(state),
    h('h2', { class: 'visually-hidden' }, 'Answers'),
    answerTiles(q.choices, { correct: q.correct, chosen: r?.choice ?? null, counts: state.distribution })));
}

function myPosition(state, prefix) {
  const me = state.me;
  if (!me.rank) return null;
  return h('div', { class: 'my-position' },
    h('span', {}, prefix, ' ', h('strong', {}, placeText(me.rank, me.tied)), ` of ${state.playerCount}`),
    h('span', {}, `${formatNumber(me.score)} pts`));
}

function buildStandings(state) {
  const v = app.view;
  v.hostAway = h('div');
  clear(els.gameView, h('div', { class: 'player-view' },
    v.hostAway,
    h('div', { class: 'status-block' },
      h('h1', {}, 'Standings'),
      h('p', { class: 'lead' }, `After question ${state.qIndex + 1} of ${state.questionCount}`)),
    myPosition(state, 'You’re'),
    standingsBoards(state.summary, { meId: state.me.id, bottomNote: state.isLast ? null : 'Plenty of time to climb' }),
    h('p', { class: 'answer-status' }, icon('clock'),
      h('span', {}, state.isLast ? 'That was the last question. Final results are next.' : 'Get ready: the next question is coming up.'))));
}

function buildFinal(state) {
  const me = state.me;
  const summary = state.summary;
  const bottom = summary.bottom.length
    ? standingsBoards(summary, { meId: me.id, showRound: false, showTop: false })
    : null;
  clear(els.gameView, h('div', { class: 'player-view' },
    h('div', { class: 'status-block' },
      h('h1', {}, 'Final results'),
      h('p', { class: 'lead' }, state.title)),
    myPosition(state, 'You finished'),
    h('p', { class: 'help' }, `You answered ${me.correctCount} of ${state.questionCount} questions correctly.`),
    podium(summary.top),
    podiumNote(summary),
    bottom,
    h('a', { class: 'btn btn-primary btn-lg btn-block', href: '/', onclick: () => endSession() }, 'Join another game')));
}

/* ---------- Start up ---------- */

function initialCode() {
  const fromPath = location.pathname.match(/^\/join\/(\d{6})\/?$/);
  if (fromPath) return fromPath[1];
  const fromQuery = new URLSearchParams(location.search).get('code');
  return fromQuery ? codeFromInput(fromQuery) : null;
}

function init() {
  const code = initialCode();
  els.name.value = store.get('grove:lastName') ?? '';
  if (!code) {
    els.code.focus();
    return;
  }
  app.code = code;
  els.code.value = formatCode(code);
  const saved = store.get(credKey(code));
  if (saved?.playerId && saved?.token) {
    Object.assign(app, { playerId: saved.playerId, token: saved.token, name: saved.name });
    showGame();
    renderLoading('Reconnecting you to the game…');
    if (socket.connected) rejoin();
    return;
  }
  lookupRoom(code);
  els.name.focus();
}

init();

// Tiny guard so a toast shows if the page is used after a long sleep offline.
window.addEventListener('online', () => toast('Back online.'));
