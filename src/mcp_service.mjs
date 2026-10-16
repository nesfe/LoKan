import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler, localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';
import { normalizeLink, PRIORITIES, updateState } from './model.mjs';

const PORT = 37419;
const id = z.string().min(1).max(99);
const boardArg = { board_id: id };
const taskArg = { ...boardArg, task: z.union([id, z.number().int().positive()]).describe('Task UUID or number within the board') };
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

function findBoard(state, boardId) {
  const board = state.boards.find(item => item.id === boardId);
  if (!board) throw new Error(`Board not found: ${boardId}`);
  return board;
}

function findTask(board, ref) {
  const number = typeof ref === 'number' ? ref : /^#?\d+$/.test(ref) ? Number(ref.replace(/^#/, '')) : null;
  const task = board.cards.find(item => item.id === ref || (number !== null && item.number === number));
  if (!task) throw new Error(`Task not found: ${ref}`);
  return task;
}

function findColumn(board, ref) {
  const column = board.columns.find(item => item.id === ref || item.name.toLowerCase() === ref.toLowerCase());
  if (!column) throw new Error(`Status not found: ${ref}`);
  return column;
}

function taskView(board, task) {
  return { ...task, status: board.columns.find(item => item.id === task.columnId)?.name || '', tags: task.tagIds.map(id => board.tags.find(item => item.id === id)?.name).filter(Boolean) };
}

export class McpService {
  constructor({ userData, readLocal, writeLocal, enqueueTask, changed, notify }) {
    this.file = path.join(userData, 'mcp.json');
    this.readLocal = readLocal;
    this.writeLocal = writeLocal;
    this.enqueueTask = enqueueTask;
    this.changed = changed;
    this.notify = notify;
    this.config = { enabled: false, port: PORT, token: '' };
    this.listener = null;
    this.handler = null;
    this.error = '';
  }

  status() {
    return { enabled: this.config.enabled, running: Boolean(this.listener?.listening), port: this.config.port,
      url: `http://127.0.0.1:${this.config.port}/mcp`, error: this.error };
  }

