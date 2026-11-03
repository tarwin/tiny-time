// Tiny Time — a local, offline time tracker that lives in the menu bar.
//
// "mainWindow": false — at rest there is NO WebView at all: just this backend,
// a sqlite file and a tray item we draw ourselves (~17 MiB on macOS). Two
// named windows exist only while you use them:
//
//   pop  the little popover that drops from the tray (day view, start/stop,
//        quick entry). Hidden on blur, then CLOSED after a short grace period
//        so WebKit's memory goes away too.
//   app  the full app: timesheet, reports with graphs, clients, projects,
//        tasks, settings. A normal window; while it's open we're a regular
//        Dock app, when it closes we drop back to menu-bar only.
//
// The backend is the clock (a hidden page is throttled to near-zero): a
// running entry stores started_at, and its length is always computed as
// seconds + (now − started_at). Pages are thin renderers.

import * as db from './db.js';
import { renderTrayPNG, renderTraySquarePNG } from './traypng.js';
import { parseHarvest, toHarvestCSV } from './harvest.js';
import { handoff } from './tally.js';

const POP = { w: 380, h: 520 };
// macOS gets the two-zone pill in the menu bar. Windows and Linux trays are
// square: a single icon, the time in its tooltip, and a click opens the popover.
let IS_MAC = true;                       // set in init from app.system.os()
const POP_MAX_W = 560, POP_MIN_H = 430;  // torn-off resize bounds
const POP_CLOSE_AFTER = 45_000;          // ms hidden before the popover's WebView is torn down
const SC_IDS = ['sc_pop', 'sc_timer', 'sc_new', 'sc_app'];

let app;
const DEFAULT_ACCENT = '#22a676';
let prefs = { idleEnabled: true, idleMinutes: 10, weekStart: 1, accent: DEFAULT_ACCENT, appearance: 'system', shortcuts: {}, harvestName: { first: '', last: '' } };
const isHex = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
const accentRGB = () => { const h = isHex(prefs.accent) ? prefs.accent : DEFAULT_ACCENT; return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); };
let popState = 'closed';                 // 'closed' | 'hidden' | 'shown'
let popCloseTimer = null;
let popLastHide = 0;
let popPending = null;                   // { view } for a popover page that's still loading
let popAnchor = null;
// Torn-off popover (Till's trick): drag the header away from the menu bar and
// it becomes a plain window — resizable, normal level, survives losing focus.
// Drag it back under the tray icon to re-attach. The page drives the drag; we
// own the mode and the remembered rect (persisted as 'popwin').
let detached = false;
let detRect = null;                      // { x, y, w, h } while detached
let appOpen = false;
let modalOpen = false;                   // a native dialog from the popover is up — don't hide on blur
let lastTrayKey = '';
// Screenshot tour (scripts/screenshots.sh): TINYTIME_TOUR=<dir> runs on demo
// data in that dir and never reads or writes your settings.
const TOUR = tjs.env.TINYTIME_TOUR || '';
const save = (k, v) => (TOUR ? Promise.resolve() : app.store.set(k, v).catch(() => {}));
let idleTick = 0;

// ── dates (local, never toISOString — that's UTC and can be a day off) ──────
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const today = () => ymd(new Date());
const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const isYmd = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
function weekOf(ds) {
  const d = parseYmd(ds);
  const back = (d.getDay() - prefs.weekStart + 7) % 7;
  const out = [];
  for (let i = 0; i < 7; i++) out.push(ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() - back + i)));
  return out;
}
const fmtHM = (s) => Math.floor(s / 3600) + ':' + pad(Math.floor((s % 3600) / 60));

// ── broadcast ────────────────────────────────────────────────────────────────
function changed() {
  updateTray();
  if (popState !== 'closed' || appOpen) app.push('changed', {});
}

// ── tray ─────────────────────────────────────────────────────────────────────
let trayN = 0;
let tmpDir = (tjs.env.TMPDIR || tjs.env.TEMP || '/tmp').replace(/[\\/]$/, '');   // replaced by app.paths().temp in init
const trayPath = () => tmpDir + '/tinytime-tray-' + (trayN ^= 1) + '.png';

