// Tiny Time — data layer. One sqlite file in the app's data dir.
//
// clients ─< projects >─< project_tasks >─ tasks
//    │            └──────< entries >───────┘
//    └──< invoices ─────────────┘ (entries.invoice_id)
//
// An invoice here is only a record: "invoiced these entries, as number N,
// on date D". Seconds and amount are copied in when it's made, so changing a
// rate later doesn't rewrite what was billed. PDFs and payments belong to an
// accounting app.
// A running timer is an entry with started_at > 0; its true length is
// seconds + (now − started_at). Only one entry runs at a time.
// tjs:sqlite is fully synchronous — never await it.

import { Database } from 'tjs:sqlite';

let db;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT 'USD',
  terms_days INTEGER NOT NULL DEFAULT 30,
  tax_pct REAL NOT NULL DEFAULT 0,
  discount_pct REAL NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#5b8def',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  rate REAL NOT NULL DEFAULT 0,
  common INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS project_tasks (
  project_id INTEGER NOT NULL REFERENCES projects(id),
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (project_id, task_id)
);
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  notes TEXT NOT NULL DEFAULT '',
  seconds INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  project_id INTEGER REFERENCES projects(id),
  number TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  seconds INTEGER NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,       -- billed before tax: time × rates less the client's discount, unless typed
  amount_set INTEGER NOT NULL DEFAULT 0, -- 1 = typed by hand
  currency TEXT NOT NULL DEFAULT 'USD',
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS entries_date ON entries(date);
CREATE INDEX IF NOT EXISTS entries_project ON entries(project_id);
`;

// validated categorical palette (CVD-separated, fixed order)
export const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];

export async function open(dir) {
  await tjs.makeDir(dir, { recursive: true }).catch(() => {});
  db = new Database(dir.replace(/\/$/, '') + '/tinytime.db');
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  // 0.2: entries can belong to an invoice
  if (!q('PRAGMA table_info(entries)').some((c) => c.name === 'invoice_id'))
    db.exec('ALTER TABLE entries ADD COLUMN invoice_id INTEGER REFERENCES invoices(id)');
  db.exec('CREATE INDEX IF NOT EXISTS entries_invoice ON entries(invoice_id)');
  // 0.3: what Indian GST invoices need: a GSTIN, state, country and SAC
  const cols = q('PRAGMA table_info(clients)').map((c) => c.name);
  for (const col of ['tax_id', 'state', 'country', 'sac']) {
    if (!cols.includes(col)) db.exec(`ALTER TABLE clients ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
  }
}

// India: invoice numbers follow GST's rules, and the year runs April to March.
let india = false;
export const setIndia = (on) => { india = !!on; };

// "2026-07-01" → "2026-27"
export function financialYear(date) {
  const y = Number(date.slice(0, 4)), start = Number(date.slice(5, 7)) >= 4 ? y : y - 1;
  return `${start}-${String(start + 1).slice(2)}`;
}

// Rule 46: up to 16 letters, digits, hyphens or slashes, unique within the financial year.
function checkIndiaNumber(number, date, id) {
  if (!india || !number) return;
  if (number.length > 16) throw new Error('A GST invoice number is at most 16 characters.');
  if (!/^[A-Za-z0-9/-]+$/.test(number)) throw new Error('A GST invoice number can only use letters, digits, hyphens and slashes.');
  const year = financialYear(date);
  const clash = q('SELECT date FROM invoices WHERE number = ? AND id IS NOT ?', number, id).some((i) => financialYear(i.date) === year);
  if (clash) throw new Error(`Invoice ${number} is already used in ${year}.`);
}

// prepared statements are cached by SQL text — this process lives for days,
// and an un-finalized statement per call would slowly leak
const stmts = new Map();
function st(sql) {
  let s = stmts.get(sql);
  if (!s) { s = db.prepare(sql); stmts.set(sql, s); }
  return s;
}
const q = (sql, ...args) => st(sql).all(...args);
const one = (sql, ...args) => q(sql, ...args)[0] || null;
const run = (sql, ...args) => st(sql).run(...args);
const insert = (sql, ...args) => q(sql + ' RETURNING id', ...args)[0].id;
function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

const now = () => Date.now();
const str = (v, max = 500) => String(v == null ? '' : v).trim().slice(0, max);
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const pct = (v) => Math.min(100, Math.max(0, num(v)));

