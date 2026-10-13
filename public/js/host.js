// Host page: write a quiz, open a room, run the game on a big screen.
import {
  answerTiles, brandMark, clear, connectSocket, createTimer, emitAck, errorMessage, formatCode,
  formatNumber, h, icon, LETTERS, plural, podium, podiumNote, setBusy, standingsBoards, store, toast,
} from './common.js';
import { LIMITS, TIME_OPTIONS, validateQuiz } from './rules.js';
import { SAMPLE_QUIZ } from './sample-quiz.js';

const DRAFT_KEY = 'grove:draft';
const HOST_KEY = 'grove:host';

const $ = (id) => document.getElementById(id);
const els = {
  loading: $('view-loading'),
  editor: $('view-editor'),
  stage: $('view-stage'),
  meta: $('meta'),
  conn: $('conn'),
};
$('brand-mark').replaceWith(brandMark());

const host = {
  mode: 'editor',
  code: null,
  token: null,
  joinUrl: null,
  state: null,
  viewKey: null,
  timer: null,
  view: {},
  info: null,
  chips: new Map(),
};

/* ---------- Session resume ---------- */

// "#resume=CODE.TOKEN" lets a host move this screen from localhost to the
// computer's network address without losing the room.
(function readResumeFragment() {
  const match = location.hash.match(/^#resume=(\d{6})\.([A-Za-z0-9_-]+)$/);
  if (match) {
    store.set(HOST_KEY, { code: match[1], hostToken: match[2] });
    history.replaceState(null, '', '/host');
  }
}());

const socket = connectSocket({
  banner: els.conn,
  onConnect: () => {
    if (host.code && host.token) resume();
  },
});

async function resume() {
  const res = await emitAck(socket, 'host:rejoin', { code: host.code, hostToken: host.token });
  if (res.ok) {
    host.joinUrl = res.joinUrl;
    if (host.mode !== 'stage') showStage();
    return;
  }
  if (res.error === 'timeout') return;
  store.del(HOST_KEY);
  host.code = null;
  host.token = null;
  showEditor();
  toast(res.error === 'not_found' ? 'Your previous room has ended.' : errorMessage(res.error));
}

/* ---------- Quiz editor ---------- */

const clone = (value) => JSON.parse(JSON.stringify(value));

function blankQuestion() {
  return { text: '', choices: ['', '', '', ''], correct: -1, timeLimit: LIMITS.defaultTime };
}

function coerceQuiz(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const questions = (Array.isArray(source.questions) ? source.questions : []).slice(0, LIMITS.maxQuestions).map((q) => {
    const choices = Array.isArray(q?.choices) ? q.choices.slice(0, 4).map((c) => String(c ?? '')) : [];
    while (choices.length < 4) choices.push('');
    const correct = Number.isInteger(q?.correct) ? q.correct : -1;
    const timeLimit = Number.isInteger(q?.timeLimit) ? q.timeLimit : LIMITS.defaultTime;
    return { text: String(q?.text ?? ''), choices, correct, timeLimit };
  });
  return { title: String(source.title ?? ''), questions };
}

let quiz = coerceQuiz(store.get(DRAFT_KEY) ?? clone(SAMPLE_QUIZ));
if (!quiz.questions.length) quiz = clone(SAMPLE_QUIZ);
let errors = new Map();
let showErrors = false;
let saveTimer = null;

function saveDraft() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.set(DRAFT_KEY, quiz), 300);
}

const fieldId = (path) => `f-${path.replace(/\./g, '-')}`;
const errorId = (path) => `e-${path.replace(/\./g, '-')}`;

function errorSlot(path) {
  return h('p', { class: 'error', id: errorId(path), hidden: true, dataset: { errPath: path } });
}

function validateNow() {
  const result = validateQuiz(quiz);
  errors = new Map();
  for (const e of result.errors) if (!errors.has(e.path)) errors.set(e.path, e.message);
  return result;
}

function refreshErrors() {
  if (!showErrors) return;
  validateNow();
  els.editor.querySelectorAll('[data-err-path]').forEach((el) => {
    const message = errors.get(el.dataset.errPath);
    if (message) {
      clear(el, icon('alert'), message);
      el.hidden = false;
    } else {
      el.hidden = true;
      el.replaceChildren();
    }
  });
  els.editor.querySelectorAll('[data-path]').forEach((el) => {
    if (errors.has(el.dataset.path)) el.setAttribute('aria-invalid', 'true');
    else el.removeAttribute('aria-invalid');
  });
  els.editor.querySelectorAll('.q-card').forEach((card, i) => {
    card.classList.toggle('has-error', [...errors.keys()].some((p) => p.startsWith(`q.${i}.`)));
  });
  renderErrorSummary();
}

