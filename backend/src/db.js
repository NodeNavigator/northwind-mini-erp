import pg from 'pg';

// Managed Postgres (Render, Neon, Supabase) terminates TLS with a certificate
// this container has no CA for, so verification must be relaxed for those hosts
// and ONLY those. Defaulting `ssl` on everywhere would silently disable
// verification against a database that could have offered a verifiable chain.
const dsn = process.env.DATABASE_URL ?? 'postgres://postgres:erp@localhost:55432/erp';
const needsSsl = process.env.PGSSL === 'require' || /sslmode=require/.test(dsn);

export const pool = new pg.Pool({
  connectionString: dsn,
  max: Number(process.env.PG_POOL ?? 20),
  ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
});
pool.on('connect', (c) => c.query('SET search_path = erp, public'));

/** Commit or rollback, never both; client released even when fn throws. */
export async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
}

/**
 * ACQUIRE. Locks every position a transaction will touch, in one canonical
 * order (sku, then warehouse), so no two transactions can request the same rows
 * in opposite directions.
 *
 * Here rather than in the callers because the rule was previously implemented
 * three times — a JS sort in `reserve`, a SQL ORDER BY in `fulfil`, a ternary in
 * `transfer`. Three implementations of one invariant is three chances to get it
 * wrong, and a fourth caller had to know it existed. `test/deadlock.mjs` proves
 * the window is real: the same race with request-order locking returns 40P01.
 */
export async function lockPositions(c, keys) {
  const sorted = [...keys].sort((a, b) => a.skuId - b.skuId || a.whId - b.whId);
  for (const k of sorted) {
    const r = await c.query(
      'SELECT 1 FROM stock_positions WHERE sku_id=$1 AND warehouse_id=$2 FOR UPDATE', [k.skuId, k.whId]);
    if (r.rowCount === 0) throw httpError(404, 'NO_SUCH_STOCK_POSITION', k);
  }
}

/**
 * MEASURE. Availability as of now. Separate from acquiring, because a caller
 * that locks two positions usually wants one measurement, and folding the two
 * together forced it to reconstruct which of two returned numbers it meant.
 * The caller must already hold the lock — reading before locking is the
 * check-then-act bug this whole mechanism exists to prevent.
 */
export async function readAvailable(c, skuId, whId) {
  const a = await c.query(
    'SELECT available FROM available_stock WHERE sku_id=$1 AND warehouse_id=$2', [skuId, whId]);
  if (a.rowCount === 0) throw httpError(404, 'NO_SUCH_STOCK_POSITION', { skuId, whId });
  return Number(a.rows[0].available);
}


export const stdCost = async (c, skuId) =>
  Number((await c.query('SELECT standard_cost FROM products WHERE sku_id=$1', [skuId])).rows[0].standard_cost);

export function httpError(status, code, detail) {
  const e = new Error(code);
  Object.assign(e, { status, code, detail });
  return e;
}