// seconds including the live stretch of a running entry — as SQL, so
// aggregates are always current
const LIVE = `(e.seconds + CASE WHEN e.started_at > 0 THEN MAX(0, (? - e.started_at) / 1000) ELSE 0 END)`;

// ── catalog ──────────────────────────────────────────────────────────────────
export function catalog() {
  const clients = q('SELECT * FROM clients ORDER BY archived, name COLLATE NOCASE');
  const projects = q(`SELECT p.*, (SELECT COUNT(*) FROM entries e WHERE e.project_id = p.id) AS entry_count
                      FROM projects p ORDER BY p.archived, p.name COLLATE NOCASE`);
  const tasks = q(`SELECT t.*, (SELECT COUNT(*) FROM entries e WHERE e.task_id = t.id) AS entry_count
                   FROM tasks t ORDER BY t.archived, t.name COLLATE NOCASE`);
  const links = q('SELECT project_id, task_id FROM project_tasks');
  const byProject = {};
  for (const l of links) (byProject[l.project_id] ||= []).push(l.task_id);
  for (const p of projects) p.task_ids = byProject[p.id] || [];
  for (const c of clients) c.project_count = projects.filter((p) => p.client_id === c.id).length;
  return { clients, projects, tasks, palette: PALETTE };
}

// ── clients ──────────────────────────────────────────────────────────────────
export function saveClient(c) {
  const name = str(c.name, 200);
  if (!name) throw new Error('A client needs a name.');
  const vals = [name, str(c.address, 2000), str(c.currency || 'USD', 8).toUpperCase(),
    Math.max(0, Math.round(num(c.terms_days, 30))), pct(c.tax_pct), pct(c.discount_pct), c.archived ? 1 : 0,
    str(c.tax_id, 15).toUpperCase(), str(c.state, 2), str(c.country, 2).toUpperCase(), str(c.sac, 8)];
  if (c.id) {
    run('UPDATE clients SET name=?, address=?, currency=?, terms_days=?, tax_pct=?, discount_pct=?, archived=?, tax_id=?, state=?, country=?, sac=? WHERE id=?', ...vals, c.id);
    return c.id;
  }
  return insert('INSERT INTO clients (name, address, currency, terms_days, tax_pct, discount_pct, archived, tax_id, state, country, sac, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', ...vals, now());
}
export function deleteClient(id) {
  if (one('SELECT 1 AS x FROM invoices WHERE client_id = ?', id))
    throw new Error('This client has invoices. Archive it instead to keep the history.');
  if (one('SELECT 1 AS x FROM projects WHERE client_id = ?', id))
    throw new Error('This client still has projects. Delete or move them first, or archive the client.');
  run('DELETE FROM clients WHERE id = ?', id);
}

// ── projects ─────────────────────────────────────────────────────────────────
// New projects get every non-archived "common" task automatically, plus any
// explicitly chosen ones.
export function saveProject(p) {
  const name = str(p.name, 200);
  if (!name) throw new Error('A project needs a name.');
  if (!one('SELECT id FROM clients WHERE id = ?', p.client_id)) throw new Error('Pick a client for this project.');
  return tx(() => {
    let id = p.id;
    if (id) {
      run('UPDATE projects SET client_id=?, name=?, color=?, archived=? WHERE id=?', p.client_id, name, str(p.color, 16) || PALETTE[0], p.archived ? 1 : 0, id);
    } else {
      const n = one('SELECT COUNT(*) AS n FROM projects').n;
      id = insert('INSERT INTO projects (client_id, name, color, archived, created_at) VALUES (?,?,?,?,?)',
        p.client_id, name, str(p.color, 16) || PALETTE[n % PALETTE.length], 0, now());
    }
    let taskIds = Array.isArray(p.task_ids) ? p.task_ids.map(Number) : null;
    if (!p.id && !taskIds) taskIds = q('SELECT id FROM tasks WHERE common = 1 AND archived = 0').map((t) => t.id);
    if (taskIds) {
      // never unlink a task that already has time logged on this project
      const used = new Set(q('SELECT DISTINCT task_id FROM entries WHERE project_id = ?', id).map((r) => r.task_id));
      for (const t of used) if (!taskIds.includes(t)) taskIds.push(t);
      run('DELETE FROM project_tasks WHERE project_id = ?', id);
      for (const t of taskIds) run('INSERT OR IGNORE INTO project_tasks (project_id, task_id) VALUES (?, ?)', id, t);
    }
    return id;
  });
}
export function deleteProject(id) {
  if (one('SELECT 1 AS x FROM entries WHERE project_id = ?', id) || one('SELECT 1 AS x FROM invoices WHERE project_id = ?', id))
    throw new Error('This project has time logged against it. Archive it instead to keep the history.');
  tx(() => { run('DELETE FROM project_tasks WHERE project_id = ?', id); run('DELETE FROM projects WHERE id = ?', id); });
}

