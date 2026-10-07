import { createInitialState, getBoard, normalizeState, normalizeLink, updateState, PRIORITIES, COLORS } from './model.mjs';
import { translate } from './i18n.mjs';

let state = createInitialState();
let search = '';
let priorityFilter = '';
let tagFilter = '';
let dueFilter = '';
let pendingSaves = 0;
let toastTimer;
let draggingId = null;
let saveFailed = false;

const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const dateToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
const t = (key, values) => translate(state.language, key, values);
const tr = (key, values) => escape(t(key, values));
const dateLabel = value => value ? new Intl.DateTimeFormat(state.language === 'en' ? 'en-US' : 'ru-RU', { day:'numeric', month:'short' }).format(new Date(`${value}T12:00:00`)) : '';
const priorityName = value => t(value === 'none' ? 'noPriority' : value);
const cardRef = card => `#${card.number}`;
const board = () => getBoard(state);

function applyStaticTranslations() {
  document.documentElement.lang = state.language;
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  for (const [dataKey, attribute] of [['i18nTitle','title'], ['i18nAria','aria-label'], ['i18nPlaceholder','placeholder']]) {
    document.querySelectorAll(`[data-${dataKey.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}]`).forEach(el => el.setAttribute(attribute, t(el.dataset[dataKey])));
  }
  document.querySelectorAll('[data-language]').forEach(el => {
    el.classList.toggle('active', el.dataset.language === state.language);
    el.setAttribute('aria-pressed', String(el.dataset.language === state.language));
  });
}

