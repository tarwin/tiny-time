// Tiny Time — Harvest CSV in and out. Pure functions, no database: main.js
// reads/writes the files, db.js does the inserts.
//
// The format is Harvest's "Detailed time" report export (Reports → Detailed
// time → Export → CSV). We read it and write the same columns back, so a file
// we export can be imported again here, or kept alongside your Harvest ones.

export const HARVEST_COLUMNS = ['Date', 'Client', 'Project', 'Project Code', 'Task', 'Notes', 'Hours', 'Billable?',
  'Invoiced?', 'Approved?', 'First Name', 'Last Name', 'Employee Id', 'Roles', 'Teams', 'Employee?', 'Billable Rate',
  'Billable Amount', 'Cost Rate', 'Cost Amount', 'Currency', 'External Reference URL'];

// Harvest writes the currency as "United States Dollar - USD"
const CURRENCY_NAMES = {
  USD: 'United States Dollar', EUR: 'Euro', GBP: 'British Pound', AUD: 'Australian Dollar', CAD: 'Canadian Dollar',
  NZD: 'New Zealand Dollar', JPY: 'Japanese Yen', CHF: 'Swiss Franc', SEK: 'Swedish Krona', NOK: 'Norwegian Krone',
  DKK: 'Danish Krone', SGD: 'Singapore Dollar', HKD: 'Hong Kong Dollar', INR: 'Indian Rupee', ZAR: 'South African Rand',
  BRL: 'Brazilian Real', MXN: 'Mexican Peso', PLN: 'Polish Zloty', CZK: 'Czech Koruna', IDR: 'Indonesian Rupiah',
};

// RFC 4180: quoted fields, "" escapes, newlines inside quotes, CRLF or LF
export function parseCSV(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [], field = '', quoted = false, i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === '') { quoted = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r' || ch === '\n') {
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += ch; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// "1,250.0" (Harvest's thousands separator) or "1,5" (a decimal comma) → number
function toNum(v) {
  const s = String(v || '').trim();
  if (!s) return NaN;
  return Number(/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.'));
}

// "1.5", "1,5", "1:30" → seconds
function hoursToSeconds(v) {
  const s = String(v || '').trim();
  const hm = s.match(/^(\d+):(\d{1,2})$/);
  if (hm) return Number(hm[1]) * 3600 + Number(hm[2]) * 60;
  const n = toNum(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 3600) : null;
}

// "United States Dollar - USD" → "USD"
function currencyCode(v) {
  const m = String(v || '').trim().match(/([A-Za-z]{3})\s*$/);
  return m ? m[1].toUpperCase() : '';
}

// Harvest dates are YYYY-MM-DD in the detailed export; allow a trailing time
function isoDate(v) {
  const m = String(v || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// → { rows: [{ date, client, project, task, notes, seconds, rate, currency }], skipped, name }
export function parseHarvest(text) {
  const table = parseCSV(text);
  if (!table.length) throw new Error('That file is empty.');
  const head = table[0].map((h) => h.trim().toLowerCase());
  const col = (...names) => { for (const nm of names) { const i = head.indexOf(nm); if (i >= 0) return i; } return -1; };
  const C = {
    date: col('date', 'spent date'), client: col('client'), project: col('project'), task: col('task'),
    notes: col('notes'), hours: col('hours'), rate: col('billable rate'), currency: col('currency'),
    first: col('first name'), last: col('last name'), invoiced: col('invoiced?', 'invoiced'),
  };
  const missing = ['date', 'client', 'project', 'task', 'hours'].filter((k) => C[k] < 0);
  if (missing.length) throw new Error(`This doesn’t look like a Harvest time export: no ${missing.map((k) => k[0].toUpperCase() + k.slice(1)).join(', ')} column.`);

  const rows = [];
  let skipped = 0;
  const names = new Map();
  for (let r = 1; r < table.length; r++) {
    const t = table[r];
    const get = (i) => (i >= 0 && i < t.length ? t[i].trim() : '');
    const date = isoDate(get(C.date));
    const seconds = hoursToSeconds(get(C.hours));
    const client = get(C.client), project = get(C.project), task = get(C.task);
    if (!date || seconds == null || !client || !project || !task) { skipped++; continue; }
    const rate = toNum(get(C.rate));
    rows.push({ date, client, project, task, notes: get(C.notes), seconds,
      rate: Number.isFinite(rate) && rate >= 0 ? rate : null, currency: currencyCode(get(C.currency)),
      invoiced: /^(yes|true|1)$/i.test(get(C.invoiced)) });
    const nm = [get(C.first), get(C.last)].join('\t');
    if (nm.trim()) names.set(nm, (names.get(nm) || 0) + 1);
  }
  // the person most rows belong to, so exports can be signed the same way
  let name = null;
  if (names.size) {
    const [first, last] = [...names.entries()].sort((a, b) => b[1] - a[1])[0][0].split('\t');
    name = { first, last };
  }
  return { rows, skipped, name };
}

const cell = (v) => { const s = String(v == null ? '' : v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
// Harvest prints numbers like 250.0, 0.5, 617.5 and 1,250.0
const hnum = (x) => {
  const r = Math.round(x * 100) / 100;
  const [i, f] = (Number.isInteger(r) ? r.toFixed(1) : String(r)).split('.');
  return i.replace(/\B(?=(\d{3})+$)/g, ',') + '.' + f;
};

// entries (db.exportRows shape) → Harvest detailed-time CSV text
export function toHarvestCSV(rows, name = {}) {
  const lines = [HARVEST_COLUMNS.join(',')];
  for (const r of rows) {
    const hours = Math.round((r.seconds / 3600) * 100) / 100;
    const cur = String(r.currency || 'USD').toUpperCase();
    const amount = hours * (r.rate || 0);
    lines.push([
      r.date, r.client, r.project, '', r.task, r.notes, hnum(hours), r.rate > 0 ? 'Yes' : 'No',
      r.invoice_id ? 'Yes' : 'No', 'No', name.first || '', name.last || '', '', '', '', 'Yes', hnum(r.rate || 0),
      hnum(amount), '0.0', '0.0', CURRENCY_NAMES[cur] ? `${CURRENCY_NAMES[cur]} - ${cur}` : cur, '',
    ].map(cell).join(','));
  }
  return lines.join('\n') + '\n';
}
