import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, getBoard, normalizeState, updateState } from '../src/model.mjs';

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
  const restored = normalizeState(JSON.parse(JSON.stringify(source)));
  const card = getBoard(restored).cards[0];
  assert.equal(card.columnId, b.columns[0].id);
  assert.deepEqual(card.tagIds, []);
  assert.equal(card.priority, 'none');
  assert.equal(getBoard(restored).nextNumber, 46);
});
