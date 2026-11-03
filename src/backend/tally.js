// Tiny Time → Tiny Tally. An invoice goes over as a .tallyinvoice file: JSON
// that Tiny Tally opens as a new invoice, filled in, for you to check and
// save. Neither app reads the other's database. The format is documented in
// Tiny Tally's src/shared/invoiceHandoff.ts.

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (s) => { const [y, m, d] = s.split('-').map(Number); return { y, m, d }; };
// "18 Jun – 9 Sep 2026", "3 – 17 Jun 2026", "17 Jun 2026"
export function period(from, to) {
  const a = day(from), b = day(to);
  const end = `${b.d} ${MON[b.m - 1]} ${b.y}`;
  if (from === to) return end;
  if (a.y !== b.y) return `${a.d} ${MON[a.m - 1]} ${a.y} – ${end}`;
  if (a.m !== b.m) return `${a.d} ${MON[a.m - 1]} – ${end}`;
  return `${a.d} – ${end}`;
}

const round2 = (x) => Math.round(x * 100) / 100;

// inv: the invoice row; client: its client; entries: its entries (ENTRY_COLS shape)
export function handoff(inv, client, entries) {
  const lines = new Map();
  for (const e of entries) {
    const k = e.project_id + ':' + e.task_id;
    if (!lines.has(k)) lines.set(k, { project: e.project, task: e.task, rate: e.rate, seconds: 0, from: e.date, to: e.date });
    const l = lines.get(k);
    l.seconds += e.seconds;
    if (e.date < l.from) l.from = e.date;
    if (e.date > l.to) l.to = e.date;
  }
  const out = [...lines.values()].map((l) => ({
    description: `${l.project}: ${l.task} (${period(l.from, l.to)})`,
    quantity: round2(l.seconds / 3600),
    unitPrice: l.rate,
  }));
  const worked = out.reduce((a, l) => a + l.quantity * l.unitPrice, 0);
  // the client's discount, then whatever was typed as the billed amount
  if (client.discount_pct > 0) out.push({ description: `Discount (${client.discount_pct}%)`, quantity: 1, unitPrice: -round2(worked * client.discount_pct / 100) });
  if (inv.amount_set) {
    const adjust = round2(inv.amount - out.reduce((a, l) => a + l.quantity * l.unitPrice, 0));
    if (Math.abs(adjust) >= 0.01) out.push({ description: 'Adjustment', quantity: 1, unitPrice: adjust });
  }
  return {
    tallyInvoice: 1,
    source: 'Tiny Time',
    customer: { name: client.name, address: client.address || '' },
    number: inv.number || '',
    issueDate: inv.date,
    dueDays: client.terms_days,
    currency: client.currency,
    reference: '',
    notes: inv.notes || '',
    lines: out,
  };
}
