// Shared page helpers (popover + app window). Pure DOM/format code — the
// backend owns data and time.

export const $ = (id) => document.getElementById(id);

// ⌘ on the Mac, Ctrl elsewhere — for in-window shortcuts and their labels
export const IS_MAC = (() => { try { return tiny.system.isMacOS(); } catch (e) { return true; } })();
export const mod = (e) => (IS_MAC ? e.metaKey : e.ctrlKey);
export const keyLabel = (k) => (IS_MAC ? '⌘' + k : 'Ctrl+' + k);
export const FILE_MANAGER = IS_MAC ? 'Finder' : (() => { try { return tiny.system.isWindows() ? 'Explorer' : 'Files'; } catch (e) { return 'Files'; } })();
export const call = (m, p) => tiny.api.call(m, p || {});

export function el(tag, cls, txt) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
}
export function h(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else if (k in n && typeof v !== 'string') n[k] = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k.nodeType ? k : String(k));
  return n;
}
export function icon(name, cls) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('class', 'ic' + (cls ? ' ' + cls : ''));
  const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  u.setAttribute('href', '#i-' + name);
  s.appendChild(u);
  return s;
}

// ── time ─────────────────────────────────────────────────────────────────────
const two = (n) => (n < 10 ? '0' + n : '' + n);
export const fmtHM = (s) => { s = Math.max(0, Math.floor(s)); return Math.floor(s / 3600) + ':' + two(Math.floor((s % 3600) / 60)); };
export const fmtHMS = (s) => { s = Math.max(0, Math.floor(s)); return Math.floor(s / 3600) + ':' + two(Math.floor((s % 3600) / 60)) + ':' + two(s % 60); };
export const fmtHours = (s) => (s / 3600).toFixed(2);

// "1:30", "1.5", "90m", "1h 30m", "45" (minutes if < 10? no — plain number = hours)
export function parseDuration(str) {
  str = String(str || '').trim().toLowerCase();
  if (!str) return 0;
  let m;
  if ((m = str.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/))) return (+m[1]) * 3600 + (+m[2]) * 60 + (+(m[3] || 0));
  if ((m = str.match(/^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+)\s*m)?$/)) && (m[1] || m[2])) return Math.round((+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60);
  if ((m = str.match(/^\d+(?:\.\d+)?$/))) return Math.round(parseFloat(str) * 3600);
  return null;
}

// ── dates (local) ────────────────────────────────────────────────────────────
export const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const ymd = (d) => d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate());
export const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
export function weekOf(s, weekStart = 1) {
  const d = parseYmd(s);
  const back = (d.getDay() - weekStart + 7) % 7;
  return Array.from({ length: 7 }, (_, i) => ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() - back + i)));
}
export function dayLabel(s, today) {
  const d = parseYmd(s);
  const diff = Math.round((d - parseYmd(today)) / 864e5);
  const tail = d.getDate() + ' ' + MON[d.getMonth()];
  if (diff === 0) return 'Today, ' + tail;
  if (diff === -1) return 'Yesterday, ' + tail;
  if (diff === 1) return 'Tomorrow, ' + tail;
  return DOW[d.getDay()] + ', ' + tail + (d.getFullYear() !== parseYmd(today).getFullYear() ? ' ' + d.getFullYear() : '');
}

// ── money ────────────────────────────────────────────────────────────────────
const fmts = {};
export function money(amount, currency) {
  const c = (currency || 'USD').toUpperCase();
  try {
    // rupees group in lakhs and crores, whatever the system's language
    fmts[c] ||= new Intl.NumberFormat(c === 'INR' ? 'en-IN' : undefined, { style: 'currency', currency: c });
    return fmts[c].format(amount);
  } catch (e) {
    return c + ' ' + amount.toFixed(2);
  }
}
export const CURRENCIES = ['USD', 'EUR', 'GBP', 'AUD', 'NZD', 'CAD', 'CHF', 'JPY', 'SEK', 'NOK', 'DKK', 'SGD', 'HKD', 'INR', 'ZAR', 'BRL', 'MXN'];
export const TERMS = [[0, 'Due on receipt'], [7, 'Net 7'], [14, 'Net 14'], [15, 'Net 15'], [30, 'Net 30'], [45, 'Net 45'], [60, 'Net 60'], [90, 'Net 90']];
export function termsLabel(days) {
  const t = TERMS.find(([d]) => d === days);
  return t ? t[1] : `Net ${days} (custom)`;
}

