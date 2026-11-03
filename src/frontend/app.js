// Tiny Time — dashboard window. Opened on demand (the app has no main
// window); closing it drops the WebView and the Dock icon again.

import { $, el, h, icon, call, fmtHM, fmtHMS, fmtHours, parseDuration, parseYmd, ymd, addDays, weekOf, dayLabel,
  DOW, MON, money, CURRENCIES, TERMS, termsLabel, indexCatalog, projectSelect, taskOptions, errMsg, applyTheme, ACCENTS, DEFAULT_ACCENT, IS_MAC, mod, FILE_MANAGER } from './lib.js';

let view = 'time';
let cat = null;              // indexed catalog
let weekStart = 1;
let today = ymd(new Date());
let running = null;          // running entry (as of last load)
let runBase = 0;
const S = {                  // per-view state that survives re-renders
  timeSel: null, timeMode: 'day',
  rep: { preset: 'month', from: null, to: null, client: '', project: '', invoiced: '', by: 'project' },
  showArchived: false,
};

// ── navigation ───────────────────────────────────────────────────────────────
const VIEWS = { time: renderTime, reports: renderReports, clients: renderClients, projects: renderProjects, tasks: renderTasks, invoices: renderInvoices, data: renderData, settings: renderSettings };
document.querySelectorAll('.nav').forEach((a) => (a.onclick = () => go(a.dataset.view)));
function go(v) {
  if (v === 'new') { go('time'); entryModal(); return; }
  if (!VIEWS[v]) v = 'time';
  view = v;
  document.querySelectorAll('.nav').forEach((a) => a.classList.toggle('on', a.dataset.view === v));
  refresh();
}
let refreshing = null;
async function refresh() {
  // coalesce bursts of 'changed'
  if (refreshing) { refreshing.again = true; return; }
  refreshing = { again: false };
  try {
    cat = indexCatalog(await call('catalog'));
    const st = await call('entries', { from: today, to: today });
    today = st.today; setRunning(st.running);
    const keep = $('main').scrollTop;
    await VIEWS[view]();
    $('main').scrollTop = keep;
  } catch (e) { console.error(e); }
  const again = refreshing.again; refreshing = null;
  if (again) refresh();
}
function setRunning(r) {
  running = r; runBase = r ? r.seconds : 0;
  const box = $('sideRun'); box.replaceChildren();
  if (!r) return;
  box.append(h('div', { class: 'rc' },
    h('span', { class: 'dot', style: { background: r.color } }),
    h('div', { class: 'm' }, h('div', { class: 'p' }, r.project), h('div', { class: 't' }, r.task)),
    h('span', { class: 'v', 'data-live': r.seconds, 'data-fmt': 'hms' }, fmtHMS(r.seconds)),
    h('button', { class: 'tog', style: { width: '28px', height: '28px', background: 'var(--accent)', color: 'var(--on-accent)', borderColor: 'var(--accent)' }, title: 'Stop', onclick: () => call('stopTimer') }, icon('stop'))));
}

// live-ticking numbers: any element with data-live="<seconds at load>"
tiny.api.on('tick', (t) => {
  if (!running || t.id !== running.id) return;
  const d = t.seconds - runBase;
  document.querySelectorAll('[data-live]').forEach((n) => {
    const v = Number(n.dataset.live) + d;
    n.textContent = n.dataset.fmt === 'hms' ? fmtHMS(v) : n.dataset.fmt === 'dec' ? fmtHours(v) : fmtHM(v);
  });
});
tiny.api.on('changed', () => refresh());
tiny.api.on('view', ({ view: v }) => go(v));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('modalLayer').classList.contains('open')) closeModal();
  else if (mod(e) && e.key.toLowerCase() === 'n' && !$('modalLayer').classList.contains('open')) { e.preventDefault(); if (cat && cat.projects.length) entryModal(); }
});

// ── helpers ──────────────────────────────────────────────────────────────────
const main = () => $('main');
const top = (title, ...rest) => h('div', { class: 'top' }, h('h1', null, title), ...rest);
const activeProjects = () => cat.projects.filter((p) => !p.archived && !cat.byClient[p.client_id]?.archived);
const amountOf = (e) => (e.seconds / 3600) * (e.rate || 0);

function seg(options, value, onChange) {
  return h('div', { class: 'seg' }, options.map(([v, l]) => h('button', { class: v === value ? 'on' : '', onclick: () => onChange(v) }, l)));
}

// ── modal ────────────────────────────────────────────────────────────────────
function openModal(title, body, actions) {
  const m = h('div', { class: 'modal' }, h('h3', null, title), h('div', { class: 'mb' }, body), h('div', { class: 'mf' }, actions));
  $('modalLayer').replaceChildren(m);
  $('modalLayer').classList.add('open');
  setTimeout(() => { const f = m.querySelector('input:not([type=checkbox]), select, textarea'); f && f.focus(); }, 30);
  return m;
}
function closeModal() { $('modalLayer').classList.remove('open'); $('modalLayer').replaceChildren(); }
$('modalLayer').addEventListener('pointerdown', (e) => { if (e.target === $('modalLayer')) closeModal(); });
const field = (label, input, hint) => [h('label', { class: 'f' }, label), input, hint ? h('div', { class: 'hint' }, hint) : null];
const spacer = () => h('span', { class: 'grow' });
async function confirmDanger(msg, detail, ok = 'Delete') { return tiny.dialog.confirm(msg, { detail, ok, cancel: 'Cancel' }); }

// ── Harvest ──────────────────────────────────────────────────────────────────
async function harvestImport() {
  try {
    const r = await call('importHarvest');
    if (!r) return;
    const inv = r.invoiced || [];
    if (r.entries) {
      await tiny.dialog.alert('Imported from Harvest', { detail: `${r.entries} time entries, ${(r.seconds / 3600).toFixed(1)} hours.`
        + (r.duplicates ? ` ${r.duplicates} were already here and were skipped.` : '') });
    }
    if (inv.length) { go('invoices'); await harvestInvoicesModal(inv); }
    else if (r.entries) go('reports');
  } catch (x) { tiny.dialog.alert('Couldn’t import that file', { detail: errMsg(x) }); }
}
async function harvestExport(range) {
  try {
    const r = await call('exportHarvest', range || {});
    if (r) tiny.notify && tiny.notify('Exported for Harvest', `${r.entries} entries → ${r.path}`);
  } catch (x) { tiny.dialog.alert('Couldn’t export', { detail: errMsg(x) }); }
}

// ════════════════════════════════════════════════════════════════════════════
// TIMESHEET
// ════════════════════════════════════════════════════════════════════════════
async function renderTime() {
  const sel = S.timeSel || today;
  const week = weekOf(sel, weekStart);
  const { entries } = await call('entries', { from: week[0], to: week[6] });
  const m = main(); m.replaceChildren();

  const ws = parseYmd(week[0]), we = parseYmd(week[6]);
  const range = `${ws.getDate()} ${MON[ws.getMonth()]} – ${we.getDate()} ${MON[we.getMonth()]} ${we.getFullYear()}`;
  // the arrows sit left of the title, so a longer or shorter date never moves them
  m.append(h('div', { class: 'top' },
    h('button', { class: 'iconbtn', title: 'Previous', onclick: () => { S.timeSel = addDays(sel, S.timeMode === 'day' ? -1 : -7); refresh(); } }, icon('left')),
    h('button', { class: 'iconbtn', title: 'Next', onclick: () => { S.timeSel = addDays(sel, S.timeMode === 'day' ? 1 : 7); refresh(); } }, icon('right')),
    h('h1', { style: { marginLeft: '4px' } }, S.timeMode === 'day' ? dayLabel(sel, today) : 'Week of ' + range),
    sel !== today ? h('button', { class: 'btn', onclick: () => { S.timeSel = today; refresh(); } }, 'Today') : null,
    spacer(),
    seg([['day', 'Day'], ['week', 'Week']], S.timeMode, (v) => { S.timeMode = v; refresh(); }),
    h('button', { class: 'btn primary', onclick: () => entryModal(null, sel) }, '+ New Entry')));

  if (!cat.projects.length) {
    m.append(h('div', { class: 'card empty-note' }, h('div', null, 'You need a client and a project before you can track time.'),
      h('button', { class: 'btn primary', onclick: () => go('clients') }, 'Add a Client')));
    return;
  }

  // week bar
  const tot = {}; let wk = 0;
  for (const e of entries) { tot[e.date] = (tot[e.date] || 0) + e.seconds; wk += e.seconds; }
  const runDate = running && running.date;
  const bar = h('div', { class: 'weekbar' });
  for (const d of week) {
    const dd = parseYmd(d);
    const cls = 'wd' + (d === sel && S.timeMode === 'day' ? ' sel' : '') + (d === today ? ' today' : '') + (tot[d] ? ' has' : '');
    bar.append(h('div', { class: cls, onclick: () => { S.timeSel = d; S.timeMode = 'day'; refresh(); } },
      h('div', { class: 'n' }, DOW[dd.getDay()] + ' ' + dd.getDate()),
      h('div', { class: 'v', 'data-live': d === runDate ? (tot[d] || 0) : null }, fmtHM(tot[d] || 0))));
  }
  bar.append(h('div', { class: 'wd tot' }, h('div', { class: 'n' }, 'Week'),
    h('div', { class: 'v', 'data-live': runDate && week.includes(runDate) ? wk : null }, fmtHM(wk))));
  m.append(bar);

  if (S.timeMode === 'week') { m.append(weekGrid(week, entries)); return; }

  const dayEntries = entries.filter((e) => e.date === sel);
  if (!dayEntries.length) {
    m.append(h('div', { class: 'card empty-note' }, h('div', null, 'No time on this day.'),
      h('button', { class: 'btn primary', onclick: () => entryModal(null, sel) }, sel === today ? 'Start a Timer' : 'Add Time')));
    return;
  }
  const list = h('div', { class: 'card elist' });
  for (const e of dayEntries) {
    const run = running && running.id === e.id;
    const amt = amountOf(e);
    list.append(h('div', { class: 'row' + (run ? ' run' : ''), ondblclick: () => entryModal(e) },
      h('div', { class: 'bar', style: { background: e.color } }),
      h('div', { class: 'm' },
        h('div', { class: 'p' }, e.project + ' ', h('span', { class: 'c' }, '(' + e.client + ')')),
        h('div', { class: 't' }, e.task, e.invoice_id ? h('span', { class: 'badge grey', style: { marginLeft: '8px' }, title: 'Invoiced ' + fmtDay(e.invoice_date) }, 'Invoiced' + (e.invoice_number ? ' · ' + e.invoice_number : '')) : null),
        e.notes ? h('div', { class: 'nt' }, e.notes) : null),
      h('div', { class: 'rowact' },
        h('button', { class: 'lnk', onclick: () => entryModal(e) }, 'Edit'),
        h('button', { class: 'lnk danger', onclick: async () => { if (await confirmDanger('Delete this time entry?', `${fmtHM(e.seconds)} on ${e.project} · ${e.task}` + (e.invoice_id ? `. It’s on invoice ${e.invoice_number || ''}, which keeps the amount it was billed for.` : ''))) call('deleteEntry', { id: e.id }); } }, 'Delete')),
      h('div', { class: 'amt' }, amt ? money(amt, e.currency) : ''),
      h('div', { class: 'tm', 'data-live': run ? e.seconds : null, 'data-fmt': run ? 'hms' : null }, run ? fmtHMS(e.seconds) : fmtHM(e.seconds)),
      h('button', { class: 'tog', title: run ? 'Stop timer' : 'Start timer', onclick: () => (run ? call('stopTimer') : call('startEntry', { id: e.id })) }, icon(run ? 'stop' : 'play'))));
  }
  m.append(list);
}

