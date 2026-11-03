// Popover — the day view that drops from the tray. A thin renderer: every
// action is a backend call, then we reload the snapshot. The backend pushes
// 'tick' each second while a timer runs, and 'changed' after any mutation
// (from here, the app window, the tray or a hotkey).

import { $, el, h, icon, call, fmtHM, fmtHMS, parseDuration, parseYmd, addDays, dayLabel, DOW,
  projectSelect, taskOptions, errMsg, applyTheme, mod, keyLabel } from './lib.js';

let data = null;            // last snapshot
let sel = null;             // selected YYYY-MM-DD
let runBase = 0;            // running seconds when the snapshot loaded (for live deltas)
let runTimeEl = null;
let editing = null;         // entry being edited in the sheet (null = new)

async function load(date) {
  data = await call('popState', { date: date || sel });
  sel = data.selDate;
  runBase = data.running ? data.running.seconds : 0;
  render();
}
const runDelta = () => (data && data.running ? data.running.seconds - runBase : 0);

function render() {
  $('hdrDate').textContent = dayLabel(sel, data.today);
  renderWeek(); renderBody(); renderTotal();
}

function renderWeek() {
  const days = $('days'); days.replaceChildren();
  for (const w of data.week) {
    let total = w.total;
    if (data.running && data.running.date === w.date) total += runDelta();
    const d = parseYmd(w.date);
    const col = el('div', 'day' + (w.date === sel ? ' sel' : '') + (w.date === data.today ? ' today' : '') + (total > 0 ? ' has' : ''));
    col.append(el('div', 'dl', DOW[d.getDay()].slice(0, 2)), el('div', 'dt', fmtHM(total)));
    col.title = dayLabel(w.date, data.today);
    col.onclick = () => { if (w.date !== sel) load(w.date); };
    days.appendChild(col);
  }
}

function renderTotal() {
  let t = data.entries.reduce((a, e) => a + e.seconds, 0);
  if (data.running && data.running.date === sel) t += runDelta();
  const n = $('dayTotal'); n.replaceChildren('Total ', el('b', null, fmtHM(t)));
  n.style.visibility = data.entries.length ? '' : 'hidden';
}

function renderBody() {
  const body = $('body'); body.replaceChildren(); runTimeEl = null;
  if (data.empty) { body.appendChild(onboarding()); return; }
  if (!data.entries.length) {
    body.appendChild(h('div', { class: 'empty' },
      h('div', null, sel === data.today ? 'Nothing tracked yet today.' : 'Nothing tracked on this day.'),
      h('button', { class: 'btn primary', onclick: () => openSheet() }, sel === data.today ? 'Start a Timer' : 'Add Time')));
    return;
  }
  for (const e of data.entries) body.appendChild(entryRow(e));
}

function onboarding() {
  return h('div', { class: 'empty' },
    h('h3', null, 'Welcome to Tiny Time'),
    h('div', null, 'Add a client and a project, then track time against tasks right from the menu bar.'),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: () => call('openApp', { view: 'clients' }) }, 'Set Up Clients'),
      h('button', { class: 'btn', onclick: async () => { await call('seedSample'); } }, 'Try Sample Data')));
}

function entryRow(e) {
  const running = data.running && data.running.id === e.id;
  const row = el('div', 'entry' + (running ? ' run' : ''));
  const bar = el('div', 'bar'); bar.style.background = e.color;
  const meta = el('div', 'meta');
  const pj = el('div', 'pj'); pj.append(e.project + ' ', el('span', 'cl', '(' + e.client + ')'));
  meta.append(pj, el('div', 'tk', e.task));
  if (e.notes) meta.appendChild(el('div', 'nt', e.notes));
  const time = el('div', 'time', running ? fmtHMS(e.seconds) : fmtHM(e.seconds));
  if (running) runTimeEl = time;
  const tog = el('button', 'tog'); tog.title = running ? 'Stop timer' : 'Start timer';
  tog.appendChild(icon(running ? 'stop' : 'play'));
  tog.onclick = (ev) => { ev.stopPropagation(); running ? call('stopTimer') : call('startEntry', { id: e.id }); };
  row.append(bar, meta, time, tog);
  row.onclick = () => openSheet(e);
  row.oncontextmenu = (ev) => { ev.preventDefault(); openContext(ev, e, running); };
  return row;
}

