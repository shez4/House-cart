'use strict';

const LS_KEY = 'housecart.me';
let me = null;                 // { id, name, color }
let state = { roommates: [], items: [] };
let currentView = 'shopping';
let pollTimer = null;

// ---- tiny helpers --------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const k of kids) node.append(k?.nodeType ? k : document.createTextNode(k ?? ''));
  return node;
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    let msg = 'Something went wrong.';
    try { msg = (await res.json()).error || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 1800);
}

// ---- data ----------------------------------------------------------------
async function refresh() {
  state = await api('/api/state');
  // Keep our own identity fresh (name/colour may change server-side).
  if (me) {
    const mine = state.roommates.find((r) => r.id === me.id);
    if (mine) { me = mine; localStorage.setItem(LS_KEY, JSON.stringify(me)); }
  }
  if (me) render();
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { refresh().catch(() => {}); }, 4000);
}

// ---- onboarding ----------------------------------------------------------
function showOnboarding() {
  $('#app').classList.add('hidden');
  $('#add-modal').classList.add('hidden');
  const overlay = $('#onboarding');
  overlay.classList.remove('hidden');

  const picker = $('#roommate-picker');
  picker.innerHTML = '';
  for (const r of state.roommates) {
    const btn = el('button', { className: 'pick-btn', type: 'button' });
    btn.append(dot(r.color), r.name);
    btn.onclick = () => setMe(r);
    picker.append(btn);
  }
}

async function onboardSubmit(e) {
  e.preventDefault();
  const input = $('#new-roommate-name');
  const name = input.value.trim();
  if (!name) return;
  try {
    const r = await api('/api/roommates', { method: 'POST', body: JSON.stringify({ name }) });
    input.value = '';
    await refresh();
    setMe(r);
  } catch (err) { toast(err.message); }
}

function setMe(r) {
  me = r;
  localStorage.setItem(LS_KEY, JSON.stringify(me));
  $('#onboarding').classList.add('hidden');
  $('#app').classList.remove('hidden');
  render();
}

function switchUser() {
  me = null;
  localStorage.removeItem(LS_KEY);
  refresh().then(showOnboarding);
}

// ---- rendering -----------------------------------------------------------
function dot(color) {
  return el('span', { className: 'dot', style: `background:${color}` });
}

function render() {
  // who chip
  const chip = $('#who-chip');
  chip.innerHTML = '';
  chip.append(dot(me.color), me.name);

  // active tab
  document.querySelectorAll('.tab').forEach((t) =>
    t.classList.toggle('is-active', t.dataset.view === currentView));

  const view = $('#view');
  view.innerHTML = '';
  ({
    shopping: renderShopping,
    house: renderHouse,
    mine: renderMine,
    bought: renderBought,
  })[currentView](view);
}

function sectionHead(title, count) {
  const head = el('div', { className: 'section-head' }, el('h2', {}, title));
  head.append(el('span', { className: 'count' }, String(count)));
  return head;
}

function emptyState(emoji, text) {
  const box = el('div', { className: 'empty' });
  box.append(el('span', { className: 'big' }, emoji), el('div', {}, text));
  return box;
}

// Shopping: everything still to buy — house first, then each roommate's list.
function renderShopping(view) {
  const active = state.items.filter((i) => !i.bought);
  if (active.length === 0) {
    view.append(emptyState('🎉', 'Nothing to buy right now. You\'re all stocked up!'));
    return;
  }

  const house = active.filter((i) => i.list_type === 'house');
  if (house.length) {
    view.append(sectionHead('🏠 House', house.length));
    house.forEach((i) => view.append(itemCard(i)));
  }

  for (const r of state.roommates) {
    const personal = active.filter((i) => i.list_type === 'personal' && i.owner_id === r.id);
    if (!personal.length) continue;
    const label = r.id === me.id ? '🙋 Your list' : `🙋 ${r.name}'s list`;
    view.append(sectionHead(label, personal.length));
    personal.forEach((i) => view.append(itemCard(i)));
  }
}

function renderHouse(view) {
  const items = state.items.filter((i) => i.list_type === 'house' && !i.bought);
  view.append(sectionHead('🏠 House list', items.length));
  if (!items.length) { view.append(emptyState('🏠', 'The house list is empty. Tap ＋ to add something.')); return; }
  items.forEach((i) => view.append(itemCard(i)));
}

function renderMine(view) {
  const items = state.items.filter((i) => i.list_type === 'personal' && i.owner_id === me.id && !i.bought);
  view.append(sectionHead('🙋 My personal list', items.length));
  if (!items.length) { view.append(emptyState('🙋', 'Nothing personal yet. Tap ＋ and choose "My personal list".')); return; }
  items.forEach((i) => view.append(itemCard(i)));
}

function renderBought(view) {
  const items = state.items.filter((i) => i.bought);
  const head = el('div', { className: 'section-head' }, el('h2', {}, '✅ Bought'));
  head.append(el('span', { className: 'count' }, String(items.length)));
  view.append(head);
  if (!items.length) { view.append(emptyState('🛒', 'Nothing bought yet.')); return; }

  const clear = el('button', { className: 'mini-btn danger', style: 'margin:0 4px 12px' }, 'Clear all bought');
  clear.onclick = clearBought;
  view.append(clear);

  items.forEach((i) => view.append(itemCard(i)));
}