// project·task rows × days of the week
function weekGrid(week, entries) {
  const rows = new Map();
  for (const e of entries) {
    const k = e.project_id + ':' + e.task_id;
    if (!rows.has(k)) rows.set(k, { e, days: {}, total: 0 });
    const r = rows.get(k); r.days[e.date] = (r.days[e.date] || 0) + e.seconds; r.total += e.seconds;
  }
  if (!rows.size) return h('div', { class: 'card empty-note' }, 'No time this week.');
  const colTot = {}; let all = 0;
  const body = [...rows.values()].sort((a, b) => a.e.client.localeCompare(b.e.client) || a.e.project.localeCompare(b.e.project) || a.e.task.localeCompare(b.e.task)).map((r) => {
    all += r.total;
    return h('tr', null,
      h('td', null, h('div', { class: 'barcell' }, h('span', { class: 'dot', style: { background: r.e.color } }),
        h('div', null, h('div', null, h('b', null, r.e.project), h('span', { class: 'muted' }, ' · ' + r.e.client)), h('div', { class: 'muted' }, r.e.task)))),
      week.map((d) => { colTot[d] = (colTot[d] || 0) + (r.days[d] || 0); return h('td', { class: 'r' + (r.days[d] ? '' : ' zero') }, fmtHM(r.days[d] || 0)); }),
      h('td', { class: 'r' }, h('b', null, fmtHM(r.total))));
  });
  return h('div', { class: 'card' }, h('table', { class: 'grid' },
    h('thead', null, h('tr', null, h('th', null, 'Project / Task'), week.map((d) => { const dd = parseYmd(d); return h('th', { class: 'r' }, DOW[dd.getDay()] + ' ' + dd.getDate()); }), h('th', { class: 'r' }, 'Total'))),
    h('tbody', null, body),
    h('tfoot', null, h('tr', null, h('td', null, 'Total'), week.map((d) => h('td', { class: 'r' }, fmtHM(colTot[d] || 0))), h('td', { class: 'r' }, fmtHM(all))))));
}

function entryModal(e, date) {
  date = e ? e.date : date || S.timeSel || today;
  if (!activeProjects().length) { go('projects'); return; }
  const isRun = e && running && running.id === e.id;
  const def = e || running;                       // new entries default to what you're tracking
  const pSel = projectSelect(cat, def ? def.project_id : null);
  const tSel = h('select', { class: 'in' });
  taskOptions(tSel, cat, def ? def.project_id : null, def ? def.task_id : null);
  pSel.onchange = () => taskOptions(tSel, cat, Number(pSel.value), null);
  const dIn = h('input', { class: 'in', type: 'date', value: date });
  const notes = h('textarea', { class: 'in', rows: 3, placeholder: 'Notes (optional)' }, e ? e.notes : '');
  const dur = h('input', { class: 'in num', placeholder: 'Empty = start a timer · 1:30 · 1.5 · 90m', value: e ? fmtHM(e.seconds) : '', disabled: !!isRun });
  const err = h('div', { class: 'err' });
  const saveBtn = h('button', { class: 'btn primary' }, e ? 'Save' : 'Start Timer');
  const relabel = () => { if (!e) saveBtn.textContent = dur.value.trim() || dIn.value !== today ? 'Save Entry' : 'Start Timer'; };
  dur.oninput = relabel; dIn.onchange = relabel; relabel();
  saveBtn.onclick = async () => {
    const raw = dur.value.trim();
    let seconds = isRun ? running.seconds : 0;
    if (raw && !isRun) { seconds = parseDuration(raw); if (seconds == null) { err.textContent = 'Try a duration like 1:30, 1.5 or 90m.'; return; } }
    if (!Number(pSel.value)) { err.textContent = 'Choose a project.'; return; }
    if (!Number(tSel.value)) { err.textContent = 'This project has no tasks yet — add some under Projects.'; return; }
    try {
      await call('saveEntry', { id: e ? e.id : undefined, project_id: Number(pSel.value), task_id: Number(tSel.value), notes: notes.value,
        date: dIn.value || date, seconds, start: !e && !raw && dIn.value === today });
      closeModal();
    } catch (x) { err.textContent = errMsg(x); }
  };
  openModal(e ? 'Edit Time Entry' : 'New Time Entry',
    [e && e.invoice_id ? h('div', { class: 'hint', style: { marginTop: 0, marginBottom: '6px' } }, `On invoice ${e.invoice_number || ''} (${fmtDay(e.invoice_date)}). Changing it here doesn’t change what that invoice billed.`) : null,
      ...field('Project', pSel), ...field('Task', tSel), ...field('Notes', notes),
      h('div', { class: 'cols' }, h('div', null, ...field('Date', dIn)), h('div', null, ...field('Duration', dur))), err],
    [e ? h('button', { class: 'btn danger ghost', onclick: async () => { await call('deleteEntry', { id: e.id }); closeModal(); } }, 'Delete') : null,
      spacer(), h('button', { class: 'btn', onclick: closeModal }, 'Cancel'), saveBtn]);
}

// ════════════════════════════════════════════════════════════════════════════
// REPORTS
// ════════════════════════════════════════════════════════════════════════════
const PRESETS = [['week', 'This Week'], ['lastweek', 'Last Week'], ['last30', 'Last 30 Days'], ['month', 'This Month'], ['lastmonth', 'Last Month'],
  ['quarter', 'This Quarter'], ['year', 'This Year'], ['last12', 'Last 12 Months'], ['all', 'All Time'], ['custom', 'Custom…']];
function presetRange(p) {
  const t = parseYmd(today), y = t.getFullYear(), mo = t.getMonth();
  const w = weekOf(today, weekStart);
  switch (p) {
    case 'week': return [w[0], w[6]];
    case 'lastweek': return [addDays(w[0], -7), addDays(w[6], -7)];
    case 'last30': return [addDays(today, -29), today];
    case 'month': return [ymd(new Date(y, mo, 1)), ymd(new Date(y, mo + 1, 0))];
    case 'lastmonth': return [ymd(new Date(y, mo - 1, 1)), ymd(new Date(y, mo, 0))];
    case 'quarter': { const q = Math.floor(mo / 3) * 3; return [ymd(new Date(y, q, 1)), ymd(new Date(y, q + 3, 0))]; }
    case 'year': return [ymd(new Date(y, 0, 1)), ymd(new Date(y, 11, 31))];
    case 'last12': return [ymd(new Date(y, mo - 11, 1)), ymd(new Date(y, mo + 1, 0))];
    case 'all': return ['0000-01-01', today];   // narrowed to the first entry once the rows are in
  }
  return [S.rep.from || ymd(new Date(y, mo, 1)), S.rep.to || today];
}