function updateTray(force) {
  const run = db.running();
  const text = run ? fmtHM(run.seconds) : '-:--';
  const key = (run ? 'run:' + run.id : 'idle') + '|' + text;
  if (!force && key === lastTrayKey) return;
  lastTrayKey = key;
  const last = run ? null : db.lastEntry();
  const menu = [
    { id: 'pop', label: 'Open Tiny Time' },
    { id: 'new', label: 'New Time Entry…' },
    { id: 'app', label: 'Dashboard & Reports…' },
    { separator: true },
    run ? { id: 'stop', label: `Stop “${run.project} · ${run.task}”` }
        : last ? { id: 'resume', label: `Start “${last.project} · ${last.task}”` }
               : { id: 'resume', label: 'Start last timer', enabled: false },
    { separator: true },
    { id: 'settings', label: 'Settings…' },
    { id: 'check-updates', label: 'Check for Updates…' },
    { id: 'quit', label: 'Quit Tiny Time' },
  ];
  const tooltip = IS_MAC
    ? (run ? `Tracking ${run.client} · ${run.project} — ${run.task}` : 'Tiny Time — ▶ starts your last timer, the time opens the day')
    : (run ? `Tiny Time — ${text} on ${run.project} · ${run.task}` : 'Tiny Time — click to open, right-click for the menu');
  const spec = { tooltip, primaryAction: true, menu };
  (async () => {
    try {
      const path = trayPath();
      await tjs.writeFile(path, IS_MAC ? renderTrayPNG(!!run, text, accentRGB()) : renderTraySquarePNG(!!run, accentRGB()));
      app.tray.set({ ...spec, title: '', icon: path, template: false });
    } catch (e) {
      app.tray.set({ ...spec, title: IS_MAC ? text : '', icon: IS_MAC ? (run ? 'sf:pause.fill' : 'sf:play.fill') : (run ? 'emoji:⏸' : 'emoji:▶') });
    }
  })();
}

// The pill is two zones — ▶/‖ on the left, the time on the right — but a
// status item is one click target. tray.position() + mousePosition() tell us
// which half was hit.
async function onTrayClick() {
  if (!IS_MAC) { togglePopover(); return; }          // one zone off the Mac: open the day
  try {
    const [spot, mouse] = await Promise.all([app.tray.position(), app.mousePosition()]);
    if (spot && mouse && typeof mouse.x === 'number') {
      if (mouse.x >= spot.x + spot.width * 0.34) { togglePopover(); return; }
    }
  } catch (e) {}
  toggleTimer();
}

function toggleTimer() {
  const run = db.running();
  if (run) db.stopRunning();
  else {
    const last = db.lastEntry();
    if (!last) { showPopover(db.isEmpty() ? {} : { view: 'new' }); return; }
    db.startEntry(last.id, today());
  }
  changed();
}

// ── popover ──────────────────────────────────────────────────────────────────
async function anchorRect() {
  const W = POP.w;
  let x = 40, y = 32, pointer = W - 60, side = 'up';   // side: where the pointer is

  try {
    const spot = await app.tray.position();
    const screens = await app.screens();
    const rects = (screens || []).map((s) => s.visible || s);
    if (spot) {
      const cx = spot.x + spot.width / 2;
      const scr = rects.find((s) => cx >= s.x && cx < s.x + s.width) || rects[0] || { x: 0, y: 0, width: 1440, height: 900 };
      // tray at the bottom of the screen (Windows taskbar): open above it
      if (spot.y > scr.y + scr.height / 2) { side = 'down'; y = spot.y - POP.h - 4; }
      else y = spot.y + spot.height + 4;
      x = Math.round(cx - (W - 46));                 // pointer sits ~46px from the card's right edge
      x = Math.max(scr.x + 8, Math.min(x, scr.x + scr.width - W - 8));
      pointer = Math.round(Math.max(24, Math.min(W - 24, cx - x)));
    } else if (rects[0]) {                           // no tray geometry (Linux): top-right corner
      x = rects[0].x + rects[0].width - W - 12; y = rects[0].y + 8;
    }
  } catch (e) {}
  return { x, y, pointer, side };
}