// ── live updates ─────────────────────────────────────────────────────────────
tiny.api.on('tick', (t) => {
  if (!data || !data.running || t.id !== data.running.id) return;
  data.running.seconds = t.seconds;
  if (runTimeEl) runTimeEl.textContent = fmtHMS(t.seconds);
  renderWeek(); renderTotal();
  if (summaryOpen) paintSummary();
});
tiny.api.on('changed', () => load());
tiny.api.on('shown', (s) => onShown(s));

function onShown(s) {
  if (s && s.anchor) setAnchor(s.anchor);
  if (s && typeof s.detached === 'boolean') setMode(s.detached);
  closePops();
  load().then(() => { if (s && s.view === 'new' && !data.empty) openSheet(); });
}

// ── header / footer ──────────────────────────────────────────────────────────
$('btnToday').onclick = () => load(data.today);
$('prevWk').onclick = () => load(addDays(sel, -7));
$('nextWk').onclick = () => load(addDays(sel, 7));
$('btnApp').onclick = () => call('openApp', { view: 'time' });
$('btnNew').onclick = () => { if (data.empty) call('openApp', { view: 'clients' }); else openSheet(); };
$('btnSummary').onclick = (e) => openSummary(e.currentTarget);
$('btnGear').onclick = (e) => openGear(e.currentTarget);

// ── entry sheet ──────────────────────────────────────────────────────────────
let fProject = null;
function openSheet(e) {
  closePops();
  editing = e || null;
  const cat = data.catalog;
  // new entries default to the last-used project/task
  const last = data.entries[0];
  const pid = e ? e.project_id : last ? last.project_id : null;
  fProject = projectSelect(cat, pid);
  fProject.onchange = () => taskOptions($('fTask'), cat, Number(fProject.value), null);
  $('fProjectWrap').replaceChildren(fProject);
  taskOptions($('fTask'), cat, pid, e ? e.task_id : last ? last.task_id : null);
  $('fNotes').value = e ? e.notes : '';
  const running = e && data.running && data.running.id === e.id;
  $('fDur').value = e ? (running ? fmtHMS(e.seconds) : fmtHM(e.seconds)) : '';
  $('fDur').disabled = !!running;
  $('fErr').textContent = '';
  $('sheetTitle').textContent = e ? 'Edit Time Entry' : 'New Time Entry';
  $('sheetDate').textContent = dayLabel(e ? e.date : sel, data.today);
  $('fDelete').style.display = e ? '' : 'none';
  updateSaveLabel();
  $('sheet').classList.add('open');
  setTimeout(() => (pid ? $('fNotes') : fProject).focus(), 60);
}
function closeSheet() { $('sheet').classList.remove('open'); editing = null; }
function updateSaveLabel() {
  $('fSave').textContent = !editing && !$('fDur').value.trim() ? 'Start Timer' : 'Save Entry';
}
$('fDur').addEventListener('input', updateSaveLabel);
$('fCancel').onclick = closeSheet;
$('fDelete').onclick = async () => {
  if (!editing) return;
  await call('deleteEntry', { id: editing.id });
  closeSheet();
};
$('fSave').onclick = save;
async function save() {
  const project_id = Number(fProject.value), task_id = Number($('fTask').value);
  if (!project_id) { $('fErr').textContent = 'Choose a project.'; return; }
  if (!task_id) { $('fErr').textContent = 'This project has no tasks — add some in the dashboard.'; return; }
  const running = editing && data.running && data.running.id === editing.id;
  let seconds = 0;
  const raw = $('fDur').value.trim();
  if (raw && !running) {
    seconds = parseDuration(raw);
    if (seconds == null) { $('fErr').textContent = 'Try a duration like 1:30, 1.5 or 90m.'; return; }
  } else if (running) seconds = data.running.seconds;
  const payload = { project_id, task_id, notes: $('fNotes').value, date: editing ? editing.date : sel, seconds };
  try {
    if (editing) await call('saveEntry', { ...payload, id: editing.id });
    else await call('saveEntry', { ...payload, start: !raw });
    closeSheet();
  } catch (err) { $('fErr').textContent = errMsg(err); }
}

