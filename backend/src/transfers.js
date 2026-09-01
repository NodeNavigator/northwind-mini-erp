import { tx, lockPositions, readAvailable, stdCost, httpError } from './db.js';

/**
 * R3. A transfer is TWO movements - out of source, into destination - written in
 * one transaction and linked by a transfer header. It is deliberately NOT a
 * balance edit: stock is still SUM(qty_delta), so the same append-only ledger
 * that answers "why is stock 7?" answers it for transfers too.
 *
 * No journal is posted, and that is a decision rather than an omission: the two
 * legs carry equal unit_cost and opposite sign, so they sum to zero value. Total
 * inventory value is unchanged, the reconciliation invariant still holds, and a
 * DR/CR against one inventory account would net to nothing. If warehouses ever
 * map to separate inventory accounts this becomes a real journal - noted, not built.
 */
export const transfer = (user, b) => tx(async (c) => {
  const skuId = Number(b.sku_id);
  const from = Number(b.from_warehouse_id);
  const to = Number(b.to_warehouse_id);
  const qty = Number(b.qty);
  if (!Number.isInteger(skuId) || !Number.isInteger(from) || !Number.isInteger(to)) {
    throw httpError(400, 'INVALID_IDS');
  }
  if (!(qty > 0)) throw httpError(400, 'INVALID_QTY', b.qty);
  if (from === to) throw httpError(400, 'SAME_WAREHOUSE');

  // Both anchors locked in the system-wide canonical order, so simultaneous
  // A->B and B->A transfers cannot each hold what the other needs. Acquiring and
  // measuring are separate calls: only the source's availability decides this,
  // and the previous shape returned two numbers the caller had to choose between.
  await lockPositions(c, [{ skuId, whId: from }, { skuId, whId: to }]);
  const available = await readAvailable(c, skuId, from);
  if (available < qty) {
    throw httpError(409, 'INSUFFICIENT_STOCK',
      { sku_id: skuId, warehouse_id: from, requested: qty, available });
  }

  const t = await c.query(
    `INSERT INTO stock_transfers (sku_id, from_warehouse_id, to_warehouse_id, qty, moved_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING transfer_id`, [skuId, from, to, qty, user.user_id]);
  const id = t.rows[0].transfer_id;

  // Same unit_cost on both legs: valuing them differently would move value
  // between warehouses and break the ledger reconciliation.
  const cost = await stdCost(c, skuId);
  for (const [wh, delta] of [[from, -qty], [to, qty]]) {
    await c.query(
      `INSERT INTO stock_movements (sku_id, warehouse_id, qty_delta, unit_cost, reason, ref_type, ref_id)
       VALUES ($1,$2,$3,$4,'TRANSFER','TRANSFER',$5)`, [skuId, wh, delta, cost, id]);
  }
  return { transfer_id: id, sku_id: skuId, from_warehouse_id: from, to_warehouse_id: to, qty };
});
