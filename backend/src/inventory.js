import { pool } from './db.js';

/** Three numbers, never one: "available" alone hides why it is low. */
export const getStock = async (q) => (await pool.query(
  `SELECT s.sku_id, s.warehouse_id, p.sku, w.code AS warehouse, s.on_hand, s.reserved, s.available
     FROM available_stock s JOIN products p USING (sku_id) JOIN warehouses w USING (warehouse_id)
    WHERE ($1::text IS NULL OR p.sku=$1) ORDER BY p.sku`, [q.sku ?? null])).rows;

export const listMovements = async (q) => (await pool.query(
  `SELECT movement_id, sku_id, warehouse_id, qty_delta, unit_cost, reason, ref_type, ref_id, occurred_at
     FROM stock_movements WHERE ($1::bigint IS NULL OR sku_id=$1)
    ORDER BY movement_id DESC LIMIT 200`, [q.sku_id ?? null])).rows;