// ── in-card pops ─────────────────────────────────────────────────────────────
let summaryOpen = false;
function closePops() { $('popLayer').replaceChildren(); summaryOpen = false; }
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('.pop') && !e.target.closest('.hbtn,.fbtn')) closePops();
}, true);

function mount(pop, x, y) {
  closePops();
  $('popLayer').appendChild(pop);
  const card = $('card').getBoundingClientRect(), r = pop.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(x - card.left, card.width - r.width - 8)) + 'px';
  pop.style.top = Math.max(8, Math.min(y - card.top, card.height - r.height - 8)) + 'px';
}
const item = (label, fn, opts = {}) => h('div', { class: 'pi' + (opts.danger ? ' danger' : ''), onclick: () => { closePops(); fn(); } },
  h('span', null, label), opts.key ? h('span', { class: 'k' }, opts.key) : null);

function openGear(anchor) {
  const pop = h('div', { class: 'pop' },
    item('New Time Entry', () => $('btnNew').click(), { key: keyLabel('N') }),
    item('Dashboard & Reports', () => call('openApp', { view: 'reports' })),
    item('Clients, Projects & Tasks', () => call('openApp', { view: 'projects' })),
    h('div', { class: 'sep' }),
    item('Settings…', () => call('openApp', { view: 'settings' })),
    item('Quit Tiny Time', () => call('quit'), { key: keyLabel('Q') }));
  const a = anchor.getBoundingClientRect();
  $('popLayer').appendChild(pop);
  const r = pop.getBoundingClientRect();
  mount(pop, a.right - r.width, a.top - r.height - 6);
}

function openContext(ev, e, running) {
  const pop = h('div', { class: 'pop' },
    item('Edit Entry', () => openSheet(e)),
    item(running ? 'Stop Timer' : 'Start Timer', () => (running ? call('stopTimer') : call('startEntry', { id: e.id }))),
    item('Duplicate Entry', () => call('saveEntry', { project_id: e.project_id, task_id: e.task_id, notes: e.notes, date: e.date, seconds: e.seconds })),
    h('div', { class: 'sep' }),
    item('Delete Entry', () => call('deleteEntry', { id: e.id }), { danger: true }));
  mount(pop, ev.clientX, ev.clientY);
}

function openSummary(anchor) {
  const pop = h('div', { class: 'pop summary' }, h('div', { class: 'stitle' }, 'Time Summary'), h('div', { class: 'sgrid', id: 'sgrid' }));
  const a = anchor.getBoundingClientRect();
  $('popLayer').appendChild(pop);
  const r = pop.getBoundingClientRect();
  mount(pop, a.right - r.width + 4, a.bottom + 6);
  summaryOpen = true;
  paintSummary();
}
function paintSummary() {
  const g = $('sgrid'); if (!g) return;
  const d = runDelta();
  const todayAdd = data.running && data.running.date === data.today ? d : 0;
  g.replaceChildren(...[['Today', data.summary.today + todayAdd], ['This Week', data.summary.week + d], ['This Month', data.summary.month + d]]
    .map(([l, v]) => h('div', { class: 'cell' }, h('div', { class: 'l' }, l), h('div', { class: 'v' }, fmtHM(v)))));
}

// ── keyboard ─────────────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if ($('popLayer').children.length) closePops();
    else if ($('sheet').classList.contains('open')) closeSheet();
    else call('hidePopover');
  } else if (mod(e) && e.key.toLowerCase() === 'n') { e.preventDefault(); $('btnNew').click(); }
  else if (mod(e) && e.key.toLowerCase() === 'q') { e.preventDefault(); call('quit'); }
  else if (e.key === 'Enter' && $('sheet').classList.contains('open') && (mod(e) || e.target.tagName === 'INPUT')) { e.preventDefault(); save(); }
});

// ── dismiss like a real menu-bar popover (attached only — the backend
//    ignores blur while torn off) ──────────────────────────────────────────────
window.addEventListener('blur', () => { if (!detached) call('blurPopover'); });