function renderErrorSummary() {
  const panel = host.view.errorSummary;
  if (!panel) return;
  if (!showErrors || errors.size === 0) {
    panel.hidden = true;
    return;
  }
  const items = [...errors.entries()].slice(0, 8).map(([path, message]) => {
    const where = path === 'title' ? 'Title' : path === 'questions' ? 'Questions' : `Question ${Number(path.split('.')[1]) + 1}`;
    const target = path === 'questions' ? 'add-question' : fieldId(path);
    return h('li', {}, h('a', {
      href: `#${target}`,
      onclick: (e) => {
        e.preventDefault();
        document.getElementById(target)?.focus();
      },
    }, `${where}: ${message}`));
  });
  const more = errors.size > 8 ? h('li', {}, `and ${errors.size - 8} more`) : null;
  clear(panel,
    h('h2', { id: 'error-summary-h' }, `Fix ${plural(errors.size, 'thing')} before hosting`),
    h('ul', {}, items, more));
  panel.hidden = false;
}

function summaryText() {
  const n = quiz.questions.length;
  const seconds = quiz.questions.reduce((sum, q) => sum + (Number(q.timeLimit) || LIMITS.defaultTime), 0);
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `${plural(n, 'question')}, about ${plural(minutes, 'minute')} of answering time.`;
}

function updateSummaries() {
  els.editor.querySelectorAll('[data-summary]').forEach((el) => {
    el.textContent = summaryText();
  });
}

function changed() {
  saveDraft();
  refreshErrors();
}

function questionCard(q, i) {
  const n = quiz.questions.length;
  const headingId = `q${i}-h`;
  const timeOptions = [...new Set([...TIME_OPTIONS, q.timeLimit])].sort((a, b) => a - b);
  const timeSelect = h('select', {
    class: 'select',
    id: fieldId(`q.${i}.timeLimit`),
    'aria-label': `Time limit for question ${i + 1}`,
    dataset: { path: `q.${i}.timeLimit` },
    onchange: (e) => {
      q.timeLimit = Number(e.target.value);
      updateSummaries();
      changed();
    },
  }, timeOptions.map((t) => h('option', { value: String(t), selected: t === q.timeLimit }, `${t} seconds`)));

  const move = (delta) => {
    const j = i + delta;
    [quiz.questions[i], quiz.questions[j]] = [quiz.questions[j], quiz.questions[i]];
    renderEditor({ focus: `${delta < 0 ? 'up' : 'down'}-${j}`, fallback: `q${j}-h` });
    saveDraft();
  };

  const tools = [
    h('button', {
      class: 'btn btn-ghost btn-icon', type: 'button', id: `up-${i}`, disabled: i === 0,
      'aria-label': `Move question ${i + 1} up`, onclick: () => move(-1),
    }, icon('up')),
    h('button', {
      class: 'btn btn-ghost btn-icon', type: 'button', id: `down-${i}`, disabled: i === n - 1,
      'aria-label': `Move question ${i + 1} down`, onclick: () => move(1),
    }, icon('down')),
    h('button', {
      class: 'btn btn-ghost btn-icon', type: 'button', disabled: n === 1,
      'aria-label': `Delete question ${i + 1}`,
      onclick: () => {
        const hasContent = q.text.trim() || q.choices.some((c) => c.trim());
        if (hasContent && !window.confirm(`Delete question ${i + 1}?`)) return;
        quiz.questions.splice(i, 1);
        renderEditor({ focus: `q${Math.min(i, quiz.questions.length - 1)}-h` });
        saveDraft();
      },
    }, icon('trash')),
  ];

  const textPath = `q.${i}.text`;
  const choices = q.choices.map((choice, j) => {
    const path = `q.${i}.choice.${j}`;
    return h('div', { class: 'choice-edit', dataset: { letter: LETTERS[j] } },
      h('span', { class: 'letter', 'aria-hidden': 'true' }, LETTERS[j]),
      h('input', {
        class: 'input',
        id: fieldId(path),
        value: choice,
        maxlength: String(LIMITS.choiceMax),
        placeholder: `Answer ${LETTERS[j]}`,
        'aria-label': `Question ${i + 1}, answer ${LETTERS[j]}`,
        'aria-describedby': errorId(path),
        dataset: { path },
        oninput: (e) => {
          q.choices[j] = e.target.value;
          changed();
        },
      }),
      h('label', { class: 'correct-toggle' },
        h('input', {
          type: 'radio',
          name: `q${i}-correct`,
          value: String(j),
          id: j === 0 ? fieldId(`q.${i}.correct`) : null,
          checked: q.correct === j,
          'aria-label': `Answer ${LETTERS[j]} is correct`,
          onchange: () => {
            q.correct = j;
            changed();
          },
        }),
        h('span', { 'aria-hidden': 'true' }, 'Correct')),
      errorSlot(path));
  });

  return h('section', { class: 'q-card', 'aria-labelledby': headingId },
    h('div', { class: 'q-card-head' },
      h('h2', { id: headingId, tabindex: '-1' }, `Question ${i + 1}`),
      timeSelect,
      h('span', { class: 'q-tools' }, tools)),
    errorSlot(`q.${i}.timeLimit`),
    h('div', { class: 'field' },
      h('label', { for: fieldId(textPath) }, 'Question'),
      h('textarea', {
        class: 'textarea',
        id: fieldId(textPath),
        rows: '2',
        maxlength: String(LIMITS.questionMax),
        placeholder: 'What do you want to ask?',
        'aria-describedby': errorId(textPath),
        dataset: { path: textPath },
        oninput: (e) => {
          q.text = e.target.value;
          changed();
        },
      }, q.text),
      errorSlot(textPath)),
    h('div', { role: 'group', 'aria-label': `Answers for question ${i + 1}` },
      h('p', { class: 'help', id: `q${i}-choices-help` }, 'Write four answers and mark the correct one.'),
      h('div', { class: 'choice-edit-list' }, choices),
      errorSlot(`q.${i}.correct`)));
}