async function renderReports() {
  const R = S.rep;
  let [from, to] = presetRange(R.preset);
  const res = await call('report', { from, to, client_id: R.client || null, project_id: R.project || null, invoiced: R.invoiced || null });
  const rows = res.rows;
  if (R.preset === 'all') {        // rows come sorted by date
    from = rows.length ? rows[0].date : today;
    if (rows.length && rows[rows.length - 1].date > to) to = rows[rows.length - 1].date;
  }
  R.from = from; R.to = to;
  const m = main(); m.replaceChildren();

  // filters — one row above the charts
  const preset = h('select', { class: 'in sm', onchange: (e) => { R.preset = e.target.value; refresh(); } },
    PRESETS.map(([v, l]) => h('option', { value: v, selected: v === R.preset }, l)));
  const fromIn = h('input', { class: 'in sm', type: 'date', value: from, onchange: (e) => { R.preset = 'custom'; R.from = e.target.value; refresh(); } });
  const toIn = h('input', { class: 'in sm', type: 'date', value: to, onchange: (e) => { R.preset = 'custom'; R.to = e.target.value; refresh(); } });
  const cSel = h('select', { class: 'in sm', onchange: (e) => { R.client = e.target.value; R.project = ''; refresh(); } },
    h('option', { value: '' }, 'All clients'), cat.clients.map((c) => h('option', { value: c.id, selected: String(c.id) === String(R.client) }, c.name)));
  const pSel = h('select', { class: 'in sm', onchange: (e) => { R.project = e.target.value; refresh(); } },
    h('option', { value: '' }, 'All projects'),
    cat.projects.filter((p) => !R.client || String(p.client_id) === String(R.client)).map((p) => h('option', { value: p.id, selected: String(p.id) === String(R.project) }, p.name)));
  const iSel = h('select', { class: 'in sm', onchange: (e) => { R.invoiced = e.target.value; refresh(); } },
    [['', 'Invoiced or not'], ['no', 'Not invoiced'], ['yes', 'Invoiced']].map(([v, l]) => h('option', { value: v, selected: v === (R.invoiced || '') }, l)));
  const sel = { from, to, client_id: R.client || null, project_id: R.project || null, invoiced: R.invoiced || null };
  m.append(top('Reports', preset, fromIn, h('span', { class: 'muted' }, '→'), toIn, cSel, pSel, iSel, spacer(),
    h('button', { class: 'btn', onclick: async () => { const p = await call('exportCSV', sel); if (p) tiny.notify && tiny.notify('Exported', p); } }, icon('download'), 'Export CSV'),
    h('button', { class: 'btn', title: 'The columns of Harvest’s Detailed time export', onclick: () => harvestExport(sel) }, icon('download'), 'Harvest CSV')));

  if (!rows.length) { m.append(h('div', { class: 'card empty-note' }, 'No time tracked in this range.')); return; }

  // enrich rows
  for (const r of rows) {
    const t = cat.byTask[r.task_id], c = cat.byClient[r.client_id];
    r.hours = r.seconds / 3600; r.rate = t ? t.rate : 0; r.amount = r.hours * r.rate; r.currency = c ? c.currency : 'USD';
  }
  const totalSec = rows.reduce((a, r) => a + r.seconds, 0);
  const days = new Set(rows.map((r) => r.date)).size;
  const byCur = {};
  for (const r of rows) byCur[r.currency] = (byCur[r.currency] || 0) + r.amount;
  const curs = Object.entries(byCur).sort((a, b) => b[1] - a[1]);
  const billableSec = rows.filter((r) => r.rate > 0).reduce((a, r) => a + r.seconds, 0);

  // hero tiles
  m.append(h('div', { class: 'tiles' },
    tile('Total hours', fmtHours(totalSec), fmtHM(totalSec) + ' h:mm'),
    tile('Billable amount', curs.length ? money(curs[0][1], curs[0][0]) : '—', curs.slice(1).map(([c, v]) => money(v, c)).join(' · ') || (curs.length ? 'before discount & tax' : '')),
    tile('Billable hours', fmtHours(billableSec), totalSec ? Math.round((billableSec / totalSec) * 100) + '% of tracked time' : ''),
    tile('Average per day worked', fmtHours(days ? totalSec / days : 0), days + ' day' + (days === 1 ? '' : 's') + ' with time')));

  // hours over time, stacked by project
  m.append(timeChart(rows, from, to));

  // breakdown
  const by = R.by;
  const groups = new Map();
  for (const r of rows) {
    const key = by === 'client' ? r.client_id : by === 'task' ? r.task_id : r.project_id;
    if (!groups.has(key)) groups.set(key, { key, seconds: 0, amounts: {} });
    const g = groups.get(key); g.seconds += r.seconds; g.amounts[r.currency] = (g.amounts[r.currency] || 0) + r.amount;
  }
  const list = [...groups.values()].sort((a, b) => b.seconds - a.seconds);
  const maxS = list[0] ? list[0].seconds : 1;
  const label = (g) => {
    if (by === 'client') return [cat.byClient[g.key]?.name || '?', null, '#888'];
    if (by === 'task') return [cat.byTask[g.key]?.name || '?', null, 'var(--accent)'];
    const p = cat.byProject[g.key]; return [p?.name || '?', cat.byClient[p?.client_id]?.name, p?.color || '#888'];
  };
  m.append(h('div', { class: 'card panel' },
    h('div', { class: 'panel-h' }, h('h2', null, 'Breakdown'), seg([['client', 'Clients'], ['project', 'Projects'], ['task', 'Tasks']], by, (v) => { R.by = v; refresh(); })),
    h('table', { class: 'grid' },
      h('thead', null, h('tr', null, h('th', null, by === 'client' ? 'Client' : by === 'task' ? 'Task' : 'Project'), h('th', { style: { width: '38%' } }, ''), h('th', { class: 'r' }, 'Hours'), h('th', { class: 'r' }, '%'), h('th', { class: 'r' }, 'Amount'))),
      h('tbody', null, list.map((g) => {
        const [name, sub, color] = label(g);
        return h('tr', null,
          h('td', null, h('div', { class: 'barcell' }, by === 'project' ? h('span', { class: 'dot', style: { background: color } }) : null, h('div', null, name, sub ? h('span', { class: 'muted' }, ' · ' + sub) : null))),
          h('td', null, h('div', { class: 'barcell' }, h('div', { class: 'track' }, h('div', { class: 'fill', style: { width: (g.seconds / maxS) * 100 + '%', background: by === 'project' ? color : 'var(--accent)' } })))),
          h('td', { class: 'r' }, fmtHours(g.seconds)),
          h('td', { class: 'r muted' }, Math.round((g.seconds / totalSec) * 100) + '%'),
          h('td', { class: 'r' }, Object.entries(g.amounts).filter(([, v]) => v > 0).map(([c, v]) => money(v, c)).join(' + ') || h('span', { class: 'muted' }, '—')));
      })))));

  // billing summary per client — applies each client's discount and tax
  const perClient = new Map();
  for (const r of rows) {
    if (!perClient.has(r.client_id)) perClient.set(r.client_id, { seconds: 0, sub: 0 });
    const p = perClient.get(r.client_id); p.seconds += r.seconds; p.sub += r.amount;
  }
  m.append(h('div', { class: 'card panel' },
    h('div', { class: 'panel-h' }, h('h2', null, 'Billing summary'), h('span', { class: 'muted' }, 'Uses each client’s currency, discount, tax and terms')),
    h('table', { class: 'grid' },
      h('thead', null, h('tr', null, ['Client', 'Hours', 'Subtotal', 'Discount', 'Tax', 'Total', 'Terms'].map((t, i) => h('th', { class: i && i < 6 ? 'r' : '' }, t)))),
      h('tbody', null, [...perClient.entries()].sort((a, b) => b[1].sub - a[1].sub).map(([cid, p]) => {
        const c = cat.byClient[cid] || { name: '?', currency: 'USD', discount_pct: 0, tax_pct: 0, terms_days: 30 };
        const disc = p.sub * (c.discount_pct / 100), taxed = (p.sub - disc) * (c.tax_pct / 100), total = p.sub - disc + taxed;
        return h('tr', null, h('td', null, c.name),
          h('td', { class: 'r' }, fmtHours(p.seconds)),
          h('td', { class: 'r' }, money(p.sub, c.currency)),
          h('td', { class: 'r' + (disc ? '' : ' zero') }, disc ? '−' + money(disc, c.currency) + ` (${c.discount_pct}%)` : '—'),
          h('td', { class: 'r' + (taxed ? '' : ' zero') }, taxed ? money(taxed, c.currency) + ` (${c.tax_pct}%)` : '—'),
          h('td', { class: 'r' }, h('b', null, money(total, c.currency))),
          h('td', { class: 'muted' }, termsLabel(c.terms_days)));
      })))));
}
const tile = (l, v, s) => h('div', { class: 'card tile' }, h('div', { class: 'l' }, l), h('div', { class: 'v' }, v), h('div', { class: 's' }, s || ' '));