// keep a remembered torn-off rect on a display that still exists
async function clampDetRect() {
  try {
    const rects = ((await app.screens()) || []).map((s) => s.visible || s);
    const cx = detRect.x + detRect.w / 2, cy = detRect.y + 20;
    const scr = rects.find((s) => cx >= s.x && cx < s.x + s.width && cy >= s.y && cy < s.y + s.height)
      || rects[0] || { x: 0, y: 0, width: 1440, height: 900 };
    detRect.w = Math.max(POP.w, Math.min(detRect.w, POP_MAX_W));
    detRect.h = Math.max(POP_MIN_H, Math.min(detRect.h, scr.height));
    detRect.x = Math.max(scr.x, Math.min(detRect.x, scr.x + scr.width - detRect.w));
    detRect.y = Math.max(scr.y, Math.min(detRect.y, scr.y + scr.height - 80));
  } catch (e) {}
}
const savePopWin = () => save('popwin', { detached, rect: detRect });

async function showPopover(opts = {}) {
  clearTimeout(popCloseTimer); popCloseTimer = null;
  const a = await anchorRect();
  popAnchor = a;
  if (detached && detRect) await clampDetRect();
  const r = detached && detRect ? detRect : { x: a.x, y: a.y, w: POP.w, h: POP.h };
  const fresh = popState === 'closed';
  if (fresh) {
    popPending = { view: opts.view || null };
    app.win.open('pop', {
      page: 'popover.html', title: 'Tiny Time Popover', size: `${r.w}x${r.h}`, x: r.x, y: r.y, show: false,
      chrome: { frame: false, windowControls: false, transparent: true },
    });
  }
  const w = app.window('pop');
  if (detached) {
    try { w.setResizable(true); w.setMinSize(POP.w, POP_MIN_H); } catch (e) {}
    try { w.setLevel('normal'); w.setAllSpaces(false); } catch (e) {}
    w.show();
    // position AFTER show — resizing a hidden window re-centers it on macOS
    try { w.setSize(r.w, r.h); w.setPosition(r.x, r.y); } catch (e) {}
  } else {
    try { w.setResizable(false); if (!fresh) w.setSize(POP.w, POP.h); w.setPosition(a.x, a.y); } catch (e) {}
    try { w.setLevel('floating'); w.setAllSpaces(true); } catch (e) {}
    w.show();
  }
  popState = 'shown';
  w.push('shown', { anchor: a, detached, view: opts.view || null });
  updateTray(true);
}

// the page's header drag let go: tear off at rect, or snap back under the tray
async function setDetached(on, rect) {
  const was = detached;
  detached = !!on;
  if (detached) {
    detRect = { x: Math.round(rect.x) || 0, y: Math.round(rect.y) || 0, w: Math.round(rect.w) || POP.w, h: Math.round(rect.h) || POP.h };
    if (!was) {
      const w = app.window('pop');
      try { w.setResizable(true); w.setMinSize(POP.w, POP_MIN_H); } catch (e) {}
      try { w.setLevel('normal'); w.setAllSpaces(false); } catch (e) {}
    }
    app.window('pop').push('mode', { detached: true, anchor: await anchorRect() });
  } else {
    detRect = null;
    await showPopover();                 // snaps under the tray, restores size/level
    app.window('pop').push('mode', { detached: false });
  }
  savePopWin();
}

function hidePopover() {
  if (popState !== 'shown' || modalOpen) return;
  popState = 'hidden';
  popLastHide = Date.now();
  try { app.window('pop').hide({ app: false }); } catch (e) {}
  clearTimeout(popCloseTimer);
  popCloseTimer = setTimeout(() => {
    popCloseTimer = null;
    if (popState !== 'hidden') return;
    popState = 'closed';
    try { app.window('pop').close(); } catch (e) {}
  }, POP_CLOSE_AFTER);
}

async function togglePopover() {
  if (popState === 'shown') {
    // a torn-off window buried under other windows comes forward instead
    if (detached) {
      try { const st = await app.window('pop').getState(); if (st && st.minimized) { app.window('pop').restore(); return; } if (st && st.visible && !st.focused) { app.window('pop').show(); return; } } catch (e) {}
    }
    hidePopover(); return;
  }
  // clicking the tray while the popover is up blurs it first (which hides
  // it) — don't let that same click pop it straight back open
  if (Date.now() - popLastHide < 250) return;
  showPopover();
}

