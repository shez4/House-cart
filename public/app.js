'use strict';

const LS_KEY = 'housecart.me';
let me = null;                 // { id, name, color }
let state = { roommates: [], items: [], parsing_enabled: false, default_currency: '£' };
let receipts = [];             // list of receipts (with items) for the Split tab
let openReceiptId = null;      // id of the receipt whose detail modal is open
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
  if (currentView === 'split') await refreshReceipts();
  if (me) render();
  if (openReceiptId) await refreshOpenReceipt();
}

async function refreshReceipts() {
  try { receipts = await api('/api/receipts'); } catch { /* keep last */ }
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
    btn.append(avatar(r, 26), r.name);
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

// Circular initial avatar (iOS-style), used in the nav bar and pickers.
function avatar(r, size = 30) {
  const a = el('span', {
    className: 'avatar',
    style: `background:${r?.color || 'var(--tab-inactive)'};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.44)}px`,
  });
  a.setAttribute('aria-hidden', 'true'); // decorative initial; keep it out of accessible names
  a.textContent = (r?.name || '?').trim().charAt(0).toUpperCase();
  return a;
}

const VIEW_TITLES = { shopping: 'Shopping', house: 'House', mine: 'My List', bought: 'Bought', split: 'Split' };

function render() {
  const chip = $('#user-chip');
  chip.innerHTML = '';
  chip.append(avatar(me), el('span', { className: 'user-name' }, me.name));

  document.querySelectorAll('.tab').forEach((t) =>
    t.classList.toggle('is-active', t.dataset.view === currentView));

  const view = $('#view');
  view.innerHTML = '';
  view.append(el('div', { className: 'large-title' }, VIEW_TITLES[currentView]));
  ({
    shopping: renderShopping,
    house: renderHouse,
    mine: renderMine,
    bought: renderBought,
    split: renderSplit,
  })[currentView](view);
}

function grpHeader(text) {
  return el('div', { className: 'grp-header' }, text);
}

// Wrap rows in a single rounded iOS list-group card.
function grp(rows) {
  const g = el('div', { className: 'grp' });
  rows.forEach((r) => g.append(r));
  return g;
}

function countLabel(n) {
  return `${n} ${n === 1 ? 'item' : 'items'}`;
}

function emptyState(glyph, title, sub) {
  const box = el('div', { className: 'empty' });
  box.append(el('div', { className: 'empty-glyph' }, glyph));
  box.append(el('div', { className: 'empty-title' }, title));
  if (sub) box.append(el('div', { className: 'empty-sub' }, sub));
  return box;
}

// Shopping: everything still to buy — house first, then each roommate's list.
function renderShopping(view) {
  const active = state.items.filter((i) => !i.bought);
  if (active.length === 0) {
    view.append(emptyState('🛒', 'All stocked up', 'Nothing on any list right now.'));
    return;
  }

  const house = active.filter((i) => i.list_type === 'house');
  if (house.length) {
    view.append(grpHeader('🏠 House'), grp(house.map((i) => itemRow(i))));
  }

  for (const r of state.roommates) {
    const personal = active.filter((i) => i.list_type === 'personal' && i.owner_id === r.id);
    if (!personal.length) continue;
    const label = r.id === me.id ? '🙋 Your list' : `🙋 ${r.name}'s list`;
    view.append(grpHeader(label), grp(personal.map((i) => itemRow(i))));
  }
}

function renderHouse(view) {
  const items = state.items.filter((i) => i.list_type === 'house' && !i.bought);
  if (!items.length) { view.append(emptyState('🏠', 'House list is empty', 'Tap ＋ to add something the house needs.')); return; }
  view.append(grpHeader(countLabel(items.length)), grp(items.map((i) => itemRow(i))));
}

function renderMine(view) {
  const items = state.items.filter((i) => i.list_type === 'personal' && i.owner_id === me.id && !i.bought);
  if (!items.length) { view.append(emptyState('🙋', 'Nothing here yet', 'Tap ＋ and choose “My List”.')); return; }
  view.append(grpHeader(countLabel(items.length)), grp(items.map((i) => itemRow(i))));
}

function renderBought(view) {
  const items = state.items.filter((i) => i.bought);
  if (!items.length) { view.append(emptyState('✅', 'Nothing bought yet', 'Items you check off show up here.')); return; }
  view.append(grpHeader(countLabel(items.length)), grp(items.map((i) => itemRow(i))));
  const clear = el('button', { className: 'text-btn destructive', style: 'margin:14px 6px' }, 'Clear all bought');
  clear.onclick = clearBought;
  view.append(clear);
}

// ---- item row ------------------------------------------------------------
function itemRow(item) {
  const row = el('div', { className: 'row item-row' + (item.bought ? ' bought' : '') });

  const check = el('button', { className: 'check' + (item.bought ? ' done' : ''), title: item.bought ? 'Mark as not bought' : 'Mark as bought' });
  if (item.bought) check.textContent = '✓';
  check.onclick = () => toggleBought(item);
  row.append(check);

  const main = el('div', { className: 'row-main' });
  const title = el('div', { className: 'item-title' });
  if (item.quantity) title.append(el('span', { className: 'qty' }, item.quantity));
  title.append(item.name);
  main.append(title);
  if (item.note) main.append(el('div', { className: 'item-note' }, item.note));

  const chips = el('div', { className: 'chips' });
  if (item.list_type === 'personal' && item.owner_name) {
    const c = el('span', { className: 'chip' });
    c.append(dot(item.owner_color || '#999'), `for ${item.owner_id === me.id ? 'you' : item.owner_name}`);
    chips.append(c);
  }
  if (item.bought && item.bought_by_name) {
    chips.append(el('span', { className: 'chip' }, `✓ ${item.bought_by_name === me.name ? 'you' : item.bought_by_name}`));
  } else if (item.claimed_by && item.claimed_by_name) {
    chips.append(el('span', { className: 'chip claimed' }, `🛍️ ${item.claimed_by === me.id ? "you're getting this" : item.claimed_by_name + ' is getting this'}`));
  }
  if (chips.children.length) main.append(chips);

  const actions = el('div', { className: 'row-actions' });
  if (!item.bought) {
    if (!item.claimed_by) {
      const b = el('button', { className: 'act' }, "I'll get it");
      b.onclick = () => claim(item, me.id);
      actions.append(b);
    } else if (item.claimed_by === me.id) {
      const b = el('button', { className: 'act' }, 'Unclaim');
      b.onclick = () => claim(item, null);
      actions.append(b);
    }
  }
  const del = el('button', { className: 'act destructive' }, 'Delete');
  del.onclick = () => removeItem(item);
  actions.append(del);
  main.append(actions);

  row.append(main);
  return row;
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

// ---- receipts / split ----------------------------------------------------
function money(n, currency) {
  const cur = currency || state.default_currency || '£';
  const val = (Number(n) || 0).toFixed(2);
  return /^[A-Za-z]{3}$/.test(cur) ? `${val} ${cur.toUpperCase()}` : `${cur}${val}`;
}

// Works out who owes the buyer how much for one receipt.
function computeSettlement(receipt) {
  const buyerId = receipt.buyer_id;
  const nSplit = Math.max(state.roommates.length, 1);
  const owed = {};
  let unassigned = 0;
  for (const it of receipt.items || []) {
    const price = Number(it.price) || 0;
    if (it.shared) {
      const share = price / nSplit;
      for (const r of state.roommates) {
        if (r.id === buyerId) continue;
        owed[r.id] = (owed[r.id] || 0) + share;
      }
    } else if (it.assigned_to) {
      if (it.assigned_to !== buyerId) owed[it.assigned_to] = (owed[it.assigned_to] || 0) + price;
    } else {
      unassigned += price;
    }
  }
  return { owed, unassigned };
}

function renderSplit(view) {
  const cta = el('button', { className: 'ios-scan' });
  cta.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8a2 2 0 0 1 2-2h1.6l.9-1.5h5l.9 1.5H18a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><circle cx="12" cy="12.5" r="3.1"/></svg>';
  cta.append(document.createTextNode('Scan a receipt'));
  cta.onclick = triggerScan;
  view.append(cta);

  if (!receipts.length) {
    view.append(emptyState('🧾', 'No receipts yet', state.parsing_enabled
      ? 'Snap one after a shop — we\'ll pull out the items to split.'
      : 'Snap one and add the items to split the cost.'));
    return;
  }
  view.append(grpHeader('Receipts'), grp(receipts.map((r) => receiptRow(r))));
}

function receiptRow(r) {
  const row = el('div', { className: 'row receipt-row' });

  const main = el('div', { className: 'row-main' });
  main.append(el('div', { className: 'rr-store' }, r.store || 'Receipt'));

  const meta = el('div', { className: 'rr-meta' });
  meta.append(dot(r.buyer_color || '#999'));
  meta.append(`Paid by ${r.buyer_id === me.id ? 'you' : (r.buyer_name || 'someone')}${r.purchased_at ? ' · ' + r.purchased_at : ''}`);
  main.append(meta);

  const { owed } = computeSettlement(r);
  if (r.buyer_id === me.id) {
    const total = Object.values(owed).reduce((a, b) => a + b, 0);
    if (total > 0.005) main.append(el('div', { className: 'rr-owe pos' }, `You're owed ${money(total, r.currency)}`));
  } else if ((owed[me.id] || 0) > 0.005) {
    main.append(el('div', { className: 'rr-owe neg' }, `You owe ${r.buyer_name || 'them'} ${money(owed[me.id], r.currency)}`));
  }
  row.append(main);

  const trailing = el('div', { className: 'rr-trailing' });
  trailing.append(el('span', { className: 'rr-total' }, money(r.total, r.currency)));
  trailing.append(el('span', { className: 'chevron' }, '›'));
  row.append(trailing);

  row.onclick = () => openReceipt(r.id);
  return row;
}

// ---- scan flow -----------------------------------------------------------
function onFab() {
  if (currentView === 'split') triggerScan();
  else openAddModal();
}

function triggerScan() {
  const input = $('#receipt-file');
  input.value = '';
  input.click();
}

async function onReceiptFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const scanning = $('#scanning');
  $('#scan-text').textContent = state.parsing_enabled ? 'Reading your receipt…' : 'Uploading receipt…';
  scanning.classList.remove('hidden');
  try {
    const img = await prepImage(file);
    const receipt = await api('/api/receipts', {
      method: 'POST',
      body: JSON.stringify({ buyer_id: me.id, image_base64: img.base64, media_type: img.mediaType }),
    });
    scanning.classList.add('hidden');
    currentView = 'split';
    await refreshReceipts();
    render();
    setOpenReceipt(receipt);
    if (receipt.parse_status === 'disabled') toast('Auto-scan is off — add items below');
    else if (receipt.parse_status === 'error') toast("Couldn't read it — add items below");
  } catch (err) {
    scanning.classList.add('hidden');
    toast(err.message || 'Upload failed');
  }
}

// Downscale to keep the upload small; fall back to the raw file if canvas fails.
function prepImage(file, maxDim = 1600) {
  return new Promise((resolve) => {
    const done = (base64, mediaType) => resolve({ base64, mediaType });
    const strip = (d) => String(d).replace(/^data:[^,]+,/, '');
    const fallback = () => {
      const reader = new FileReader();
      reader.onload = () => done(strip(reader.result), file.type || 'image/jpeg');
      reader.onerror = () => done('', file.type || 'image/jpeg');
      reader.readAsDataURL(file);
    };
    try {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          let { width, height } = img;
          const scale = Math.min(1, maxDim / Math.max(width, height));
          width = Math.round(width * scale);
          height = Math.round(height * scale);
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          canvas.getContext('2d').drawImage(img, 0, 0, width, height);
          URL.revokeObjectURL(url);
          done(strip(canvas.toDataURL('image/jpeg', 0.82)), 'image/jpeg');
        } catch { URL.revokeObjectURL(url); fallback(); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); fallback(); };
      img.src = url;
    } catch { fallback(); }
  });
}

