import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { McpService } from '../src/mcp_service.mjs';
import { createInitialState, normalizeState } from '../src/model.mjs';

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('MCP client manages tasks through the local authenticated server', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lokan-mcp-test-'));
  let state = createInitialState();
  let sequence = Promise.resolve();
  let writes = 0;
  const service = new McpService({
    userData: dir, readLocal: async () => ({ state }), writeLocal: async next => { writes++; state = normalizeState(next); return state; },
    enqueueTask: fn => (sequence = sequence.then(fn)), changed: () => {}, notify: () => {}
  });
  const client = new Client({ name: 'lokan-test', version: '1.0.0' });
  try {
    const status = await service.configure({ enabled: true, port: await freePort() });
    assert.equal(status.running, true);
    const { url, headers } = service.connection();
    assert.equal((await fetch(url, { method: 'POST' })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
    const badHostStatus = await new Promise((resolve, reject) => {
      const req = httpRequest(url, { method: 'POST', headers: { ...headers, Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(badHostStatus, 403);
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
    const call = async (name, args) => {
      const response = await client.callTool({ name, arguments: args });
      assert.equal(response.isError, undefined, `${name}: ${response.content?.[0]?.text}`);
      return JSON.parse(response.content[0].text);
    };
    const [board] = await call('list_boards', {});
    const tag = await call('create_tag', { board_id: board.id, name: 'Work', color: '#112233' });
    const task = await call('create_task', { board_id: board.id, title: 'Ship MCP', status: board.statuses[1].name,
      description: 'Test task', link: 'example.com', priority: 'high', tag_ids: [tag.id] });
    assert.equal(task.number, 1);
    assert.equal(task.link, 'https://example.com/');
    assert.equal(task.priority, 'high');
    assert.deepEqual(task.tags, ['Work']);
    const list = await call('list_tasks', { board_id: board.id, query: 'Ship' });
    assert.equal(list.total, 1);
    const moved = await call('move_task', { board_id: board.id, task: 1, status: board.statuses[2].id });
    assert.equal(moved.status, board.statuses[2].name);
    const check = await call('add_checklist_item', { board_id: board.id, task: '#1', text: 'Done' });
    const done = await call('set_checklist_item', { board_id: board.id, task: task.id, item_id: check.id, done: true });
    assert.equal(done.done, true);
    const previousWrites = writes;
    await call('set_checklist_item', { board_id: board.id, task: task.id, item_id: check.id, done: true });
    assert.equal(writes, previousWrites);
    const archived = await call('archive_task', { board_id: board.id, task: 1 });
    assert.equal(archived.archived, true);
    assert.equal((await call('list_tasks', { board_id: board.id })).total, 0);
    assert.equal((await call('list_tasks', { board_id: board.id, archived: true })).total, 1);
    const oldHeaders = headers;
    await service.rotate();
    assert.equal((await fetch(url, { method: 'POST', headers: oldHeaders })).status, 401);
    await client.close();
    await service.configure({ enabled: false });
    assert.equal(service.status().running, false);
  } finally {
    await client.close().catch(() => {});
    await service.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