// ── tasks ────────────────────────────────────────────────────────────────────
export function saveTask(t) {
  const name = str(t.name, 200);
  if (!name) throw new Error('A task needs a name.');
  const vals = [name, Math.max(0, num(t.rate)), t.common ? 1 : 0, t.archived ? 1 : 0];
  return tx(() => {
    let id = t.id;
    if (id) run('UPDATE tasks SET name=?, rate=?, common=?, archived=? WHERE id=?', ...vals, id);
    else id = insert('INSERT INTO tasks (name, rate, common, archived, created_at) VALUES (?,?,?,?,?)', ...vals, now());
    if (t.add_to_all) {
      for (const p of q('SELECT id FROM projects WHERE archived = 0'))
        run('INSERT OR IGNORE INTO project_tasks (project_id, task_id) VALUES (?, ?)', p.id, id);
    }
    return id;
  });
}
export function deleteTask(id) {
  if (one('SELECT 1 AS x FROM entries WHERE task_id = ?', id))
    throw new Error('This task has time logged against it. Archive it instead to keep the history.');
  tx(() => { run('DELETE FROM project_tasks WHERE task_id = ?', id); run('DELETE FROM tasks WHERE id = ?', id); });
}

// ── entries ──────────────────────────────────────────────────────────────────
const ENTRY_COLS = `e.id, e.date, e.project_id, e.task_id, e.notes, e.started_at, e.created_at,
  ${LIVE} AS seconds, p.name AS project, p.color, c.id AS client_id, c.name AS client,
  c.currency, t.name AS task, t.rate, e.invoice_id, i.number AS invoice_number, i.date AS invoice_date`;
const ENTRY_FROM = `FROM entries e JOIN projects p ON p.id = e.project_id JOIN clients c ON c.id = p.client_id
  JOIN tasks t ON t.id = e.task_id LEFT JOIN invoices i ON i.id = e.invoice_id`;

export function entriesBetween(from, to) {
  return q(`SELECT ${ENTRY_COLS} ${ENTRY_FROM} WHERE e.date BETWEEN ? AND ? ORDER BY e.date DESC, e.created_at DESC`, now(), from, to);
}
export function entry(id) {
  return one(`SELECT ${ENTRY_COLS} ${ENTRY_FROM} WHERE e.id = ?`, now(), id);
}
export function running() {
  return one(`SELECT ${ENTRY_COLS} ${ENTRY_FROM} WHERE e.started_at > 0 LIMIT 1`, now());
}
export function lastEntry() {
  return one(`SELECT ${ENTRY_COLS} ${ENTRY_FROM} WHERE p.archived = 0 AND t.archived = 0 ORDER BY e.created_at DESC LIMIT 1`, now());
}
export function totalBetween(from, to) {
  return one(`SELECT COALESCE(SUM(${LIVE}), 0) AS s FROM entries e WHERE e.date BETWEEN ? AND ?`, now(), from, to).s;
}
export function dayTotals(from, to) {
  return q(`SELECT e.date, SUM(${LIVE}) AS seconds FROM entries e WHERE e.date BETWEEN ? AND ? GROUP BY e.date`, now(), from, to);
}

function stopAll() {
  const t = now();
  run('UPDATE entries SET seconds = seconds + MAX(0, (? - started_at) / 1000), started_at = 0 WHERE started_at > 0', t);
}

