import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, getBoard, normalizeLink, normalizeState, updateState } from '../src/model.mjs';

test('numbers stay unique after moving, archiving and deleting cards', () => {
  let state = createInitialState();
  const [first, second] = getBoard(state).columns;
  state = updateState(state, { type:'card.add', title:'Первая', columnId:first.id });
  const original = getBoard(state).cards[0];
  state = updateState(state, { type:'card.move', id:original.id, columnId:second.id });
  state = updateState(state, { type:'card.archive', id:original.id, archived:true });
  state = updateState(state, { type:'card.delete', id:original.id });
  state = updateState(state, { type:'card.add', title:'Вторая', columnId:first.id });
  assert.equal(getBoard(state).cards[0].number, 2);
  assert.equal(getBoard(state).nextNumber, 3);
});

test('deleting a column keeps its tasks in the board', () => {
  let state = createInitialState();
  const [first, second] = getBoard(state).columns;
  state = updateState(state, { type:'card.add', title:'Сохранить', columnId:second.id });
  state = updateState(state, { type:'column.delete', id:second.id });
  assert.equal(getBoard(state).cards.length, 1);
  assert.equal(getBoard(state).cards[0].columnId, first.id);
});

test('normalization repairs references and keeps the next task number', () => {
  const source = createInitialState();
  const b = getBoard(source);
  b.cards.push({ id:'card', number:45, title:'Импорт', columnId:'missing', tagIds:['missing'], priority:'unexpected', checklist:[] });
  b.nextNumber = 2;
  delete source.language;
  const restored = normalizeState(JSON.parse(JSON.stringify(source)));
  const card = getBoard(restored).cards[0];
  assert.equal(restored.language, 'ru');
  assert.equal(card.link, '');
  assert.equal(card.columnId, b.columns[0].id);
  assert.deepEqual(card.tagIds, []);
  assert.equal(card.priority, 'none');
  assert.equal(getBoard(restored).nextNumber, 46);
});

test('links accept web URLs and reject other protocols or credentials', () => {
  assert.equal(normalizeLink('example.com/task'), 'https://example.com/task');
  assert.equal(normalizeLink('http://localhost:3000/task'), 'http://localhost:3000/task');
  for (const value of ['javascript:alert(1)', 'file:///tmp/task', 'https://user:pass@example.com', 'https://example.com bad']) {
    assert.equal(normalizeLink(value), '');
  }
  let state = createInitialState();
  state = updateState(state, { type:'card.add', title:'Linked' });
  const id = getBoard(state).cards[0].id;
  state = updateState(state, { type:'card.update', id, link:'example.com/task' });
  assert.equal(normalizeState(state).boards[0].cards[0].link, 'https://example.com/task');
});

test('language changes translate only default board and status names', () => {
  let state = createInitialState();
  const customColumn = getBoard(state).columns[0].id;
  state = updateState(state, { type:'column.update', id:customColumn, name:'Свой статус' });
  state = updateState(state, { type:'language.set', language:'en' });
  assert.equal(state.language, 'en');
  assert.equal(getBoard(state).name, 'My board');
  assert.equal(getBoard(state).columns[0].name, 'Свой статус');
  assert.equal(getBoard(state).columns[1].name, 'To do');
  state = updateState(state, { type:'board.add', name:'Project' });
  assert.equal(getBoard(state).columns[0].name, 'Inbox');
  assert.equal(normalizeState(state).language, 'en');
});