// ── the full app window ──────────────────────────────────────────────────────
function openApp(view) {
  if (popState === 'shown' && !detached) hidePopover();
  if (!appOpen) {
    appOpen = true;
    appPendingView = view || null;                   // the page asks for it once it's loaded
    try { app.presence('normal'); } catch (e) {}     // Dock icon + ⌘-Tab while it's open
    app.win.open('app', { page: 'app.html', title: 'Tiny Time', size: '1180x760', minSize: '900x580' });
  } else if (view) {
    app.window('app').push('view', { view });
  }
  try { app.window('app').show(); } catch (e) {}
}
let appPendingView = null;

// ── idle detection ───────────────────────────────────────────────────────────
async function checkIdle() {
  if (!prefs.idleEnabled) return;
  if (!db.running()) return;
  try {
    const idle = Math.floor(await app.system.idleTime());
    if (!(idle >= Math.max(1, prefs.idleMinutes) * 60)) return;
    const e = db.stopIdle(idle);
    changed();
    if (e) app.notify('Timer stopped', `You were away ${Math.round(idle / 60)} min — “${e.project} · ${e.task}” stopped at ${fmtHM(e.seconds)}.`);
  } catch (e) {}
}

// ── shortcuts ────────────────────────────────────────────────────────────────
async function applyShortcut(id, combo) {
  if (!SC_IDS.includes(id)) return false;
  try { app.hotkey.unregister(id); } catch (e) {}
  if (combo) {
    try { app.hotkey.register(id, combo); } catch (e) { return false; }
    prefs.shortcuts[id] = combo;
  } else delete prefs.shortcuts[id];
  await save('prefs', prefs);
  return true;
}

// ── popover snapshot ─────────────────────────────────────────────────────────
function popSnapshot(sel) {
  const t = today();
  sel = isYmd(sel) ? sel : t;
  const week = weekOf(sel);
  const totals = Object.fromEntries(db.dayTotals(week[0], week[6]).map((r) => [r.date, r.seconds]));
  const tw = weekOf(t);
  const cat = db.catalog();
  const run = db.running();
  return {
    today: t, selDate: sel, weekStart: prefs.weekStart,
    week: week.map((d) => ({ date: d, total: totals[d] || 0 })),
    entries: db.entriesBetween(sel, sel),
    running: run,
    summary: {
      today: db.totalBetween(t, t),
      week: db.totalBetween(tw[0], tw[6]),
      month: db.totalBetween(t.slice(0, 8) + '01', t.slice(0, 8) + '31'),
    },
    empty: cat.clients.length === 0,
    catalog: cat,
  };
}

// ── api ──────────────────────────────────────────────────────────────────────
const id = (v) => Number(v) || null;