export function saveEntry(e) {
  const projectId = Number(e.project_id), taskId = Number(e.task_id);
  if (!one('SELECT id FROM projects WHERE id = ?', projectId)) throw new Error('Pick a project.');
  if (!one('SELECT id FROM tasks WHERE id = ?', taskId)) throw new Error('Pick a task.');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(e.date || '') ? e.date : null;
  if (!date) throw new Error('Bad date.');
  const secs = Math.max(0, Math.floor(num(e.seconds)));
  return tx(() => {
    run('INSERT OR IGNORE INTO project_tasks (project_id, task_id) VALUES (?, ?)', projectId, taskId);
    if (e.id) {
      const cur = one('SELECT started_at FROM entries WHERE id = ?', e.id);
      if (!cur) throw new Error('That entry no longer exists.');
      // editing the duration of a running timer rebases it to "now"
      run('UPDATE entries SET date=?, project_id=?, task_id=?, notes=?, seconds=?, started_at=? WHERE id=?',
        date, projectId, taskId, str(e.notes, 4000), secs, cur.started_at > 0 ? now() : 0, e.id);
      return e.id;
    }
    if (e.start) stopAll();
    return insert('INSERT INTO entries (date, project_id, task_id, notes, seconds, started_at, created_at) VALUES (?,?,?,?,?,?,?)',
      date, projectId, taskId, str(e.notes, 4000), secs, e.start ? now() : 0, now());
  });
}

// Start an entry's timer. Restarting one from an earlier day starts a fresh
// copy today (Harvest does the same), so past days stay as logged. The same
// goes for an invoiced entry, so billed time never grows.
export function startEntry(id, today) {
  const e = one('SELECT * FROM entries WHERE id = ?', id);
  if (!e) throw new Error('That entry no longer exists.');
  return tx(() => {
    stopAll();
    if (e.date !== today || e.invoice_id) {
      return insert('INSERT INTO entries (date, project_id, task_id, notes, seconds, started_at, created_at) VALUES (?,?,?,?,?,?,?)',
        today, e.project_id, e.task_id, e.notes, 0, now(), now());
    }
    run('UPDATE entries SET started_at = ? WHERE id = ?', now(), id);
    return id;
  });
}
export function stopRunning() { stopAll(); }

// stop the running entry, rolling back `idleSeconds` it didn't really work
export function stopIdle(idleSeconds) {
  const r = one('SELECT id, seconds, started_at FROM entries WHERE started_at > 0');
  if (!r) return null;
  const total = r.seconds + Math.max(0, Math.floor((now() - r.started_at) / 1000));
  run('UPDATE entries SET seconds = ?, started_at = 0 WHERE id = ?', Math.max(0, total - idleSeconds), r.id);
  return entry(r.id);
}
export function deleteEntry(id) { run('DELETE FROM entries WHERE id = ?', id); }

// ── reports ──────────────────────────────────────────────────────────────────
// One row per (date, project, task) — small enough for the page to slice any
// way it likes (by day, client, project, task, currency).
export function report(from, to, filter = {}) {
  let where = 'e.date BETWEEN ? AND ?';
  const args = [now(), from, to];
  if (filter.client_id) { where += ' AND c.id = ?'; args.push(Number(filter.client_id)); }
  if (filter.project_id) { where += ' AND p.id = ?'; args.push(Number(filter.project_id)); }
  if (filter.invoiced === 'yes') where += ' AND e.invoice_id IS NOT NULL';
  if (filter.invoiced === 'no') where += ' AND e.invoice_id IS NULL';
  return q(`SELECT e.date, e.project_id, e.task_id, c.id AS client_id, SUM(${LIVE}) AS seconds, COUNT(*) AS n
            ${ENTRY_FROM} WHERE ${where} GROUP BY e.date, e.project_id, e.task_id ORDER BY e.date`, ...args);
}

export function exportRows(from, to, filter = {}) {
  let where = 'e.date BETWEEN ? AND ?';
  const args = [now(), from, to];
  if (filter.client_id) { where += ' AND c.id = ?'; args.push(Number(filter.client_id)); }
  if (filter.project_id) { where += ' AND p.id = ?'; args.push(Number(filter.project_id)); }
  if (filter.invoiced === 'yes') where += ' AND e.invoice_id IS NOT NULL';
  if (filter.invoiced === 'no') where += ' AND e.invoice_id IS NULL';
  return q(`SELECT ${ENTRY_COLS} ${ENTRY_FROM} WHERE ${where} ORDER BY e.date, e.created_at`, ...args);
}

// ── invoices ─────────────────────────────────────────────────────────────────
// A running timer is never invoiced: stop it first.
const BILLABLE = 'e.invoice_id IS NULL AND e.started_at = 0';