// ── tear-off ─────────────────────────────────────────────────────────────────
// Drag the header past a few px and the popover "tears": traffic lights
// appear and, on release, it becomes a plain window. Drag it back near its
// spot under the tray (the pointer pokes out to say so) and release to snap
// home. We move the window ourselves (pointer capture + setPosition) so we
// know exactly where it was let go.
let detached = false;
let anchor = null;                 // { x, y, pointer } — where the attached popover lives
let drag = null;
const NEAR_Y = 44, NEAR_X = 140;
const nearAnchor = (x, y) => !!anchor && Math.abs(y - anchor.y) < NEAR_Y && Math.abs(x - anchor.x) < NEAR_X;

// side 'down' = the popover opened ABOVE a bottom tray (Windows taskbar)
function setAnchor(a) {
  anchor = a;
  document.documentElement.style.setProperty('--ptr', a.pointer);
  document.body.classList.toggle('ptr-down', a.side === 'down');
}
function setMode(on) {
  detached = !!on;
  document.body.classList.toggle('detached', detached);
  document.body.classList.remove('torn', 'will-attach');
}
tiny.api.on('mode', (m) => { if (m.anchor) setAnchor(m.anchor); setMode(m.detached); });

const hdr = $('hdr');
hdr.addEventListener('pointerdown', async (e) => {
  if (e.button !== 0 || e.target.closest('button')) return;
  const pid = e.pointerId, sx = e.screenX, sy = e.screenY;
  hdr.setPointerCapture(pid);
  try {
    const st = await tiny.win.getState();
    drag = { sx, sy, ox: st.x, oy: st.y, x: st.x, y: st.y, w: st.width, h: st.height, moved: false };
  } catch (er) { drag = null; }
});
hdr.addEventListener('pointermove', (e) => {
  if (!drag) return;
  drag.x = drag.ox + (e.screenX - drag.sx);
  drag.y = drag.oy + (e.screenY - drag.sy);
  if (!drag.moved && Math.hypot(drag.x - drag.ox, drag.y - drag.oy) < 6) return;
  if (!drag.moved) { drag.moved = true; closePops(); }
  tiny.win.setPosition(drag.x, drag.y);
  const near = nearAnchor(drag.x, drag.y);
  document.body.classList.toggle('will-attach', near);   // pointer pokes out: "I'll attach"
  document.body.classList.toggle('torn', !near);         // lights preview: "I'll detach"
});
const endDrag = () => {
  if (!drag) return;
  const d = drag; drag = null;
  document.body.classList.remove('torn', 'will-attach');
  if (!d.moved) return;                                   // a click, not a drag
  if (nearAnchor(d.x, d.y)) call('setDetached', { detached: false });
  else call('setDetached', { detached: true, x: d.x, y: d.y, w: d.w, h: d.h });
};
hdr.addEventListener('pointerup', endDrag);
hdr.addEventListener('pointercancel', endDrag);
hdr.addEventListener('dblclick', (e) => { if (detached && !e.target.closest('button')) tiny.win.zoom(); });

$('tlClose').onclick = () => call('hidePopover');
$('tlMin').onclick = () => tiny.win.minimize();
$('tlZoom').onclick = () => tiny.win.zoom();

// torn off it resizes natively — keep it popover-ish in width, and remember
// the rect (moves too) so reopening and relaunching put it back
let rectTimer = null;
function rememberRect() {
  if (!detached || drag) return;
  clearTimeout(rectTimer);
  rectTimer = setTimeout(async () => {
    try {
      const st = await tiny.win.getState();
      const w = Math.max(380, Math.min(560, st.width)), hh = Math.max(430, st.height);
      if (w !== st.width || hh !== st.height) tiny.win.setSize(w, hh);
      call('saveWinRect', { x: st.x, y: st.y, w, h: hh });
    } catch (e) {}
  }, 200);
}
window.addEventListener('resize', rememberRect);
hdr.addEventListener('pointerup', () => setTimeout(rememberRect, 50));

$('btnNew').title = 'New time entry (' + keyLabel('N') + ')';

// ── boot ─────────────────────────────────────────────────────────────────────
call('popHello').then((s) => { applyTheme(s); onShown(s); });

// screenshot tour (scripts/screenshots.sh) sets scenes from the backend
tiny.api.on('tour', (t) => { if ('sheet' in t) (t.sheet ? openSheet() : closeSheet()); });
