export const COLORS = ['#6877f4', '#55b7a0', '#f0ab62', '#dd789d', '#a989e8', '#6b9fd7'];
export const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'];
const makeId = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const DEFAULT_NAMES = {
  ru: { board: 'Моя доска', columns: ['Входящие', 'К работе', 'В работе', 'Проверка', 'Готово'] },
  en: { board: 'My board', columns: ['Inbox', 'To do', 'In progress', 'Review', 'Done'] }
};

export function normalizeLink(value) {
  const input = typeof value === 'string' ? value.trim() : '';
  if (!input) return '';
  if (input.length > 2048 || /[\s\\]/.test(input)) return '';
  try {
    const hasProtocol = /^https?:\/\//i.test(input);
    if (!hasProtocol && (input.includes('://') || (/^[a-z][a-z\d+.-]*:/i.test(input) && !/^[^/:]+:\d+(?:[/?#]|$)/.test(input)))) return '';
    const url = new URL(hasProtocol ? input : `https://${input}`);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return '';
    return url.href;
  } catch { return ''; }
}

export function createBoard(name, language = 'ru') {
  const defaults = DEFAULT_NAMES[language] || DEFAULT_NAMES.ru;
  return {
    id: makeId(), name: typeof name === 'string' && name.trim() ? name.trim() : defaults.board, color: COLORS[0], nextNumber: 1,
    columns: [
      { id: makeId(), name: defaults.columns[0], color: '#8d98a8', limit: null },
      { id: makeId(), name: defaults.columns[1], color: '#6877f4', limit: null },
      { id: makeId(), name: defaults.columns[2], color: '#f0ab62', limit: 5 },
      { id: makeId(), name: defaults.columns[3], color: '#a989e8', limit: null },
      { id: makeId(), name: defaults.columns[4], color: '#55b7a0', limit: null }
    ],
    tags: [], cards: []
  };
}

export function createInitialState() {
  const board = createBoard();
  return { version: 1, activeBoardId: board.id, theme: 'dark', language: 'ru', boards: [board] };
}

const str = (value, max = 5000) => typeof value === 'string' ? value.slice(0, max) : '';
const color = value => /^#[0-9a-fA-F]{6}$/.test(value) ? value : COLORS[0];
const id = value => typeof value === 'string' && value.length < 100 && value.length > 0 ? value : makeId();

export function normalizeState(raw) {
  if (!raw || raw.version !== 1 || !Array.isArray(raw.boards)) throw new Error('Неподдерживаемый формат данных');
  const language = raw.language === 'en' ? 'en' : 'ru';
  const boards = raw.boards.slice(0, 100).map(source => {
    const columns = (Array.isArray(source.columns) ? source.columns : []).slice(0, 30).map(item => ({
      id: id(item.id), name: str(item.name, 80) || (language === 'en' ? 'Column' : 'Колонка'), color: color(item.color),
      limit: Number.isInteger(item.limit) && item.limit > 0 && item.limit < 10000 ? item.limit : null
    }));
    if (!columns.length) columns.push({ id: makeId(), name: language === 'en' ? 'Tasks' : 'Задачи', color: COLORS[0], limit: null });
    const tags = (Array.isArray(source.tags) ? source.tags : []).slice(0, 200).map(item => ({
      id: id(item.id), name: str(item.name, 40), color: color(item.color)
    }));
    const cards = (Array.isArray(source.cards) ? source.cards : []).slice(0, 50000).map(item => ({
      id: id(item.id), number: Number.isInteger(item.number) && item.number > 0 ? item.number : 1,
      title: str(item.title, 200) || (language === 'en' ? 'Untitled' : 'Без названия'), description: str(item.description, 20000), link: normalizeLink(item.link),
      columnId: columns.some(c => c.id === item.columnId) ? item.columnId : columns[0].id,
      priority: PRIORITIES.includes(item.priority) ? item.priority : 'none',
      color: /^#[0-9a-fA-F]{6}$/.test(item.color) ? item.color : '',
      dueDate: /^\d{4}-\d{2}-\d{2}$/.test(item.dueDate) ? item.dueDate : '',
      tagIds: Array.isArray(item.tagIds) ? item.tagIds.filter(t => tags.some(tag => tag.id === t)) : [],
      checklist: (Array.isArray(item.checklist) ? item.checklist : []).slice(0, 200).map(check => ({
        id: id(check.id), text: str(check.text, 300), done: Boolean(check.done)
      })),
      createdAt: str(item.createdAt, 40) || now(), updatedAt: str(item.updatedAt, 40) || now(),
      archived: Boolean(item.archived), order: Number.isFinite(item.order) ? item.order : 0
    }));
    const maxNumber = Math.max(0, ...cards.map(c => c.number));
    return {
      id: id(source.id), name: str(source.name, 80) || (language === 'en' ? 'Board' : 'Доска'), color: color(source.color),
      nextNumber: Math.max(maxNumber + 1, Number.isInteger(source.nextNumber) ? source.nextNumber : 1),
      columns, tags, cards
    };
  });
  if (!boards.length) boards.push(createBoard(undefined, language));
  return {
    version: 1, theme: raw.theme === 'light' ? 'light' : 'dark', language,
    activeBoardId: boards.some(b => b.id === raw.activeBoardId) ? raw.activeBoardId : boards[0].id,
    boards
  };
}

export function getBoard(state) { return state.boards.find(b => b.id === state.activeBoardId) || state.boards[0]; }

export function updateState(state, action) {
  const next = structuredClone(state);
  let board = getBoard(next);
  const card = () => board.cards.find(c => c.id === action.id);
  switch (action.type) {
    case 'board.add': {
      const added = createBoard(action.name, next.language);
      next.boards.push(added); next.activeBoardId = added.id; break;
    }
    case 'board.select':
      if (next.boards.some(b => b.id === action.id)) next.activeBoardId = action.id;
      break;
    case 'board.update':
      if (action.name !== undefined) board.name = str(action.name, 80).trim() || board.name;
      if (action.color !== undefined) board.color = color(action.color);
      break;
    case 'board.delete':
      if (next.boards.length > 1) { next.boards = next.boards.filter(b => b.id !== board.id); next.activeBoardId = next.boards[0].id; }
      break;
    case 'column.add':
      board.columns.push({ id: makeId(), name: str(action.name, 80).trim() || (next.language === 'en' ? 'New column' : 'Новая колонка'), color: color(action.color || COLORS[0]), limit: null });
      break;
    case 'column.update': {
      const column = board.columns.find(c => c.id === action.id);
      if (!column) break;
      if (action.name !== undefined) column.name = str(action.name, 80).trim() || column.name;
      if (action.color !== undefined) column.color = color(action.color);
      if (action.limit !== undefined) column.limit = Number.isInteger(action.limit) && action.limit > 0 ? action.limit : null;
      break;
    }
    case 'column.delete':
      if (board.columns.length > 1) {
        const replacement = board.columns.find(c => c.id !== action.id);
        board.cards.forEach(c => { if (c.columnId === action.id) c.columnId = replacement.id; });
        board.columns = board.columns.filter(c => c.id !== action.id);
      }
      break;
    case 'column.move': {
      const index = board.columns.findIndex(c => c.id === action.id);
      const target = index + action.delta;
      if (index >= 0 && target >= 0 && target < board.columns.length) {
        const [column] = board.columns.splice(index, 1); board.columns.splice(target, 0, column);
      }
      break;
    }
    case 'tag.add':
      if (str(action.name, 40).trim()) board.tags.push({ id: makeId(), name: str(action.name, 40).trim(), color: color(action.color || COLORS[0]) });
      break;
    case 'tag.update': {
      const tag = board.tags.find(t => t.id === action.id);
      if (tag) { tag.name = str(action.name, 40).trim() || tag.name; tag.color = color(action.color || tag.color); }
      break;
    }
    case 'tag.delete':
      board.tags = board.tags.filter(t => t.id !== action.id);
      board.cards.forEach(c => { c.tagIds = c.tagIds.filter(t => t !== action.id); });
      break;
    case 'card.add': {
      const columnId = board.columns.some(c => c.id === action.columnId) ? action.columnId : board.columns[0].id;
      const order = Math.max(-1, ...board.cards.filter(c => c.columnId === columnId && !c.archived).map(c => c.order)) + 1;
      const created = now();
      board.cards.push({ id: makeId(), number: board.nextNumber++, title: str(action.title, 200).trim() || (next.language === 'en' ? 'New task' : 'Новая задача'),
        description: '', link: '', columnId, priority: 'none', color: '', dueDate: '', tagIds: [], checklist: [],
        createdAt: created, updatedAt: created, archived: false, order });
      break;
    }
    case 'card.update': {
      const item = card(); if (!item) break;
      if (action.title !== undefined) item.title = str(action.title, 200).trim() || item.title;
      if (action.description !== undefined) item.description = str(action.description, 20000);
      if (action.link !== undefined) item.link = normalizeLink(action.link);
      if (action.priority !== undefined && PRIORITIES.includes(action.priority)) item.priority = action.priority;
      if (action.color !== undefined) item.color = /^#[0-9a-fA-F]{6}$/.test(action.color) ? action.color : '';
      if (action.dueDate !== undefined) item.dueDate = /^\d{4}-\d{2}-\d{2}$/.test(action.dueDate) ? action.dueDate : '';
      if (action.tagIds !== undefined) item.tagIds = action.tagIds.filter(t => board.tags.some(tag => tag.id === t));
      item.updatedAt = now(); break;
    }
    case 'card.move': {
      const item = card();
      if (!item || !board.columns.some(c => c.id === action.columnId)) break;
      const siblings = board.cards.filter(c => !c.archived && c.id !== item.id && c.columnId === action.columnId).sort((a,b) => a.order - b.order);
      const index = Math.max(0, Math.min(Number.isInteger(action.index) ? action.index : siblings.length, siblings.length));
      siblings.splice(index, 0, item);
      siblings.forEach((c, i) => { c.order = i; });
      item.columnId = action.columnId; item.updatedAt = now(); break;
    }
    case 'card.archive': {
      const item = card(); if (item) { item.archived = Boolean(action.archived); item.updatedAt = now(); } break;
    }
    case 'card.delete':
      board.cards = board.cards.filter(c => c.id !== action.id); break;
    case 'check.add': {
      const item = card(); const value = str(action.text, 300).trim();
      if (item && value) { item.checklist.push({ id: makeId(), text: value, done: false }); item.updatedAt = now(); } break;
    }
    case 'check.toggle': {
      const item = card(); const check = item?.checklist.find(c => c.id === action.checkId);
      if (check) { check.done = !check.done; item.updatedAt = now(); } break;
    }
    case 'check.delete': {
      const item = card(); if (item) { item.checklist = item.checklist.filter(c => c.id !== action.checkId); item.updatedAt = now(); } break;
    }
    case 'theme.set': next.theme = action.theme === 'light' ? 'light' : 'dark'; break;
    case 'language.set': {
      const previous = next.language === 'en' ? 'en' : 'ru';
      const language = action.language === 'en' ? 'en' : 'ru';
      if (previous === language) break;
      for (const item of next.boards) {
        if (item.name === DEFAULT_NAMES[previous].board) item.name = DEFAULT_NAMES[language].board;
        for (const column of item.columns) {
          const index = DEFAULT_NAMES[previous].columns.indexOf(column.name);
          if (index >= 0) column.name = DEFAULT_NAMES[language].columns[index];
        }
      }
      next.language = language; break;
    }
    default: return state;
  }
  return next;
}