// Time not invoiced yet, one row per project (running timer included, so the
// number is honest), with the last invoice that covered that project.
export function unbilled() {
  const rows = q(`SELECT c.id AS client_id, c.name AS client, c.currency, p.id AS project_id, p.name AS project, p.color,
      COUNT(*) AS n, SUM(${LIVE}) AS seconds, SUM(${LIVE} * t.rate) / 3600.0 AS amount, MIN(e.date) AS first, MAX(e.date) AS last
    ${ENTRY_FROM} WHERE e.invoice_id IS NULL GROUP BY p.id ORDER BY c.name COLLATE NOCASE, p.name COLLATE NOCASE`, now(), now());
  for (const r of rows) {
    r.last_invoice = one(`SELECT id, number, date FROM invoices WHERE id IN (SELECT invoice_id FROM entries WHERE project_id = ?)
      ORDER BY date DESC, id DESC LIMIT 1`, r.project_id);
  }
  return rows;
}

// sel: { entry_ids } or { client_id, project_id?, to? }
function selectBillable(sel) {
  if (Array.isArray(sel.entry_ids)) {
    return q(`SELECT ${ENTRY_COLS} ${ENTRY_FROM} WHERE e.id IN (SELECT value FROM json_each(?)) AND ${BILLABLE} ORDER BY e.date, e.created_at`,
      now(), JSON.stringify(sel.entry_ids.map(Number)));
  }
  const cid = Number(sel.client_id), pid = Number(sel.project_id) || 0;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(sel.to || '') ? sel.to : '9999-12-31';
  return q(`SELECT ${ENTRY_COLS} ${ENTRY_FROM} WHERE c.id = ? AND (? = 0 OR p.id = ?) AND e.date <= ? AND ${BILLABLE} ORDER BY e.date, e.created_at`,
    now(), cid, pid, pid, to);
}

// what an invoice for sel would hold: totals plus one line per project · task
export function invoicePreview(sel) {
  const rows = selectBillable(sel);
  const out = { entry_ids: rows.map((r) => r.id), n: rows.length, seconds: 0, amount: 0, net: 0, from: null, to: null, lines: [], client: null };
  if (!rows.length) return out;
  const cids = new Set(rows.map((r) => r.client_id));
  if (cids.size > 1) throw new Error('Those entries belong to more than one client. An invoice is for one client.');
  out.client = one('SELECT id, name, currency, tax_pct, discount_pct, terms_days FROM clients WHERE id = ?', rows[0].client_id);
  const pids = new Set(rows.map((r) => r.project_id));
  out.project_id = pids.size === 1 ? rows[0].project_id : null;
  const lines = new Map();
  for (const r of rows) {
    const k = r.project_id + ':' + r.task_id;
    if (!lines.has(k)) lines.set(k, { project: r.project, task: r.task, rate: r.rate, seconds: 0, amount: 0, from: r.date, to: r.date });
    const l = lines.get(k);
    l.seconds += r.seconds; l.amount += (r.seconds / 3600) * r.rate; l.to = r.date;
    out.seconds += r.seconds; out.amount += (r.seconds / 3600) * r.rate;
  }
  out.from = rows[0].date; out.to = rows[rows.length - 1].date;
  out.lines = [...lines.values()];
  out.net = out.amount * (1 - out.client.discount_pct / 100);   // what it bills at, before tax
  return out;
}

// "CW-2" → "CW-3", "0041" → "0042"; the client's last number first, then anyone's
export function suggestInvoiceNumber(clientId, today = '') {
  const next = nextAfter(clientId, today);
  if (!india) return next;
  // never suggest one that's taken this year
  let s = next, n = 0;
  const free = (x) => !q('SELECT date FROM invoices WHERE number = ?', x).some((i) => financialYear(i.date) === financialYear(today || i.date));
  while (!free(s) && n++ < 1000) s = bump(s);
  return s;
}

function bump(number) {
  const m = number.match(/^(.*?)(\d+)(\D*)$/);
  if (!m) return number + '-2';
  return m[1] + String(Number(m[2]) + 1).padStart(m[2].length, '0') + m[3];
}