// Stacked bars of hours per day/week/month, one segment per project. Top 7
// projects keep their own color; the rest fold into "Other" (gray) so no
// generated hues ever appear.
function timeChart(rows, from, to) {
  const span = Math.round((parseYmd(to) - parseYmd(from)) / 864e5) + 1;
  const unit = span <= 45 ? 'day' : span <= 190 ? 'week' : 'month';
  const bucketOf = (d) => unit === 'day' ? d : unit === 'week' ? weekOf(d, weekStart)[0] : d.slice(0, 7);
  const buckets = [];
  if (unit === 'day') for (let d = from; d <= to; d = addDays(d, 1)) buckets.push(d);
  else if (unit === 'week') for (let d = weekOf(from, weekStart)[0]; d <= to; d = addDays(d, 7)) buckets.push(d);
  else { const s = parseYmd(from); for (let x = new Date(s.getFullYear(), s.getMonth(), 1); ymd(x) <= to; x.setMonth(x.getMonth() + 1)) buckets.push(ymd(x).slice(0, 7)); }

  const projTot = {};
  for (const r of rows) projTot[r.project_id] = (projTot[r.project_id] || 0) + r.seconds;
  const ranked = Object.keys(projTot).map(Number).sort((a, b) => projTot[b] - projTot[a]);
  const keep = ranked.length > 8 ? ranked.slice(0, 7) : ranked;
  const series = keep.map((id) => ({ id, name: cat.byProject[id]?.name || '?', color: cat.byProject[id]?.color || '#888' }));
  if (ranked.length > keep.length) series.push({ id: 'other', name: 'Other', color: '#8b9096' });
  const sid = (pid) => (keep.includes(pid) ? pid : 'other');

  const data = new Map(buckets.map((b) => [b, {}]));
  for (const r of rows) { const b = data.get(bucketOf(r.date)); if (b) b[sid(r.project_id)] = (b[sid(r.project_id)] || 0) + r.seconds; }

  const W = Math.max(480, main().clientWidth - 56 - 38), H = 240, L = 36, B = 24, T = 8;   // real px — no stretched text
  const maxH = Math.max(1, ...[...data.values()].map((b) => Object.values(b).reduce((a, s) => a + s, 0) / 3600));
  const step = maxH <= 4 ? 1 : maxH <= 10 ? 2 : maxH <= 25 ? 5 : maxH <= 60 ? 10 : maxH <= 120 ? 20 : 50;
  const top = Math.ceil(maxH / step) * step;
  const y = (hrs) => T + (H - T - B) * (1 - hrs / top);
  const slot = (W - L) / buckets.length;
  const bw = Math.max(3, Math.min(34, slot * 0.66));
  const NS = 'http://www.w3.org/2000/svg';
  const s = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };
  const svg = s('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, width: W, height: H });
  const grid = s('g', { class: 'grid' }), axis = s('g', { class: 'axis' });
  for (let v = 0; v <= top; v += step) {
    grid.append(s('line', { x1: L, x2: W, y1: y(v), y2: y(v), 'stroke-dasharray': v ? '2 3' : '' }));
    const t = s('text', { x: L - 8, y: y(v) + 4, 'text-anchor': 'end' }); t.textContent = v + 'h'; axis.append(t);
  }
  svg.append(grid, axis);
  const every = Math.ceil(buckets.length / 14);
  const bucketLabel = (b) => {
    if (unit === 'month') return MON[Number(b.slice(5, 7)) - 1] + (b.slice(5, 7) === '01' ? ' ' + b.slice(0, 4) : '');
    const d = parseYmd(b); return d.getDate() + ' ' + MON[d.getMonth()];
  };
  buckets.forEach((b, i) => {
    const cx = L + slot * i + slot / 2, x = cx - bw / 2;
    const vals = data.get(b);
    let acc = 0;
    const segs = series.filter((se) => vals[se.id]);
    segs.forEach((se, j) => {
      const hrs = vals[se.id] / 3600;
      const y0 = y(acc), y1 = y(acc + hrs);
      const hgt = Math.max(0, y0 - y1 - (j < segs.length - 1 ? 2 : 0));   // 2px surface gap between segments
      const isTop = j === segs.length - 1, r = Math.min(4, bw / 2, hgt);
      const yy = y0 - hgt - (j > 0 ? 0 : 0);
      const path = isTop
        ? `M${x},${y0} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + bw - r} Q${x + bw},${yy} ${x + bw},${yy + r} V${y0} Z`
        : `M${x},${y0} V${yy} H${x + bw} V${y0} Z`;
      svg.append(s('path', { d: path, fill: se.color }));
      acc += hrs;
    });
    if (i % every === 0) { const t = s('text', { x: cx, y: H - 6, 'text-anchor': 'middle' }); t.textContent = bucketLabel(b); axis.append(t); }
    // hit target bigger than the mark
    const hit = s('rect', { class: 'hit', x: L + slot * i, y: T, width: slot, height: H - T - B, rx: 4 });
    hit.addEventListener('pointermove', (ev) => showTip(ev, unit === 'week' ? 'Week of ' + bucketLabel(b) : unit === 'day' ? dayLabel(b, today) : bucketLabel(b), segs.map((se) => [se, vals[se.id]]).reverse()));
    hit.addEventListener('pointerleave', hideTip);
    svg.insertBefore(hit, grid.nextSibling);
  });
  svg.append(axis);

  return h('div', { class: 'card panel' },
    h('div', { class: 'panel-h' }, h('h2', null, 'Hours per ' + unit + ' by project')),
    series.length > 1 ? h('div', { class: 'legend' }, series.map((se) => h('span', null, h('i', { style: { background: se.color } }), se.name))) : null,
    svg);
}
function showTip(ev, title, items) {
  const t = $('tip');
  const total = items.reduce((a, [, v]) => a + v, 0);
  t.replaceChildren(h('div', { class: 'th' }, title),
    ...(items.length ? items.map(([se, v]) => h('div', { class: 'tr' }, h('span', { class: 'k' }, h('span', { class: 'dot', style: { background: se.color } }), se.name), h('span', null, fmtHM(v))))
      : [h('div', { class: 'muted' }, 'No time')]),
    items.length > 1 ? h('div', { class: 'tr tt' }, h('span', null, 'Total'), h('span', null, fmtHM(total))) : null);
  t.style.display = 'block';
  const r = t.getBoundingClientRect();
  let x = ev.clientX + 14, yy = ev.clientY + 14;
  if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - 14;
  if (yy + r.height > innerHeight - 8) yy = ev.clientY - r.height - 14;
  t.style.left = x + 'px'; t.style.top = yy + 'px';
}
function hideTip() { $('tip').style.display = 'none'; }

// ════════════════════════════════════════════════════════════════════════════
// CLIENTS
// ════════════════════════════════════════════════════════════════════════════
function archivedToggle() {
  return h('label', { class: 'check', style: { margin: 0 } }, h('input', { type: 'checkbox', checked: S.showArchived, onchange: (e) => { S.showArchived = e.target.checked; refresh(); } }), 'Show archived');
}
function renderClients() {
  const m = main(); m.replaceChildren();
  m.append(top('Clients', spacer(), archivedToggle(), h('button', { class: 'btn primary', onclick: () => clientModal() }, '+ New Client')));
  const list = cat.clients.filter((c) => S.showArchived || !c.archived);
  if (!list.length) { m.append(h('div', { class: 'card empty-note' }, h('div', null, 'No clients yet. A client holds your billing details — currency, payment terms, tax and discount.'), h('button', { class: 'btn primary', onclick: () => clientModal() }, 'Add Your First Client'))); return; }
  m.append(h('div', { class: 'card' }, h('table', { class: 'grid' },
    h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Currency'), h('th', null, 'Terms'), h('th', { class: 'r' }, 'Tax'), h('th', { class: 'r' }, 'Discount'), h('th', { class: 'r' }, 'Projects'))),
    h('tbody', null, list.map((c) => h('tr', { class: 'click', onclick: () => clientModal(c) },
      h('td', null, h('b', null, c.name), c.archived ? h('span', { class: 'badge grey' }, 'Archived') : null, c.address ? h('div', { class: 'muted', style: { fontSize: '12px' } }, c.address.split('\n')[0]) : null),
      h('td', null, c.currency), h('td', null, termsLabel(c.terms_days)),
      h('td', { class: 'r' }, c.tax_pct ? c.tax_pct + '%' : '—'), h('td', { class: 'r' }, c.discount_pct ? c.discount_pct + '%' : '—'),
      h('td', { class: 'r' }, c.project_count)))))));
}