// ---- receipt detail modal ------------------------------------------------
async function openReceipt(id) {
  try { setOpenReceipt(await api(`/api/receipts/${id}`)); }
  catch (err) { toast(err.message); }
}

function setOpenReceipt(receipt) {
  openReceiptId = receipt.id;
  renderReceiptDetail(receipt);
  $('#receipt-modal').classList.remove('hidden');
}

function closeReceipt() {
  openReceiptId = null;
  const m = $('#receipt-modal');
  m.classList.add('hidden');
  m.innerHTML = '';
}

async function refreshOpenReceipt() {
  if (!openReceiptId) return;
  const modal = $('#receipt-modal');
  // Don't rebuild while the user is editing a field inside it.
  if (modal.contains(document.activeElement) && document.activeElement !== document.body) return;
  try {
    const receipt = await api(`/api/receipts/${openReceiptId}`);
    if (openReceiptId === receipt.id) renderReceiptDetail(receipt);
  } catch { /* ignore */ }
}

function rdField(label, control) {
  const f = el('div', { className: 'rd-field' });
  f.append(el('label', {}, label), control);
  return f;
}

function renderReceiptDetail(receipt) {
  const modal = $('#receipt-modal');
  modal.innerHTML = '';
  const wrap = el('div', { className: 'sheet receipt-detail' });
  wrap.append(el('div', { className: 'grabber' }));

  const head = el('div', { className: 'rd-head' });
  head.append(el('h2', {}, 'Receipt'));
  const close = el('button', { className: 'rd-close' }, '✕');
  close.onclick = closeReceipt;
  head.append(close);
  wrap.append(head);

  const body = el('div', { className: 'rd-body' });

  if (receipt.image_file) {
    const photo = el('img', { className: 'rd-photo', src: `/api/receipts/${receipt.id}/image`, alt: 'Receipt photo' });
    photo.onerror = () => photo.remove();
    body.append(photo);
  }

  // Store / Paid by / Date+Total — grouped iOS form
  const formGrp = el('div', { className: 'grp form-grp' });

  const storeInput = el('input', { type: 'text', value: receipt.store || '', placeholder: 'Shop name' });
  storeInput.onchange = () => patchReceipt(receipt.id, { store: storeInput.value });
  formGrp.append(rdField('Store', storeInput));

  const buyerSel = el('select');
  for (const r of state.roommates) {
    const opt = el('option', { value: String(r.id) }, r.id === me.id ? `${r.name} (you)` : r.name);
    if (r.id === receipt.buyer_id) opt.selected = true;
    buyerSel.append(opt);
  }
  buyerSel.onchange = () => patchReceipt(receipt.id, { buyer_id: Number(buyerSel.value) });
  formGrp.append(rdField('Paid by', buyerSel));

  const row2 = el('div', { className: 'rd-row2' });
  const dateInput = el('input', { type: 'text', value: receipt.purchased_at || '', placeholder: 'YYYY-MM-DD' });
  dateInput.onchange = () => patchReceipt(receipt.id, { purchased_at: dateInput.value });
  row2.append(rdField('Date', dateInput));
  const totalInput = el('input', { type: 'number', step: '0.01', value: receipt.total == null ? '' : receipt.total });
  totalInput.onchange = () => patchReceipt(receipt.id, { total: totalInput.value === '' ? null : Number(totalInput.value) });
  row2.append(rdField(`Total (${receipt.currency || state.default_currency})`, totalInput));
  formGrp.append(row2);
  body.append(formGrp);

  // Items
  body.append(el('div', { className: 'rd-section-label' }, 'Items — assign each to someone'));
  const items = receipt.items || [];
  if (items.length) {
    const itemsGrp = el('div', { className: 'grp ri-grp' });
    items.forEach((it) => itemsGrp.append(receiptItemRow(receipt, it)));
    body.append(itemsGrp);
  }

  const addBtn = el('button', { className: 'rd-additem' }, '＋ Add item');
  addBtn.onclick = () => addReceiptItem(receipt.id);
  body.append(addBtn);

  body.append(settlementBox(receipt));
  wrap.append(body);

  const foot = el('div', { className: 'rd-foot' });
  const del = el('button', { className: 'rd-delete' }, 'Delete receipt');
  del.onclick = () => deleteReceipt(receipt.id);
  foot.append(del);
  wrap.append(foot);

  modal.append(wrap);
  modal.onclick = (e) => { if (e.target === modal) closeReceipt(); };
}