function nextAfter(clientId, today) {
  const last = one('SELECT number FROM invoices WHERE client_id = ? AND number != \'\' ORDER BY date DESC, id DESC LIMIT 1', Number(clientId) || 0)
    || one('SELECT number FROM invoices WHERE number != \'\' ORDER BY date DESC, id DESC LIMIT 1');
  if (!last) return '1';
  // India: a number with the year in it starts again in the new financial year
  const fy = india && today ? last.number.match(/^(.*?)(\d{4}-\d{2})(\D+)(\d+)$/) : null;
  if (fy && fy[2] !== financialYear(today)) return fy[1] + financialYear(today) + fy[3] + '1'.padStart(fy[4].length, '0');
  return bump(last.number);
}

// what was billed: [amount, typed?]. Blank = the time × rates, less discount.
const billed = (typed, worked) => {
  const n = typed === '' || typed == null ? NaN : Number(String(typed).replace(/,/g, ''));
  const set = Number.isFinite(n) && n >= 0;
  return [Math.round((set ? n : worked) * 100) / 100, set ? 1 : 0];
};

export function createInvoice(inv) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(inv.date || '') ? inv.date : null;
  if (!date) throw new Error('Pick the date the invoice was issued.');
  checkIndiaNumber(str(inv.number, 60), date, null);
  return tx(() => {
    const pre = invoicePreview(inv);
    if (!pre.n) throw new Error('There’s no uninvoiced time to put on this invoice.');
    const id = insert('INSERT INTO invoices (client_id, project_id, number, date, notes, seconds, amount, amount_set, currency, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      pre.client.id, pre.project_id, str(inv.number, 60), date, str(inv.notes, 2000), pre.seconds,
      ...billed(inv.amount, pre.net), pre.client.currency, now());
    run('UPDATE entries SET invoice_id = ? WHERE id IN (SELECT value FROM json_each(?))', id, JSON.stringify(pre.entry_ids));
    return id;
  });
}

export function updateInvoice(inv) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(inv.date || '') ? inv.date : null;
  if (!date) throw new Error('Pick the date the invoice was issued.');
  const id = Number(inv.id);
  checkIndiaNumber(str(inv.number, 60), date, id);
  const cur = one('SELECT i.id, c.discount_pct FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.id = ?', id);
  if (!cur) throw new Error('That invoice no longer exists.');
  // blank goes back to what its time is worth now, at today's rates
  const worked = one(`SELECT COALESCE(SUM(e.seconds * t.rate), 0) / 3600.0 AS a FROM entries e JOIN tasks t ON t.id = e.task_id WHERE e.invoice_id = ?`, id).a;
  run('UPDATE invoices SET number = ?, date = ?, notes = ?, amount = ?, amount_set = ? WHERE id = ?', str(inv.number, 60), date, str(inv.notes, 2000),
    ...billed(inv.amount, worked * (1 - cur.discount_pct / 100)), id);
}

// the time goes back to uninvoiced; the entries themselves stay
export function deleteInvoice(id) {
  tx(() => { run('UPDATE entries SET invoice_id = NULL WHERE invoice_id = ?', id); run('DELETE FROM invoices WHERE id = ?', id); });
}

export function invoice(id) {
  return one('SELECT * FROM invoices WHERE id = ?', Number(id));
}
export function client(id) {
  return one('SELECT * FROM clients WHERE id = ?', Number(id));
}
export function invoiceEntries(id) {
  return q(`SELECT ${ENTRY_COLS} ${ENTRY_FROM} WHERE e.invoice_id = ? ORDER BY e.date, e.created_at`, now(), Number(id));
}
export function entriesByIds(ids) {
  return q(`SELECT ${ENTRY_COLS} ${ENTRY_FROM} WHERE e.id IN (SELECT value FROM json_each(?)) ORDER BY e.date, e.created_at`, now(), JSON.stringify((ids || []).map(Number)));
}

export function invoices() {
  return q(`SELECT i.*, c.name AS client, p.name AS project, p.color,
      (SELECT COUNT(*) FROM entries e WHERE e.invoice_id = i.id) AS n,
      (SELECT MIN(date) FROM entries e WHERE e.invoice_id = i.id) AS first,
      (SELECT MAX(date) FROM entries e WHERE e.invoice_id = i.id) AS last,
      (SELECT COALESCE(SUM(seconds), 0) FROM entries e WHERE e.invoice_id = i.id) AS seconds_now
    FROM invoices i JOIN clients c ON c.id = i.client_id LEFT JOIN projects p ON p.id = i.project_id
    ORDER BY i.date DESC, i.id DESC`);
}