function clientModal(c) {
  c = c || { name: '', address: '', currency: 'USD', terms_days: 30, tax_pct: 0, discount_pct: 0, archived: 0 };
  const name = h('input', { class: 'in', value: c.name, placeholder: 'Company or person' });
  const addr = h('textarea', { class: 'in', rows: 3, placeholder: 'Street, city, country' }, c.address);
  const curList = CURRENCIES.includes(c.currency) ? CURRENCIES : [c.currency, ...CURRENCIES];
  const cur = h('select', { class: 'in' }, curList.map((x) => h('option', { value: x, selected: x === c.currency }, x)), h('option', { value: '__other' }, 'Other…'));
  const curOther = h('input', { class: 'in', placeholder: 'ISO code, e.g. THB', maxlength: 3, style: { display: 'none', marginTop: '6px' } });
  cur.onchange = () => { curOther.style.display = cur.value === '__other' ? '' : 'none'; if (cur.value === '__other') curOther.focus(); };
  const isPreset = TERMS.some(([d]) => d === c.terms_days);
  const terms = h('select', { class: 'in' }, TERMS.map(([d, l]) => h('option', { value: d, selected: isPreset && d === c.terms_days }, l)), h('option', { value: 'custom', selected: !isPreset }, 'Custom…'));
  const days = h('input', { class: 'in num', type: 'number', min: 0, max: 365, value: c.terms_days, style: { display: isPreset ? 'none' : '', marginTop: '6px' }, placeholder: 'Days' });
  terms.onchange = () => { days.style.display = terms.value === 'custom' ? '' : 'none'; if (terms.value === 'custom') days.focus(); };
  const pctIn = (v) => h('div', { class: 'withunit' }, h('input', { class: 'in num', type: 'number', min: 0, max: 100, step: '0.01', value: v }), h('span', { class: 'u' }, '%'));
  const tax = pctIn(c.tax_pct), disc = pctIn(c.discount_pct);
  const arch = h('input', { type: 'checkbox', checked: !!c.archived });
  const err = h('div', { class: 'err' });
  const save = async () => {
    const currency = cur.value === '__other' ? curOther.value.trim().toUpperCase() : cur.value;
    if (!/^[A-Z]{3}$/.test(currency)) { err.textContent = 'Currency should be a 3-letter code like USD.'; return; }
    try {
      await call('saveClient', { id: c.id, name: name.value, address: addr.value, currency,
        terms_days: terms.value === 'custom' ? Number(days.value) : Number(terms.value),
        tax_pct: Number(tax.firstChild.value), discount_pct: Number(disc.firstChild.value), archived: arch.checked });
      closeModal();
    } catch (x) { err.textContent = errMsg(x); }
  };
  openModal(c.id ? 'Edit Client' : 'New Client',
    [...field('Name', name), ...field('Address', addr),
      h('div', { class: 'cols' }, h('div', null, ...field('Currency', cur), curOther), h('div', null, ...field('Payment terms', terms), days)),
      h('div', { class: 'cols' }, h('div', null, ...field('Tax', tax)), h('div', null, ...field('Discount', disc))),
      c.id ? h('label', { class: 'check', style: { marginTop: '14px' } }, arch, 'Archived — hide from timers and pickers') : null, err],
    [c.id ? h('button', { class: 'btn danger ghost', onclick: async () => {
      if (!(await confirmDanger(`Delete “${c.name}”?`, 'This can’t be undone.'))) return;
      try { await call('deleteClient', { id: c.id }); closeModal(); } catch (x) { err.textContent = errMsg(x); }
    } }, 'Delete') : null, spacer(), h('button', { class: 'btn', onclick: closeModal }, 'Cancel'), h('button', { class: 'btn primary', onclick: save }, 'Save Client')]);
}

// ════════════════════════════════════════════════════════════════════════════
// PROJECTS
// ════════════════════════════════════════════════════════════════════════════
function renderProjects() {
  const m = main(); m.replaceChildren();
  m.append(top('Projects', spacer(), archivedToggle(), h('button', { class: 'btn primary', onclick: () => projectModal() }, '+ New Project')));
  if (!cat.clients.length) { m.append(h('div', { class: 'card empty-note' }, h('div', null, 'Projects belong to a client — add one first.'), h('button', { class: 'btn primary', onclick: () => { go('clients'); clientModal(); } }, 'Add a Client'))); return; }
  const list = cat.projects.filter((p) => S.showArchived || !p.archived);
  if (!list.length) { m.append(h('div', { class: 'card empty-note' }, h('div', null, 'No projects yet.'), h('button', { class: 'btn primary', onclick: () => projectModal() }, 'Add a Project'))); return; }
  for (const c of cat.clients) {
    const ps = list.filter((p) => p.client_id === c.id);
    if (!ps.length) continue;
    m.append(h('div', { class: 'groupname' }, c.name));
    m.append(h('div', { class: 'card' }, h('table', { class: 'grid' },
      h('tbody', null, ps.map((p) => h('tr', { class: 'click', onclick: () => projectModal(p) },
        h('td', null, h('div', { class: 'barcell' }, h('span', { class: 'dot', style: { background: p.color } }), h('b', null, p.name), p.archived ? h('span', { class: 'badge grey' }, 'Archived') : null)),
        h('td', { class: 'muted' }, p.task_ids.map((id) => cat.byTask[id]?.name).filter(Boolean).join(', ') || 'No tasks'),
        h('td', { class: 'r muted', style: { width: '110px' } }, p.entry_count + ' entr' + (p.entry_count === 1 ? 'y' : 'ies'))))))));
  }
}

function projectModal(p) {
  if (!cat.clients.length) { go('clients'); return; }
  const isNew = !p;
  const clients = cat.clients.filter((c) => !c.archived || (p && c.id === p.client_id));
  p = p || { name: '', client_id: clients[0]?.id, color: cat.palette[cat.projects.length % cat.palette.length], task_ids: cat.tasks.filter((t) => t.common && !t.archived).map((t) => t.id), archived: 0 };
  const name = h('input', { class: 'in', value: p.name, placeholder: 'e.g. Website Redesign' });
  const client = h('select', { class: 'in' }, clients.map((c) => h('option', { value: c.id, selected: c.id === p.client_id }, c.name)));
  let color = p.color;
  const sw = h('div', { class: 'swatches' });
  const paintSw = () => sw.replaceChildren(...cat.palette.map((col) => h('button', { class: 'sw' + (col === color ? ' on' : ''), style: { background: col }, onclick: () => { color = col; paintSw(); } })));
  paintSw();
  const checks = new Map();
  const tl = h('div', { class: 'tasklist' }, cat.tasks.filter((t) => !t.archived || p.task_ids.includes(t.id)).map((t) => {
    const cb = h('input', { type: 'checkbox', checked: p.task_ids.includes(t.id) });
    checks.set(t.id, cb);
    return h('label', { class: 'check' }, cb, t.name, t.common ? h('span', { class: 'badge' }, 'Common') : null, h('span', { class: 'r' }, t.rate ? t.rate + '/h' : ''));
  }));
  const arch = h('input', { type: 'checkbox', checked: !!p.archived });
  const err = h('div', { class: 'err' });
  const save = async () => {
    try {
      await call('saveProject', { id: p.id, name: name.value, client_id: Number(client.value), color, archived: arch.checked,
        task_ids: [...checks].filter(([, cb]) => cb.checked).map(([id]) => id) });
      closeModal();
    } catch (x) { err.textContent = errMsg(x); }
  };
  openModal(isNew ? 'New Project' : 'Edit Project',
    [...field('Name', name), ...field('Client', client), ...field('Color', sw),
      ...field('Tasks', cat.tasks.length ? tl : h('div', { class: 'muted' }, 'No tasks yet — create some under Tasks.'), isNew ? 'Common tasks are ticked for you.' : 'Tasks with time logged stay attached.'),
      !isNew ? h('label', { class: 'check', style: { marginTop: '14px' } }, arch, 'Archived — hide from timers and pickers') : null, err],
    [!isNew ? h('button', { class: 'btn danger ghost', onclick: async () => {
      if (!(await confirmDanger(`Delete “${p.name}”?`, 'This can’t be undone.'))) return;
      try { await call('deleteProject', { id: p.id }); closeModal(); } catch (x) { err.textContent = errMsg(x); }
    } }, 'Delete') : null, spacer(), h('button', { class: 'btn', onclick: closeModal }, 'Cancel'), h('button', { class: 'btn primary', onclick: save }, 'Save Project')]);
}

// ════════════════════════════════════════════════════════════════════════════
// TASKS
// ════════════════════════════════════════════════════════════════════════════
function renderTasks() {
  const m = main(); m.replaceChildren();
  m.append(top('Tasks', h('span', { class: 'sub' }, 'Categories you track time against, each with an hourly rate'), spacer(), archivedToggle(), h('button', { class: 'btn primary', onclick: () => taskModal() }, '+ New Task')));
  const list = cat.tasks.filter((t) => S.showArchived || !t.archived);
  if (!list.length) { m.append(h('div', { class: 'card empty-note' }, h('div', null, 'No tasks yet. Mark everyday ones (Design, Meetings…) as common and every new project gets them.'), h('button', { class: 'btn primary', onclick: () => taskModal() }, 'Add a Task'))); return; }
  const used = (id) => cat.projects.filter((p) => p.task_ids.includes(id)).length;
  m.append(h('div', { class: 'card' }, h('table', { class: 'grid' },
    h('thead', null, h('tr', null, h('th', null, 'Task'), h('th', { class: 'r' }, 'Rate / hour'), h('th', { class: 'r' }, 'Projects'), h('th', { class: 'r' }, 'Entries'))),
    h('tbody', null, list.map((t) => h('tr', { class: 'click', onclick: () => taskModal(t) },
      h('td', null, h('b', null, t.name), t.common ? h('span', { class: 'badge' }, 'Common') : null, t.archived ? h('span', { class: 'badge grey' }, 'Archived') : null),
      h('td', { class: 'r' }, t.rate ? t.rate.toFixed(2) : h('span', { class: 'muted' }, 'Non-billable')),
      h('td', { class: 'r' }, used(t.id)), h('td', { class: 'r' }, t.entry_count)))))));
}