// ---- item card -----------------------------------------------------------
function itemCard(item) {
  const card = el('div', { className: 'item' + (item.bought ? ' bought' : '') });

  // check circle
  const check = el('button', { className: 'check' + (item.bought ? ' done' : ''), title: item.bought ? 'Mark as not bought' : 'Mark as bought' });
  if (item.bought) check.textContent = '✓';
  check.onclick = () => toggleBought(item);
  card.append(check);

  // body
  const body = el('div', { className: 'item-body' });
  const title = el('div', { className: 'item-title' });
  if (item.quantity) title.append(el('span', { className: 'qty' }, item.quantity));
  title.append(item.name);
  body.append(title);
  if (item.note) body.append(el('div', { className: 'item-note' }, item.note));

  // chips
  const chips = el('div', { className: 'chips' });
  if (item.list_type === 'personal' && item.owner_name) {
    const c = el('span', { className: 'chip' });
    c.append(dot(item.owner_color || '#999'), `for ${item.owner_id === me.id ? 'you' : item.owner_name}`);
    chips.append(c);
  }
  if (item.bought && item.bought_by_name) {
    chips.append(el('span', { className: 'chip' }, `✅ ${item.bought_by_name === me.name ? 'you' : item.bought_by_name}`));
  } else if (item.claimed_by && item.claimed_by_name) {
    const c = el('span', { className: 'chip claimed' });
    c.append(`🛍️ ${item.claimed_by === me.id ? "you're getting this" : item.claimed_by_name + ' is getting this'}`);
    chips.append(c);
  }
  if (chips.children.length) body.append(chips);

  // actions (hidden once bought)
  if (!item.bought) {
    const actions = el('div', { className: 'item-actions' });
    if (!item.claimed_by) {
      const b = el('button', { className: 'mini-btn primary' }, "I'll get it");
      b.onclick = () => claim(item, me.id);
      actions.append(b);
    } else if (item.claimed_by === me.id) {
      const b = el('button', { className: 'mini-btn' }, 'Unclaim');
      b.onclick = () => claim(item, null);
      actions.append(b);
    }
    const del = el('button', { className: 'mini-btn danger' }, 'Delete');
    del.onclick = () => removeItem(item);
    actions.append(del);
    body.append(actions);
  } else {
    const actions = el('div', { className: 'item-actions' });
    const del = el('button', { className: 'mini-btn danger' }, 'Delete');
    del.onclick = () => removeItem(item);
    actions.append(del);
    body.append(actions);
  }

  card.append(body);
  return card;
}

// ---- mutations -----------------------------------------------------------
async function toggleBought(item) {
  try {
    await api(`/api/items/${item.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ bought: !item.bought, bought_by: me.id }),
    });
    toast(item.bought ? 'Back on the list' : `Got it! ✅`);
    await refresh();
  } catch (err) { toast(err.message); }
}

async function claim(item, roommateId) {
  try {
    await api(`/api/items/${item.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ claimed_by: roommateId }),
    });
    await refresh();
  } catch (err) { toast(err.message); }
}

async function removeItem(item) {
  if (!confirm(`Delete "${item.name}"?`)) return;
  try {
    await api(`/api/items/${item.id}`, { method: 'DELETE' });
    await refresh();
  } catch (err) { toast(err.message); }
}

async function clearBought() {
  const bought = state.items.filter((i) => i.bought);
  if (!bought.length) return;
  if (!confirm(`Clear ${bought.length} bought item(s)?`)) return;
  try {
    await Promise.all(bought.map((i) => api(`/api/items/${i.id}`, { method: 'DELETE' })));
    await refresh();
  } catch (err) { toast(err.message); }
}

// ---- add-item modal ------------------------------------------------------
function openAddModal() {
  $('#add-item-form').reset();
  // Default destination follows the current tab.
  const dest = currentView === 'mine' ? 'personal' : 'house';
  $(`input[name="dest"][value="${dest}"]`).checked = true;
  $('#add-modal').classList.remove('hidden');
  setTimeout(() => $('#item-name').focus(), 50);
}
function closeAddModal() { $('#add-modal').classList.add('hidden'); }

async function addItemSubmit(e) {
  e.preventDefault();
  const name = $('#item-name').value.trim();
  if (!name) return;
  const dest = document.querySelector('input[name="dest"]:checked').value;
  const payload = {
    name,
    quantity: $('#item-qty').value,
    note: $('#item-note').value,
    list_type: dest,
    owner_id: dest === 'personal' ? me.id : null,
    added_by: me.id,
  };
  try {
    await api('/api/items', { method: 'POST', body: JSON.stringify(payload) });
    closeAddModal();
    toast('Added to the list');
    await refresh();
  } catch (err) { toast(err.message); }
}

// ---- wire up -------------------------------------------------------------
function init() {
  $('#add-me-form').addEventListener('submit', onboardSubmit);
  $('#who-chip').addEventListener('click', switchUser);
  $('#fab').addEventListener('click', openAddModal);
  $('#cancel-add').addEventListener('click', closeAddModal);
  $('#add-item-form').addEventListener('submit', addItemSubmit);
  $('#add-modal').addEventListener('click', (e) => { if (e.target.id === 'add-modal') closeAddModal(); });

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => { currentView = tab.dataset.view; render(); });
  });

  const saved = localStorage.getItem(LS_KEY);
  if (saved) { try { me = JSON.parse(saved); } catch { me = null; } }

  refresh()
    .then(() => {
      // Validate stored identity still exists on the server.
      if (me && !state.roommates.find((r) => r.id === me.id)) me = null;
      if (me) setMe(me); else showOnboarding();
      startPolling();
    })
    .catch(() => {
      toast('Could not reach the server.');
      showOnboarding();
    });
}

document.addEventListener('DOMContentLoaded', init);
