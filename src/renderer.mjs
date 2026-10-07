import { createInitialState, getBoard, normalizeState, updateState, PRIORITIES, COLORS } from './model.mjs';

let state = createInitialState();
let search = '';
let priorityFilter = '';
let tagFilter = '';
let dueFilter = '';
let pendingSaves = 0;
let toastTimer;
let draggingId = null;

const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const dateToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
const dateLabel = value => value ? new Intl.DateTimeFormat('ru', { day:'numeric', month:'short' }).format(new Date(`${value}T12:00:00`)) : '';
const priorityNames = { none:'Без приоритета', low:'Низкий', medium:'Средний', high:'Высокий', urgent:'Срочно' };
const cardRef = card => `#${String(card.number).padStart(3,'0')}`;
const board = () => getBoard(state);

function toast(message) {
  const el = $('#toast'); el.textContent = message; el.classList.add('visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('visible'), 3200);
}

function persist() {
  pendingSaves++;
  $('#save-state').textContent = '● Сохранение...';
  $('#save-state').classList.remove('error');
  window.lokan.save(state).then(() => {
    pendingSaves--; if (!pendingSaves) $('#save-state').textContent = '● Сохранено';
  }).catch(error => {
    pendingSaves--; $('#save-state').textContent = '● Ошибка сохранения';
    $('#save-state').classList.add('error'); toast(`Не удалось сохранить: ${error.message}`);
  });
}

function dispatch(action) {
  const previous = state;
  state = updateState(state, action);
  if (state === previous) return;
  render(); persist();
}

function matches(card) {
  const b = board();
  const term = search.trim().toLocaleLowerCase();
  if (term && ![card.title, card.description, cardRef(card), ...card.tagIds.map(id => b.tags.find(t => t.id === id)?.name || '')].join(' ').toLocaleLowerCase().includes(term)) return false;
  if (priorityFilter && card.priority !== priorityFilter) return false;
  if (tagFilter && !card.tagIds.includes(tagFilter)) return false;
  if (dueFilter === 'none' && card.dueDate) return false;
  const today = dateToday();
  if (dueFilter === 'overdue' && (!card.dueDate || card.dueDate >= today)) return false;
  if (dueFilter === 'today' && card.dueDate !== today) return false;
  if (dueFilter === 'week') {
    const end = new Date(`${today}T12:00:00`); end.setDate(end.getDate() + 7);
    const endString = `${end.getFullYear()}-${String(end.getMonth()+1).padStart(2,'0')}-${String(end.getDate()).padStart(2,'0')}`;
    if (!card.dueDate || card.dueDate < today || card.dueDate > endString) return false;
  }
  return true;
}

function cardHtml(card) {
  const b = board();
  const tags = card.tagIds.map(id => b.tags.find(t => t.id === id)).filter(Boolean);
  const complete = card.checklist.filter(item => item.done).length;
  const dateState = card.dueDate && card.dueDate < dateToday() ? 'overdue' : card.dueDate === dateToday() ? 'today' : '';
  return `<article class="task-card" data-id="${escape(card.id)}" draggable="true" tabindex="0" role="button" ${card.color ? `style="border-left:3px solid ${card.color}"` : ''} aria-label="Открыть задачу ${escape(cardRef(card))}: ${escape(card.title)}">
    <div class="task-meta"><span class="task-number">${escape(cardRef(card))}</span>${card.priority !== 'none' ? `<span class="priority ${card.priority}">${priorityNames[card.priority]}</span>` : ''}</div>
    <div class="task-title">${escape(card.title)}</div>${card.description ? `<div class="task-description">${escape(card.description)}</div>` : ''}
    ${tags.length ? `<div class="task-tags">${tags.map(t => `<span class="tag" style="color:${t.color};background:${t.color}22">${escape(t.name)}</span>`).join('')}</div>` : ''}
    ${card.dueDate || card.checklist.length ? `<div class="task-footer">${card.dueDate ? `<span class="due ${dateState}">◷ ${escape(dateLabel(card.dueDate))}</span>` : ''}${card.checklist.length ? `<span>☑ ${complete}/${card.checklist.length}</span>` : ''}</div>` : ''}
  </article>`;
}

function render() {
  const b = board();
  document.documentElement.dataset.theme = state.theme;
  $('#theme-toggle').textContent = state.theme === 'dark' ? '☀' : '☾';
  $('#board-list').innerHTML = state.boards.map(item => {
    const count = item.cards.filter(c => !c.archived).length;
    return `<button type="button" class="board-nav ${item.id === b.id ? 'active' : ''}" data-board="${escape(item.id)}"><span class="board-dot" style="background:${item.color}"></span><span class="nav-name">${escape(item.name)}</span><span class="nav-count">${count}</span></button>`;
  }).join('');
  $('#breadcrumb-board').textContent = b.name;
  $('#board-title').textContent = b.name;
  const active = b.cards.filter(c => !c.archived);
  const doneId = b.columns.at(-1)?.id;
  const done = active.filter(c => c.columnId === doneId).length;
  $('#board-subtitle').textContent = `${active.length} задач · ${done} в последней колонке · ${b.columns.length} статусов`;
  $('#archive-count').textContent = b.cards.filter(c => c.archived).length;
  $('#board-stats').textContent = `${active.length} активных задач · ${active.filter(c => c.dueDate && c.dueDate < dateToday()).length} просрочено`;
  const tagSelect = $('#filter-tag');
  tagSelect.innerHTML = `<option value="">Все теги</option>${b.tags.map(t => `<option value="${escape(t.id)}">${escape(t.name)}</option>`).join('')}`;
  if (!b.tags.some(t => t.id === tagFilter)) tagFilter = '';
  tagSelect.value = tagFilter;
  $('#clear-filters').hidden = !(search || priorityFilter || tagFilter || dueFilter);
  $('#board').innerHTML = b.columns.map(column => {
    const all = active.filter(c => c.columnId === column.id).sort((a,c) => a.order - c.order);
    const visible = all.filter(matches);
    const count = column.limit ? `${all.length}/${column.limit}` : all.length;
    return `<section class="column" data-column="${escape(column.id)}" aria-label="${escape(column.name)}">
      <div class="column-header"><span class="column-color" style="background:${column.color}"></span><h2 class="column-title" title="${escape(column.name)}">${escape(column.name)}</h2><span class="column-count ${column.limit && all.length > column.limit ? 'exceeded' : ''}" title="${column.limit ? 'Лимит задач' : 'Количество задач'}">${count}</span><button type="button" class="icon-button column-menu" data-edit-column="${escape(column.id)}" title="Настройки колонки" aria-label="Настройки колонки">⋯</button></div>
      <div class="cards">${visible.length ? visible.map(cardHtml).join('') : `<div class="empty-column">${all.length ? 'Нет задач по фильтру' : 'Пока пусто'}</div>`}</div>
      <button type="button" class="card-add" data-add-column="${escape(column.id)}"><span>＋</span> Добавить задачу</button>
    </section>`;
  }).join('') + `<button type="button" id="add-column" class="add-column">＋ Добавить статус</button>`;
}

function closeModal() { $('#modal-root').innerHTML = ''; }
function openModal(title, subtitle, body, footer = '', wide = false) {
  $('#modal-root').innerHTML = `<div class="modal-backdrop"><div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-header"><div><h2 id="modal-title">${escape(title)}</h2>${subtitle ? `<p>${escape(subtitle)}</p>` : ''}</div><button type="button" class="icon-button" id="modal-close" aria-label="Закрыть">×</button></div><div class="modal-body">${body}</div>${footer ? `<div class="modal-footer">${footer}</div>` : ''}</div></div>`;
  $('#modal-close').onclick = closeModal;
  $('.modal-backdrop').addEventListener('mousedown', event => { if (event.target.classList.contains('modal-backdrop')) closeModal(); });
  $('.modal input:not([type=checkbox]):not([type=color]),.modal textarea')?.focus();
}

function confirmAction(title, message, button, action) {
  openModal(title, message, '', `<button type="button" class="button secondary" id="cancel-confirm">Отмена</button><div class="right"><button type="button" class="button danger" id="do-confirm">${escape(button)}</button></div>`);
  $('#cancel-confirm').onclick = closeModal;
  $('#do-confirm').onclick = async () => { closeModal(); await action(); };
}

function newCard(columnId = board().columns[0].id) {
  const b = board();
  openModal('Новая задача', 'Задаче будет присвоен следующий номер', `<form id="new-card-form"><div class="field"><label for="new-title">Название</label><input id="new-title" maxlength="200" required placeholder="Что нужно сделать?"></div><div class="field"><label for="new-column">Статус</label><select id="new-column">${b.columns.map(c => `<option value="${escape(c.id)}" ${c.id === columnId ? 'selected' : ''}>${escape(c.name)}</option>`).join('')}</select></div></form>`, `<button id="cancel-new" type="button" class="button secondary">Отмена</button><div class="right"><button id="create-card" type="submit" form="new-card-form" class="button primary">Создать задачу</button></div>`);
  $('#cancel-new').onclick = closeModal;
  $('#new-card-form').onsubmit = event => {
    event.preventDefault();
    const title = $('#new-title').value.trim(); if (!title) return;
    dispatch({ type:'card.add', title, columnId:$('#new-column').value });
    const card = board().cards.at(-1); closeModal(); editCard(card.id);
  };
}

function editCard(id) {
  const b = board(); const card = b.cards.find(c => c.id === id);
  if (!card) { closeModal(); return; }
  const tags = b.tags.map(tag => `<button type="button" class="tag-option ${card.tagIds.includes(tag.id) ? 'selected' : ''}" data-tag-pick="${escape(tag.id)}" style="color:${tag.color}">${escape(tag.name)}</button>`).join('');
  const checks = card.checklist.map(check => `<div class="check-row ${check.done ? 'done' : ''}"><input type="checkbox" data-check-toggle="${escape(check.id)}" ${check.done ? 'checked' : ''} aria-label="Выполнено: ${escape(check.text)}"><span>${escape(check.text)}</span><button class="icon-delete" type="button" data-check-delete="${escape(check.id)}" title="Удалить пункт" aria-label="Удалить пункт">×</button></div>`).join('');
  const body = `<form id="card-form"><div class="field"><label for="edit-title">Название</label><input id="edit-title" maxlength="200" required value="${escape(card.title)}"></div><div class="field"><label for="edit-description">Описание</label><textarea id="edit-description" rows="4" maxlength="20000" placeholder="Добавьте детали задачи...">${escape(card.description)}</textarea></div><div class="field-row"><div class="field"><label for="edit-column">Статус</label><select id="edit-column">${b.columns.map(c => `<option value="${escape(c.id)}" ${c.id === card.columnId ? 'selected' : ''}>${escape(c.name)}</option>`).join('')}</select></div><div class="field"><label for="edit-priority">Приоритет</label><select id="edit-priority">${PRIORITIES.map(p => `<option value="${p}" ${p === card.priority ? 'selected' : ''}>${priorityNames[p]}</option>`).join('')}</select></div></div><div class="field-row"><div class="field"><label for="edit-due">Срок</label><input id="edit-due" type="date" value="${escape(card.dueDate)}"></div><div class="field"><label for="edit-color">Цвет карточки</label><select id="edit-color"><option value="">Без цвета</option>${COLORS.map((c,i) => `<option value="${c}" ${c === card.color ? 'selected' : ''}>${['Индиго','Мята','Янтарь','Роза','Сирень','Голубой'][i]}</option>`).join('')}</select></div></div><span class="field-hint">Номер задачи ${escape(cardRef(card))} сохраняется при переносе</span></form><div class="section-title">Теги</div><div class="tag-picker">${tags || `<span class="field-hint">Создайте теги в настройках доски</span>`}</div><div class="section-title">Чек-лист ${card.checklist.length ? `(${card.checklist.filter(c => c.done).length}/${card.checklist.length})` : ''}</div><div class="check-list">${checks || `<span class="field-hint">Добавьте первый пункт</span>`}</div><form id="check-form" class="check-add"><input id="check-text" maxlength="300" placeholder="Новый пункт чек-листа"><button type="submit" class="button secondary">Добавить</button></form>`;
  const footer = `<button id="delete-card" type="button" class="text-button">Удалить</button><div class="right"><button id="archive-card" type="button" class="button secondary">${card.archived ? 'Восстановить' : 'В архив'}</button><button id="save-card" type="submit" form="card-form" class="button primary">Сохранить</button></div>`;
  openModal(`${cardRef(card)} · Задача`, `Создана ${new Intl.DateTimeFormat('ru', { dateStyle:'medium' }).format(new Date(card.createdAt))}`, body, footer, true);
  const saveDraft = () => {
    const current = board().cards.find(c => c.id === id); if (!current) return;
    const title = $('#edit-title').value.trim(); if (!title) { $('#edit-title').focus(); return false; }
    const columnId = $('#edit-column').value;
    const selectedTags = [...document.querySelectorAll('.tag-option.selected')].map(el => el.dataset.tagPick);
    dispatch({ type:'card.update', id, title, description:$('#edit-description').value, priority:$('#edit-priority').value, color:$('#edit-color').value, dueDate:$('#edit-due').value, tagIds:selectedTags });
    if (columnId !== current.columnId) dispatch({ type:'card.move', id, columnId });
    return true;
  };
  $('#card-form').onsubmit = event => { event.preventDefault(); if (saveDraft()) { closeModal(); toast('Задача сохранена'); } };
  document.querySelectorAll('[data-tag-pick]').forEach(el => el.onclick = () => el.classList.toggle('selected'));
  $('#check-form').onsubmit = event => {
    event.preventDefault(); const value = $('#check-text').value.trim(); if (!value || !saveDraft()) return;
    dispatch({ type:'check.add', id, text:value }); editCard(id);
  };
  document.querySelectorAll('[data-check-toggle]').forEach(el => el.onchange = () => { if (saveDraft()) { dispatch({ type:'check.toggle', id, checkId:el.dataset.checkToggle }); editCard(id); } });
  document.querySelectorAll('[data-check-delete]').forEach(el => el.onclick = () => { if (saveDraft()) { dispatch({ type:'check.delete', id, checkId:el.dataset.checkDelete }); editCard(id); } });
  $('#archive-card').onclick = () => { if (saveDraft()) { dispatch({ type:'card.archive', id, archived:!card.archived }); closeModal(); toast(card.archived ? 'Задача восстановлена' : 'Задача в архиве'); } };
  $('#delete-card').onclick = () => confirmAction('Удалить задачу?', `${cardRef(card)} · ${card.title}. Это действие нельзя отменить.`, 'Удалить', () => { dispatch({ type:'card.delete', id }); toast('Задача удалена'); });
}

function createBoardDialog() {
  openModal('Новая доска', 'Отдельное пространство для задач', `<form id="new-board-form"><div class="field"><label for="board-name">Название доски</label><input id="board-name" maxlength="80" required placeholder="Например, Личные проекты"></div></form>`, `<button id="cancel-board" type="button" class="button secondary">Отмена</button><div class="right"><button type="submit" form="new-board-form" class="button primary">Создать доску</button></div>`);
  $('#cancel-board').onclick = closeModal;
  $('#new-board-form').onsubmit = event => { event.preventDefault(); const name = $('#board-name').value.trim(); if (name) { dispatch({ type:'board.add', name }); closeModal(); toast('Доска создана'); } };
}

function createColumnDialog() {
  openModal('Новый статус', 'Колонка появится в конце доски', `<form id="new-column-form"><div class="field"><label for="column-name">Название статуса</label><input id="column-name" maxlength="80" required placeholder="Например, На паузе"></div><div class="field"><label for="column-color">Цвет</label><input id="column-color" class="color-input" type="color" value="${COLORS[0]}"></div></form>`, `<button id="cancel-column" type="button" class="button secondary">Отмена</button><div class="right"><button type="submit" form="new-column-form" class="button primary">Добавить</button></div>`);
  $('#cancel-column').onclick = closeModal;
  $('#new-column-form').onsubmit = event => { event.preventDefault(); const name = $('#column-name').value.trim(); if (name) { dispatch({ type:'column.add', name, color:$('#column-color').value }); closeModal(); } };
}

function archiveDialog() {
  const cards = board().cards.filter(c => c.archived).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
  const body = cards.length ? cards.map(card => `<div class="archive-card"><div><small>${escape(cardRef(card))} · ${escape(board().columns.find(c => c.id === card.columnId)?.name || '')}</small><strong>${escape(card.title)}</strong></div><div class="actions"><button type="button" class="button secondary" data-restore="${escape(card.id)}">Вернуть</button><button type="button" class="icon-delete" data-archive-delete="${escape(card.id)}" title="Удалить навсегда" aria-label="Удалить навсегда">×</button></div></div>`).join('') : `<div class="empty-state"><span class="big">▤</span>Архив пуст</div>`;
  openModal('Архив', `${cards.length} задач`, body);
  document.querySelectorAll('[data-restore]').forEach(el => el.onclick = () => { dispatch({ type:'card.archive', id:el.dataset.restore, archived:false }); archiveDialog(); });
  document.querySelectorAll('[data-archive-delete]').forEach(el => el.onclick = () => {
    const id = el.dataset.archiveDelete;
    confirmAction('Удалить задачу навсегда?', 'Восстановить её после удаления не получится.', 'Удалить', () => { dispatch({ type:'card.delete', id }); archiveDialog(); });
  });
}

function settingsDialog() {
  const b = board();
  const columns = b.columns.map((c,i) => `<div class="settings-row" data-column-row="${escape(c.id)}"><input type="color" value="${c.color}" data-column-color="${escape(c.id)}" title="Цвет колонки"><input type="text" maxlength="80" value="${escape(c.name)}" data-column-name="${escape(c.id)}" aria-label="Название колонки"><input type="number" min="1" max="9999" placeholder="∞" value="${c.limit ?? ''}" data-column-limit="${escape(c.id)}" title="Лимит задач"><button type="button" class="small-button" data-column-up="${escape(c.id)}" ${i === 0 ? 'disabled' : ''} title="Сдвинуть влево">←</button><button type="button" class="small-button" data-column-down="${escape(c.id)}" ${i === b.columns.length - 1 ? 'disabled' : ''} title="Сдвинуть вправо">→</button><button type="button" class="small-button danger" data-column-delete="${escape(c.id)}" ${b.columns.length === 1 ? 'disabled' : ''} title="Удалить колонку">×</button></div>`).join('');
  const tags = b.tags.map(t => `<div class="settings-row"><input type="color" value="${t.color}" data-tag-color="${escape(t.id)}" title="Цвет тега"><input type="text" maxlength="40" value="${escape(t.name)}" data-tag-name="${escape(t.id)}" aria-label="Название тега"><button type="button" class="small-button danger" data-tag-delete="${escape(t.id)}" title="Удалить тег">×</button></div>`).join('');
  const body = `<div class="section-title">Доска</div><div class="settings-row"><input type="color" value="${b.color}" id="settings-board-color" title="Цвет доски"><input id="settings-board-name" type="text" maxlength="80" value="${escape(b.name)}" aria-label="Название доски"><button type="button" id="delete-board" class="small-button danger" ${state.boards.length === 1 ? 'disabled' : ''}>Удалить доску</button></div>
    <div class="section-title">Статусы <span class="field-hint">· ∞ без лимита</span></div><div class="settings-list">${columns}</div><div class="settings-add"><input id="settings-new-column" type="text" maxlength="80" placeholder="Новый статус"><button id="settings-add-column" type="button" class="button secondary">Добавить</button></div>
    <div class="section-title">Теги</div><div class="settings-list">${tags || `<span class="field-hint">Тегов пока нет</span>`}</div><div class="settings-add"><input id="settings-new-tag" type="text" maxlength="40" placeholder="Новый тег"><input id="settings-new-tag-color" type="color" class="color-input" value="${COLORS[1]}" title="Цвет тега"><button id="settings-add-tag" type="button" class="button secondary">Добавить</button></div>
    <div class="section-title">Данные</div><div class="settings-actions"><button id="export-data" class="button secondary" type="button">Экспорт JSON</button><button id="import-data" class="button secondary" type="button">Импорт JSON</button></div><p class="settings-note">Данные сохраняются автоматически в папке приложения на этом устройстве. Экспортируйте файл JSON для резервной копии или переноса.</p><p id="data-location" class="settings-note"></p>`;
  openModal('Настройки', b.name, body, `<div class="right"><button type="button" class="button primary" id="settings-done">Готово</button></div>`, true);
  $('#settings-done').onclick = closeModal;
  $('#settings-board-name').onchange = el => dispatch({ type:'board.update', name:el.target.value });
  $('#settings-board-color').onchange = el => dispatch({ type:'board.update', color:el.target.value });
  $('#delete-board').onclick = () => confirmAction('Удалить доску?', `Доска «${b.name}» и все её задачи будут удалены без возможности восстановления.`, 'Удалить доску', () => { dispatch({ type:'board.delete' }); settingsDialog(); });
  document.querySelectorAll('[data-column-name]').forEach(el => el.onchange = () => dispatch({ type:'column.update', id:el.dataset.columnName, name:el.value }));
  document.querySelectorAll('[data-column-color]').forEach(el => el.onchange = () => dispatch({ type:'column.update', id:el.dataset.columnColor, color:el.value }));
  document.querySelectorAll('[data-column-limit]').forEach(el => el.onchange = () => dispatch({ type:'column.update', id:el.dataset.columnLimit, limit:el.value ? Number(el.value) : null }));
  document.querySelectorAll('[data-column-up]').forEach(el => el.onclick = () => { dispatch({ type:'column.move', id:el.dataset.columnUp, delta:-1 }); settingsDialog(); });
  document.querySelectorAll('[data-column-down]').forEach(el => el.onclick = () => { dispatch({ type:'column.move', id:el.dataset.columnDown, delta:1 }); settingsDialog(); });
  document.querySelectorAll('[data-column-delete]').forEach(el => el.onclick = () => {
    const column = b.columns.find(c => c.id === el.dataset.columnDelete);
    confirmAction('Удалить статус?', `Задачи из «${column.name}» перейдут в другую колонку.`, 'Удалить', () => { dispatch({ type:'column.delete', id:column.id }); settingsDialog(); });
  });
  $('#settings-add-column').onclick = () => { const name = $('#settings-new-column').value.trim(); if (name) { dispatch({ type:'column.add', name }); settingsDialog(); } };
  $('#settings-new-column').onkeydown = e => { if (e.key === 'Enter') $('#settings-add-column').click(); };
  document.querySelectorAll('[data-tag-name]').forEach(el => el.onchange = () => {
    const t = b.tags.find(t => t.id === el.dataset.tagName); dispatch({ type:'tag.update', id:t.id, name:el.value, color:t.color });
  });
  document.querySelectorAll('[data-tag-color]').forEach(el => el.onchange = () => {
    const t = b.tags.find(t => t.id === el.dataset.tagColor); dispatch({ type:'tag.update', id:t.id, name:t.name, color:el.value });
  });
  document.querySelectorAll('[data-tag-delete]').forEach(el => el.onclick = () => { dispatch({ type:'tag.delete', id:el.dataset.tagDelete }); settingsDialog(); });
  $('#settings-add-tag').onclick = () => { const name = $('#settings-new-tag').value.trim(); if (name) { dispatch({ type:'tag.add', name, color:$('#settings-new-tag-color').value }); settingsDialog(); } };
  $('#settings-new-tag').onkeydown = e => { if (e.key === 'Enter') $('#settings-add-tag').click(); };
  $('#export-data').onclick = async () => { try { if (await window.lokan.export()) toast('Резервная копия сохранена'); } catch(error) { toast(`Ошибка экспорта: ${error.message}`); } };
  $('#import-data').onclick = () => confirmAction('Импортировать данные?', 'Текущие данные будут заменены содержимым выбранного файла. Сделайте экспорт, если нужна копия.', 'Выбрать файл', async () => {
    try { const imported = await window.lokan.import(); if (imported) { state = normalizeState(imported); search = priorityFilter = tagFilter = dueFilter = ''; $('#search').value = ''; $('#filter-priority').value = ''; $('#filter-due').value = ''; render(); settingsDialog(); toast('Данные импортированы'); } else settingsDialog(); }
    catch(error) { settingsDialog(); toast(`Ошибка импорта: ${error.message}`); }
  });
  window.lokan.dataPath().then(path => { const target = $('#data-location'); if (target) target.textContent = `Файл данных: ${path}`; });
}

$('#board-list').addEventListener('click', event => {
  const nav = event.target.closest('[data-board]');
  if (nav) { dispatch({ type:'board.select', id:nav.dataset.board }); tagFilter = ''; render(); }
});
$('#board').addEventListener('click', event => {
  const editColumn = event.target.closest('[data-edit-column]');
  const addColumnCard = event.target.closest('[data-add-column]');
  const card = event.target.closest('.task-card');
  if (editColumn) settingsDialog();
  else if (addColumnCard) newCard(addColumnCard.dataset.addColumn);
  else if (card) editCard(card.dataset.id);
  else if (event.target.closest('#add-column')) createColumnDialog();
});
$('#board').addEventListener('keydown', event => {
  if ((event.key === 'Enter' || event.key === ' ') && event.target.classList.contains('task-card')) { event.preventDefault(); editCard(event.target.dataset.id); }
});
$('#board').addEventListener('dragstart', event => {
  const card = event.target.closest('.task-card'); if (!card) return;
  draggingId = card.dataset.id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', draggingId);
  requestAnimationFrame(() => card.classList.add('dragging'));
});
$('#board').addEventListener('dragend', () => { draggingId = null; document.querySelectorAll('.dragging,.drag-over').forEach(el => el.classList.remove('dragging','drag-over')); });
$('#board').addEventListener('dragover', event => {
  const column = event.target.closest('.column'); if (!column || !draggingId) return;
  event.preventDefault(); event.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over')); column.classList.add('drag-over');
});
$('#board').addEventListener('drop', event => {
  const column = event.target.closest('.column'); if (!column || !draggingId) return;
  event.preventDefault();
  const cards = [...column.querySelectorAll('.task-card:not(.dragging)')];
  const index = cards.findIndex(el => event.clientY < el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2);
  dispatch({ type:'card.move', id:draggingId, columnId:column.dataset.column, index:index < 0 ? cards.length : index });
  draggingId = null;
});

$('#add-board').onclick = createBoardDialog;
$('#open-settings').onclick = settingsDialog;
$('#new-card').onclick = () => newCard();
$('#show-archive').onclick = archiveDialog;
$('#theme-toggle').onclick = () => dispatch({ type:'theme.set', theme:state.theme === 'dark' ? 'light' : 'dark' });
$('#search').oninput = event => { search = event.target.value; render(); };
$('#filter-priority').onchange = event => { priorityFilter = event.target.value; render(); };
$('#filter-tag').onchange = event => { tagFilter = event.target.value; render(); };
$('#filter-due').onchange = event => { dueFilter = event.target.value; render(); };
$('#clear-filters').onclick = () => { search = priorityFilter = tagFilter = dueFilter = ''; $('#search').value = ''; $('#filter-priority').value = ''; $('#filter-due').value = ''; render(); };
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && $('#modal-root').children.length) { closeModal(); return; }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); closeModal(); $('#search').focus(); return; }
  const writing = ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName) || $('#modal-root').children.length;
  if (!writing && event.key.toLowerCase() === 'n') { event.preventDefault(); newCard(); }
});

try {
  const loaded = await window.lokan.load();
  state = normalizeState(loaded.state);
  render();
  if (loaded.recovered) toast('Данные восстановлены из резервной копии');
} catch (error) {
  render();
  $('#save-state').textContent = '● Ошибка загрузки'; $('#save-state').classList.add('error');
  toast(`Не удалось загрузить данные: ${error.message}`);
}