function taskModal(t) {
  const isNew = !t;
  t = t || { name: '', rate: 0, common: 0, archived: 0 };
  const name = h('input', { class: 'in', value: t.name, placeholder: 'e.g. Design' });
  const rate = h('input', { class: 'in num', type: 'number', min: 0, step: '0.01', value: t.rate || '' , placeholder: '0 = non-billable' });
  const common = h('input', { type: 'checkbox', checked: !!t.common });
  const addAll = h('input', { type: 'checkbox', checked: false });
  const addAllRow = h('label', { class: 'check', style: { marginLeft: '23px', display: t.common ? '' : 'none' } }, addAll, 'Also add it to all existing projects');
  common.onchange = () => { addAllRow.style.display = common.checked ? '' : 'none'; };
  const arch = h('input', { type: 'checkbox', checked: !!t.archived });
  const err = h('div', { class: 'err' });
  const save = async () => {
    try {
      await call('saveTask', { id: t.id, name: name.value, rate: Number(rate.value) || 0, common: common.checked, archived: arch.checked, add_to_all: common.checked && addAll.checked });
      closeModal();
    } catch (x) { err.textContent = errMsg(x); }
  };
  openModal(isNew ? 'New Task' : 'Edit Task',
    [...field('Name', name), ...field('Hourly rate', rate, 'Charged in each client’s own currency.'),
      h('label', { class: 'check', style: { marginTop: '14px' } }, common, 'Common task — add automatically to every new project'), addAllRow,
      !isNew ? h('label', { class: 'check' }, arch, 'Archived — hide from timers and pickers') : null, err],
    [!isNew ? h('button', { class: 'btn danger ghost', onclick: async () => {
      if (!(await confirmDanger(`Delete “${t.name}”?`, 'It will be removed from every project.'))) return;
      try { await call('deleteTask', { id: t.id }); closeModal(); } catch (x) { err.textContent = errMsg(x); }
    } }, 'Delete') : null, spacer(), h('button', { class: 'btn', onclick: closeModal }, 'Cancel'), h('button', { class: 'btn primary', onclick: save }, 'Save Task')]);
}

// ════════════════════════════════════════════════════════════════════════════
// SETTINGS
// ════════════════════════════════════════════════════════════════════════════
const SLOTS = [['sc_pop', 'Show / hide the popover'], ['sc_timer', 'Start / stop the timer'], ['sc_new', 'New time entry'], ['sc_app', 'Open this dashboard']];
const SYM = { ctrl: '⌃', alt: '⌥', shift: '⇧', cmd: '⌘' };
const WORD = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', cmd: 'Win' };
const pretty = (combo) => IS_MAC ? combo.split('+').map((p) => SYM[p] || p.toUpperCase()).join('')
  : combo.split('+').map((p) => WORD[p] || p.toUpperCase()).join('+');
let recording = null;
let P = null;

async function renderSettings() {
  P = await call('getPrefs');
  const pr = P.prefs;
  const m = main(); m.replaceChildren();
  const login = h('input', { type: 'checkbox', checked: P.autostart === true || P.autostart === 'enabled', disabled: P.autostart === 'unsupported',
    onchange: async (e) => { P.autostart = await call('setAutostart', { enabled: e.target.checked }); } });
  const idle = h('input', { type: 'checkbox', checked: pr.idleEnabled, onchange: (e) => call('setPrefs', { idleEnabled: e.target.checked }) });
  const mins = h('input', { class: 'in sm num', type: 'number', min: 1, max: 240, value: pr.idleMinutes, style: { width: '70px' }, onchange: (e) => call('setPrefs', { idleMinutes: Number(e.target.value) }) });
  const wk = h('select', { class: 'in sm', onchange: (e) => call('setPrefs', { weekStart: Number(e.target.value) }).then((x) => { weekStart = x.weekStart; }) },
    h('option', { value: 1, selected: pr.weekStart === 1 }, 'Monday'), h('option', { value: 0, selected: pr.weekStart === 0 }, 'Sunday'));
  const sc = h('div');
  const paintSc = () => sc.replaceChildren(...SLOTS.map(([id, label]) => {
    const combo = pr.shortcuts[id];
    const b = h('button', { class: 'screc' + (recording === id ? ' rec' : combo ? ' set2' : ''), onclick: () => { recording = recording === id ? null : id; paintSc(); } },
      recording === id ? 'Type shortcut… (⌫ clears)' : combo ? pretty(combo) : 'Record Shortcut');
    return h('div', { class: 'line' }, h('span', { class: 'lab' }, label), b);
  }));
  paintSc();
  document.onkeydown = async (e) => {
    if (!recording) return;
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Escape') { recording = null; paintSc(); return; }
    if (e.key === 'Backspace' || e.key === 'Delete') { const r = await call('setShortcut', { id: recording, combo: null }); pr.shortcuts = r.shortcuts; recording = null; paintSc(); return; }
    if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return;
    const mods = [];
    if (e.ctrlKey) mods.push('ctrl'); if (e.altKey) mods.push('alt'); if (e.shiftKey) mods.push('shift'); if (e.metaKey) mods.push('cmd');
    if (!mods.some((x) => x !== 'shift')) return;
    let key = e.key.toLowerCase();
    if (e.code && e.code.startsWith('Key')) key = e.code.slice(3).toLowerCase();
    else if (e.code && e.code.startsWith('Digit')) key = e.code.slice(5);
    if (!/^([a-z0-9]|f[0-9]{1,2})$/.test(key)) return;
    const r = await call('setShortcut', { id: recording, combo: mods.concat(key).join('+') });
    if (r.ok) { pr.shortcuts = r.shortcuts; recording = null; }
    paintSc();
  };

  // appearance — applies live in every open window (backend pushes 'theme')
  const setTheme = (patch) => call('setPrefs', patch).then((x) => { Object.assign(pr, x); paintLook(); });
  const look = h('div');
  const paintLook = () => {
    const cur = (pr.accent || DEFAULT_ACCENT).toLowerCase();
    const custom = !ACCENTS.some(([c]) => c === cur);
    const picker = h('input', { type: 'color', value: cur, class: 'colorpick', title: 'Pick any color',
      oninput: (e) => applyTheme({ accent: e.target.value }), onchange: (e) => setTheme({ accent: e.target.value }) });
    look.replaceChildren(
      h('div', { class: 'line' }, h('span', { class: 'lab' }, 'Appearance'),
        seg([['system', 'System'], ['light', 'Light'], ['dark', 'Dark']], pr.appearance || 'system', (v) => setTheme({ appearance: v }))),
      h('div', { class: 'line' }, h('span', { class: 'lab' }, 'Accent color'),
        h('div', { class: 'swatches' },
          ACCENTS.map(([c, name]) => h('button', { class: 'sw' + (c === cur ? ' on' : ''), title: name, style: { background: c }, onclick: () => setTheme({ accent: c }) })),
          h('label', { class: 'sw custom' + (custom ? ' on' : ''), title: 'Custom color', style: custom ? { background: cur } : null }, picker))),
      h('div', { class: 'hint', style: { textAlign: 'right' } }, 'Used for the header, buttons, highlights and the menu-bar timer while it runs.'));
  };
  paintLook();

  m.append(top('Settings'), h('div', { class: 'set' },
    h('section', { class: 'card' }, h('h2', null, 'Look'), look),
    h('section', { class: 'card' }, h('h2', null, 'General'),
      h('label', { class: 'check' }, login, 'Start Tiny Time when I log in', P.autostart === 'unsupported' ? h('span', { class: 'muted' }, ' (only in the built app)') : null),
      h('div', { class: 'line' }, h('label', { class: 'check', style: { margin: 0 } }, idle, 'Stop the timer when I’ve been idle for'), mins, h('span', { class: 'muted' }, 'minutes')),
      h('div', { class: 'hint', style: { marginLeft: '23px' } }, 'The idle stretch is taken back off the entry, and you get a notification.'),
      h('div', { class: 'line' }, h('span', { class: 'lab' }, 'Weeks start on'), wk)),
    h('section', { class: 'card' }, h('h2', null, 'Global shortcuts'), h('div', { class: 'hint', style: { marginBottom: '6px' } }, IS_MAC ? 'Work from any app. Use ⌘, ⌃ or ⌥ plus a key.' : 'Work from any app. Use Ctrl or Alt plus a key.'), sc),
    h('section', { class: 'card' }, h('h2', null, 'Your data'),
      h('div', { class: 'hint' }, 'Everything stays on this computer, in one SQLite file:'),
      h('div', { class: 'line' }, h('code', { class: 'muted', style: { fontFamily: 'var(--mono)', fontSize: '11.5px', flex: 1, overflowWrap: 'anywhere' } }, (P.dataDir || '') + '/tinytime.db'),
        h('button', { class: 'btn', onclick: () => call('revealData') }, 'Show in ' + FILE_MANAGER)),
      h('div', { class: 'line', style: { marginTop: '12px' } },
        !cat.clients.length ? h('button', { class: 'btn', onclick: async () => { await call('seedSample'); go('reports'); } }, 'Load sample data') : null,
        h('button', { class: 'btn danger', onclick: async () => {
          if (await confirmDanger('Erase all Tiny Time data?', 'Every client, project, task and time entry will be deleted. This can’t be undone.', 'Erase Everything')) call('wipeAll');
        } }, 'Erase all data')))));
}

// ════════════════════════════════════════════════════════════════════════════
// INVOICES
// ════════════════════════════════════════════════════════════════════════════
// A record of what was invoiced when, not the invoice itself: Tiny Tally (or
// any other tool) makes that.
const fmtDay = (s) => { const d = parseYmd(s); return d.getDate() + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear(); };
const fmtPeriod = (a, b) => (!a ? '' : a === b ? fmtDay(a) : fmtDay(a) + ' – ' + fmtDay(b));
const sumMoney = (byCur) => Object.entries(byCur).filter(([, v]) => v).map(([c, v]) => money(v, c)).join(' + ') || money(0, 'USD');

