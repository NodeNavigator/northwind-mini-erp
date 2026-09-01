/**
 * R4 — what breaks first at 100x, measured rather than asserted.
 *
 * The obvious guess is that `available_stock` aggregates the whole
 * stock_movements table on every read. EXPLAIN says otherwise: Postgres pushes
 * the (sku_id, warehouse_id) predicate down into the aggregate subquery and uses
 * the index, so a busy warehouse does not slow down an unrelated SKU.
 *
 * What actually scales badly is narrower and worse. `lockPosition()` takes
 * `FOR UPDATE` and then recomputes availability from that SKU's *entire movement
 * history* while still holding the lock. Cost is linear in the depth of one
 * position's history, and it is paid inside the critical section, so every
 * concurrent reservation for that SKU queues behind an increasingly expensive
 * read. Throughput on a hot SKU therefore degrades with age, not with load.
 *
 * This varies exactly one thing — history depth for ONE position — and holds
 * everything else constant, so the curve is attributable.
 *
 *   node ops/loadtest.mjs
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { server } from '../backend/src/server.js';
import { pool } from '../backend/src/db.js';

const here = dirname(fileURLToPath(import.meta.url));
const DSN = process.env.DATABASE_URL
  ?? `postgres://postgres:${process.env.POSTGRES_PASSWORD ?? 'erp'}`
   + `@localhost:${process.env.DB_PORT ?? 55432}/erp`;
const PORT = Number(process.env.PORT ?? 3501);
const DEPTHS = (process.env.DEPTHS ?? '100,1000,10000,50000,200000').split(',').map(Number);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 40);

execFileSync('psql', [DSN, '-q', '-v', 'ON_ERROR_STOP=1', '-f', join(here, '..', 'db', '01-schema.sql')],
  { stdio: 'pipe' });

// FIX=1 is the ONLY difference between the two runs: same script, same depths,
// same concurrency, same seeding. The delta is therefore attributable to
// 02-scale-fix.sql and not to anything else that moved between measurements.
const FIX = process.env.FIX === '1';
if (FIX) {
  execFileSync('psql', [DSN, '-q', '-v', 'ON_ERROR_STOP=1', '-f', join(here, '..', 'db', '02-scale-fix.sql')],
    { stdio: 'pipe' });
}
console.log(FIX ? 'variant: WITH 02-scale-fix.sql (rollup)' : 'variant: BASELINE (aggregate over history)');

await new Promise((r) => server.listen(PORT, r));

const api = async (method, path, token, body) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

const pct = (xs, p) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length * p)];

/** Direct INSERT, deliberately. This grows history depth for the latency
 *  measurement only; it is not application behaviour and posts no journal, so
 *  reconciliation is meaningless during the run and is not asserted. */
async function growHistory(target) {
  const have = Number((await pool.query(
    'SELECT count(*)::int n FROM stock_movements WHERE sku_id=1 AND warehouse_id=1')).rows[0].n);
  const need = target - have;
  if (need <= 0) return;
  // Balanced +1/-1 pairs so on_hand stays flat and the only variable is depth.
  await pool.query(
    `INSERT INTO stock_movements (sku_id, warehouse_id, qty_delta, unit_cost, reason, ref_type, ref_id)
     SELECT 1, 1, CASE WHEN g % 2 = 0 THEN 1 ELSE -1 END, 10.00, 'BENCH', 'BENCH', g
       FROM generate_series(1, $1) g`, [need]);
}

console.log(`concurrency=${CONCURRENCY}  depths=${DEPTHS.join(',')}\n`);
console.log('  depth   avail_p50  avail_p95   reserve_ok  wall_ms   reserve/s');
console.log('  ------  ---------  ---------   ----------  -------   ---------');

const rows = [];
for (const depth of DEPTHS) {
  await growHistory(depth);
  // Top the position up so every round has stock to reserve, and ANALYZE so the
  // planner is costing the table as it actually is at this depth.
  await pool.query(
    `INSERT INTO stock_movements (sku_id, warehouse_id, qty_delta, unit_cost, reason, ref_type, ref_id)
     VALUES (1, 1, $1, 10.00, 'BENCH_TOPUP', 'BENCH', 0)`, [CONCURRENCY * 2]);
  await pool.query('ANALYZE stock_movements');

  const reads = [];
  for (let i = 0; i < 50; i += 1) {
    const t = process.hrtime.bigint();
    await pool.query(
      'SELECT available FROM available_stock WHERE sku_id=$1 AND warehouse_id=$2', [1, 1]);
    reads.push(Number(process.hrtime.bigint() - t) / 1e6);
  }

  const ids = [];
  for (let i = 0; i < CONCURRENCY; i += 1) {
    const so = await api('POST', '/sales-orders', 'tok-sales',
      { customer: `bench-${depth}-${i}`, lines: [{ sku_id: 1, warehouse_id: 1, qty: 1, unit_price: 20 }] });
    ids.push(so.body.so_id);
  }
  const t0 = process.hrtime.bigint();
  const res = await Promise.all(ids.map((id) => api('POST', `/sales-orders/${id}/reserve`, 'tok-sales')));
  const wall = Number(process.hrtime.bigint() - t0) / 1e6;
  const ok = res.filter((r) => r.status === 200).length;

  const row = {
    depth,
    p50: pct(reads, 0.50),
    p95: pct(reads, 0.95),
    ok,
    wall,
    tps: (ok / wall) * 1000,
  };
  rows.push(row);
  console.log(`  ${String(depth).padStart(6)}  ${row.p50.toFixed(3).padStart(9)}  `
    + `${row.p95.toFixed(3).padStart(9)}   ${String(ok).padStart(10)}  ${wall.toFixed(0).padStart(7)}   `
    + `${row.tps.toFixed(1).padStart(9)}`);
}

const first = rows[0];
const last = rows[rows.length - 1];
console.log(`\n  depth ${first.depth} -> ${last.depth} (${(last.depth / first.depth).toFixed(0)}x history):`);
console.log(`    availability p50   ${first.p50.toFixed(3)} ms -> ${last.p50.toFixed(3)} ms  `
  + `(${(last.p50 / first.p50).toFixed(1)}x)`);
console.log(`    reserve throughput ${first.tps.toFixed(1)} /s -> ${last.tps.toFixed(1)} /s  `
  + `(${(first.tps / last.tps).toFixed(1)}x slower)`);

// A cache is only worth having if it provably still agrees with the log. This
// runs after 200k+ trigger firings under concurrent load, which is the condition
// under which a hand-maintained balance would have drifted.
if (FIX) {
  const drift = await pool.query('SELECT * FROM balance_drift');
  console.log(`\n  balance_drift rows: ${drift.rowCount} (any row is a bug)`);
  const cmp = await pool.query(
    `SELECT b.on_hand AS cached, (SELECT SUM(qty_delta) FROM stock_movements
        WHERE sku_id=1 AND warehouse_id=1) AS recomputed
       FROM stock_position_balance b WHERE b.sku_id=1 AND b.warehouse_id=1`);
  console.log(`  position (1,1): cached=${cmp.rows[0].cached} recomputed=${cmp.rows[0].recomputed}`);
}

console.log('\n  plan at final depth:');
const plan = await pool.query(
  'EXPLAIN (ANALYZE, COSTS OFF) SELECT available FROM available_stock WHERE sku_id=1 AND warehouse_id=1');
for (const r of plan.rows) console.log(`    ${r['QUERY PLAN']}`);

await new Promise((r) => server.close(r));
await pool.end();
