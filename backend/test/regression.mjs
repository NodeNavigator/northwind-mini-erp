// One focused regression per seeded bug. Each is written to FAIL against the
// snapshot and pass after the fix: a regression test that never went red proves
// nothing about the bug it claims to cover.
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { server } from '../src/server.js';
import { pool } from '../src/db.js';
import { dsn, numEnv } from '../src/config.js';
const DSN = dsn();


// The suites apply the same migration set the deployed system does; testing a
// schema the server never runs is how a passing suite starts lying.
const SCHEMA_DIR = new URL('../../db/', import.meta.url).pathname;
const SCHEMA_FILES = (process.env.SCHEMA_SQL ?? '').split(',').filter(Boolean)
  .map((f) => f.trim());
const PORT = numEnv('PORT', 3399);
const T = { ops: 'tok-ops', buyer: 'tok-buyer', pm: 'tok-pm', sales: 'tok-sales', acct: 'tok-acct' };
let pass = 0, fail = 0;
const check = (n, fn) => {
  try { fn(); console.log(`PASS  ${n}`); pass += 1; }
  catch (e) { console.log(`FAIL  ${n}\n      ${e.message}`); fail += 1; }
};
const eq = (a, b) => assert.equal(Number(a), Number(b));

async function api(method, path, token, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function approvedPO(skuId, qty, price) {
  const po = await api('POST', '/purchase-orders', T.buyer,
    { supplier_id: 1, lines: [{ sku_id: skuId, warehouse_id: 1, qty_ordered: qty, unit_price: price }] });
  await api('POST', `/purchase-orders/${po.body.po_id}/approve`, T.pm);
  const line = (await api('GET', `/purchase-orders/${po.body.po_id}`, T.buyer)).body[0].po_line_id;
  return { poId: po.body.po_id, line };
}

for (const f of (SCHEMA_FILES.length ? SCHEMA_FILES
  : readdirSync(SCHEMA_DIR).filter((x) => x.endsWith('.sql')).sort().map((x) => SCHEMA_DIR + x))) {
  execFileSync('psql', [DSN, '-q', '-v', 'ON_ERROR_STOP=1', '-f', f], { stdio: 'pipe' });
}
await new Promise((r) => server.listen(PORT, r));

// ---- BUG 1: reservation race allows overselling under concurrency -----------
console.log('\n== BUG 1 reservation race ==');
{
  const { poId, line } = await approvedPO(3, 3, 5.00);
  await api('POST', `/purchase-orders/${poId}/receipts`, T.ops,
    { lines: [{ po_line_id: line, qty_received: 3 }] });

  const ids = [];
  for (let i = 0; i < 12; i += 1) {
    const so = await api('POST', '/sales-orders', T.sales,
      { customer: `race${i}`, lines: [{ sku_id: 3, warehouse_id: 1, qty: 1, unit_price: 20 }] });
    ids.push(so.body.so_id);
  }
  const res = await Promise.all(ids.map((id) => api('POST', `/sales-orders/${id}/reserve`, T.sales)));
  const ok = res.filter((r) => r.status === 200).length;
  const st = (await pool.query('SELECT * FROM available_stock WHERE sku_id=3')).rows[0];
  console.log(`      12 concurrent reserves on 3 units -> ${ok} succeeded, `
    + `on_hand=${st.on_hand} reserved=${st.reserved} available=${st.available}`);
  check('at most 3 reservations succeed', () => eq(ok, 3));
  check('available never negative', () => assert.ok(Number(st.available) >= 0,
    `available=${st.available}`));
  check('reserved never exceeds on hand', () =>
    assert.ok(Number(st.reserved) <= Number(st.on_hand), `${st.reserved} > ${st.on_hand}`));
}

// ---- BUG 2: second partial receipt double-counts ---------------------------
console.log('\n== BUG 2 partial receipt double-count ==');
{
  const { poId, line } = await approvedPO(1, 100, 9.50);
  let r = await api('POST', `/purchase-orders/${poId}/receipts`, T.ops,
    { lines: [{ po_line_id: line, qty_received: 40 }] });
  const after1 = r.body.outstanding[0].qty_outstanding;
  console.log(`      after 1st receipt of 40/100 -> outstanding=${after1}`);
  check('outstanding is 60 after first partial receipt', () => eq(after1, 60));

  r = await api('POST', `/purchase-orders/${poId}/receipts`, T.ops,
    { lines: [{ po_line_id: line, qty_received: 30 }] });
  console.log(`      2nd receipt of 30 (well within the 60 outstanding) -> ${r.status} `
    + `${r.status === 200 ? '' : JSON.stringify(r.body)}`);
  check('a second partial receipt inside the outstanding qty is accepted', () => eq(r.status, 200));
  const received = Number((await pool.query(
    'SELECT qty_received FROM po_line_status WHERE po_line_id=$1', [line])).rows[0].qty_received);
  const outstanding = Number((await pool.query(
    'SELECT qty_outstanding FROM po_line_status WHERE po_line_id=$1', [line])).rows[0].qty_outstanding);
  console.log(`      totals now -> received=${received} outstanding=${outstanding}`);
  check('received totals 70, not double-counted', () => eq(received, 70));
  check('outstanding is 30 after two partial receipts', () => eq(outstanding, 30));
}

// ---- BUG 3: warehouse role can read Finance ledger endpoints ---------------
console.log('\n== BUG 3 missing authorization on ledger ==');
{
  const recon = await api('GET', '/ledger/reconciliation', T.ops);
  const entries = await api('GET', '/ledger/entries', T.ops);
  console.log(`      warehouse operator -> /ledger/reconciliation ${recon.status}, /ledger/entries ${entries.status}`);
  check('warehouse operator refused 403 on /ledger/reconciliation', () => eq(recon.status, 403));
  check('warehouse operator refused 403 on /ledger/entries', () => eq(entries.status, 403));
  const acct = await api('GET', '/ledger/reconciliation', T.acct);
  check('accountant still permitted 200', () => eq(acct.status, 200));
}

// ---- FEATURE: stock transfer as a linked movement pair --------------------
console.log('\n== FEATURE stock transfers ==');
{
  await pool.query("INSERT INTO warehouses (code) VALUES ('WEST') ON CONFLICT DO NOTHING");
  const west = Number((await pool.query("SELECT warehouse_id FROM warehouses WHERE code='WEST'")).rows[0].warehouse_id);
  await pool.query('INSERT INTO stock_positions VALUES (2,$1) ON CONFLICT DO NOTHING', [west]);

  const { poId, line } = await approvedPO(2, 10, 25.00);
  await api('POST', `/purchase-orders/${poId}/receipts`, T.ops, { lines: [{ po_line_id: line, qty_received: 10 }] });

  const before = (await pool.query('SELECT * FROM available_stock WHERE sku_id=2 ORDER BY warehouse_id')).rows;
  const reconBefore = (await api('GET', '/ledger/reconciliation', T.acct)).body;

  let r = await api('POST', '/stock/transfers', T.ops,
    { sku_id: 2, from_warehouse_id: 1, to_warehouse_id: west, qty: 4 });
  console.log(`      transfer 4 of GADGET-2 MAIN->WEST -> ${r.status} ${JSON.stringify(r.body)}`);
  check('transfer accepted', () => eq(r.status, 200));

  const legs = (await pool.query(
    "SELECT warehouse_id, qty_delta, unit_cost FROM stock_movements WHERE ref_type='TRANSFER' AND ref_id=$1 ORDER BY qty_delta",
    [r.body.transfer_id])).rows;
  console.log(`      legs: ${legs.map((l) => `wh${l.warehouse_id} ${l.qty_delta} @${l.unit_cost}`).join('  |  ')}`);
  check('exactly two linked movements written', () => eq(legs.length, 2));
  check('legs are equal and opposite', () => eq(Number(legs[0].qty_delta) + Number(legs[1].qty_delta), 0));
  check('both legs valued identically', () => eq(legs[0].unit_cost, legs[1].unit_cost));

  const after = (await pool.query('SELECT * FROM available_stock WHERE sku_id=2 ORDER BY warehouse_id')).rows;
  const main = after.find((x) => Number(x.warehouse_id) === 1);
  const dest = after.find((x) => Number(x.warehouse_id) === west);
  console.log(`      MAIN ${before[0].on_hand} -> ${main.on_hand}, WEST -> ${dest.on_hand}`);
  check('source fell by 4', () => eq(Number(before[0].on_hand) - Number(main.on_hand), 4));
  check('destination rose by 4', () => eq(dest.on_hand, 4));

  const reconAfter = (await api('GET', '/ledger/reconciliation', T.acct)).body;
  console.log(`      drift before=${reconBefore.drift} after=${reconAfter.drift}`);
  check('transfer leaves reconciliation drift at 0', () => eq(reconAfter.drift, 0));
  check('total inventory value unchanged by the move', () =>
    eq(reconAfter.movements_value, reconBefore.movements_value));

  r = await api('POST', '/stock/transfers', T.ops,
    { sku_id: 2, from_warehouse_id: 1, to_warehouse_id: west, qty: 999 });
  check('over-transfer refused 409', () => eq(r.status, 409));
  r = await api('POST', '/stock/transfers', T.ops,
    { sku_id: 2, from_warehouse_id: 1, to_warehouse_id: 1, qty: 1 });
  check('same-warehouse transfer refused 400', () => eq(r.status, 400));
  r = await api('POST', '/stock/transfers', T.sales,
    { sku_id: 2, from_warehouse_id: 1, to_warehouse_id: west, qty: 1 });
  check('sales agent cannot transfer stock (403)', () => eq(r.status, 403));
}

console.log(`\n${pass} passed, ${fail} failed`);
await new Promise((r) => server.close(r));
await pool.end();
process.exit(fail === 0 ? 0 : 1);