async function renderInvoices() {
  const res = await call('invoices');
  const m = main(); m.replaceChildren();
  m.append(top('Invoices', spacer(),
    h('button', { class: 'btn primary', disabled: !cat.clients.length, onclick: () => invoiceModal({}) }, '+ New Invoice')));

  const ub = res.unbilled, invs = res.invoices;
  const ubCur = {}, yrCur = {};
  for (const u of ub) ubCur[u.currency] = (ubCur[u.currency] || 0) + u.amount;
  const yr = res.today.slice(0, 4);
  for (const i of invs) if (i.date.startsWith(yr)) yrCur[i.currency] = (yrCur[i.currency] || 0) + i.amount;
  const last = invs[0];
  m.append(h('div', { class: 'tiles' },
    tile('Not invoiced', fmtHours(ub.reduce((a, u) => a + u.seconds, 0)) + ' h', ub.reduce((a, u) => a + u.n, 0) + ' entries'),
    tile('Worth', sumMoney(ubCur), 'at your task rates'),
    tile('Invoiced in ' + yr, sumMoney(yrCur), invs.filter((i) => i.date.startsWith(yr)).length + ' invoices'),
    tile('Last invoice', last ? last.number || '—' : '—', last ? fmtDay(last.date) + ' · ' + last.client : 'none yet')));

  m.append(h('h2', { class: 'sect' }, 'Not invoiced yet'));
  if (!ub.length) m.append(h('div', { class: 'card empty-note' }, 'All your time is invoiced.'));
  else m.append(h('div', { class: 'card' }, h('table', { class: 'grid' },
    h('thead', null, h('tr', null, h('th', null, 'Project'), h('th', null, 'Since last invoice'), h('th', { class: 'r' }, 'Entries'),
      h('th', { class: 'r' }, 'Hours'), h('th', { class: 'r' }, 'Amount'), h('th', null, ''))),
    h('tbody', null, ub.map((u) => h('tr', null,
      h('td', null, h('div', { class: 'barcell' }, h('span', { class: 'dot', style: { background: u.color } }),
        h('div', null, h('b', null, u.project), h('span', { class: 'muted' }, ' · ' + u.client)))),
      h('td', null, u.last_invoice ? (u.last_invoice.number || 'Invoice') + ', ' + fmtDay(u.last_invoice.date) : h('span', { class: 'muted' }, 'Never invoiced'),
        h('div', { class: 'muted small' }, fmtPeriod(u.first, u.last))),
      h('td', { class: 'r' }, String(u.n)),
      h('td', { class: 'r' }, fmtHours(u.seconds)),
      h('td', { class: 'r' }, money(u.amount, u.currency)),
      h('td', { class: 'r' }, h('button', { class: 'btn', onclick: () => invoiceModal({ client_id: u.client_id, project_id: u.project_id }) }, 'Invoice…'))))))));

  m.append(h('h2', { class: 'sect' }, 'Invoices'));
  if (!invs.length) { m.append(h('div', { class: 'card empty-note' }, 'No invoices yet. When you bill a client, record it here and the time is marked as invoiced.')); return; }
  m.append(h('div', { class: 'card' }, h('table', { class: 'grid' },
    h('thead', null, h('tr', null, h('th', null, 'Number'), h('th', null, 'Issued'), h('th', null, 'Client'), h('th', null, 'Time covered'),
      h('th', { class: 'r' }, 'Hours'), h('th', { class: 'r' }, 'Amount'), h('th', null, ''))),
    h('tbody', null, invs.map((i) => h('tr', { class: 'click', ondblclick: () => editInvoiceModal(i) },
      h('td', null, h('b', null, i.number || '—')),
      h('td', null, fmtDay(i.date)),
      h('td', null, i.client, i.project ? h('span', { class: 'muted' }, ' · ' + i.project) : null),
      h('td', { class: 'muted' }, i.n ? fmtPeriod(i.first, i.last) : 'no entries left'),
      h('td', { class: 'r', title: i.seconds_now !== i.seconds ? `Its entries now add up to ${fmtHours(i.seconds_now)} h` : null },
        fmtHours(i.seconds), i.seconds_now !== i.seconds ? ' *' : ''),
      h('td', { class: 'r' }, money(i.amount, i.currency)),
      h('td', { class: 'r nowrap' },
        h('button', { class: 'lnk', title: 'Open it in Tiny Tally as a new invoice, filled in', onclick: () => tallySend(i.id) }, 'Tiny Tally'),
        h('button', { class: 'lnk', onclick: () => editInvoiceModal(i) }, 'Edit'))))))));
}

async function tallySend(id) {
  try { await call('sendToTally', { id }); } catch (x) { tiny.dialog.alert('Couldn’t send it to Tiny Tally', { detail: errMsg(x) }); }
}

// lines of a preview, as shown in the invoice dialog
function previewBox(pre, currency) {
  if (!pre || !pre.n) return h('div', { class: 'invsum muted' }, 'No uninvoiced time here up to that date. A running timer isn’t included until it’s stopped.');
  const c = pre.client;
  return h('div', { class: 'invsum' },
    h('div', { class: 'muted' }, `${pre.n} ${pre.n === 1 ? 'entry' : 'entries'} · ${fmtPeriod(pre.from, pre.to)}`),
    pre.lines.map((l) => h('div', { class: 'ln' }, h('span', null, l.project + ': ' + l.task),
      h('span', { class: 'muted' }, fmtHours(l.seconds) + ' h × ' + money(l.rate, currency)), h('b', null, money(l.amount, currency)))),
    c.discount_pct ? h('div', { class: 'ln' }, h('span', null, `Less ${c.discount_pct}% discount`), h('span'), h('b', null, '−' + money(pre.amount - pre.net, currency))) : null,
    h('div', { class: 'ln tot' }, h('span', null, 'Total before tax'), h('span', { class: 'muted' }, fmtHours(pre.seconds) + ' h'), h('b', null, money(pre.net, currency))));
}

