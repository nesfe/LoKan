const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = value => value === undefined ? undefined : structuredClone(value);

function field(base, local, remote) {
  if (same(local, base)) return clone(remote);
  if (same(remote, base) || same(local, remote)) return clone(local);
  return clone(local); // A later local edit wins only when the same field changed on both sides.
}

function idSet(base = [], local = [], remote = []) {
  const old = new Set(base);
  const result = new Set(remote.filter(id => !old.has(id) || local.includes(id)));
  for (const id of local) if (!old.has(id)) result.add(id);
  return [...result];
}

function entities(base = [], local = [], remote = [], kind) {
  const prior = new Map(base.map(item => [item.id, item]));
  const mine = new Map(local.map(item => [item.id, item]));
  const theirs = new Map(remote.map(item => [item.id, item]));
  const localReordered = !same(local.map(item => item.id).filter(id => prior.has(id)), base.map(item => item.id).filter(id => mine.has(id)));
  const order = localReordered ? [...local, ...remote] : [...remote, ...local];
  const seen = new Set();
  const output = [];
  for (const item of order) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const before = prior.get(item.id);
    const ours = mine.get(item.id);
    const current = theirs.get(item.id);
    if (!ours || !current) {
      const survivor = ours || current;
      if (!before || (survivor && !same(survivor, before))) output.push(clone(survivor));
    } else {
      output.push(entity(before, ours, current, kind));
    }
  }
  return output;
}

function entity(base = {}, local, remote, kind) {
  const result = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
    if (key === 'columns' || key === 'tags' || key === 'cards' || key === 'checklist') {
      result[key] = entities(base[key], local[key], remote[key], key);
    } else if (key === 'tagIds') {
      result[key] = idSet(base[key], local[key], remote[key]);
    } else if (key === 'nextNumber') {
      result[key] = Math.max(base[key] || 1, local[key] || 1, remote[key] || 1);
    } else {
      result[key] = field(base[key], local[key], remote[key]);
    }
  }
  if (kind === 'boards') fixNumbers(result);
  return result;
}

function fixNumbers(board) {
  let next = Math.max(1, board.nextNumber || 1);
  const used = new Set();
  for (const card of board.cards || []) {
    if (!Number.isInteger(card.number) || card.number < 1 || used.has(card.number)) {
      while (used.has(next)) next++;
      card.number = next++;
    }
    used.add(card.number);
    next = Math.max(next, card.number + 1);
  }
  board.nextNumber = next;
}

export const sharedState = state => ({ version: 1, boards: clone(state.boards) });

export function isPristineState(state) {
  if (state.boards?.length !== 1) return false;
  const board = state.boards[0];
  const names = ['Входящие', 'К работе', 'В работе', 'Проверка', 'Готово'];
  const english = ['Inbox', 'To do', 'In progress', 'Review', 'Done'];
  return ['Моя доска', 'My board'].includes(board.name) && board.nextNumber === 1 &&
    board.cards.length === 0 && board.tags.length === 0 && board.columns.length === 5 &&
    [names, english].some(expected => board.columns.every((column, index) => column.name === expected[index]));
}

export function mergeShared(base, local, remote) {
  const boards = entities(base?.boards || [], local?.boards || [], remote?.boards || [], 'boards');
  return { version: 1, boards };
}