  async load() {
    try {
      const stored = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (stored && Number.isInteger(stored.port) && stored.port >= 1024 && stored.port <= 65535 && /^[a-f0-9]{64}$/.test(stored.token)) {
        this.config = { enabled: stored.enabled === true, port: stored.port, token: stored.token };
      }
    } catch (error) { if (error.code !== 'ENOENT') this.error = error.message; }
    if (this.config.enabled) await this.start().catch(error => { this.error = error.message; });
  }

  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(this.config), { encoding: 'utf8', mode: 0o600 });
    await fs.chmod(this.file, 0o600).catch(() => {});
  }

  async configure({ enabled, port }) {
    if (typeof enabled !== 'boolean') throw new Error('Invalid MCP setting');
    if (port !== undefined && (!Number.isInteger(port) || port < 1024 || port > 65535)) throw new Error('Port must be 1024–65535');
    await this.stop();
    this.config = { enabled, port: port ?? this.config.port, token: this.config.token || randomBytes(32).toString('hex') };
    this.error = '';
    await this.save();
    if (enabled) await this.start().catch(error => { this.error = error.message; });
    return this.status();
  }

  async rotate() {
    if (!this.config.enabled) throw new Error('Enable MCP first');
    this.config.token = randomBytes(32).toString('hex');
    await this.save();
    return this.status();
  }

  connection() {
    if (!this.listener?.listening) throw new Error('MCP server is not running');
    return { url: this.status().url, headers: { Authorization: `Bearer ${this.config.token}` } };
  }

  async read() { return this.enqueueTask(async () => (await this.readLocal()).state); }

  async mutate(boardId, operation) {
    return this.enqueueTask(async () => {
      const { state } = await this.readLocal();
      const board = boardId ? findBoard(state, boardId) : null;
      const { action, actions, pick } = operation(board, state);
      if (!action && !actions) return pick(state);
      const selected = board ? { ...state, activeBoardId: board.id } : state;
      const next = (actions || [action]).reduce((current, entry) => updateState(current, { ...entry, actor: 'MCP' }), selected);
      next.activeBoardId = state.activeBoardId;
      const saved = await this.writeLocal(next);
      this.changed();
      this.notify(saved);
      return pick(saved);
    });
  }

  createTools() {
    const server = new McpServer({ name: 'lokan', version: '1.3.0' });
    const tool = (name, description, schema, handler) => server.registerTool(name, { description, inputSchema: z.object(schema) },
      async args => { try { return result(await handler(args)); } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; } });

    tool('list_boards', 'List LoKan boards with their statuses, tags, and task counts.', {}, async () => {
      const state = await this.read();
      return state.boards.map(board => ({ id: board.id, name: board.name, color: board.color, active: board.id === state.activeBoardId,
        statuses: board.columns, tags: board.tags, active_tasks: board.cards.filter(task => !task.archived).length,
        archived_tasks: board.cards.filter(task => task.archived).length }));
    });
    tool('list_tasks', 'Search or filter tasks on one board. Returns up to 100 tasks.', { ...boardArg,
      query: z.string().max(200).optional(), status: z.string().max(99).optional(), archived: z.boolean().default(false), limit: z.number().int().min(1).max(100).default(100) },
    async ({ board_id, query, status, archived, limit }) => {
      const board = findBoard(await this.read(), board_id);
      const column = status ? findColumn(board, status) : null;
      const needle = query?.toLocaleLowerCase();
      const tasks = board.cards.filter(task => task.archived === archived && (!column || task.columnId === column.id) &&
        (!needle || [task.title, task.description, task.link, task.assignee, `#${task.number}`, ...task.tagIds.map(id => board.tags.find(tag => tag.id === id)?.name || '')].join(' ').toLocaleLowerCase().includes(needle)))
        .sort((a, b) => board.columns.findIndex(c => c.id === a.columnId) - board.columns.findIndex(c => c.id === b.columnId) || a.order - b.order);
      return { total: tasks.length, tasks: tasks.slice(0, limit).map(task => taskView(board, task)) };
    });
    tool('get_task', 'Get full details of a task by UUID or board number.', taskArg, async ({ board_id, task }) => {
      const board = findBoard(await this.read(), board_id);
      return taskView(board, findTask(board, task));
    });
    tool('create_board', 'Create a new board with default statuses.', { name: z.string().trim().min(1).max(80) }, async ({ name }) => {
      const boardId = randomUUID();
      return this.mutate(null, () => ({ action: { type: 'board.add', name, boardId }, pick: saved => findBoard(saved, boardId) }));
    });
    tool('update_board', 'Rename or recolor a board.', { ...boardArg, name: z.string().trim().min(1).max(80).optional(), color: hexColor.optional() },
      async ({ board_id, name, color }) => this.mutate(board_id, () => ({ action: { type: 'board.update', name, color }, pick: saved => findBoard(saved, board_id) })));
    tool('create_status', 'Add a status column to a board.', { ...boardArg, name: z.string().trim().min(1).max(80), color: hexColor.optional() },
      async ({ board_id, name, color }) => {
        const newId = randomUUID();
        return this.mutate(board_id, () => ({ action: { type: 'column.add', name, color, newId }, pick: saved => findBoard(saved, board_id).columns.find(item => item.id === newId) }));
      });
    tool('update_status', 'Rename, recolor, or set the task limit of a status.', { ...boardArg, status: id,
      name: z.string().trim().min(1).max(80).optional(), color: hexColor.optional(), limit: z.number().int().min(1).max(9999).nullable().optional() },
      async ({ board_id, status, name, color, limit }) => this.mutate(board_id, board => {
        const column = findColumn(board, status);
        return { action: { type: 'column.update', id: column.id, name, color, limit },
          pick: saved => findBoard(saved, board_id).columns.find(item => item.id === column.id) };
      }));
    tool('delete_status', 'Delete a status and move its tasks to another status. Set confirm=true to proceed.', { ...boardArg, status: id, confirm: z.literal(true) },
      async ({ board_id, status }) => this.mutate(board_id, board => {
        if (board.columns.length < 2) throw new Error('Cannot delete the last status');
        const column = findColumn(board, status);
        return { action: { type: 'column.delete', id: column.id }, pick: saved => ({ deleted: true, board_id, status_id: column.id, remaining: findBoard(saved, board_id).columns }) };
      }));
    tool('create_tag', 'Add a colored tag to a board.', { ...boardArg, name: z.string().trim().min(1).max(40), color: hexColor.optional() },
      async ({ board_id, name, color }) => {
        const newId = randomUUID();
        return this.mutate(board_id, () => ({ action: { type: 'tag.add', name, color, newId }, pick: saved => findBoard(saved, board_id).tags.find(item => item.id === newId) }));
      });
    tool('update_tag', 'Rename or recolor a tag.', { ...boardArg, tag_id: id, name: z.string().trim().min(1).max(40).optional(), color: hexColor.optional() },
      async ({ board_id, tag_id, name, color }) => this.mutate(board_id, board => {
        if (!board.tags.some(tag => tag.id === tag_id)) throw new Error('Tag not found');
        return { action: { type: 'tag.update', id: tag_id, name, color }, pick: saved => findBoard(saved, board_id).tags.find(tag => tag.id === tag_id) };
      }));
    tool('delete_tag', 'Delete a tag from the board and all tasks. Set confirm=true to proceed.', { ...boardArg, tag_id: id, confirm: z.literal(true) },
      async ({ board_id, tag_id }) => this.mutate(board_id, board => {
        if (!board.tags.some(tag => tag.id === tag_id)) throw new Error('Tag not found');
        return { action: { type: 'tag.delete', id: tag_id }, pick: () => ({ deleted: true, board_id, tag_id }) };
      }));
    tool('create_task', 'Create a task in a status. The next board number is assigned automatically.', { ...boardArg,
      title: z.string().trim().min(1).max(200), status: z.string().max(99).optional(), description: z.string().max(20000).optional(),
      link: z.string().max(2048).optional(), priority: z.enum(PRIORITIES).optional(), due_date: z.iso.date().optional(),
      assignee: z.string().max(80).optional(), color: hexColor.optional(), tag_ids: z.array(id).max(200).optional() },
    async ({ board_id, status, title, description, link, priority, due_date, assignee, color, tag_ids }) => {
      const newId = randomUUID();
      return this.mutate(board_id, board => {
        const columnId = status ? findColumn(board, status).id : board.columns[0].id;
        if (link && !normalizeLink(link)) throw new Error('Invalid http(s) link');
        if (tag_ids?.some(id => !board.tags.some(tag => tag.id === id))) throw new Error('Unknown tag ID');
        return { actions: [
          { type: 'card.add', title, columnId, newId },
          { type: 'card.update', id: newId, description, link, priority, dueDate: due_date, assignee, color, tagIds: tag_ids }
        ], pick: saved => taskView(findBoard(saved, board_id), findTask(findBoard(saved, board_id), newId)) };
      });
    });
    tool('update_task', 'Edit task fields, including priority, link, due date, assignee and tags. Empty link/date clears the field.', { ...taskArg,
      title: z.string().trim().min(1).max(200).optional(), description: z.string().max(20000).optional(), link: z.string().max(2048).optional(),
      priority: z.enum(PRIORITIES).optional(), due_date: z.union([z.iso.date(), z.literal('')]).optional(), assignee: z.string().max(80).optional(),
      color: z.union([hexColor, z.literal('')]).optional(), tag_ids: z.array(id).max(200).optional() },
    async ({ board_id, task, due_date, tag_ids, link, ...fields }) => this.mutate(board_id, board => {
      const item = findTask(board, task);
      if (link && !normalizeLink(link)) throw new Error('Invalid http(s) link');
      if (tag_ids?.some(id => !board.tags.some(tag => tag.id === id))) throw new Error('Unknown tag ID');
      return { action: { type: 'card.update', id: item.id, ...fields, link, dueDate: due_date, tagIds: tag_ids },
        pick: saved => taskView(findBoard(saved, board_id), findTask(findBoard(saved, board_id), item.id)) };
    }));
    tool('move_task', 'Move a task to a status, optionally at a zero-based position.', { ...taskArg, status: z.string().min(1).max(99), index: z.number().int().min(0).optional() },
      async ({ board_id, task, status, index }) => this.mutate(board_id, board => {
        const item = findTask(board, task);
        return { action: { type: 'card.move', id: item.id, columnId: findColumn(board, status).id, index },
          pick: saved => taskView(findBoard(saved, board_id), findTask(findBoard(saved, board_id), item.id)) };
      }));
    tool('archive_task', 'Archive or restore a task.', { ...taskArg, archived: z.boolean().default(true) },
      async ({ board_id, task, archived }) => this.mutate(board_id, board => {
        const item = findTask(board, task);
        return { action: { type: 'card.archive', id: item.id, archived }, pick: saved => taskView(findBoard(saved, board_id), findTask(findBoard(saved, board_id), item.id)) };
      }));
    tool('delete_task', 'Permanently delete a task. Set confirm=true to proceed.', { ...taskArg, confirm: z.literal(true) },
      async ({ board_id, task }) => this.mutate(board_id, board => {
        const item = findTask(board, task);
        return { action: { type: 'card.delete', id: item.id }, pick: () => ({ deleted: true, board_id, task_id: item.id, number: item.number }) };
      }));
    tool('add_checklist_item', 'Add a checklist item to a task.', { ...taskArg, text: z.string().trim().min(1).max(300) },
      async ({ board_id, task, text }) => this.mutate(board_id, board => {
        const item = findTask(board, task), newId = randomUUID();
        return { action: { type: 'check.add', id: item.id, newId, text },
          pick: saved => findTask(findBoard(saved, board_id), item.id).checklist.find(check => check.id === newId) };
      }));
    tool('set_checklist_item', 'Mark a checklist item done or not done.', { ...taskArg, item_id: id, done: z.boolean() },
      async ({ board_id, task, item_id, done }) => this.mutate(board_id, board => {
        const item = findTask(board, task), check = item.checklist.find(entry => entry.id === item_id);
        if (!check) throw new Error('Checklist item not found');
        return { action: check.done === done ? null : { type: 'check.toggle', id: item.id, checkId: item_id },
          pick: saved => findTask(findBoard(saved, board_id), item.id).checklist.find(entry => entry.id === item_id) };
      }));
    tool('delete_checklist_item', 'Remove a checklist item. Set confirm=true to proceed.', { ...taskArg, item_id: id, confirm: z.literal(true) },
      async ({ board_id, task, item_id }) => this.mutate(board_id, board => {
        const item = findTask(board, task);
        if (!item.checklist.some(entry => entry.id === item_id)) throw new Error('Checklist item not found');
        return { action: { type: 'check.delete', id: item.id, checkId: item_id }, pick: () => ({ deleted: true, item_id }) };
      }));
    tool('delete_board', 'Permanently delete a board and all its tasks. Set confirm=true to proceed.', { ...boardArg, confirm: z.literal(true) },
      async ({ board_id }) => this.mutate(board_id, (board, state) => {
        if (state.boards.length < 2) throw new Error('Cannot delete the last board');
        return { action: { type: 'board.delete' }, pick: () => ({ deleted: true, board_id }) };
      }));
    return server;
  }

  async start() {
    if (this.listener?.listening) return;
    if (!this.config.token) { this.config.token = randomBytes(32).toString('hex'); await this.save(); }
    this.handler = createMcpHandler(() => this.createTools());
    const nodeHandler = toNodeHandler(this.handler);
    const validateHost = localhostHostValidation();
    const validateOrigin = localhostOriginValidation();
    const listener = createServer((req, res) => {
      if (!validateHost(req, res) || !validateOrigin(req, res)) return;
      if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
      const auth = req.headers.authorization || '';
      const expected = `Bearer ${this.config.token}`;
      const left = Buffer.from(auth), right = Buffer.from(expected);
      if (left.length !== right.length || !timingSafeEqual(left, right)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Bearer', 'Content-Type': 'text/plain' }).end('Unauthorized'); return;
      }
      void nodeHandler(req, res).catch(error => { if (!res.headersSent) res.writeHead(500).end(); this.error = error.message; });
    });
    listener.requestTimeout = 30000;
    listener.headersTimeout = 10000;
    await new Promise((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(this.config.port, '127.0.0.1', () => { listener.off('error', reject); resolve(); });
    }).catch(async error => { listener.close(); await this.handler.close(); this.handler = null; throw error; });
    this.listener = listener;
    this.error = '';
  }

  async stop() {
    const listener = this.listener;
    this.listener = null;
    const handler = this.handler;
    this.handler = null;
    if (handler) await handler.close();
    if (listener) await new Promise(resolve => listener.close(resolve));
  }
}
