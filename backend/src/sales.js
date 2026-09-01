import { pool, tx, lockPositions, readAvailable, stdCost, httpError } from './db.js';
import { postJournal, ACC } from './ledger.js';

export const createSO = (user, b) => tx(async (c) => {
  const so = await c.query('INSERT INTO sales_orders (customer,created_by) VALUES ($1,$2) RETURNING so_id,status',
    [b.customer, user.user_id]);
  for (const l of b.lines) {
    await c.query('INSERT INTO sales_order_lines (so_id,sku_id,warehouse_id,qty,unit_price) VALUES ($1,$2,$3,$4,$5)',
      [so.rows[0].so_id, l.sku_id, l.warehouse_id, l.qty, l.unit_price]);
  }
  return so.rows[0];
});

/** R2. The anchor row is locked BEFORE availability is read, so concurrent
 *  requests for the last unit serialise: the second blocks, then reads a value
 *  that already reflects the first. Nothing external happens inside the lock.
 *  R5: a line that cannot be fully covered reserves what exists; the rest is
 *  backordered rather than failing the whole order. */
export const reserve = (user, soId) => tx(async (c) => {
  const lines = await c.query(
    'SELECT so_line_id,sku_id,warehouse_id,qty FROM sales_order_lines WHERE so_id=$1', [soId]);
  if (lines.rowCount === 0) throw httpError(404, 'NO_SUCH_SO');
  // Every position this order touches, locked up front in the canonical order
  // db.js owns. Availability is then read per line rather than once, because two
  // lines can share a position and the second must see the first's reservation.
  await lockPositions(c, lines.rows.map(
    (l) => ({ skuId: Number(l.sku_id), whId: Number(l.warehouse_id) })));

  const reservations = [];
  const backordered = [];
  for (const l of lines.rows) {
    const available = await readAvailable(c, l.sku_id, l.warehouse_id);
    const want = Number(l.qty);
    const take = Math.min(want, available);
    if (take > 0) {
      const r = await c.query(
        'INSERT INTO stock_reservations (so_line_id,sku_id,warehouse_id,qty) VALUES ($1,$2,$3,$4) RETURNING reservation_id,qty,expires_at',
        [l.so_line_id, l.sku_id, l.warehouse_id, take]);
      reservations.push({ so_line_id: l.so_line_id, ...r.rows[0] });
    }
    if (take < want) backordered.push({ so_line_id: l.so_line_id, requested: want, available });
  }
  if (reservations.length === 0) throw httpError(409, 'INSUFFICIENT_STOCK', backordered);
  await c.query("UPDATE sales_orders SET status='CONFIRMED' WHERE so_id=$1", [soId]);
  return { so_id: soId, reservations, backordered };
});

/** R5. Ships whatever is reservable now; the rest stays backordered. Movement,
 *  reservation state change and both ledger legs commit in one transaction, so
 *  the ledger can never disagree with the movements. */
export const fulfil = (user, soId) => tx(async (c) => {
  const lines = await c.query(
    'SELECT so_line_id,sku_id,warehouse_id,qty_backordered FROM so_line_status WHERE so_id=$1 ORDER BY sku_id,warehouse_id',
    [soId]);
  if (lines.rowCount === 0) throw httpError(404, 'NO_SUCH_SO');

  await lockPositions(c, lines.rows.map(
    (l) => ({ skuId: Number(l.sku_id), whId: Number(l.warehouse_id) })));

  const legs = [];
  const shipped = [];
  let short = false;
  for (const l of lines.rows) {
    const remaining = Number(l.qty_backordered);
    if (remaining <= 0) continue;
    const available = await readAvailable(c, l.sku_id, l.warehouse_id);
    // This line's own ACTIVE reservations are already excluded from `available`,
    // so add them back: that stock is reserved *for this order*.
    const own = Number((await c.query(
      "SELECT COALESCE(SUM(qty),0) q FROM stock_reservations WHERE so_line_id=$1 AND status='ACTIVE'",
      [l.so_line_id])).rows[0].q);
    const qty = Math.min(remaining, available + own);
    if (qty <= 0) { short = true; continue; }
    if (qty < remaining) short = true;

    const std = await stdCost(c, l.sku_id);
    await c.query(
      `INSERT INTO stock_movements (sku_id,warehouse_id,qty_delta,unit_cost,reason,ref_type,ref_id)
       VALUES ($1,$2,$3,$4,'SO_FULFIL','SO_LINE',$5)`, [l.sku_id, l.warehouse_id, -qty, std, l.so_line_id]);
    await c.query("UPDATE stock_reservations SET status='CONSUMED' WHERE so_line_id=$1 AND status='ACTIVE'",
      [l.so_line_id]);
    legs.push({ account: ACC.COGS, debit: qty * std }, { account: ACC.INVENTORY, credit: qty * std });
    shipped.push({ so_line_id: l.so_line_id, qty_shipped: qty, qty_backordered: remaining - qty });
  }
  if (shipped.length === 0) throw httpError(409, 'NOTHING_SHIPPABLE');

  const journal_id = await postJournal(c, 'SO_FULFIL', soId, legs);
  const status = short ? 'PARTIALLY_SHIPPED' : 'SHIPPED';
  await c.query('UPDATE sales_orders SET status=$1 WHERE so_id=$2', [status, soId]);
  return { so_id: soId, status, journal_id, lines: shipped };
});

export const soStatus = async (soId) =>
  (await pool.query('SELECT * FROM so_line_status WHERE so_id=$1 ORDER BY so_line_id', [soId])).rows;