function toast(message) {
  const el = $('#toast'); el.textContent = message; el.classList.add('visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('visible'), 3200);
}

function persist() {
  pendingSaves++;
  saveFailed = false;
  $('#save-state').textContent = t('saving');
  $('#save-state').classList.remove('error');
  window.lokan.save(state).then(() => {
    pendingSaves--; if (!pendingSaves && !saveFailed) $('#save-state').textContent = t('saved');
  }).catch(error => {
    pendingSaves--; saveFailed = true; $('#save-state').textContent = t('saveError');
    $('#save-state').classList.add('error'); toast(t('saveErrorToast', { error:error.message }));
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
  if (term && ![card.title, card.description, card.link, cardRef(card), ...card.tagIds.map(id => b.tags.find(t => t.id === id)?.name || '')].join(' ').toLocaleLowerCase().includes(term)) return false;
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
  return `<article class="task-card" data-id="${escape(card.id)}" draggable="true" tabindex="0" role="button" ${card.color ? `style="border-left:3px solid ${card.color}"` : ''} aria-label="${escape(t('openTask', { number:cardRef(card), title:card.title }))}">
    <div class="task-meta"><span class="task-number">${escape(cardRef(card))}</span>${card.priority !== 'none' ? `<span class="priority ${card.priority}">${escape(priorityName(card.priority))}</span>` : ''}${card.link ? `<button type="button" class="task-link-icon" data-card-link="${escape(card.id)}" title="${escape(t('openLink'))}" aria-label="${escape(t('openLink'))}">↗</button>` : ''}</div>
    <div class="task-title">${card.link ? `<button type="button" class="task-title-link" data-card-link="${escape(card.id)}" title="${escape(t('openLink'))}">${escape(card.title)}</button>` : escape(card.title)}</div>${card.description ? `<div class="task-description">${escape(card.description)}</div>` : ''}
    ${tags.length ? `<div class="task-tags">${tags.map(t => `<span class="tag" style="color:${t.color};background:${t.color}22">${escape(t.name)}</span>`).join('')}</div>` : ''}
    ${card.dueDate || card.checklist.length ? `<div class="task-footer">${card.dueDate ? `<span class="due ${dateState}">◷ ${escape(dateLabel(card.dueDate))}</span>` : ''}${card.checklist.length ? `<span>☑ ${complete}/${card.checklist.length}</span>` : ''}</div>` : ''}
  </article>`;
}

function render() {
  const b = board();
  applyStaticTranslations();
  document.documentElement.dataset.theme = state.theme;
  $('#theme-toggle').textContent = state.theme === 'dark' ? '☀' : '☾';
  $('#save-state').textContent = t(saveFailed ? 'saveError' : pendingSaves ? 'saving' : 'saved');
  $('#board-list').innerHTML = state.boards.map(item => {
    const count = item.cards.filter(c => !c.archived).length;
    return `<button type="button" class="board-nav ${item.id === b.id ? 'active' : ''}" data-board="${escape(item.id)}"><span class="board-dot" style="background:${item.color}"></span><span class="nav-name">${escape(item.name)}</span><span class="nav-count">${count}</span></button>`;
  }).join('');
  $('#breadcrumb-board').textContent = b.name;
  $('#board-title').textContent = b.name;
  const active = b.cards.filter(c => !c.archived);
  const doneId = b.columns.at(-1)?.id;
  const done = active.filter(c => c.columnId === doneId).length;
  $('#board-subtitle').textContent = t('boardSubtitle', { tasks:active.length, done, columns:b.columns.length });
  $('#archive-count').textContent = b.cards.filter(c => c.archived).length;
  $('#board-stats').textContent = t('boardStats', { tasks:active.length, overdue:active.filter(c => c.dueDate && c.dueDate < dateToday()).length });
  const tagSelect = $('#filter-tag');
  tagSelect.innerHTML = `<option value="">${escape(t('allTags'))}</option>${b.tags.map(tag => `<option value="${escape(tag.id)}">${escape(tag.name)}</option>`).join('')}`;
  if (!b.tags.some(t => t.id === tagFilter)) tagFilter = '';
  tagSelect.value = tagFilter;
  $('#clear-filters').hidden = !(search || priorityFilter || tagFilter || dueFilter);
  $('#board').innerHTML = b.columns.map(column => {
    const all = active.filter(c => c.columnId === column.id).sort((a,c) => a.order - c.order);
    const visible = all.filter(matches);
    const count = column.limit ? `${all.length}/${column.limit}` : all.length;
    return `<section class="column" data-column="${escape(column.id)}" aria-label="${escape(column.name)}">
      <div class="column-header"><span class="column-color" style="background:${column.color}"></span><h2 class="column-title" title="${escape(column.name)}">${escape(column.name)}</h2><span class="column-count ${column.limit && all.length > column.limit ? 'exceeded' : ''}" title="${escape(t(column.limit ? 'limit' : 'count'))}">${count}</span><button type="button" class="icon-button column-menu" data-edit-column="${escape(column.id)}" title="${escape(t('columnSettings'))}" aria-label="${escape(t('columnSettings'))}">⋯</button></div>
      <div class="cards">${visible.length ? visible.map(cardHtml).join('') : `<div class="empty-column">${escape(t(all.length ? 'noMatches' : 'emptyColumn'))}</div>`}</div>
      <button type="button" class="card-add" data-add-column="${escape(column.id)}"><span>＋</span> ${escape(t('addTask'))}</button>
    </section>`;
  }).join('') + `<button type="button" id="add-column" class="add-column">＋ ${escape(t('addStatus'))}</button>`;
}

function closeModal() { $('#modal-root').innerHTML = ''; }
function openModal(title, subtitle, body, footer = '', wide = false) {
  $('#modal-root').innerHTML = `<div class="modal-backdrop"><div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-header"><div><h2 id="modal-title">${escape(title)}</h2>${subtitle ? `<p>${escape(subtitle)}</p>` : ''}</div><button type="button" class="icon-button" id="modal-close" aria-label="${escape(t('close'))}">×</button></div><div class="modal-body">${body}</div>${footer ? `<div class="modal-footer">${footer}</div>` : ''}</div></div>`;
  $('#modal-close').onclick = closeModal;
  $('.modal-backdrop').addEventListener('mousedown', event => { if (event.target.classList.contains('modal-backdrop')) closeModal(); });
  $('.modal input:not([type=checkbox]):not([type=color]),.modal textarea')?.focus();
}

function confirmAction(title, message, button, action) {
  openModal(title, message, '', `<button type="button" class="button secondary" id="cancel-confirm">${escape(t('cancel'))}</button><div class="right"><button type="button" class="button danger" id="do-confirm">${escape(button)}</button></div>`);
  $('#cancel-confirm').onclick = closeModal;
  $('#do-confirm').onclick = async () => { closeModal(); await action(); };
}

function newCard(columnId = board().columns[0].id) {
  const b = board();
  openModal(t('newTask'), t('newTaskSubtitle'), `<form id="new-card-form"><div class="field"><label for="new-title">${escape(t('title'))}</label><input id="new-title" maxlength="200" required placeholder="${escape(t('titlePlaceholder'))}"></div><div class="field"><label for="new-column">${escape(t('status'))}</label><select id="new-column">${b.columns.map(c => `<option value="${escape(c.id)}" ${c.id === columnId ? 'selected' : ''}>${escape(c.name)}</option>`).join('')}</select></div></form>`, `<button id="cancel-new" type="button" class="button secondary">${escape(t('cancel'))}</button><div class="right"><button id="create-card" type="submit" form="new-card-form" class="button primary">${escape(t('createTask'))}</button></div>`);
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
  const checks = card.checklist.map(check => `<div class="check-row ${check.done ? 'done' : ''}"><input type="checkbox" data-check-toggle="${escape(check.id)}" ${check.done ? 'checked' : ''} aria-label="${escape(t('checkDone', { text:check.text }))}"><span>${escape(check.text)}</span><button class="icon-delete" type="button" data-check-delete="${escape(check.id)}" title="${escape(t('deleteCheck'))}" aria-label="${escape(t('deleteCheck'))}">×</button></div>`).join('');
  const body = `<form id="card-form">
    <div class="field"><label for="edit-title">${escape(t('title'))}</label><input id="edit-title" maxlength="200" required value="${escape(card.title)}"></div>
    <div class="field"><label for="edit-description">${escape(t('description'))}</label><textarea id="edit-description" rows="4" maxlength="20000" placeholder="${escape(t('descriptionPlaceholder'))}">${escape(card.description)}</textarea></div>
    <div class="field"><label for="edit-link">${escape(t('link'))}</label><input id="edit-link" type="text" inputmode="url" maxlength="2048" value="${escape(card.link)}" placeholder="${escape(t('linkPlaceholder'))}"><span class="field-hint">${escape(t('linkHint'))}</span></div>
    <div class="field-row"><div class="field"><label for="edit-column">${escape(t('status'))}</label><select id="edit-column">${b.columns.map(c => `<option value="${escape(c.id)}" ${c.id === card.columnId ? 'selected' : ''}>${escape(c.name)}</option>`).join('')}</select></div><div class="field"><label for="edit-priority">${escape(t('priority'))}</label><select id="edit-priority">${PRIORITIES.map(p => `<option value="${p}" ${p === card.priority ? 'selected' : ''}>${escape(priorityName(p))}</option>`).join('')}</select></div></div>
    <div class="field-row"><div class="field"><label for="edit-due">${escape(t('due'))}</label><input id="edit-due" type="date" value="${escape(card.dueDate)}"></div><div class="field"><label for="edit-color">${escape(t('cardColor'))}</label><select id="edit-color"><option value="">${escape(t('noColor'))}</option>${COLORS.map((c,i) => `<option value="${c}" ${c === card.color ? 'selected' : ''}>${escape(t(['indigo','mint','amber','rose','lilac','blue'][i]))}</option>`).join('')}</select></div></div>
    <span class="field-hint">${escape(t('numberHint', { number:cardRef(card) }))}</span></form>
    <div class="section-title">${escape(t('tags'))}</div><div class="tag-picker">${tags || `<span class="field-hint">${escape(t('tagsHint'))}</span>`}</div>
    <div class="section-title">${escape(t('checklist'))} ${card.checklist.length ? `(${card.checklist.filter(c => c.done).length}/${card.checklist.length})` : ''}</div><div class="check-list">${checks || `<span class="field-hint">${escape(t('firstCheck'))}</span>`}</div>
    <form id="check-form" class="check-add"><input id="check-text" maxlength="300" placeholder="${escape(t('newCheck'))}"><button type="submit" class="button secondary">${escape(t('add'))}</button></form>`;
  const footer = `<button id="delete-card" type="button" class="text-button">${escape(t('delete'))}</button><div class="right"><button id="archive-card" type="button" class="button secondary">${escape(t(card.archived ? 'restore' : 'toArchive'))}</button><button id="save-card" type="submit" form="card-form" class="button primary">${escape(t('save'))}</button></div>`;
  const createdDate = new Intl.DateTimeFormat(state.language === 'en' ? 'en-US' : 'ru-RU', { dateStyle:'medium' }).format(new Date(card.createdAt));
  openModal(`${cardRef(card)} · ${t('task')}`, t('createdOn', { date:createdDate }), body, footer, true);
  const saveDraft = () => {
    const current = board().cards.find(c => c.id === id); if (!current) return;
    const title = $('#edit-title').value.trim(); if (!title) { $('#edit-title').focus(); return false; }
    const rawLink = $('#edit-link').value.trim();
    const link = normalizeLink(rawLink);
    if (rawLink && !link) { $('#edit-link').setCustomValidity(t('invalidLink')); $('#edit-link').reportValidity(); $('#edit-link').focus(); return false; }
    const columnId = $('#edit-column').value;
    const selectedTags = [...document.querySelectorAll('.tag-option.selected')].map(el => el.dataset.tagPick);
    dispatch({ type:'card.update', id, title, description:$('#edit-description').value, link, priority:$('#edit-priority').value, color:$('#edit-color').value, dueDate:$('#edit-due').value, tagIds:selectedTags });
    if (columnId !== current.columnId) dispatch({ type:'card.move', id, columnId });
    return true;
  };
  $('#edit-link').oninput = () => $('#edit-link').setCustomValidity('');
  $('#card-form').onsubmit = event => { event.preventDefault(); if (saveDraft()) { closeModal(); toast(t('taskSaved')); } };
  document.querySelectorAll('[data-tag-pick]').forEach(el => el.onclick = () => el.classList.toggle('selected'));
  $('#check-form').onsubmit = event => {
    event.preventDefault(); const value = $('#check-text').value.trim(); if (!value || !saveDraft()) return;
    dispatch({ type:'check.add', id, text:value }); editCard(id);
  };
  document.querySelectorAll('[data-check-toggle]').forEach(el => el.onchange = () => { if (saveDraft()) { dispatch({ type:'check.toggle', id, checkId:el.dataset.checkToggle }); editCard(id); } });
  document.querySelectorAll('[data-check-delete]').forEach(el => el.onclick = () => { if (saveDraft()) { dispatch({ type:'check.delete', id, checkId:el.dataset.checkDelete }); editCard(id); } });
  $('#archive-card').onclick = () => { if (saveDraft()) { dispatch({ type:'card.archive', id, archived:!card.archived }); closeModal(); toast(t(card.archived ? 'taskRestored' : 'taskArchived')); } };
  $('#delete-card').onclick = () => confirmAction(t('deleteTaskTitle'), t('deleteTaskBody', { number:cardRef(card), title:card.title }), t('delete'), () => { dispatch({ type:'card.delete', id }); toast(t('taskDeleted')); });
}

function createBoardDialog() {
  openModal(t('newBoard'), t('newBoardSubtitle'), `<form id="new-board-form"><div class="field"><label for="board-name">${escape(t('boardName'))}</label><input id="board-name" maxlength="80" required placeholder="${escape(t('boardPlaceholder'))}"></div></form>`, `<button id="cancel-board" type="button" class="button secondary">${escape(t('cancel'))}</button><div class="right"><button type="submit" form="new-board-form" class="button primary">${escape(t('createBoard'))}</button></div>`);
  $('#cancel-board').onclick = closeModal;
  $('#new-board-form').onsubmit = event => { event.preventDefault(); const name = $('#board-name').value.trim(); if (name) { dispatch({ type:'board.add', name }); closeModal(); toast(t('boardCreated')); } };
}

function createColumnDialog() {
  openModal(t('newStatus'), t('newStatusSubtitle'), `<form id="new-column-form"><div class="field"><label for="column-name">${escape(t('statusName'))}</label><input id="column-name" maxlength="80" required placeholder="${escape(t('statusPlaceholder'))}"></div><div class="field"><label for="column-color">${escape(t('color'))}</label><input id="column-color" class="color-input" type="color" value="${COLORS[0]}"></div></form>`, `<button id="cancel-column" type="button" class="button secondary">${escape(t('cancel'))}</button><div class="right"><button type="submit" form="new-column-form" class="button primary">${escape(t('add'))}</button></div>`);
  $('#cancel-column').onclick = closeModal;
  $('#new-column-form').onsubmit = event => { event.preventDefault(); const name = $('#column-name').value.trim(); if (name) { dispatch({ type:'column.add', name, color:$('#column-color').value }); closeModal(); } };
}

function archiveDialog() {
  const cards = board().cards.filter(c => c.archived).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
  const body = cards.length ? cards.map(card => `<div class="archive-card"><div><small>${escape(cardRef(card))} · ${escape(board().columns.find(c => c.id === card.columnId)?.name || '')}</small><strong>${escape(card.title)}</strong></div><div class="actions"><button type="button" class="button secondary" data-restore="${escape(card.id)}">${escape(t('returnTask'))}</button><button type="button" class="icon-delete" data-archive-delete="${escape(card.id)}" title="${escape(t('deletePermanent'))}" aria-label="${escape(t('deletePermanent'))}">×</button></div></div>`).join('') : `<div class="empty-state"><span class="big">▤</span>${escape(t('archiveEmpty'))}</div>`;
  openModal(t('archive'), t('archiveCount', { count:cards.length }), body);
  document.querySelectorAll('[data-restore]').forEach(el => el.onclick = () => { dispatch({ type:'card.archive', id:el.dataset.restore, archived:false }); archiveDialog(); });
  document.querySelectorAll('[data-archive-delete]').forEach(el => el.onclick = () => {
    const id = el.dataset.archiveDelete;
    confirmAction(t('deletePermanentTitle'), t('deletePermanentBody'), t('delete'), () => { dispatch({ type:'card.delete', id }); archiveDialog(); });
  });
}

function settingsDialog() {
  const b = board();
  const columns = b.columns.map((c,i) => `<div class="settings-row" data-column-row="${escape(c.id)}"><input type="color" value="${c.color}" data-column-color="${escape(c.id)}" title="${tr('columnColor')}"><input type="text" maxlength="80" value="${escape(c.name)}" data-column-name="${escape(c.id)}" aria-label="${tr('columnName')}"><input type="number" min="1" max="9999" placeholder="∞" value="${c.limit ?? ''}" data-column-limit="${escape(c.id)}" title="${tr('taskLimit')}"><button type="button" class="small-button" data-column-up="${escape(c.id)}" ${i === 0 ? 'disabled' : ''} title="${tr('moveLeft')}">←</button><button type="button" class="small-button" data-column-down="${escape(c.id)}" ${i === b.columns.length - 1 ? 'disabled' : ''} title="${tr('moveRight')}">→</button><button type="button" class="small-button danger" data-column-delete="${escape(c.id)}" ${b.columns.length === 1 ? 'disabled' : ''} title="${tr('deleteColumn')}">×</button></div>`).join('');
  const tags = b.tags.map(tag => `<div class="settings-row"><input type="color" value="${tag.color}" data-tag-color="${escape(tag.id)}" title="${tr('tagColor')}"><input type="text" maxlength="40" value="${escape(tag.name)}" data-tag-name="${escape(tag.id)}" aria-label="${tr('tagName')}"><button type="button" class="small-button danger" data-tag-delete="${escape(tag.id)}" title="${tr('deleteTag')}">×</button></div>`).join('');
  const body = `<div class="section-title">${tr('boardSection')}</div><div class="settings-row"><input type="color" value="${b.color}" id="settings-board-color" title="${tr('boardColor')}"><input id="settings-board-name" type="text" maxlength="80" value="${escape(b.name)}" aria-label="${tr('boardName')}"><button type="button" id="delete-board" class="small-button danger" ${state.boards.length === 1 ? 'disabled' : ''}>${tr('deleteBoard')}</button></div>
    <div class="section-title">${tr('statusesSection')} <span class="field-hint">· ${tr('noLimit')}</span></div><div class="settings-list">${columns}</div><div class="settings-add"><input id="settings-new-column" type="text" maxlength="80" placeholder="${tr('newStatusPlaceholder')}"><button id="settings-add-column" type="button" class="button secondary">${tr('add')}</button></div>
    <div class="section-title">${tr('tags')}</div><div class="settings-list">${tags || `<span class="field-hint">${tr('noTags')}</span>`}</div><div class="settings-add"><input id="settings-new-tag" type="text" maxlength="40" placeholder="${tr('newTag')}"><input id="settings-new-tag-color" type="color" class="color-input" value="${COLORS[1]}" title="${tr('tagColor')}"><button id="settings-add-tag" type="button" class="button secondary">${tr('add')}</button></div>
    <div class="section-title">${tr('data')}</div><div class="settings-actions"><button id="export-data" class="button secondary" type="button">${tr('exportJson')}</button><button id="import-data" class="button secondary" type="button">${tr('importJson')}</button></div><p class="settings-note">${tr('dataNote')}</p><p id="data-location" class="settings-note"></p>`;
  openModal(t('settings'), b.name, body, `<div class="right"><button type="button" class="button primary" id="settings-done">${tr('done')}</button></div>`, true);
  $('#settings-done').onclick = closeModal;
  $('#settings-board-name').onchange = el => dispatch({ type:'board.update', name:el.target.value });
  $('#settings-board-color').onchange = el => dispatch({ type:'board.update', color:el.target.value });
  $('#delete-board').onclick = () => confirmAction(t('deleteBoardTitle'), t('deleteBoardBody', { name:b.name }), t('deleteBoard'), () => { dispatch({ type:'board.delete' }); settingsDialog(); });
  document.querySelectorAll('[data-column-name]').forEach(el => el.onchange = () => dispatch({ type:'column.update', id:el.dataset.columnName, name:el.value }));
  document.querySelectorAll('[data-column-color]').forEach(el => el.onchange = () => dispatch({ type:'column.update', id:el.dataset.columnColor, color:el.value }));
  document.querySelectorAll('[data-column-limit]').forEach(el => el.onchange = () => dispatch({ type:'column.update', id:el.dataset.columnLimit, limit:el.value ? Number(el.value) : null }));
  document.querySelectorAll('[data-column-up]').forEach(el => el.onclick = () => { dispatch({ type:'column.move', id:el.dataset.columnUp, delta:-1 }); settingsDialog(); });
  document.querySelectorAll('[data-column-down]').forEach(el => el.onclick = () => { dispatch({ type:'column.move', id:el.dataset.columnDown, delta:1 }); settingsDialog(); });
  document.querySelectorAll('[data-column-delete]').forEach(el => el.onclick = () => {
    const column = b.columns.find(c => c.id === el.dataset.columnDelete);
    confirmAction(t('deleteStatusTitle'), t('deleteStatusBody', { name:column.name }), t('delete'), () => { dispatch({ type:'column.delete', id:column.id }); settingsDialog(); });
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
  $('#export-data').onclick = async () => { try { if (await window.lokan.export()) toast(t('backupSaved')); } catch(error) { toast(t('exportError', { error:error.message })); } };
  $('#import-data').onclick = () => confirmAction(t('importTitle'), t('importBody'), t('chooseFile'), async () => {
    try { const imported = await window.lokan.import(); if (imported) { state = normalizeState(imported); search = priorityFilter = tagFilter = dueFilter = ''; $('#search').value = ''; $('#filter-priority').value = ''; $('#filter-due').value = ''; render(); settingsDialog(); toast(t('imported')); } else settingsDialog(); }
    catch(error) { settingsDialog(); toast(t('importError', { error:error.message })); }
  });
  window.lokan.dataPath().then(path => { const target = $('#data-location'); if (target) target.textContent = t('dataPath', { path }); });
}

$('#board-list').addEventListener('click', event => {
  const nav = event.target.closest('[data-board]');
  if (nav) { dispatch({ type:'board.select', id:nav.dataset.board }); tagFilter = ''; render(); }
});
$('#board').addEventListener('click', event => {
  const linkButton = event.target.closest('[data-card-link]');
  const editColumn = event.target.closest('[data-edit-column]');
  const addColumnCard = event.target.closest('[data-add-column]');
  const card = event.target.closest('.task-card');
  if (linkButton) {
    event.stopPropagation();
    const link = board().cards.find(item => item.id === linkButton.dataset.cardLink)?.link;
    if (link) window.lokan.openLink(link).catch(error => toast(t('linkOpenError', { error:error.message })));
  }
  else if (editColumn) settingsDialog();
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
document.querySelectorAll('[data-language]').forEach(el => el.onclick = () => dispatch({ type:'language.set', language:el.dataset.language }));
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
  if (loaded.recovered) toast(t('recovered'));
} catch (error) {
  render();
  $('#save-state').textContent = t('loadError'); $('#save-state').classList.add('error');
  toast(t('loadErrorToast', { error:error.message }));
}