function renderEditor({ focus, fallback } = {}) {
  host.view = {};
  const titlePath = 'title';
  const fileInput = h('input', {
    type: 'file',
    accept: 'application/json,.json',
    class: 'visually-hidden',
    tabindex: '-1',
    'aria-hidden': 'true',
    onchange: (e) => importQuiz(e.target.files?.[0], e.target),
  });
  host.view.errorSummary = h('section', {
    class: 'panel error-summary', id: 'error-summary', tabindex: '-1', role: 'alert', hidden: true,
  });
  const createBtn = (extra = '') => h('button', {
    class: `btn btn-primary btn-lg ${extra}`, type: 'button', onclick: (e) => createRoom(e.currentTarget),
  }, icon('play'), 'Create room');

  clear(els.editor, h('div', { class: 'editor' },
    h('div', { class: 'editor-main' },
      h('header', { class: 'editor-head' },
        h('h1', {}, 'Write your quiz'),
        h('p', {}, 'Each question has four answers and one correct choice. Players see the question and answers on their own phones, and the answer stays hidden until you reveal it.')),
      h('div', { class: 'field' },
        h('label', { for: fieldId(titlePath) }, 'Quiz title'),
        h('input', {
          class: 'input',
          id: fieldId(titlePath),
          value: quiz.title,
          maxlength: String(LIMITS.titleMax),
          placeholder: 'For example, Friday team trivia',
          'aria-describedby': errorId(titlePath),
          dataset: { path: titlePath },
          oninput: (e) => {
            quiz.title = e.target.value;
            changed();
          },
        }),
        errorSlot(titlePath)),
      h('div', { class: 'q-list', id: 'q-list' }, quiz.questions.map(questionCard)),
      errorSlot('questions'),
      h('div', { class: 'link-row' },
        h('button', {
          class: 'btn', type: 'button', id: 'add-question',
          disabled: quiz.questions.length >= LIMITS.maxQuestions,
          onclick: () => {
            quiz.questions.push(blankQuestion());
            renderEditor({ focus: fieldId(`q.${quiz.questions.length - 1}.text`) });
            saveDraft();
          },
        }, icon('plus'), 'Add question'))),
    h('aside', { class: 'editor-side', 'aria-label': 'Hosting' },
      host.view.errorSummary,
      h('section', { class: 'panel' },
        h('h2', {}, 'Ready to host?'),
        h('p', { class: 'help', 'data-summary': '' }, summaryText()),
        createBtn('btn-block'),
        h('p', { class: 'help' }, 'You’ll get a QR code and a six-digit room code to share. Nobody can join until you create the room.')),
      h('section', { class: 'panel' },
        h('h2', {}, 'Quiz file'),
        h('div', { class: 'link-row' },
          h('button', { class: 'btn', type: 'button', onclick: exportQuiz }, icon('download'), 'Export'),
          h('button', { class: 'btn', type: 'button', onclick: () => fileInput.click() }, icon('upload'), 'Import'),
          fileInput),
        h('div', { class: 'link-row' },
          h('button', {
            class: 'btn btn-ghost', type: 'button',
            onclick: () => {
              if (!window.confirm('Replace your questions with the sample quiz?')) return;
              quiz = clone(SAMPLE_QUIZ);
              showErrors = false;
              renderEditor({ focus: fieldId('title') });
              saveDraft();
            },
          }, 'Load sample quiz'),
          h('button', {
            class: 'btn btn-ghost', type: 'button',
            onclick: () => {
              if (!window.confirm('Start a new, empty quiz? Your current questions will be cleared.')) return;
              quiz = { title: '', questions: [blankQuestion()] };
              showErrors = false;
              renderEditor({ focus: fieldId('title') });
              saveDraft();
            },
          }, 'Start from scratch'))),
      h('section', { class: 'panel' },
        h('h2', {}, 'How scoring works'),
        h('ul', {},
          h('li', {}, 'A correct answer earns 500 points, plus up to 500 more for answering fast.'),
          h('li', {}, 'Each player gets one answer per question. Changes and late answers don’t count.'),
          h('li', {}, 'Equal scores are split by total answer time on correct answers.')))),
    h('div', { class: 'mobile-bar' },
      h('p', { 'data-summary': '' }, summaryText()),
      createBtn())));

  refreshErrors();
  const target = (focus && document.getElementById(focus)) || (fallback && document.getElementById(fallback));
  if (target && !target.disabled) target.focus();
  else if (fallback) document.getElementById(fallback)?.focus();
}

