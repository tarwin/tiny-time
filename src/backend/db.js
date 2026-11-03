// Tiny Time — data layer. One sqlite file in the app's data dir.
//
// clients ─< projects >─< project_tasks >─ tasks
//                 └──────< entries >───────┘
//
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
    Math.max(0, Math.round(num(c.terms_days, 30))), pct(c.tax_pct), pct(c.discount_pct), c.archived ? 1 : 0];
  if (c.id) {
    run('UPDATE clients SET name=?, address=?, currency=?, terms_days=?, tax_pct=?, discount_pct=?, archived=? WHERE id=?', ...vals, c.id);
    return c.id;
  }
  return insert('INSERT INTO clients (name, address, currency, terms_days, tax_pct, discount_pct, archived, created_at) VALUES (?,?,?,?,?,?,?,?)', ...vals, now());
}
export function deleteClient(id) {
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
  if (one('SELECT 1 AS x FROM entries WHERE project_id = ?', id))
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
  c.currency, t.name AS task, t.rate`;
const ENTRY_FROM = `FROM entries e JOIN projects p ON p.id = e.project_id JOIN clients c ON c.id = p.client_id
  JOIN tasks t ON t.id = e.task_id`;

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
// copy today (Harvest does the same), so past days stay as logged.
export function startEntry(id, today) {
  const e = one('SELECT * FROM entries WHERE id = ?', id);
  if (!e) throw new Error('That entry no longer exists.');
  return tx(() => {
    stopAll();
    if (e.date !== today) {
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
  return q(`SELECT e.date, e.project_id, e.task_id, c.id AS client_id, SUM(${LIVE}) AS seconds, COUNT(*) AS n
            ${ENTRY_FROM} WHERE ${where} GROUP BY e.date, e.project_id, e.task_id ORDER BY e.date`, ...args);
}

export function exportRows(from, to, filter = {}) {
  let where = 'e.date BETWEEN ? AND ?';
  const args = [now(), from, to];
  if (filter.client_id) { where += ' AND c.id = ?'; args.push(Number(filter.client_id)); }
  if (filter.project_id) { where += ' AND p.id = ?'; args.push(Number(filter.project_id)); }
  return q(`SELECT ${ENTRY_COLS} ${ENTRY_FROM} WHERE ${where} ORDER BY e.date, e.created_at`, ...args);
}

export function isEmpty() { return !one('SELECT 1 AS x FROM clients LIMIT 1'); }

export function wipe() {
  tx(() => { for (const t of ['entries', 'project_tasks', 'projects', 'tasks', 'clients']) run(`DELETE FROM ${t}`); });
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