// ── catalog helpers ──────────────────────────────────────────────────────────
export function indexCatalog(cat) {
  const clients = Object.fromEntries(cat.clients.map((c) => [c.id, c]));
  const projects = Object.fromEntries(cat.projects.map((p) => [p.id, p]));
  const tasks = Object.fromEntries(cat.tasks.map((t) => [t.id, t]));
  return { ...cat, byClient: clients, byProject: projects, byTask: tasks };
}

// build a <select> of active projects grouped under their client
export function projectSelect(cat, selected) {
  const s = h('select', { class: 'in' });
  s.append(h('option', { value: '' }, 'Choose a project…'));
  for (const c of cat.clients) {
    const ps = cat.projects.filter((p) => p.client_id === c.id && (!p.archived || p.id === selected) && (!c.archived || p.id === selected));
    if (!ps.length) continue;
    const g = h('optgroup', { label: c.name });
    for (const p of ps) g.append(h('option', { value: p.id, selected: p.id === selected }, p.name));
    s.append(g);
  }
  return s;
}
export function taskOptions(sel, cat, projectId, selected) {
  sel.innerHTML = '';
  const p = cat.projects.find((x) => x.id === projectId);
  const ids = p ? p.task_ids : [];
  const ts = cat.tasks.filter((t) => ids.includes(t.id) && (!t.archived || t.id === selected));
  if (!ts.length) sel.append(h('option', { value: '' }, p ? 'No tasks on this project' : '—'));
  for (const t of ts) sel.append(h('option', { value: t.id, selected: t.id === selected }, t.name));
  if (!ts.some((t) => t.id === selected) && ts[0]) sel.value = ts[0].id;
}

// errors thrown by the backend arrive as rejected promises with a message
export function errMsg(e) { return String((e && e.message) || e).replace(/^Error:\s*/, ''); }

// no browser context menu except in text fields
addEventListener('contextmenu', (e) => {
  if (!e.target.closest('input, textarea, [contenteditable]')) e.preventDefault();
});