function showEditor() {
  host.mode = 'editor';
  host.timer?.stop();
  host.timer = null;
  host.viewKey = null;
  host.state = null;
  host.chips = new Map();
  document.body.classList.remove('stage');
  document.title = 'Host a quiz | Grove';
  els.meta.replaceChildren();
  host.metaCode = null;
  els.loading.hidden = true;
  els.stage.hidden = true;
  els.editor.hidden = false;
  renderEditor();
}

function exportQuiz() {
  const data = JSON.stringify({ title: quiz.title, questions: quiz.questions }, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const slug = (quiz.title || 'quiz').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'quiz';
  const a = h('a', { href: URL.createObjectURL(blob), download: `${slug}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('Quiz exported.');
}

async function importQuiz(file, input) {
  if (!file) return;
  try {
    if (file.size > 500_000) throw new Error('too big');
    const parsed = coerceQuiz(JSON.parse(await file.text()));
    if (!parsed.questions.length) throw new Error('no questions');
    quiz = parsed;
    showErrors = true;
    renderEditor({ focus: fieldId('title') });
    saveDraft();
    toast(`Imported ${plural(quiz.questions.length, 'question')}.`);
  } catch {
    toast('That file isn’t a Grove quiz. Choose a .json file exported from Grove.');
  } finally {
    input.value = '';
  }
}

async function createRoom(button) {
  showErrors = true;
  refreshErrors();
  const result = validateNow();
  if (!result.ok) {
    const summary = document.getElementById('error-summary');
    summary?.focus();
    return;
  }
  if (!socket.connected) {
    toast('Not connected to the server yet. Check your connection and try again.');
    return;
  }
  setBusy(button, true, 'Creating room…');
  const res = await emitAck(socket, 'host:create', { quiz: result.quiz });
  setBusy(button, false);
  if (!res.ok) {
    if (res.error === 'invalid_quiz' && Array.isArray(res.errors)) {
      errors = new Map(res.errors.map((e) => [e.path, e.message]));
      renderErrorSummary();
      document.getElementById('error-summary')?.focus();
    } else {
      toast(errorMessage(res.error));
    }
    return;
  }
  host.code = res.code;
  host.token = res.hostToken;
  host.joinUrl = res.joinUrl;
  store.set(HOST_KEY, { code: res.code, hostToken: res.hostToken });
  showStage();
}

/* ---------- Stage ---------- */

function showStage() {
  host.mode = 'stage';
  document.body.classList.add('stage');
  els.loading.hidden = true;
  els.editor.hidden = true;
  els.stage.hidden = false;
  if (!host.state) {
    clear(els.stage, h('div', { class: 'status-block' },
      h('span', { class: 'spinner', 'aria-hidden': 'true' }),
      h('p', { class: 'lead', role: 'status' }, 'Opening your room…')));
  }
  if (!host.info) {
    fetch('/api/info', { cache: 'no-store' })
      .then((r) => r.json())
      .then((info) => {
        host.info = info;
        if (host.state?.phase === 'lobby') renderLanHint();
      })
      .catch(() => {});
  }
}

socket.on('host:state', (state) => {
  if (!host.code || state.code !== host.code) return;
  host.state = state;
  host.joinUrl = state.joinUrl ?? host.joinUrl;
  if (host.mode !== 'stage') showStage();
  renderStage(state);
});

socket.on('host:replaced', () => {
  host.viewKey = null;
  host.timer?.stop();
  clear(els.stage, h('div', { class: 'status-block' },
    h('h1', { tabindex: '-1' }, 'Hosting moved to another screen'),
    h('p', { class: 'lead' }, 'This room is now being run from another tab or device. Players aren’t affected.'),
    h('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: () => resume() }, 'Host from this screen')));
  els.stage.querySelector('h1').focus();
});

socket.on('room:closed', ({ reason } = {}) => {
  store.del(HOST_KEY);
  host.code = null;
  host.token = null;
  showEditor();
  toast(reason === 'expired' ? 'Your room expired after a long break.' : 'Room closed.');
});

function renderMeta(state) {
  // Built once per room so the "Close room" button keeps focus across updates.
  if (host.metaCode !== state.code) {
    host.metaCode = state.code;
    host.metaCount = h('strong');
    clear(els.meta,
      h('span', { class: 'pill' }, h('span', { class: 'hide-sm' }, 'Room '), h('strong', {}, formatCode(state.code))),
      h('span', { class: 'pill' }, icon('users'), host.metaCount, h('span', { class: 'visually-hidden' }, ' players')),
      h('button', { class: 'btn btn-ghost', type: 'button', onclick: closeRoom }, 'Close room'));
  }
  host.metaCount.textContent = formatNumber(state.playerCount);
}

function renderStage(state) {
  renderMeta(state);
  document.title = `${formatCode(state.code)}: ${state.title} | Grove`;
  const key = `${state.phase}:${state.qIndex}`;
  if (key !== host.viewKey) {
    host.timer?.stop();
    host.timer = null;
    host.view = {};
    host.chips = new Map();
    host.viewKey = key;
    const builders = { lobby: buildLobby, question: buildQuestion, locked: buildLocked, reveal: buildReveal, standings: buildStandings, final: buildFinal };
    builders[state.phase](state);
    updateStage(state);
    const focusTarget = host.view.primary && !host.view.primary.disabled ? host.view.primary : els.stage.querySelector('h1');
    if (focusTarget?.tagName === 'H1') focusTarget.setAttribute('tabindex', '-1');
    focusTarget?.focus({ preventScroll: true });
    return;
  }
  updateStage(state);
}

async function act(type, extra = {}, button = null) {
  if (button) setBusy(button, true, 'One moment…');
  const res = await emitAck(socket, 'host:action', { type, ...extra });
  if (button && button.isConnected) setBusy(button, false);
  if (!res.ok) toast(errorMessage(res.error));
  return res;
}

function primaryButton(label, iconName, onclick) {
  const btn = h('button', { class: 'btn btn-primary btn-lg', type: 'button' }, iconName ? icon(iconName) : null, label);
  btn.addEventListener('click', () => onclick(btn));
  host.view.primary = btn;
  return btn;
}

function progressBlock(state) {
  const fill = h('div', { class: 'progress-fill' });
  fill.style.width = `${((state.qIndex + 1) / state.questionCount) * 100}%`;
  return h('div', {},
    h('p', { class: 'q-progress' }, `Question ${state.qIndex + 1} of ${state.questionCount}`),
    h('div', {
      class: 'progress-track', role: 'progressbar', 'aria-label': 'Quiz progress',
      'aria-valuemin': '0', 'aria-valuemax': String(state.questionCount), 'aria-valuenow': String(state.qIndex + 1),
    }, fill));
}

function joinStrip(state) {
  if (!state.accepting) return null;
  return h('p', { class: 'join-strip' }, icon('link'), 'Late arrivals can still join with code', h('strong', {}, formatCode(state.code)));
}

/* Lobby */

function buildLobby(state) {
  const v = host.view;
  v.count = h('span');
  v.roster = h('ul', { class: 'roster', 'aria-label': 'Players in the room' });
  v.empty = h('div', { class: 'empty' },
    h('strong', {}, 'Waiting for players'),
    'Ask everyone to scan the QR code or enter the room code. Names appear here as people join.');
  v.lockBtn = h('button', { class: 'btn', type: 'button', onclick: (e) => act('lock', { locked: !host.state.locked }, e.currentTarget) });
  v.lockedNotice = h('div', { class: 'notice', role: 'status' }, icon('lock'), h('span', {}, 'Room locked. New players can’t join until you unlock it.'));
  v.startHelp = h('p', { class: 'help' });
  v.lan = h('div', { class: 'lan-hint' });
  const qrAlt = `QR code that opens the join page for room ${formatCode(state.code)}`;

  clear(els.stage,
    h('div', { class: 'stage-title' },
      h('h1', {}, state.title),
      h('p', {}, `${plural(state.questionCount, 'question')}. Players join on their phones.`)),
    h('div', { class: 'lobby' },
      h('section', { class: 'join-panel', 'aria-label': 'How to join' },
        h('p', { class: 'lead' }, 'Scan to join'),
        h('div', { class: 'qr' }, h('img', { src: `/api/rooms/${state.code}/qr.svg`, alt: qrAlt, width: '300', height: '300' })),
        h('p', { class: 'lead' }, 'or open the link and enter the room code'),
        h('p', { class: 'join-url' }, host.joinUrl ?? ''),
        h('p', { class: 'room-code' }, h('span', { class: 'visually-hidden' }, 'Room code '), formatCode(state.code)),
        h('div', { class: 'link-row' },
          h('button', { class: 'btn', type: 'button', onclick: copyJoinLink }, icon('copy'), 'Copy join link'),
          h('a', { class: 'btn btn-ghost', href: `/join/${state.code}`, target: '_blank', rel: 'noopener' }, 'Open join page')),
        v.lan),
      h('section', { class: 'roster-panel', 'aria-labelledby': 'roster-h' },
        h('div', { class: 'roster-head' },
          h('h2', { id: 'roster-h' }, v.count),
          v.lockBtn),
        v.lockedNotice,
        v.empty,
        v.roster,
        h('div', { class: 'stage-actions' },
          v.startHelp,
          h('span', { class: 'spacer' }),
          primaryButton('Start quiz', 'play', (btn) => act('start', {}, btn))))));
  renderLanHint();
}

function renderLanHint() {
  const v = host.view;
  if (!v.lan || !host.info?.isLocalHost) return;
  const links = host.info.lanUrls.map((base) => h('li', {},
    h('a', { href: `${base}/host#resume=${host.code}.${host.token}` }, `Move this screen to ${base}`)));
  clear(v.lan, h('div', { class: 'notice' }, icon('alert'),
    h('div', {},
      h('p', {}, 'Phones can’t open “localhost”, so this QR code only works on this computer.'),
      links.length
        ? [h('p', {}, 'If players are on the same Wi-Fi, reopen this screen at your network address. The room comes with you.'), h('ul', {}, links)]
        : h('p', {}, 'Deploy Grove or set PUBLIC_URL so the QR code points to an address phones can reach.'))));
}

async function copyJoinLink() {
  const text = host.joinUrl ?? `${location.origin}/join/${host.code}`;
  try {
    await navigator.clipboard.writeText(text);
    toast('Join link copied.');
  } catch {
    window.prompt('Copy the join link:', text);
  }
}

function updateLobby(state) {
  const v = host.view;
  v.count.textContent = state.playerCount === 0 ? 'No players yet' : plural(state.playerCount, 'player');
  v.empty.hidden = state.roster.length > 0;
  v.lockedNotice.hidden = !state.locked;
  clear(v.lockBtn, icon(state.locked ? 'unlock' : 'lock'), state.locked ? 'Unlock room' : 'Lock room');
  v.primary.disabled = state.playerCount === 0;
  v.startHelp.textContent = state.playerCount === 0
    ? 'You can start once at least one player has joined.'
    : `${plural(state.connectedCount, 'player')} connected. Late arrivals can still join during the game.`;

  // Keyed update so focus on a "Remove" button survives new arrivals.
  const seen = new Set();
  state.roster.forEach((p) => {
    seen.add(p.id);
    let chip = host.chips.get(p.id);
    if (!chip) {
      chip = h('li', { class: 'chip' },
        h('span', { class: 'chip-name' }, p.name),
        h('button', {
          class: 'btn btn-ghost btn-icon',
          type: 'button',
          'aria-label': `Remove ${p.name}`,
          title: `Remove ${p.name}`,
          onclick: () => {
            if (window.confirm(`Remove ${p.name} from the room?`)) act('kick', { playerId: p.id });
          },
        }, icon('cross')));
      host.chips.set(p.id, chip);
    }
    chip.classList.toggle('is-away', !p.connected);
    v.roster.append(chip);
  });
  for (const [id, chip] of host.chips) {
    if (!seen.has(id)) {
      chip.remove();
      host.chips.delete(id);
    }
  }
}

/* Question */

function stageHead(state, aside) {
  return h('div', { class: 'q-stage-head' }, progressBlock(state), aside);
}

function answeredLine(state) {
  const away = state.playerCount - state.connectedCount;
  return [
    h('strong', {}, formatNumber(state.answeredCount)),
    ` of ${plural(state.playerCount, 'player')} answered`,
    away > 0 ? ` (${away} away)` : '',
  ];
}

function buildQuestion(state) {
  const v = host.view;
  const q = state.question;
  host.timer = createTimer({ totalMs: q.timeLimit * 1000, remainingMs: q.remainingMs, large: true });
  v.answered = h('p', { class: 'answered-count', role: 'status' });
  const endBtn = h('button', { class: 'btn btn-lg', type: 'button' }, 'End question now');
  endBtn.addEventListener('click', () => act('end_question', {}, endBtn));
  v.primary = endBtn;
  clear(els.stage, h('div', { class: 'q-stage' },
    stageHead(state, host.timer.el),
    h('h1', { class: 'q-text' }, q.text),
    answerTiles(q.choices),
    h('div', { class: 'stage-foot' }, v.answered, endBtn),
    joinStrip(state)));
}

function buildLocked(state) {
  const v = host.view;
  const q = state.question;
  const label = { all_answered: 'Everyone answered', host: 'Question closed', timer: 'Time’s up' }[state.lockReason] ?? 'Time’s up';
  v.answered = h('p', { class: 'answered-count', role: 'status' });
  clear(els.stage, h('div', { class: 'q-stage' },
    stageHead(state, h('div', { class: 'closed-badge', role: 'status' }, label)),
    h('h1', { class: 'q-text' }, q.text),
    answerTiles(q.choices),
    h('div', { class: 'stage-foot' }, v.answered, primaryButton('Reveal answer', 'check', (btn) => act('reveal', {}, btn)))));
}

function buildReveal(state) {
  const q = state.question;
  const correctCount = state.distribution[q.correct];
  const answered = state.distribution.reduce((a, b) => a + b, 0);
  clear(els.stage, h('div', { class: 'q-stage' },
    stageHead(state, h('div', { class: 'closed-badge' }, `Answer ${LETTERS[q.correct]}`)),
    h('h1', { class: 'q-text' }, q.text),
    answerTiles(q.choices, { correct: q.correct, counts: state.distribution }),
    h('div', { class: 'stage-foot' },
      h('p', { class: 'answered-count' }, h('strong', {}, formatNumber(correctCount)), ` of ${formatNumber(answered)} answered correctly`),
      primaryButton('Show standings', null, (btn) => act('standings', {}, btn)))));
}

function buildStandings(state) {
  const endEarly = state.isLast ? null : h('button', {
    class: 'btn btn-lg',
    type: 'button',
    onclick: (e) => {
      if (window.confirm('End the quiz now and show final results? The remaining questions will be skipped.')) act('finish', {}, e.currentTarget);
    },
  }, 'End quiz early');
  clear(els.stage,
    h('div', { class: 'stage-title' },
      h('h1', {}, 'Standings'),
      h('p', {}, `After question ${state.qIndex + 1} of ${state.questionCount}`)),
    standingsBoards(state.summary, { bottomNote: state.isLast ? null : 'Plenty of time to climb' }),
    h('div', { class: 'stage-foot' },
      h('p', { class: 'answered-count' }, `${plural(state.playerCount, 'player')} in the game`),
      endEarly,
      state.isLast
        ? primaryButton('Show final results', 'flag', (btn) => act('finish', {}, btn))
        : primaryButton('Next question', 'play', (btn) => act('start', {}, btn))));
}

function buildFinal(state) {
  const results = state.results ?? [];
  const table = h('table', { class: 'results-table' },
    h('thead', {}, h('tr', {},
      h('th', { scope: 'col' }, 'Place'),
      h('th', { scope: 'col' }, 'Player'),
      h('th', { scope: 'col', class: 'num' }, 'Correct'),
      h('th', { scope: 'col', class: 'num' }, 'Points'))),
    h('tbody', {}, results.map((r) => h('tr', {},
      h('td', {}, r.tied ? `${r.rank} (tied)` : String(r.rank)),
      h('td', {}, r.name),
      h('td', { class: 'num' }, `${r.correctCount} of ${state.questionCount}`),
      h('td', { class: 'num' }, formatNumber(r.score))))));
  clear(els.stage,
    h('div', { class: 'stage-title' },
      h('h1', {}, 'Final results'),
      h('p', {}, state.title)),
    state.summary.total ? podium(state.summary.top) : null,
    podiumNote(state.summary),
    standingsBoards(state.summary, { showRound: false, showTop: state.summary.total === 0 }),
    results.length
      ? h('details', { class: 'full-results' },
        h('summary', {}, `Full results for all ${plural(results.length, 'player')}`),
        table)
      : null,
    h('div', { class: 'stage-actions' },
      h('button', { class: 'btn btn-lg', type: 'button', onclick: () => downloadCsv(state) }, icon('download'), 'Download results (CSV)'),
      h('span', { class: 'spacer' }),
      primaryButton('Host another quiz', null, () => {
        store.del(HOST_KEY);
        host.code = null;
        host.token = null;
        showEditor();
      })));
}

function downloadCsv(state) {
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const lines = [['Place', 'Tied', 'Player', 'Correct answers', 'Points'].map(esc).join(',')];
  for (const r of state.results ?? []) {
    lines.push([r.rank, r.tied ? 'yes' : 'no', r.name, r.correctCount, r.score].map(esc).join(','));
  }
  const blob = new Blob([`${lines.join('\r\n')}\r\n`], { type: 'text/csv' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `grove-results-${state.code}.csv` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function updateStage(state) {
  const v = host.view;
  if (state.phase === 'lobby') updateLobby(state);
  if (v.answered) clear(v.answered, answeredLine(state));
  if (state.phase === 'question' && host.timer) host.timer.sync(state.question.remainingMs);
}

async function closeRoom() {
  if (!window.confirm('Close this room? Every player is disconnected and the game ends.')) return;
  const res = await act('close');
  if (!res.ok && res.error !== 'not_host') return;
  store.del(HOST_KEY);
  host.code = null;
  host.token = null;
  showEditor();
  toast('Room closed.');
}

// Presentation clickers send PageDown / ArrowRight: treat them as "next step".
document.addEventListener('keydown', (e) => {
  if (host.mode !== 'stage' || e.altKey || e.ctrlKey || e.metaKey) return;
  if (!['PageDown', 'ArrowRight'].includes(e.key)) return;
  if (e.target.closest?.('input, textarea, select, details')) return;
  const btn = host.view.primary;
  if (btn && !btn.disabled && btn.isConnected) {
    e.preventDefault();
    btn.click();
  }
});

/* ---------- Start up ---------- */

const saved = store.get(HOST_KEY);
if (saved?.code && saved?.hostToken) {
  host.code = saved.code;
  host.token = saved.hostToken;
  host.mode = 'loading';
  els.loading.hidden = false;
  if (socket.connected) resume();
} else {
  showEditor();
}