function receiptItemRow(receipt, it) {
  const row = el('div', { className: 'ri' });

  const name = el('input', { className: 'ri-name', type: 'text', value: it.name });
  name.onchange = () => patchItem(it.id, { name: name.value });
  row.append(name);

  const price = el('input', { className: 'ri-price', type: 'number', step: '0.01', value: it.price });
  price.onchange = () => patchItem(it.id, { price: price.value === '' ? 0 : Number(price.value) });
  row.append(price);

  const sel = el('select', { className: 'ri-assign' });
  sel.append(el('option', { value: '' }, 'Unassigned'));
  sel.append(el('option', { value: 'shared' }, '🔀 Shared'));
  for (const r of state.roommates) {
    sel.append(el('option', { value: String(r.id) }, r.name));
  }
  sel.value = it.shared ? 'shared' : (it.assigned_to ? String(it.assigned_to) : '');
  sel.onchange = () => {
    const v = sel.value;
    if (v === 'shared') patchItem(it.id, { shared: true, assigned_to: null });
    else if (v === '') patchItem(it.id, { assigned_to: null, shared: false });
    else patchItem(it.id, { assigned_to: Number(v) });
  };
  row.append(sel);

  const del = el('button', { className: 'ri-del' }, '✕');
  del.onclick = () => deleteReceiptItem(it.id);
  row.append(del);
  return row;
}