// ── icon sprite (line icons, currentColor) — injected once per page ─────────
const SPRITE = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
<symbol id="i-left" viewBox="0 0 24 24"><path d="M14.5 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-right" viewBox="0 0 24 24"><path d="M9.5 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></symbol>
<symbol id="i-play" viewBox="0 0 24 24"><path d="M9 7.2v9.6l7.6-4.8z" fill="currentColor"/></symbol>
<symbol id="i-stop" viewBox="0 0 24 24"><rect x="8" y="8" width="8" height="8" rx="1.6" fill="currentColor"/></symbol>
<symbol id="i-cal" viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M3.5 9.5h17M8 3.5v3M16 3.5v3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></symbol>
<symbol id="i-chart" viewBox="0 0 24 24"><path d="M4 20h16M7 16.5V11M12 16.5V6.5M17 16.5v-4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></symbol>
<symbol id="i-gear" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.1" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 3.6v2.3M12 18.1v2.3M20.4 12h-2.3M5.9 12H3.6M18 6l-1.6 1.6M7.6 16.4L6 18M18 18l-1.6-1.6M7.6 7.6L6 6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></symbol>
<symbol id="i-info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 11v5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><circle cx="12" cy="7.9" r="1.15" fill="currentColor"/></symbol>
<symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-users" viewBox="0 0 24 24"><circle cx="9" cy="9" r="3.2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M3.5 19c.6-3 2.8-4.6 5.5-4.6s4.9 1.6 5.5 4.6M15.5 6.2a3 3 0 010 5.6M17.5 14.6c1.6.5 2.7 2 3 4.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></symbol>
<symbol id="i-folder" viewBox="0 0 24 24"><path d="M3.5 7.5a2 2 0 012-2h4l2 2h7a2 2 0 012 2v8a2 2 0 01-2 2h-13a2 2 0 01-2-2z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></symbol>
<symbol id="i-tag" viewBox="0 0 24 24"><path d="M4 12.5V5.5a1.5 1.5 0 011.5-1.5h7l7.5 7.5-8.5 8.5z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><circle cx="8.5" cy="8.5" r="1.3" fill="currentColor"/></symbol>
<symbol id="i-open" viewBox="0 0 24 24"><path d="M13.5 4.5h6v6M19.5 4.5l-8 8M17 14v4.5a1.5 1.5 0 01-1.5 1.5h-10A1.5 1.5 0 014 18.5v-10A1.5 1.5 0 015.5 7H10" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-close" viewBox="0 0 24 24"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></symbol>
<symbol id="i-trash" viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-invoice" viewBox="0 0 24 24"><path d="M6.5 3.5h11v17l-2.75-1.6-2.75 1.6-2.75-1.6-2.75 1.6zM9.5 8h5M9.5 11.5h5M9.5 15h3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-transfer" viewBox="0 0 24 24"><path d="M7 4.5v14m0 0l-3.5-3.5M7 18.5l3.5-3.5M17 19.5v-14m0 0l-3.5 3.5M17 5.5l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-upload" viewBox="0 0 24 24"><path d="M12 15.5v-10m0 0l-4 4m4-4l4 4M5 19.5h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-download" viewBox="0 0 24 24"><path d="M12 4.5v10m0 0l-4-4m4 4l4-4M5 19.5h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></symbol>
</defs></svg>`;
document.body.insertAdjacentHTML('afterbegin', SPRITE);

// ── theme: appearance (system/light/dark) + accent color ─────────────────────
// Any accent works: we derive a darker gradient stop, a soft tint, the color
// for text ON the accent (white or ink, whichever reads), and an "ink"
// version of the accent for use AS text that keeps ≥3.5:1 on the surface —
// so a pale yellow accent still gives readable labels.
export const DEFAULT_ACCENT = '#22a676';
export const ACCENTS = [['#22a676', 'Green'], ['#2a78d6', 'Blue'], ['#6250d6', 'Violet'], ['#d6457e', 'Pink'],
  ['#d9464f', 'Red'], ['#e8833a', 'Orange'], ['#e0b100', 'Yellow'], ['#1a9bb0', 'Teal'], ['#5f6670', 'Graphite']];
const hexRGB = (hx) => [1, 3, 5].map((i) => parseInt(hx.slice(i, i + 2), 16));
const rgbHex = (c) => '#' + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
function lum(c) {
  const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

let theme = { accent: DEFAULT_ACCENT, appearance: 'system' };
const darkMQ = matchMedia('(prefers-color-scheme: dark)');
export function applyTheme(t = {}) {
  if (t.accent) theme.accent = /^#[0-9a-f]{6}$/i.test(t.accent) ? t.accent : DEFAULT_ACCENT;
  if (t.appearance) theme.appearance = ['light', 'dark'].includes(t.appearance) ? t.appearance : 'system';
  const root = document.documentElement;
  if (theme.appearance === 'system') root.removeAttribute('data-theme'); else root.dataset.theme = theme.appearance;
  const dark = theme.appearance === 'dark' || (theme.appearance === 'system' && darkMQ.matches);
  const a = hexRGB(theme.accent);
  const surface = dark ? [31, 32, 35] : [255, 255, 255];
  let ink = a;
  for (let i = 0; i < 20 && contrast(ink, surface) < 3.5; i++) ink = mix(ink, dark ? [255, 255, 255] : [0, 0, 0], 0.08);
  const st = root.style;
  st.setProperty('--accent', theme.accent);
  st.setProperty('--accent2', rgbHex(mix(a, [0, 0, 0], 0.18)));
  st.setProperty('--accent-soft', `rgba(${a.join(',')}, ${dark ? 0.22 : 0.14})`);
  st.setProperty('--accent-ink', rgbHex(ink));
  st.setProperty('--on-accent', contrast(a, [255, 255, 255]) >= 2.6 ? '#ffffff' : '#1d1f22');
}
darkMQ.addEventListener('change', () => applyTheme());
tiny.api.on('theme', (t) => applyTheme(t));
