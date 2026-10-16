import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInitialState, updateState } from '../src/model.mjs';
import { mergeShared, sharedState, isPristineState } from '../src/sync_merge.mjs';

test('concurrent task creation keeps both cards and gives each a unique number', () => {
  const base = createInitialState();
  const columnId = base.boards[0].columns[0].id;
  const left = updateState(base, { type: 'card.add', newId: 'left-card', columnId, title: 'Left' });
  const right = updateState(base, { type: 'card.add', newId: 'right-card', columnId, title: 'Right' });
  const merged = mergeShared(sharedState(base), sharedState(left), sharedState(right));
  assert.deepEqual(new Set(merged.boards[0].cards.map(card => card.title)), new Set(['Left', 'Right']));
  assert.deepEqual(new Set(merged.boards[0].cards.map(card => card.number)), new Set([1, 2]));
  assert.equal(merged.boards[0].nextNumber, 3);
});

test('parallel edits to different task fields are merged', () => {
  let base = createInitialState();
  base = updateState(base, { type: 'card.add', newId: 'card', title: 'Original' });
  const left = updateState(base, { type: 'card.update', id: 'card', title: 'Renamed' });
  const right = updateState(base, { type: 'card.update', id: 'card', priority: 'high' });
  const card = mergeShared(sharedState(base), sharedState(left), sharedState(right)).boards[0].cards[0];
  assert.equal(card.title, 'Renamed');
  assert.equal(card.priority, 'high');
});

test('the later syncing client wins a same-field conflict', () => {
  let base = createInitialState();
  base = updateState(base, { type: 'card.add', newId: 'card', title: 'Original' });
  const later = updateState(base, { type: 'card.update', id: 'card', title: 'Later' });
  const earlier = updateState(base, { type: 'card.update', id: 'card', title: 'Earlier' });
  const result = mergeShared(sharedState(base), sharedState(later), sharedState(earlier));
  assert.equal(result.boards[0].cards[0].title, 'Later');
});

test('a fresh board can join an existing shared workspace', () => {
  const fresh = createInitialState();
  const existing = updateState(createInitialState(), { type: 'card.add', newId: 'shared-card', title: 'Shared' });
  assert.equal(isPristineState(fresh), true);
  const result = mergeShared(null, { version: 1, boards: [] }, sharedState(existing));
  assert.equal(result.boards.length, 1);
  assert.equal(result.boards[0].cards[0].title, 'Shared');
});

test('server stores snapshots atomically and rejects stale revisions', { skip: process.platform !== 'linux' }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'lokan-sync-'));
  const script = path.resolve('src/sync_server.py');
  const call = request => {
    const result = spawnSync('python3', [script], { env: { ...process.env, HOME: home }, input: JSON.stringify(request), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  try {
    assert.deepEqual(call({ op: 'get', knownRevision: -1 }), { revision: 0, state: null });
    const state = sharedState(createInitialState());
    assert.deepEqual(call({ op: 'put', revision: 0, state }), { revision: 1 });
    assert.deepEqual(call({ op: 'put', revision: 0, state }), { conflict: true, revision: 1 });
    assert.deepEqual(call({ op: 'get', knownRevision: 1 }), { revision: 1 });
    assert.equal(call({ op: 'get', knownRevision: 0 }).state.boards.length, 1);
  } finally { await rm(home, { recursive: true, force: true }); }
});