function settlementBox(receipt) {
  const box = el('div', { className: 'settle' });
  const buyerName = receipt.buyer_id === me.id ? 'you' : (receipt.buyer_name || 'the buyer');
  box.append(el('h3', {}, `Who owes ${buyerName}`));

  const { owed, unassigned } = computeSettlement(receipt);
  const entries = state.roommates.filter((r) => (owed[r.id] || 0) > 0.005);

  if (!entries.length) {
    box.append(el('div', { className: 'settle-none' }, 'Assign items to people or mark them shared to see who owes what.'));
  } else {
    for (const r of entries) {
      const rowEl = el('div', { className: 'settle-row' });
      const who = r.id === me.id ? 'You owe' : `${r.name} owes`;
      rowEl.append(el('span', {}, who));
      rowEl.append(el('span', { className: 'amt' }, money(owed[r.id], receipt.currency)));
      box.append(rowEl);
    }
  }
  if (unassigned > 0.005) {
    box.append(el('div', { className: 'settle-unassigned' }, `${money(unassigned, receipt.currency)} still unassigned`));
  }
  return box;
}

async function afterReceiptChange(id) {
  if (id) {
    try {
      const receipt = await api(`/api/receipts/${id}`);
      if (openReceiptId === receipt.id) renderReceiptDetail(receipt);
    } catch { /* ignore */ }
  }
  await refreshReceipts();
  if (currentView === 'split') render();
}