export const api = {
  // popover
  popHello: async () => { const p = popPending; popPending = null; return { anchor: popAnchor, detached, view: p && p.view, accent: prefs.accent, appearance: prefs.appearance }; },
  popState: async ({ date } = {}) => popSnapshot(date),
  hidePopover: async () => { hidePopover(); return true; },
  // blur only dismisses an ATTACHED popover; a torn-off one stays put
  blurPopover: async () => { if (!detached) hidePopover(); return true; },
  setDetached: async ({ detached: on, x, y, w, h } = {}) => { await setDetached(on, { x, y, w, h }); return { detached }; },
  // while torn off: remember moves/resizes so reopen + relaunch restore them
  saveWinRect: async ({ x, y, w, h }) => {
    if (!detached) return false;
    detRect = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
    savePopWin(); return true;
  },
  setModal: async ({ on }) => { modalOpen = !!on; return true; },

  // app window
  openApp: async ({ view } = {}) => { openApp(view); return true; },
  appHello: async () => { const v = appPendingView; appPendingView = null; return { view: v, weekStart: prefs.weekStart, accent: prefs.accent, appearance: prefs.appearance }; },

  // catalog
  catalog: async () => db.catalog(),
  saveClient: async (c) => { const r = db.saveClient(c); changed(); return r; },
  deleteClient: async ({ id: x }) => { db.deleteClient(id(x)); changed(); return true; },
  saveProject: async (p) => { const r = db.saveProject({ ...p, client_id: id(p.client_id) }); changed(); return r; },
  deleteProject: async ({ id: x }) => { db.deleteProject(id(x)); changed(); return true; },
  saveTask: async (t) => { const r = db.saveTask(t); changed(); return r; },
  deleteTask: async ({ id: x }) => { db.deleteTask(id(x)); changed(); return true; },

  // time
  today: async () => today(),
  entries: async ({ from, to }) => {
    if (!isYmd(from) || !isYmd(to)) throw new Error('Bad date range.');
    return { entries: db.entriesBetween(from, to), running: db.running(), today: today() };
  },
  saveEntry: async (e) => {
    const r = db.saveEntry({ ...e, date: e.date || today() });
    changed(); return r;
  },
  deleteEntry: async ({ id: x }) => { db.deleteEntry(id(x)); changed(); return true; },
  startEntry: async ({ id: x }) => { const r = db.startEntry(id(x), today()); changed(); return r; },
  stopTimer: async () => { db.stopRunning(); changed(); return true; },

  // reports
  report: async ({ from, to, client_id, project_id, invoiced }) => {
    if (!isYmd(from) || !isYmd(to)) throw new Error('Bad date range.');
    return { rows: db.report(from, to, { client_id, project_id, invoiced }), catalog: db.catalog(), today: today() };
  },
  exportCSV: async ({ from, to, client_id, project_id, invoiced }) => {
    const rows = db.exportRows(from, to, { client_id, project_id, invoiced });
    const path = await app.dialog.saveFile({ types: ['csv'], name: from === '0000-01-01' ? `tiny-time-${today()}.csv` : `tiny-time-${from}-to-${to}.csv` });
    if (!path) return null;
    const cell = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [['Date', 'Client', 'Project', 'Task', 'Notes', 'Hours', 'Rate', 'Amount', 'Currency', 'Invoice', 'Invoice Date'].join(',')];
    for (const r of rows) {
      const h = r.seconds / 3600;
      lines.push([r.date, r.client, r.project, r.task, r.notes, h.toFixed(2), r.rate, (h * r.rate).toFixed(2), r.currency,
        r.invoice_id ? r.invoice_number || '#' + r.invoice_id : '', r.invoice_date || ''].map(cell).join(','));
    }
    await tjs.writeFile(path, new TextEncoder().encode(lines.join('\n') + '\n'));
    return path;
  },

  // Harvest: the same columns as its Detailed time report export. No range = everything.
  exportHarvest: async ({ from, to, client_id, project_id, invoiced } = {}) => {
    const all = !isYmd(from) || !isYmd(to);
    const rows = db.exportRows(all ? '0000-01-01' : from, all ? '9999-12-31' : to, { client_id, project_id, invoiced });
    if (!rows.length) throw new Error('There’s no time to export in this range.');
    const name = all ? `harvest-time-${today()}.csv` : `harvest-time-${from}-to-${to}.csv`;
    const path = await app.dialog.saveFile({ types: ['csv'], name });
    if (!path) return null;
    await tjs.writeFile(path, new TextEncoder().encode(toHarvestCSV(rows, prefs.harvestName)));
    return { path, entries: rows.length };
  },
  // pick a file, preview what it would add, confirm, import
  importHarvest: async () => {
    const path = await app.dialog.openFile({ types: ['csv'] });
    if (!path) return null;
    const { rows, skipped, name } = parseHarvest(new TextDecoder().decode(await tjs.readFile(path)));
    if (!rows.length) throw new Error('No time entries found in that file.');
    const pre = db.importRows(rows, { dry: true });
    const list = (label, xs) => (xs.length ? `\nNew ${label}: ${xs.slice(0, 6).join(', ')}${xs.length > 6 ? ` and ${xs.length - 6} more` : ''}` : '');
    // already imported, but Harvest's invoiced flags haven't been turned into invoices yet
    if (!pre.entries && pre.invoiced.length) return { entries: 0, duplicates: pre.duplicates, seconds: 0, invoiced: pre.invoiced, skipped };
    if (!pre.entries) {
      await app.dialog.alert('Nothing new to import', { detail: `All ${pre.duplicates} entries in this file are already in Tiny Time.` });
      return { entries: 0, duplicates: pre.duplicates, invoiced: [] };
    }
    const detail = `${pre.entries} time entries, ${(pre.seconds / 3600).toFixed(1)} hours.`
      + (pre.duplicates ? `\n${pre.duplicates} already in Tiny Time will be skipped.` : '')
      + (skipped ? `\n${skipped} rows without a date, hours, client, project or task will be skipped.` : '')
      + list('clients', pre.clients) + list('projects', pre.projects) + list('tasks', pre.tasks)
      + (pre.rateNotes.length ? `\n\nRates are per task in Tiny Time, so some Harvest rates won't carry over:\n${pre.rateNotes.slice(0, 4).join('\n')}` : '')
      + (pre.invoiced.length ? `\n\nHarvest marks ${pre.invoiced.length} of these entries as invoiced. Next you can say which invoices they were on.` : '');
    if (!(await app.dialog.confirm('Import from Harvest?', { detail, ok: 'Import', cancel: 'Cancel' }))) return null;
    const res = db.importRows(rows);
    if (name && !prefs.harvestName.first && !prefs.harvestName.last) { prefs.harvestName = name; await save('prefs', prefs); }
    changed();
    return { ...res, skipped };
  },

  // invoices
  invoices: async () => ({ invoices: db.invoices(), unbilled: db.unbilled(), today: today() }),
  invoicePreview: async (sel) => {
    const p = db.invoicePreview(sel);
    return { ...p, suggested: db.suggestInvoiceNumber(p.client ? p.client.id : sel.client_id) };
  },
  createInvoice: async (inv) => {
    const iid = db.createInvoice(inv);
    changed();
    return { id: iid, tally: inv.tally ? await sendToTally(iid) : null };
  },
  updateInvoice: async (inv) => { db.updateInvoice(inv); changed(); return true; },
  deleteInvoice: async ({ id: x }) => { db.deleteInvoice(id(x)); changed(); return true; },
  sendToTally: async ({ id: x }) => sendToTally(id(x)),
  entriesByIds: async ({ ids }) => db.entriesByIds(ids),

  // settings
  getPrefs: async () => {
    let autostart = 'unsupported';
    try { autostart = await app.launchAtLogin.get(); } catch (e) {}
    let dataDir = '';
    try { dataDir = (await app.paths()).data; } catch (e) {}
    return { prefs, autostart, dataDir };
  },
  setPrefs: async (patch) => {
    if (patch.idleEnabled !== undefined) prefs.idleEnabled = !!patch.idleEnabled;
    if (patch.idleMinutes !== undefined) prefs.idleMinutes = Math.min(240, Math.max(1, Math.round(Number(patch.idleMinutes)) || 10));
    if (patch.weekStart !== undefined) prefs.weekStart = Number(patch.weekStart) === 0 ? 0 : 1;
    if (patch.accent !== undefined) prefs.accent = isHex(patch.accent) ? patch.accent.toLowerCase() : DEFAULT_ACCENT;
    if (patch.appearance !== undefined) prefs.appearance = ['light', 'dark'].includes(patch.appearance) ? patch.appearance : 'system';
    if (patch.harvestName !== undefined) prefs.harvestName = { first: String(patch.harvestName.first || '').trim().slice(0, 100), last: String(patch.harvestName.last || '').trim().slice(0, 100) };
    await save('prefs', prefs);
    if (patch.accent !== undefined) updateTray(true);
    if (patch.accent !== undefined || patch.appearance !== undefined) app.push('theme', { accent: prefs.accent, appearance: prefs.appearance });
    changed();
    return prefs;
  },
  setAutostart: async ({ enabled }) => {
    try { await app.launchAtLogin.set(!!enabled); } catch (e) {}
    try { return await app.launchAtLogin.get(); } catch (e) { return 'unsupported'; }
  },
  setShortcut: async ({ id: sid, combo }) => ({ ok: await applyShortcut(sid, combo || null), shortcuts: prefs.shortcuts }),
  revealData: async () => { try { app.shell.reveal((await app.paths()).data); } catch (e) {} return true; },
  seedSample: async () => {
    if (!db.isEmpty()) throw new Error('Sample data can only be added to an empty Tiny Time.');
    db.seed(today()); changed(); return true;
  },
  wipeAll: async () => { db.wipe(); changed(); return true; },
  quit: async () => { app.quit(); },
};