// ── import ───────────────────────────────────────────────────────────────────
// rows: [{ date, client, project, task, notes, seconds, rate, currency }]
// Clients, projects and tasks are matched by name (case-insensitive, archived
// ones included) and created when missing. An entry that already exists with
// the same date, project, task, notes and length is skipped, so importing the
// same file twice adds nothing. With dry, everything is rolled back and only
// the counts come back: that's the preview.
export function importRows(rows, { dry = false } = {}) {
  const key = (s) => s.trim().toLowerCase();
  // invoiced: ids of entries Harvest marked as invoiced that aren't on an
  // invoice here yet (new ones, and matches already in the db)
  const out = { entries: 0, duplicates: 0, seconds: 0, clients: [], projects: [], tasks: [], rateNotes: [], invoiced: [] };

  // a task's rate is global here; Harvest's can differ per project, so new
  // tasks take the rate most of their rows used
  const taskRates = new Map();
  for (const r of rows) {
    if (r.rate == null) continue;
    const m = taskRates.get(key(r.task)) || new Map();
    m.set(r.rate, (m.get(r.rate) || 0) + 1);
    taskRates.set(key(r.task), m);
  }
  const usualRate = (task) => {
    const m = taskRates.get(key(task));
    return m ? [...m.entries()].sort((a, b) => b[1] - a[1])[0][0] : 0;
  };

  db.exec('BEGIN');
  try {
    const clients = new Map(q('SELECT id, name FROM clients').map((c) => [key(c.name), c.id]));
    const projects = new Map(q('SELECT id, client_id, name FROM projects').map((p) => [p.client_id + '|' + key(p.name), p.id]));
    const tasks = new Map(q('SELECT id, name, rate FROM tasks').map((t) => [key(t.name), { id: t.id, rate: t.rate }]));
    let nProjects = one('SELECT COUNT(*) AS n FROM projects').n;
    const seen = new Map();       // dedupe key → existing entries in the db not matched to a row yet
    const rateWarned = new Set();

    for (const r of rows) {
      let cid = clients.get(key(r.client));
      if (!cid) {
        cid = insert('INSERT INTO clients (name, currency, created_at) VALUES (?,?,?)', str(r.client, 200), r.currency || 'USD', now());
        clients.set(key(r.client), cid); out.clients.push(r.client);
      }
      let pid = projects.get(cid + '|' + key(r.project));
      if (!pid) {
        pid = insert('INSERT INTO projects (client_id, name, color, created_at) VALUES (?,?,?,?)',
          cid, str(r.project, 200), PALETTE[nProjects++ % PALETTE.length], now());
        projects.set(cid + '|' + key(r.project), pid); out.projects.push(r.project);
      }
      let t = tasks.get(key(r.task));
      if (!t) {
        const rate = usualRate(r.task);
        t = { id: insert('INSERT INTO tasks (name, rate, created_at) VALUES (?,?,?)', str(r.task, 200), rate, now()), rate };
        tasks.set(key(r.task), t); out.tasks.push(r.task);
      }
      if (r.rate != null && r.rate !== t.rate && !rateWarned.has(t.id)) {
        rateWarned.add(t.id);
        out.rateNotes.push(`${r.task}: Harvest has ${r.rate}/h on ${r.project}, Tiny Time uses ${t.rate}/h`);
      }
      run('INSERT OR IGNORE INTO project_tasks (project_id, task_id) VALUES (?, ?)', pid, t.id);

      const notes = str(r.notes, 4000);
      const dk = [r.date, pid, t.id, r.seconds, notes].join('|');
      if (!seen.has(dk)) {
        seen.set(dk, q('SELECT id, invoice_id FROM entries WHERE date = ? AND project_id = ? AND task_id = ? AND seconds = ? AND notes = ? AND started_at = 0 ORDER BY id',
          r.date, pid, t.id, r.seconds, notes));
      }
      const match = seen.get(dk).shift();
      if (match) {
        out.duplicates++;
        if (r.invoiced && !match.invoice_id) out.invoiced.push(match.id);
        continue;
      }
      // created_at orders entries within a day (and picks the tray's "last
      // timer"), so date it on its own day, keeping the file's order
      const [y, m, d] = r.date.split('-').map(Number);
      const eid = insert('INSERT INTO entries (date, project_id, task_id, notes, seconds, created_at) VALUES (?,?,?,?,?,?)',
        r.date, pid, t.id, notes, r.seconds, new Date(y, m - 1, d, 9).getTime() + out.entries);
      if (r.invoiced) out.invoiced.push(eid);
      out.entries++; out.seconds += r.seconds;
    }
    db.exec(dry ? 'ROLLBACK' : 'COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return out;
}

export function isEmpty() { return !one('SELECT 1 AS x FROM clients LIMIT 1'); }

export function wipe() {
  tx(() => { for (const t of ['entries', 'invoices', 'project_tasks', 'projects', 'tasks', 'clients']) run(`DELETE FROM ${t}`); });
}

// sample data so you can kick the tyres
export function seed(today) {
  tx(() => {
    const tk = {};
    for (const [name, rate, common] of [['Design', 120, 1], ['Development', 140, 1], ['Meetings', 100, 1], ['Project Management', 110, 0], ['Copywriting', 90, 0]])
      tk[name] = insert('INSERT INTO tasks (name, rate, common, created_at) VALUES (?,?,?,?)', name, rate, common, now());
    const acme = insert('INSERT INTO clients (name, address, currency, terms_days, tax_pct, discount_pct, created_at) VALUES (?,?,?,?,?,?,?)',
      'Acme Corp', '1 Infinite Loop\nSpringfield', 'USD', 30, 10, 0, now());
    const nw = insert('INSERT INTO clients (name, address, currency, terms_days, tax_pct, discount_pct, created_at) VALUES (?,?,?,?,?,?,?)',
      'Northwind GmbH', 'Hauptstraße 5\n10115 Berlin', 'EUR', 14, 19, 5, now());
    const projs = [
      [acme, 'Website Redesign', PALETTE[0], ['Design', 'Development', 'Meetings', 'Copywriting']],
      [acme, 'Mobile App', PALETTE[1], ['Design', 'Development', 'Meetings', 'Project Management']],
      [nw, 'Brand Refresh', PALETTE[2], ['Design', 'Meetings', 'Copywriting']],
    ];
    const pids = [];
    for (const [cid, name, color, tasks] of projs) {
      const pid = insert('INSERT INTO projects (client_id, name, color, created_at) VALUES (?,?,?,?)', cid, name, color, now());
      for (const t of tasks) run('INSERT INTO project_tasks (project_id, task_id) VALUES (?,?)', pid, tk[t]);
      pids.push([pid, tasks]);
    }
    // ~6 weeks of plausible history
    const [y, m, d] = today.split('-').map(Number);
    let r = 7;
    const rnd = () => (r = (r * 16807) % 2147483647) / 2147483647;
    for (let back = 42; back >= 1; back--) {
      const dt = new Date(y, m - 1, d - back);
      if (dt.getDay() === 0 || dt.getDay() === 6) continue;
      const ds = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
      const n = 2 + Math.floor(rnd() * 3);
      for (let i = 0; i < n; i++) {
        const [pid, tasks] = pids[Math.floor(rnd() * pids.length)];
        const task = tasks[Math.floor(rnd() * tasks.length)];
        const secs = Math.round((0.5 + rnd() * 3) * 4) * 900;
        run('INSERT INTO entries (date, project_id, task_id, notes, seconds, created_at) VALUES (?,?,?,?,?,?)', ds, pid, tk[task], '', secs, dt.getTime() + i);
      }
    }
  });
}

// screenshot tour: a believable "today", with a timer running for 47 min
export function tourToday(today) {
  const p = (name) => one('SELECT id FROM projects WHERE name = ?', name).id;
  const t = (name) => one('SELECT id FROM tasks WHERE name = ?', name).id;
  run('DELETE FROM entries WHERE date = ?', today);
  const base = now() - 6 * 3600e3;
  const add = (proj, task, notes, secs, i) =>
    run('INSERT INTO entries (date, project_id, task_id, notes, seconds, created_at) VALUES (?,?,?,?,?,?)', today, p(proj), t(task), notes, secs, base + i);
  add('Website Redesign', 'Meetings', 'Kick-off with the marketing team', 2700, 1);
  add('Brand Refresh', 'Design', 'Logo explorations, round two', 5400, 2);
  add('Mobile App', 'Development', 'Offline sync for the order list', 0, 3);
  run('UPDATE entries SET started_at = ?, created_at = ? WHERE date = ? AND project_id = ?', now() - 47 * 60e3, now(), today, p('Mobile App'));
}

