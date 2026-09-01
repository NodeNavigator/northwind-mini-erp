// Acceptance suite: every check hits the real HTTP API against a real Postgres,
// so authorisation and concurrency are exercised where they actually live.
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { server } from '../src/server.js';
import { pool } from '../src/db.js';

// No credential is fixed in source. DATABASE_URL wins; otherwise the parts come
// from the same env vars docker-compose.yml uses, so local defaults and deployed
// config are the same mechanism rather than two that can drift apart.
const DSN = process.env.DATABASE_URL
  ?? `postgres://postgres:${process.env.POSTGRES_PASSWORD ?? 'erp'}`
   + `@localhost:${process.env.DB_PORT ?? 55432}/erp`;
// The suites apply the same migration set the deployed system does; testing a
// schema the server never runs is how a passing suite starts lying.
const SCHEMA_DIR = new URL('../../db/', import.meta.url).pathname;
const SCHEMA_FILES = (process.env.SCHEMA_SQL ?? '').split(',').filter(Boolean)
  .map((f) => f.trim());
const PORT = 3199;
const T = { ops: 'tok-ops', buyer: 'tok-buyer', pm: 'tok-pm', sales: 'tok-sales', ship: 'tok-ship', acct: 'tok-acct' };
let pass = 0, fail = 0;

const check = (n, fn) => {
  try { fn(); console.log(`PASS  ${n}`); pass += 1; }
  catch (e) { console.log(`FAIL  ${n}\n      ${e.message}`); fail += 1; }
};
const eq = (a, b) => assert.equal(Number(a), Number(b));

/** Seeds stock the way the business does: PO -> approve -> receive, so every
 *  movement has its journal and the reconciliation stays meaningful. */
async function seedStock(skuId, qty, price) {
  const po = await api('POST', '/purchase-orders', T.buyer,
    { supplier_id: 1, lines: [{ sku_id: skuId, warehouse_id: 1, qty_ordered: qty, unit_price: price }] });
  await api('POST', `/purchase-orders/${po.body.po_id}/approve`, T.pm);
  const line = (await pool.query('SELECT po_line_id FROM po_line_status WHERE po_id=$1',
    [po.body.po_id])).rows[0].po_line_id;
  await api('POST', `/purchase-orders/${po.body.po_id}/receipts`, T.ops,
    { lines: [{ po_line_id: line, qty_received: qty }] });
}