// ── Tiny Tally ───────────────────────────────────────────────────────────────
// Write the invoice as a .tallyinvoice file and open it: Tiny Tally picks it up
// as a new invoice, filled in. Without Tiny Tally, offer to save the file.
async function sendToTally(invoiceId) {
  const inv = db.invoice(invoiceId);
  if (!inv) throw new Error('That invoice no longer exists.');
  const data = handoff(inv, db.client(inv.client_id), db.invoiceEntries(invoiceId));
  const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2) + '\n');
  const name = `Tiny Time invoice ${(inv.number || String(inv.id)).replace(/[\\/:*?"<>|]+/g, '-')}.tallyinvoice`;
  const path = tmpDir + '/' + name;
  await tjs.writeFile(path, bytes);
  try {
    await app.shell.open(path);
    return { opened: true };
  } catch (e) {
    const ok = await app.dialog.confirm('Tiny Tally isn’t installed', {
      detail: 'Tiny Tally opens these invoices as drafts. You can get it from apps.tarwin.art/tiny-tally, or save the invoice file to open later.',
      ok: 'Save Invoice File…', cancel: 'Cancel',
    });
    if (!ok) return { opened: false };
    const to = await app.dialog.saveFile({ types: ['tallyinvoice'], name });
    if (to) await tjs.writeFile(to, bytes);
    return { opened: false, saved: to || null };
  }
}

