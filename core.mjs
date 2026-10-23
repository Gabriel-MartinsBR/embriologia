export const STORAGE_KEY = 'embriologia-study-v1';

export function normalize(text) {
  return String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

export function emptyState() {
  return { version: 1, answers: {}, favorites: [], session: null };
}

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validOption = (question, option) => typeof option === 'string' && question.alternativas.some(a => a.id === option);
const uniqueIds = (values, allowed) => Array.isArray(values)
  ? [...new Set(values.filter(id => typeof id === 'string' && allowed.has(id)))] : [];
const timestamp = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

/** Saved derived results are recalculated against the current question bank. */
export function hydrateState(raw, questions) {
  const clean = emptyState();
  try {
    if (typeof raw === 'string') raw = JSON.parse(raw);
    if (!isRecord(raw) || raw.version !== 1) return clean;
    const bank = new Map(questions.map(q => [q.id, q]));
    const allowed = new Set(bank.keys());
    if (isRecord(raw.answers)) {
      clean.answers = Object.fromEntries(Object.entries(raw.answers).flatMap(([id, answer]) => {
        const q = bank.get(id);
        if (!q || !isRecord(answer) || !validOption(q, answer.option)) return [];
        return [[id, {
          option: answer.option,
          correct: answer.option === q.gabarito,
          attempts: Number.isSafeInteger(answer.attempts) && answer.attempts > 0 ? answer.attempts : 1,
          updatedAt: timestamp(answer.updatedAt),
        }]];
      }));
    }
    clean.favorites = uniqueIds(raw.favorites, allowed);
    const saved = raw.session;
    if (isRecord(saved)) {
      const ids = uniqueIds(saved.ids, allowed);
      if (ids.length) {
        const sessionIds = new Set(ids);
        // Keep the question in view when earlier stale/duplicate IDs are removed.
        const oldIndex = Number.isInteger(saved.index) ? saved.index : 0;
        const oldId = Array.isArray(saved.ids) ? saved.ids[oldIndex] : undefined;
        const retainedIndex = ids.indexOf(oldId);
        const index = retainedIndex >= 0 ? retainedIndex : Math.max(0, Math.min(ids.length - 1, oldIndex));
        const fresh = uniqueIds(saved.fresh, sessionIds);
        const freshIds = new Set(fresh);
        const confirmed = uniqueIds(saved.confirmed, sessionIds).filter(id => Object.hasOwn(clean.answers, id) && !freshIds.has(id));
        const drafts = isRecord(saved.drafts) ? Object.fromEntries(Object.entries(saved.drafts).filter(([id, option]) => sessionIds.has(id) && validOption(bank.get(id), option))) : {};
        clean.session = { ids, index, drafts, fresh, confirmed, createdAt: timestamp(saved.createdAt) };
      }
    }
    return clean;
  } catch {
    return emptyState();
  }
}

export function questionStatus(question, state) {
  const answer = state?.answers?.[question.id];
  return !answer ? 'unanswered' : answer.option === question.gabarito ? 'correct' : 'wrong';
}

export function filterQuestions(questions, filters = {}, state = emptyState()) {
  const search = normalize(filters.search).trim();
  const active = value => value != null && value !== '' && value !== 'all';
  const favorites = new Set(state.favorites ?? []);
  return questions.filter(q => {
    if (['tema', 'subtema', 'tag', 'dificuldade'].some(key => active(filters[key]) && normalize(q[key]) !== normalize(filters[key]))) return false;
    if (active(filters.status) && questionStatus(q, state) !== filters.status) return false;
    if (filters.favoritesOnly && !favorites.has(q.id)) return false;
    // Explicit allowlist: feedback, references, and the correct option stay unsearchable.
    return !search || normalize([q.enunciado, q.tema, q.subtema, ...q.alternativas.map(a => a.texto)].join(' ')).includes(search);
  });
}

export function stats(questions, state = emptyState()) {
  const unique = [...new Map(questions.map(q => [q.id, q])).values()];
  let answered = 0, correct = 0, attempts = 0;
  for (const q of unique) {
    const answer = state.answers?.[q.id];
    if (!answer || !validOption(q, answer.option)) continue;
    answered++;
    if (answer.option === q.gabarito) correct++;
    attempts += Number.isSafeInteger(answer.attempts) && answer.attempts > 0 ? answer.attempts : 1;
  }
  const favorites = new Set(state.favorites ?? []);
  return { total: unique.length, answered, correct, wrong: answered - correct,
    rate: answered ? correct / answered * 100 : null, attempts,
    favorites: unique.filter(q => favorites.has(q.id)).length };
}

export function createSession(questions, { count = 'all', order = 'original' } = {}, random = Math.random) {
  const ids = [...new Set(questions.map(q => q.id))];
  if (order === 'random') {
    for (let i = ids.length - 1; i > 0; i--) {
      const draw = random();
      const bounded = Number.isFinite(draw) ? Math.max(0, Math.min(1 - Number.EPSILON, draw)) : 0;
      const j = Math.floor(bounded * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
  }
  const size = count === 'all' ? ids.length : Number.isFinite(Number(count)) ? Math.max(0, Math.min(ids.length, Math.floor(Number(count)))) : ids.length;
  return { ids: ids.slice(0, size), index: 0, drafts: {}, fresh: [], confirmed: [], createdAt: Date.now() };
}

export function recordAnswer(state, question, option) {
  if (!validOption(question, option)) return state;
  const previous = state.answers?.[question.id];
  const attempts = Number.isSafeInteger(previous?.attempts) && previous.attempts > 0 ? previous.attempts : 0;
  const next = { ...state, answers: { ...state.answers, [question.id]: {
    option, correct: option === question.gabarito,
    attempts: Math.min(Number.MAX_SAFE_INTEGER, attempts + 1), updatedAt: Date.now(),
  } } };
  if (state.session?.ids.includes(question.id)) {
    const drafts = { ...state.session.drafts };
    delete drafts[question.id];
    next.session = { ...state.session, drafts,
      fresh: state.session.fresh.filter(id => id !== question.id),
      confirmed: [...new Set([...state.session.confirmed, question.id])],
    };
  }
  return next;
}

export function toggleFavorite(state, id) {
  if (typeof id !== 'string' || !id) return state;
  const favorites = new Set(state.favorites ?? []);
  if (favorites.has(id)) favorites.delete(id); else favorites.add(id);
  return { ...state, favorites: [...favorites] };
}

export function moveSession(state, index) {
  if (!state.session || !state.session.ids.length || !Number.isFinite(index)) return state;
  return { ...state, session: { ...state.session, index: Math.max(0, Math.min(state.session.ids.length - 1, Math.trunc(index))) } };
}