function invoiceModal(init) {
  const clients = cat.clients.filter((c) => !c.archived || c.id === init.client_id);
  if (!clients.length) { go('clients'); return; }
  const cSel = h('select', { class: 'in' }, clients.map((c) => h('option', { value: c.id, selected: c.id === init.client_id }, c.name)));
  const pSel = h('select', { class: 'in' });
  const fillProjects = (sel) => {
    const cid = Number(cSel.value);
    pSel.replaceChildren(h('option', { value: '' }, 'All projects'),
      ...cat.projects.filter((p) => p.client_id === cid).map((p) => h('option', { value: p.id, selected: p.id === sel }, p.name)));
  };
  fillProjects(init.project_id);
  const upTo = h('input', { class: 'in', type: 'date', value: today });
  const num = h('input', { class: 'in' });
  const date = h('input', { class: 'in', type: 'date', value: today });
  const amt = h('input', { class: 'in num' });
  const notes = h('textarea', { class: 'in', rows: 2, placeholder: 'Notes (optional)' });
  const box = h('div');
  const err = h('div', { class: 'err' });
  let pre = null, numTouched = false, seq = 0;
  num.oninput = () => { numTouched = true; };
  const load = async () => {
    const my = ++seq;
    err.textContent = '';
    try {
      const p = await call('invoicePreview', { client_id: Number(cSel.value), project_id: Number(pSel.value) || null, to: upTo.value || today });
      if (my !== seq) return;
      pre = p;
      const cur = (cat.byClient[cSel.value] || {}).currency || 'USD';
      if (!numTouched) num.value = p.suggested;
      amt.placeholder = p.n ? money(p.net, cur) + ', from the time' : '';
      box.replaceChildren(previewBox(p, cur));
    } catch (x) { err.textContent = errMsg(x); }
  };
  cSel.onchange = () => { fillProjects(null); numTouched = false; load(); };
  pSel.onchange = load; upTo.onchange = load;
  const save = async (tally) => {
    if (!pre || !pre.n) { err.textContent = 'There’s no uninvoiced time to put on this invoice.'; return; }
    try {
      await call('createInvoice', { client_id: Number(cSel.value), project_id: Number(pSel.value) || null, to: upTo.value || today,
        number: num.value, date: date.value, amount: amt.value.trim(), notes: notes.value, tally });
      closeModal();
    } catch (x) { err.textContent = errMsg(x); }
  };
  const md = openModal('New Invoice',
    [h('div', { class: 'cols' }, h('div', null, ...field('Client', cSel)), h('div', null, ...field('Project', pSel))),
      ...field('Time up to and including', upTo),
      box,
      h('div', { class: 'cols' }, h('div', null, ...field('Invoice number', num)), h('div', null, ...field('Issued on', date))),
      ...field('Amount billed', amt, 'Leave blank to use what the time is worth. Type the amount if you billed something else.'),
      ...field('Notes', notes), err],
    [spacer(), h('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
      h('button', { class: 'btn', onclick: () => save(false) }, 'Save'),
      h('button', { class: 'btn primary', title: 'Save it here, then open it in Tiny Tally as a new invoice', onclick: () => save(true) }, 'Save & Open in Tiny Tally')]);
  md.classList.add('wide');
  load();
}

function editInvoiceModal(i) {
  const num = h('input', { class: 'in', value: i.number });
  const date = h('input', { class: 'in', type: 'date', value: i.date });
  const amt = h('input', { class: 'in num', value: i.amount_set ? String(i.amount) : '', placeholder: i.amount_set ? '' : money(i.amount, i.currency) + ', from the time' });
  const notes = h('textarea', { class: 'in', rows: 2, placeholder: 'Notes (optional)' }, i.notes);
  const err = h('div', { class: 'err' });
  const save = async () => {
    try { await call('updateInvoice', { id: i.id, number: num.value, date: date.value, amount: amt.value.trim(), notes: notes.value }); closeModal(); return true; }
    catch (x) { err.textContent = errMsg(x); return false; }
  };
  openModal('Invoice ' + (i.number || ''),
    [h('div', { class: 'invsum' },
      h('div', null, h('b', null, i.client), i.project ? h('span', { class: 'muted' }, ' · ' + i.project) : null),
      h('div', { class: 'muted' }, `${i.n} ${i.n === 1 ? 'entry' : 'entries'} · ${fmtHours(i.seconds)} h · ${i.n ? fmtPeriod(i.first, i.last) : 'no entries left'}`)),
    h('div', { class: 'cols' }, h('div', null, ...field('Invoice number', num)), h('div', null, ...field('Issued on', date))),
    ...field('Amount billed', amt, 'Blank = what its time is worth at today’s rates.'),
    ...field('Notes', notes), err],
    [h('button', { class: 'btn danger ghost', onclick: async () => {
      if (await confirmDanger(`Delete invoice ${i.number || ''}?`, `Its ${i.n} ${i.n === 1 ? 'entry goes' : 'entries go'} back to not invoiced. The time itself stays.`)) {
        await call('deleteInvoice', { id: i.id }); closeModal();
      }
    } }, 'Delete'),
    spacer(),
    h('button', { class: 'btn', onclick: async () => { if (await save()) tallySend(i.id); } }, 'Open in Tiny Tally'),
    h('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
    h('button', { class: 'btn primary', onclick: save }, 'Save')]);
}

// Harvest only says WHICH entries were invoiced. Ask for each invoice's number
// and issue date; entries are split by date: each invoice takes the invoiced
// entries after the previous one's date, up to its own.
async function harvestInvoicesModal(ids) {
  const entries = (await call('entriesByIds', { ids })).filter((e) => !e.invoice_id);
  if (!entries.length) return;
  const groups = new Map();
  for (const e of entries) {
    if (!groups.has(e.client_id)) groups.set(e.client_id, { client: e.client, currency: e.currency, entries: [], rows: [] });
    groups.get(e.client_id).entries.push(e);
  }
  const err = h('div', { class: 'err' });
  // invoice rows sorted by date → [{ row, list }], plus what's left after the last
  const split = (g) => {
    const rows = g.rows.filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date.value)).sort((a, b) => (a.date.value < b.date.value ? -1 : 1));
    let prev = '';
    const out = rows.map((r) => { const list = g.entries.filter((e) => e.date > prev && e.date <= r.date.value); prev = r.date.value; return { r, list }; });
    return { out, left: g.entries.filter((e) => e.date > prev) };
  };
  const worth = (list) => list.reduce((a, e) => a + (e.seconds / 3600) * e.rate, 0);
  const paint = () => {
    for (const g of groups.values()) {
      const { out, left } = split(g);
      for (const { r, list } of out) {
        r.info.textContent = list.length ? `${list.length} entries · ${fmtHours(list.reduce((a, e) => a + e.seconds, 0))} h · ${money(worth(list), g.currency)}` : 'no invoiced entries up to this date';
        r.amt.placeholder = list.length ? money(worth(list), g.currency) : '';
      }
      for (const r of g.rows) if (!out.some((o) => o.r === r)) r.info.textContent = 'pick the issue date';
      g.left.textContent = left.length ? `${left.length} invoiced ${left.length === 1 ? 'entry is' : 'entries are'} after the last date (${fmtHours(left.reduce((a, e) => a + e.seconds, 0))} h). ${left.length === 1 ? 'It stays' : 'They stay'} not invoiced unless you add an invoice for ${left.length === 1 ? 'it' : 'them'}.` : '';
    }
  };
  const addRow = (g, dateVal) => {
    const r = {
      num: h('input', { class: 'in sm', placeholder: 'Number', style: { width: '110px' } }),
      date: h('input', { class: 'in sm', type: 'date', value: dateVal || '', onchange: paint }),
      amt: h('input', { class: 'in sm num', style: { width: '120px' }, title: 'Amount billed. Blank = what the time is worth.' }),
      info: h('span', { class: 'muted small grow' }),
    };
    r.el = h('div', { class: 'line hvrow' }, r.num, r.date, r.amt, r.info,
      h('button', { class: 'lnk danger', title: 'Remove', onclick: () => { g.rows = g.rows.filter((x) => x !== r); r.el.remove(); paint(); } }, '✕'));
    g.rows.push(r); g.list.append(r.el); paint();
  };
  const body = [h('div', { class: 'hint', style: { marginTop: 0 } }, 'Harvest’s export marks which entries were invoiced, but not on which invoice. Add each invoice’s number and issue date (they’re on the invoice PDFs). Each invoice takes the invoiced entries after the previous invoice’s date, up to its own.')];
  for (const g of groups.values()) {
    g.list = h('div');
    g.left = h('div', { class: 'hint' });
    const secs = g.entries.reduce((a, e) => a + e.seconds, 0);
    body.push(h('div', { class: 'hvgroup' },
      h('div', null, h('b', null, g.client), h('span', { class: 'muted' }, ` · ${g.entries.length} invoiced entries · ${fmtHours(secs)} h · ${fmtPeriod(g.entries[0].date, g.entries[g.entries.length - 1].date)}`)),
      g.list,
      h('button', { class: 'lnk', onclick: () => addRow(g, '') }, '+ Add another invoice'),
      g.left));
    addRow(g, g.entries[g.entries.length - 1].date);
  }
  body.push(err);
  const save = async () => {
    try {
      for (const g of groups.values()) {
        for (const { r, list } of split(g).out) {
          if (!list.length) continue;
          await call('createInvoice', { entry_ids: list.map((e) => e.id), number: r.num.value, date: r.date.value, amount: r.amt.value.trim(), notes: 'Imported from Harvest' });
        }
      }
      closeModal(); go('invoices');
    } catch (x) { err.textContent = errMsg(x); }
  };
  const md = openModal('Invoices from Harvest', body,
    [h('span', { class: 'hint', style: { margin: 0 } }, 'Skip this and nothing is lost: import the file again later to come back here.'), spacer(),
      h('button', { class: 'btn', onclick: closeModal }, 'Skip'), h('button', { class: 'btn primary', onclick: save }, 'Save Invoices')]);
  md.classList.add('wide');
}

// ════════════════════════════════════════════════════════════════════════════
// IMPORT & EXPORT
// ════════════════════════════════════════════════════════════════════════════
async function renderData() {
  const pr = (await call('getPrefs')).prefs;
  const m = main(); m.replaceChildren();
  const nameIn = (k, ph) => h('input', { class: 'in sm', placeholder: ph, value: (pr.harvestName || {})[k] || '', style: { width: '130px' },
    onchange: (e) => { pr.harvestName = { ...(pr.harvestName || {}), [k]: e.target.value }; call('setPrefs', { harvestName: pr.harvestName }); } });
  const empty = !cat.clients.length;
  m.append(top('Import & Export'), h('div', { class: 'set' },
    h('section', { class: 'card' }, h('h2', null, 'Import from Harvest'),
      h('div', { class: 'hint' }, 'Use the CSV from Harvest’s Reports → Detailed time → Export. You’ll see what will be added before anything changes. Clients, projects and tasks are matched by name or created, and entries already here are skipped, so importing the same file again is safe.'),
      h('div', { class: 'line' }, h('button', { class: 'btn', onclick: harvestImport }, icon('upload'), 'Import from Harvest…'))),
    h('section', { class: 'card' }, h('h2', null, 'Export'),
      h('div', { class: 'hint' }, 'All your time, ever. To export one range or client, use the export buttons in Reports.'),
      h('div', { class: 'line' },
        h('button', { class: 'btn', disabled: empty, onclick: () => harvestExport() }, icon('download'), 'Harvest CSV…'),
        h('button', { class: 'btn', disabled: empty, onclick: async () => { const p = await call('exportCSV', { from: '0000-01-01', to: '9999-12-31' }); if (p) tiny.notify && tiny.notify('Exported', p); } }, icon('download'), 'Tiny Time CSV…')),
      h('div', { class: 'hint' }, 'Harvest CSV has the same columns as Harvest’s own export. Tiny Time CSV is a simpler list: date, client, project, task, notes, hours, rate, amount.'),
      h('div', { class: 'line' }, h('span', { class: 'lab' }, 'Name on Harvest exports'), nameIn('first', 'First name'), nameIn('last', 'Last name')))));
}

let rz = null;
window.addEventListener('resize', () => { if (view !== 'reports') return; clearTimeout(rz); rz = setTimeout(refresh, 150); });

// ── boot ─────────────────────────────────────────────────────────────────────
call('appHello').then((s) => { applyTheme(s); weekStart = s.weekStart; go(s.view || 'time'); });

// screenshot tour (scripts/screenshots.sh) sets scenes from the backend
tiny.api.on('tour', async (t) => {
  if (t.timeMode) { S.timeMode = t.timeMode; if (t.weeksBack != null) S.timeSel = addDays(today, -7 * t.weeksBack); await refresh(); }
  if (t.preset) { S.rep.preset = t.preset; await refresh(); }
  if ('modal' in t) {
    if (!t.modal) closeModal();
    else { if (!cat) await refresh(); if (t.modal === 'client') clientModal(cat.clients[0]); if (t.modal === 'project') projectModal(cat.projects[0]); }
  }
});