// ── hooks ────────────────────────────────────────────────────────────────────
export function onTray(tid) {
  if (tid === null) { onTrayClick(); return; }
  if (tid === 'pop') { togglePopover(); return; }
  if (tid === 'new') { showPopover({ view: 'new' }); return; }
  if (tid === 'app') { openApp(); return; }
  if (tid === 'settings') { openApp('settings'); return; }
  if (tid === 'stop') { db.stopRunning(); changed(); return; }
  if (tid === 'resume') { const l = db.lastEntry(); if (l) { db.startEntry(l.id, today()); changed(); } return; }
  if (tid === 'check-updates') { checkForUpdates(); return; }
  if (tid === 'quit') { app.quit(); }
}

// ── self-update (tinyjs verifies sha256 + signature, swaps, relaunches) ──────
// "Check for Updates…" installs; the daily background check only notifies.
async function checkForUpdates() {
  try {
    const r = await app.update.check();
    if (r && r.available) {
      app.notify('Updating Tiny Time…', 'v' + r.latest + ' is downloading. Tiny Time will relaunch.');
      await app.update.install();
    } else {
      app.notify('Tiny Time is up to date', 'v' + ((r && r.current) || '') + ' is the latest.');
    }
  } catch (e) {
    app.notify('Update check failed', String((e && e.message) || e));
  }
}
export function onUpdateAvailable(info) {
  app.notify('Tiny Time update available', 'v' + info.latest + ' is ready. Choose “Check for Updates…” in the menu-bar menu to install it.');
}

export function onHotkey(hid) {
  if (hid === 'sc_pop') togglePopover();
  else if (hid === 'sc_timer') toggleTimer();
  else if (hid === 'sc_new') showPopover({ view: 'new' });
  else if (hid === 'sc_app') openApp();
}

export function onMenu(mid) {
  if (mid === 'settings') openApp('settings');
  else if (mid && mid.startsWith('view:')) openApp(mid.slice(5));
  else if (mid === 'new') openApp('new');
}

export function onWindowClosed(wid) {
  if (wid === 'pop') { popState = 'closed'; clearTimeout(popCloseTimer); popCloseTimer = null; modalOpen = false; }
  if (wid === 'app') {
    appOpen = false;
    try { app.presence('menubar'); } catch (e) {}
  }
}

// a sleep longer than the idle limit counts as idle too
export function onSystem(kind) {
  if (kind === 'wake') checkIdle();
}