async function api(method, path, token, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

for (const f of (SCHEMA_FILES.length ? SCHEMA_FILES
  : readdirSync(SCHEMA_DIR).filter((x) => x.endsWith('.sql')).sort().map((x) => SCHEMA_DIR + x))) {
  execFileSync('psql', [DSN, '-q', '-v', 'ON_ERROR_STOP=1', '-f', f], { stdio: 'pipe' });
}
await new Promise((r) => server.listen(PORT, r));

console.log('\n== R6 authorization: enforced server-side ==');
let r = await api('POST', '/purchase-orders/1/approve', null);
check('401 with no token', () => eq(r.status, 401));
r = await api('POST', '/purchase-orders/1/approve', 'tok-nonexistent');
check('401 with unknown token', () => eq(r.status, 401));
r = await api('POST', '/sales-orders', T.ops, { customer: 'x', lines: [] });
check('403 warehouse operator cannot create sales orders', () => {
  eq(r.status, 403); assert.equal(r.body.error, 'FORBIDDEN'); });

console.log('\n== procurement: PO, approval, separation of duties ==');
r = await api('POST', '/purchase-orders', T.buyer,
  { supplier_id: 1, lines: [{ sku_id: 1, warehouse_id: 1, qty_ordered: 100, unit_price: 9.50 }] });
const poId = r.body.po_id;
check('buyer creates PO', () => eq(r.status, 200));
r = await api('POST', `/purchase-orders/${poId}/approve`, T.buyer);
check('403 buyer cannot approve any PO', () => eq(r.status, 403));
r = await api('POST', `/purchase-orders/${poId}/approve`, T.pm);
check('procurement manager approves', () => assert.equal(r.body.status, 'APPROVED'));

console.log('\n== R4 partial receipt + over-receipt ==');
const poLine = (await pool.query('SELECT po_line_id FROM po_line_status WHERE po_id=$1', [poId])).rows[0].po_line_id;
r = await api('POST', `/purchase-orders/${poId}/receipts`, T.ops,
  { lines: [{ po_line_id: poLine, qty_received: 40 }] });
check('receive 40 of 100', () => eq(r.status, 200));
check('outstanding is 60 after partial receipt', () => eq(r.body.outstanding[0].qty_outstanding, 60));
r = await api('POST', `/purchase-orders/${poId}/receipts`, T.ops,
  { lines: [{ po_line_id: poLine, qty_received: 70 }] });
check('409 over-receipt rejected by default', () => {
  eq(r.status, 409); assert.equal(r.body.error, 'OVER_RECEIPT_REJECTED'); });
r = await api('POST', `/purchase-orders/${poId}/receipts`, T.ops,
  { lines: [{ po_line_id: poLine, qty_received: 70 }], allow_over_receipt: true });
check('over-receipt accepted with explicit flag', () => assert.equal(r.body.received[0].over_received, true));
check('over-receipt visible on the line', () => assert.equal(r.body.outstanding[0].has_over_receipt, true));
check('outstanding goes negative, not hidden', () => eq(r.body.outstanding[0].qty_outstanding, -10));

console.log('\n== R2 concurrency: 12 parallel reservations, 3 units on hand ==');
// Seeded through the real procurement path: a hand-inserted movement has no
// journal behind it and breaks the very invariant R3 asserts -- which is how the
// first version of this test failed.
await seedStock(3, 3, 5.00);

const orders = [];
for (let i = 0; i < 12; i += 1) {
  const so = await api('POST', '/sales-orders', T.sales,
    { customer: `c${i}`, lines: [{ sku_id: 3, warehouse_id: 1, qty: 1, unit_price: 20 }] });
  orders.push(so.body.so_id);
}
const results = await Promise.all(orders.map((id) => api('POST', `/sales-orders/${id}/reserve`, T.sales)));
const ok = results.filter((x) => x.status === 200).length;
const rejected = results.filter((x) => x.status === 409).length;
const stock = (await pool.query('SELECT * FROM available_stock WHERE sku_id=3')).rows[0];
console.log(`      reserved=${ok} rejected=${rejected} on_hand=${stock.on_hand} reserved_qty=${stock.reserved} available=${stock.available}`);
check('exactly 3 of 12 concurrent reservations succeed', () => eq(ok, 3));
check('the other 9 are rejected, not errored', () => eq(rejected, 9));
check('available never goes negative', () => assert.ok(Number(stock.available) >= 0));
check('reserved never exceeds on hand', () => assert.ok(Number(stock.reserved) <= Number(stock.on_hand)));

console.log('\n== R5 partial fulfilment + backorder ==');
await seedStock(2, 4, 25.00);
const big = await api('POST', '/sales-orders', T.sales,
  { customer: 'bulk', lines: [{ sku_id: 2, warehouse_id: 1, qty: 10, unit_price: 40 }] });
r = await api('POST', `/sales-orders/${big.body.so_id}/reserve`, T.sales);
check('reserve 4 of 10 requested', () => eq(r.body.reservations[0].qty, 4));
check('remaining 6 backordered', () =>
  eq(r.body.backordered[0].requested - r.body.backordered[0].available, 6));
r = await api('POST', `/sales-orders/${big.body.so_id}/fulfil`, T.ship);
check('ships 4', () => eq(r.body.lines[0].qty_shipped, 4));
check('order is PARTIALLY_SHIPPED', () => assert.equal(r.body.status, 'PARTIALLY_SHIPPED'));
check('6 still backordered', () => eq(r.body.lines[0].qty_backordered, 6));

console.log('\n== R3 reconciliation ==');
r = await api('GET', '/ledger/reconciliation', T.acct);
console.log(`      ${JSON.stringify(r.body)}`);
check('ledger debits equal credits', () => eq(r.body.total_debits, r.body.total_credits));
check('movements reconcile with ledger (drift 0)', () => eq(r.body.drift, 0));

console.log('\n== ledger immutability ==');
let denied = null;
try { await pool.query('UPDATE ledger_entries SET debit = debit + 1 WHERE entry_id = 1'); }
catch (e) { denied = e.message; }
console.log(`      ${denied}`);
check('posted entries cannot be updated', () => assert.match(denied ?? '', /append-only/));
denied = null;
try { await pool.query('DELETE FROM ledger_entries WHERE entry_id = 1'); }
catch (e) { denied = e.message; }
check('posted entries cannot be deleted', () => assert.match(denied ?? '', /append-only/));

console.log('\n== corrections are reversing entries, never edits ==');
r = await api('POST', '/ledger/journals', T.acct,
  { ref: 9001, legs: [{ account: '6000_EXPENSE', debit: 50 }, { account: '2000_ACCRUAL', credit: 50 }] });
const jid = r.body.journal_id;
check('accountant posts a manual journal', () => eq(r.status, 200));
r = await api('POST', '/ledger/journals', T.sales,
  { ref: 9002, legs: [{ account: '6000_EXPENSE', debit: 1 }, { account: '2000_ACCRUAL', credit: 1 }] });
check('403 sales agent cannot post journals', () => eq(r.status, 403));
r = await api('POST', `/ledger/journals/${jid}/reverse`, T.acct, { reason: 'wrong account' });
const rev = r.body.journal_id;
check('reversal is a new journal, not an edit', () => assert.ok(rev > jid));
const linked = (await pool.query('SELECT reverses FROM journals WHERE journal_id=$1', [rev])).rows[0];
check('reversal is linked to the original', () => eq(linked.reverses, jid));
const net = (await pool.query(
  `SELECT COALESCE(SUM(debit-credit),0) n FROM ledger_entries
    WHERE journal_id IN ($1,$2) AND account='6000_EXPENSE'`, [jid, rev])).rows[0];
check('original + reversal net to zero', () => eq(net.n, 0));
r = await api('GET', '/ledger/reconciliation', T.acct);
check('reconciliation unaffected by the reversal', () => eq(r.body.drift, 0));

console.log(`\n${pass} passed, ${fail} failed`);
await new Promise((r2) => server.close(r2));
await pool.end();
process.exit(fail === 0 ? 0 : 1);
