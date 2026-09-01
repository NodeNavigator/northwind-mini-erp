/**
 * The deadlock claim, actually tested.
 *
 * transfers.js locks both anchor rows in ascending warehouse_id, and the README
 * previously said deadlock freedom "rests on the lock order plus a passing
 * suite" — which is an argument, not evidence. This closes it.
 *
 * The test does two things a naive concurrency test does not:
 *
 *  1. It proves the RACE WINDOW IS REAL by running the same scenario against a
 *     deliberately broken lock order (request order instead of canonical) and
 *     asserting Postgres reports 40P01. A concurrency test that has never
 *     produced the failure it claims to prevent proves nothing.
 *  2. It forces the interleaving rather than hoping for it: both transactions
 *     take their FIRST lock and are held there until the other has done the
 *     same, so each is guaranteed to want a row the other holds before either
 *     asks for its second.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { server } from '../src/server.js';
import { pool, tx, lockPositions } from '../src/db.js';
import { dsn, numEnv } from '../src/config.js';
const DSN = dsn();


const SCHEMA_DIR = new URL('../../db/', import.meta.url).pathname;
const PORT = numEnv('PORT', 3402);

let pass = 0, fail = 0;
const check = (n, fn) => {
  try { fn(); console.log(`PASS  ${n}`); pass += 1; }
  catch (e) { console.log(`FAIL  ${n}\n      ${e.message}`); fail += 1; }
};

for (const f of readdirSync(SCHEMA_DIR).filter((x) => x.endsWith('.sql')).sort()) {
  execFileSync('psql', [DSN, '-q', '-v', 'ON_ERROR_STOP=1', '-f', SCHEMA_DIR + f], { stdio: 'pipe' });
}
await new Promise((r) => server.listen(PORT, r));

const api = async (method, path, token, body) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

// Two warehouses, both holding stock of SKU 2, so a transfer can go either way.
await pool.query("INSERT INTO warehouses (code) VALUES ('WEST') ON CONFLICT DO NOTHING");
const west = Number((await pool.query("SELECT warehouse_id FROM warehouses WHERE code='WEST'")).rows[0].warehouse_id);
await pool.query('INSERT INTO stock_positions VALUES (2,$1) ON CONFLICT DO NOTHING', [west]);

const po = await api('POST', '/purchase-orders', 'tok-buyer',
  { supplier_id: 1, lines: [{ sku_id: 2, warehouse_id: 1, qty_ordered: 100, unit_price: 25 }] });
await api('POST', `/purchase-orders/${po.body.po_id}/approve`, 'tok-pm');
const line = (await api('GET', `/purchase-orders/${po.body.po_id}`, 'tok-buyer')).body[0].po_line_id;
await api('POST', `/purchase-orders/${po.body.po_id}/receipts`, 'tok-ops',
  { lines: [{ po_line_id: line, qty_received: 100 }] });
// Give WEST its own stock so both directions are viable.
await api('POST', '/stock/transfers', 'tok-ops',
  { sku_id: 2, from_warehouse_id: 1, to_warehouse_id: west, qty: 50 });

/**
 * Barrier both transactions must reach before either takes its second lock. The
 * timeout is load-bearing, not padding: under REQUEST order both take different
 * first locks, both arrive, and the cycle is guaranteed. Under CANONICAL order
 * the second blocks on the SAME first row and never arrives — which is exactly
 * why no cycle forms. Without the timeout the correct case would hang forever,
 * making the shipped ordering untestable.
 */
function barrier(n, ms = 750) {
  let arrived = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const timer = setTimeout(() => release(), ms);
  timer.unref?.();
  return () => {
    arrived += 1;
    if (arrived === n) { clearTimeout(timer); release(); }
    return gate;
  };
}

/** Two opposing two-position transactions, concurrently. 'canonical' locks
 *  ascending warehouse_id (what transfers.js does); 'request' locks in the
 *  caller's own direction (the bug). */
async function race(order) {
  const wait = barrier(2);
  const leg = (from, to) => tx(async (c) => {
    const [first, second] = order === 'canonical'
      ? (from < to ? [from, to] : [to, from])
      : [from, to];
    await lockPositions(c, [{ skuId: 2, whId: first }]);
    await wait();                       // both hold their first lock here
    await lockPositions(c, [{ skuId: 2, whId: second }]); // each now wants what the other holds
    return 'ok';
  });
  const out = await Promise.allSettled([leg(1, west), leg(west, 1)]);
  return out.map((r) => (r.status === 'fulfilled' ? 'ok' : (r.reason.code ?? r.reason.message)));
}

console.log('\n== lock order: REQUEST ORDER (the bug) ==');
const bad = await race('request');
console.log(`      results: ${JSON.stringify(bad)}`);
check('request-order locking actually deadlocks (40P01)', () =>
  assert.ok(bad.includes('40P01'), `expected a 40P01, got ${JSON.stringify(bad)}`));

console.log('\n== lock order: ASCENDING warehouse_id (shipped) ==');
const good = await race('canonical');
console.log(`      results: ${JSON.stringify(good)}`);
check('canonical order: no deadlock', () =>
  assert.ok(!good.some((r) => r === '40P01'), `deadlocked: ${JSON.stringify(good)}`));
check('canonical order: both transactions completed', () =>
  assert.deepEqual(good, ['ok', 'ok']));

console.log('\n== the real endpoint, two-way, concurrently ==');
const both = await Promise.all([
  api('POST', '/stock/transfers', 'tok-ops', { sku_id: 2, from_warehouse_id: 1, to_warehouse_id: west, qty: 5 }),
  api('POST', '/stock/transfers', 'tok-ops', { sku_id: 2, from_warehouse_id: west, to_warehouse_id: 1, qty: 5 }),
]);
console.log(`      statuses: ${both.map((r) => r.status).join(', ')}`);
check('both opposing transfers succeed via the API', () =>
  assert.deepEqual(both.map((r) => r.status), [200, 200]));

const recon = (await api('GET', '/ledger/reconciliation', 'tok-acct')).body;
console.log(`      reconciliation: drift=${recon.drift} balance_drift_rows=${recon.stock_balance_drift_rows}`);
check('ledger still reconciles after the race', () => assert.equal(Number(recon.drift), 0));
check('stock rollup still agrees with the movement log', () =>
  assert.equal(Number(recon.stock_balance_drift_rows), 0));

console.log(`\n${pass} passed, ${fail} failed`);
await new Promise((r) => server.close(r));
await pool.end();
process.exit(fail === 0 ? 0 : 1);