// ── boot ─────────────────────────────────────────────────────────────────────
export async function init(a) {
  app = a;
  try { IS_MAC = app.system.os() === 'macos'; } catch (e) {}
  try { const t = (await app.paths()).temp; if (t) tmpDir = t.replace(/[\\/]$/, ''); } catch (e) {}
  if (!TOUR) try {
    const saved = await app.store.get('prefs');
    if (saved && typeof saved === 'object') prefs = { ...prefs, ...saved, shortcuts: { ...(saved.shortcuts || {}) }, harvestName: { first: '', last: '', ...(saved.harvestName || {}) } };
  } catch (e) {}
  if (!TOUR) try {
    const pw = await app.store.get('popwin');
    if (pw && pw.detached && pw.rect) { detached = true; detRect = pw.rect; }
  } catch (e) {}
  await db.open(TOUR || (await app.paths()).data);
  for (const sid of SC_IDS) if (prefs.shortcuts[sid]) { try { app.hotkey.register(sid, prefs.shortcuts[sid]); } catch (e) {} }

  app.menu.set([
    { role: 'app', items: [{ id: 'settings', label: 'Settings…', key: ',' }] },
    { title: 'View', items: [
      { id: 'view:time', label: 'Timesheet', key: '1' },
      { id: 'view:reports', label: 'Reports', key: '2' },
      { id: 'view:invoices', label: 'Invoices', key: '7' },
      { id: 'view:clients', label: 'Clients', key: '3' },
      { id: 'view:projects', label: 'Projects', key: '4' },
      { id: 'view:tasks', label: 'Tasks', key: '5' },
      { id: 'view:data', label: 'Import & Export', key: '6' },
      ...(IS_MAC ? [] : [{ separator: true }, { id: 'settings', label: 'Settings', key: ',' }]),
    ] },
  ]);

  updateTray(true);
  setInterval(() => {
    const run = db.running();
    updateTray();
    if (run && (popState === 'shown' || appOpen)) app.push('tick', { id: run.id, seconds: run.seconds });
    if (run && ++idleTick >= 15) { idleTick = 0; checkIdle(); }
  }, 1000);

  if (TOUR) { runTour(); return; }
  // first run: say hello so a menu-bar-only app isn't invisible
  if (db.isEmpty()) setTimeout(() => showPopover(), 400);
  // dev convenience: TINYTIME_OPEN=reports tinyjs dev  (or =pop)
  const devOpen = tjs.env.TINYTIME_OPEN;
  if (devOpen) setTimeout(() => (devOpen === 'pop' ? showPopover() : openApp(devOpen)), 600);
}

// ── screenshot tour ──────────────────────────────────────────────────────────
// For each shot: set the scene, write shot.json { seq, name, win }, and wait
// for scripts/screenshots.sh to answer with done-<seq> once it has captured
// the window. Then 'finished'.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function exists(p) { try { await tjs.stat(p); return true; } catch (e) { return false; } }
async function runTour() {
  const enc = new TextEncoder();
  db.seed(today());
  db.tourToday(today());
  prefs = { ...prefs, accent: DEFAULT_ACCENT, appearance: 'light', weekStart: 1 };
  updateTray(true);
  let seq = 0;
  const theme = async (appearance, accent = DEFAULT_ACCENT) => {
    prefs.appearance = appearance; prefs.accent = accent;
    updateTray(true); app.push('theme', { accent, appearance }); await sleep(400);
  };
  const shot = async (name, win) => {
    await sleep(900);
    seq++;
    await tjs.writeFile(TOUR + '/shot.json', enc.encode(JSON.stringify({ seq, name, win })));
    for (let i = 0; i < 300 && !(await exists(TOUR + '/done-' + seq)); i++) await sleep(100);
  };
  const tour = (w, step) => app.window(w).push('tour', step);

  await sleep(800);
  await showPopover(); await shot('popover', 'pop');
  await theme('dark'); await shot('popover-dark', 'pop');
  await theme('light');
  tour('pop', { sheet: 'new' }); await shot('popover-entry', 'pop');
  tour('pop', { sheet: null });
  await setDetached(true, { x: 200, y: 140, w: 420, h: 560 });
  try { app.window('pop').setSize(420, 560); app.window('pop').setPosition(200, 140); } catch (e) {}
  await shot('torn-off', 'pop');
  await setDetached(false); detached = false;
  hidePopover();

  openApp('time'); await sleep(1500); await shot('timesheet', 'app');
  tour('app', { timeMode: 'week', weeksBack: 1 }); await shot('week', 'app');
  tour('app', { timeMode: 'day', weeksBack: 0 });
  openApp('reports'); tour('app', { preset: 'last30' }); await shot('reports', 'app');
  await theme('dark'); await shot('reports-dark', 'app');
  await theme('light');
  openApp('clients'); tour('app', { modal: 'client' }); await shot('client', 'app');
  tour('app', { modal: null });
  openApp('projects'); tour('app', { modal: 'project' }); await shot('project', 'app');
  tour('app', { modal: null });
  openApp('tasks'); await shot('tasks', 'app');
  await theme('light', '#6250d6');
  openApp('settings'); await shot('settings', 'app');
  await tjs.writeFile(TOUR + '/finished', enc.encode('1'));
}

