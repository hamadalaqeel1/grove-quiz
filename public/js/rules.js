// Shared validation rules. Imported by the browser (host editor, join form)
// and by the server, so both sides apply exactly the same limits.

export const LIMITS = Object.freeze({
  titleMax: 80,
  questionMax: 200,
  choiceMax: 90,
  nameMax: 20,
  minQuestions: 1,
  maxQuestions: 50,
  minTime: 5,
  maxTime: 120,
  defaultTime: 20,
  maxPlayers: 250,
  choiceCount: 4,
});

export const TIME_OPTIONS = Object.freeze([10, 15, 20, 30, 45, 60, 90]);

export const ROOM_CODE_PATTERN = /^[1-9][0-9]{5}$/;

// Control characters, zero-width and bidi-override characters are stripped so
// names and questions can't be used to break layouts or spoof other text.
const UNSAFE_RANGES = [
  [0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e],
  [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff, 0xfeff],
];
const hex = (n) => `\\u${n.toString(16).padStart(4, '0')}`;
const UNSAFE_CHARS = new RegExp(`[${UNSAFE_RANGES.map(([a, b]) => `${hex(a)}-${hex(b)}`).join('')}]`, 'g');

export function cleanText(value) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFC').replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim();
}

export function charLength(text) {
  return Array.from(text).length;
}

export function normalizeRoomCode(value) {
  return String(value ?? '').replace(/\D/g, '').slice(0, 6);
}

export function nameKey(name) {
  return name.normalize('NFKC').toLocaleLowerCase();
}

export function validateName(raw) {
  const name = cleanText(raw);
  if (!name) return { ok: false, error: 'Enter a display name.' };
  if (charLength(name) > LIMITS.nameMax) {
    return { ok: false, error: `Use ${LIMITS.nameMax} characters or fewer.` };
  }
  return { ok: true, name };
}

function pushError(errors, path, message) {
  errors.push({ path, message });
}

/**
 * Validates and normalises a quiz. Returns { ok, quiz, errors } where errors is
 * a list of { path, message }. Paths: "title", "questions", "q.<i>.text",
 * "q.<i>.choice.<j>", "q.<i>.correct", "q.<i>.timeLimit".
 */
export function validateQuiz(input) {
  const errors = [];
  const source = input && typeof input === 'object' ? input : {};

  const title = cleanText(source.title);
  if (!title) pushError(errors, 'title', 'Give your quiz a title.');
  else if (charLength(title) > LIMITS.titleMax) {
    pushError(errors, 'title', `Keep the title to ${LIMITS.titleMax} characters or fewer.`);
  }

  const rawQuestions = Array.isArray(source.questions) ? source.questions : [];
  if (rawQuestions.length < LIMITS.minQuestions) {
    pushError(errors, 'questions', 'Add at least one question.');
  }
  if (rawQuestions.length > LIMITS.maxQuestions) {
    pushError(errors, 'questions', `A quiz can have at most ${LIMITS.maxQuestions} questions.`);
  }

  const questions = rawQuestions.slice(0, LIMITS.maxQuestions).map((raw, i) => {
    const q = raw && typeof raw === 'object' ? raw : {};
    const text = cleanText(q.text);
    if (!text) pushError(errors, `q.${i}.text`, 'Write the question.');
    else if (charLength(text) > LIMITS.questionMax) {
      pushError(errors, `q.${i}.text`, `Keep questions to ${LIMITS.questionMax} characters or fewer.`);
    }

    const rawChoices = Array.isArray(q.choices) ? q.choices : [];
    if (rawChoices.length !== LIMITS.choiceCount) {
      pushError(errors, `q.${i}.choice.0`, 'Each question needs exactly four answer choices.');
    }
    const choices = [0, 1, 2, 3].map((j) => cleanText(rawChoices[j]));
    const seen = new Map();
    choices.forEach((choice, j) => {
      if (!choice) {
        pushError(errors, `q.${i}.choice.${j}`, 'Fill in this answer choice.');
        return;
      }
      if (charLength(choice) > LIMITS.choiceMax) {
        pushError(errors, `q.${i}.choice.${j}`, `Keep answers to ${LIMITS.choiceMax} characters or fewer.`);
      }
      const key = choice.toLocaleLowerCase();
      if (seen.has(key)) {
        pushError(errors, `q.${i}.choice.${j}`, 'This answer repeats another choice. Make each choice different.');
      } else {
        seen.set(key, j);
      }
    });

    const correct = Number(q.correct);
    if (!Number.isInteger(correct) || correct < 0 || correct > 3) {
      pushError(errors, `q.${i}.correct`, 'Mark which answer is correct.');
    }

    let timeLimit = q.timeLimit === undefined || q.timeLimit === null || q.timeLimit === ''
      ? LIMITS.defaultTime
      : Number(q.timeLimit);
    if (!Number.isInteger(timeLimit) || timeLimit < LIMITS.minTime || timeLimit > LIMITS.maxTime) {
      pushError(errors, `q.${i}.timeLimit`, `Choose a time limit between ${LIMITS.minTime} and ${LIMITS.maxTime} seconds.`);
      timeLimit = LIMITS.defaultTime;
    }

    return { text, choices, correct: Number.isInteger(correct) ? correct : -1, timeLimit };
  });

  return { ok: errors.length === 0, quiz: { title, questions }, errors };
}