async function patchReceipt(id, body) {
  try { await api(`/api/receipts/${id}`, { method: 'PATCH', body: JSON.stringify(body) }); await afterReceiptChange(id); }
  catch (err) { toast(err.message); }
}
async function patchItem(id, body) {
  try { await api(`/api/receipt-items/${id}`, { method: 'PATCH', body: JSON.stringify(body) }); await afterReceiptChange(openReceiptId); }
  catch (err) { toast(err.message); }
}
async function addReceiptItem(id) {
  try { await api(`/api/receipts/${id}/items`, { method: 'POST', body: JSON.stringify({ name: 'New item', price: 0 }) }); await afterReceiptChange(id); }
  catch (err) { toast(err.message); }
}
async function deleteReceiptItem(id) {
  try { await api(`/api/receipt-items/${id}`, { method: 'DELETE' }); await afterReceiptChange(openReceiptId); }
  catch (err) { toast(err.message); }
}
async function deleteReceipt(id) {
  if (!confirm('Delete this receipt?')) return;
  try {
    await api(`/api/receipts/${id}`, { method: 'DELETE' });
    closeReceipt();
    await refreshReceipts();
    render();
  } catch (err) { toast(err.message); }
}

// ---- wire up -------------------------------------------------------------
function init() {
  $('#add-me-form').addEventListener('submit', onboardSubmit);
  $('#user-chip').addEventListener('click', switchUser);
  $('#nav-add').addEventListener('click', onFab);
  $('#cancel-add').addEventListener('click', closeAddModal);
  $('#add-item-form').addEventListener('submit', addItemSubmit);
  $('#add-modal').addEventListener('click', (e) => { if (e.target.id === 'add-modal') closeAddModal(); });
  $('#receipt-file').addEventListener('change', onReceiptFile);

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', async () => {
      currentView = tab.dataset.view;
      if (currentView === 'split') await refreshReceipts();
      render();
    });
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
