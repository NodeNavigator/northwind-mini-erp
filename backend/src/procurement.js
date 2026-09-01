import { pool, tx, stdCost, httpError } from './db.js';
import { postJournal, ACC } from './ledger.js';

export const createPO = (user, b) => tx(async (c) => {
  const amount = b.lines.reduce((s, l) => s + l.qty_ordered * l.unit_price, 0);
  const po = await c.query(
    'INSERT INTO purchase_orders (supplier_id,amount,created_by) VALUES ($1,$2,$3) RETURNING po_id,status,amount',
    [b.supplier_id, amount, user.user_id]);
  for (const l of b.lines) {
    await c.query(
      'INSERT INTO purchase_order_lines (po_id,sku_id,warehouse_id,qty_ordered,unit_price) VALUES ($1,$2,$3,$4,$5)',
      [po.rows[0].po_id, l.sku_id, l.warehouse_id, l.qty_ordered, l.unit_price]);
  }
  return { ...po.rows[0], created_by: user.user_id };
});

/** SoD checked here for a usable message AND by a schema CHECK, so no other
 *  code path can write a violating row. */
export const approvePO = (user, poId) => tx(async (c) => {
  const r = await c.query('SELECT amount,created_by,status FROM purchase_orders WHERE po_id=$1 FOR UPDATE', [poId]);
  if (r.rowCount === 0) throw httpError(404, 'NO_SUCH_PO');
  const po = r.rows[0];
  if (po.status !== 'DRAFT') throw httpError(409, 'PO_NOT_DRAFT', po.status);
  if (Number(po.amount) >= 10000 && Number(po.created_by) === user.user_id) {
    throw httpError(403, 'SEPARATION_OF_DUTIES', 'approver must differ from creator for amounts >= 10000');
  }
  return (await c.query(
    "UPDATE purchase_orders SET status='APPROVED', approved_by=$1 WHERE po_id=$2 RETURNING po_id,status,approved_by",
    [user.user_id, poId])).rows[0];
});

export const listPOs = async () => (await pool.query(
  `SELECT p.po_id, p.status, p.amount, p.created_by, p.approved_by,
          COALESCE(SUM(s.qty_outstanding),0) AS qty_outstanding
     FROM purchase_orders p LEFT JOIN po_line_status s USING (po_id)
    GROUP BY p.po_id ORDER BY p.po_id DESC LIMIT 50`)).rows;

export const poStatus = async (poId) =>
  (await pool.query('SELECT * FROM po_line_status WHERE po_id=$1 ORDER BY po_line_id', [poId])).rows;

/** R4. Over-receipt is a decision, never silent corruption of outstanding qty:
 *  rejected by default, or accepted with allow_over_receipt and flagged
 *  over_received=true so the excess stays visible downstream. */
export const receive = (user, poId, b) => tx(async (c) => {
  const po = await c.query('SELECT status FROM purchase_orders WHERE po_id=$1', [poId]);
  if (po.rowCount === 0) throw httpError(404, 'NO_SUCH_PO');
  if (po.rows[0].status !== 'APPROVED') throw httpError(409, 'PO_NOT_APPROVED');

  const grId = (await c.query('INSERT INTO goods_receipts (po_id,received_by) VALUES ($1,$2) RETURNING gr_id',
    [poId, user.user_id])).rows[0].gr_id;
  const legs = [];
  const received = [];

  for (const line of b.lines) {
    const st = await c.query(
      `SELECT s.qty_outstanding, l.sku_id, l.warehouse_id, l.unit_price
         FROM po_line_status s JOIN purchase_order_lines l USING (po_line_id)
        WHERE s.po_line_id=$1 FOR UPDATE OF l`, [line.po_line_id]);
    if (st.rowCount === 0) throw httpError(404, 'NO_SUCH_PO_LINE', line.po_line_id);
    const { qty_outstanding, sku_id, warehouse_id, unit_price } = st.rows[0];
    const qty = Number(line.qty_received);
    if (!(qty > 0)) throw httpError(400, 'INVALID_QTY', line.po_line_id);
    const over = qty > Number(qty_outstanding);
    if (over && !b.allow_over_receipt) {
      throw httpError(409, 'OVER_RECEIPT_REJECTED',
        `line ${line.po_line_id}: outstanding ${qty_outstanding}, received ${qty}`);
    }

    const std = await stdCost(c, sku_id);
    await c.query(
      'INSERT INTO goods_receipt_lines (gr_id,po_line_id,qty_received,unit_cost,over_received) VALUES ($1,$2,$3,$4,$5)',
      [grId, line.po_line_id, qty, unit_price, over]);
    await c.query(
      `INSERT INTO stock_movements (sku_id,warehouse_id,qty_delta,unit_cost,reason,ref_type,ref_id)
       VALUES ($1,$2,$3,$4,'GOODS_RECEIPT','GR',$5)`, [sku_id, warehouse_id, qty, std, grId]);

    // Inventory at standard, liability at PO price, difference to PPV. The movement
    // is valued at standard too: value both sides alike or drift is permanent.
    const inv = qty * std;
    const grni = qty * Number(unit_price);
    const variance = inv - grni;
    legs.push({ account: ACC.INVENTORY, debit: inv }, { account: ACC.GRNI, credit: grni },
      variance >= 0 ? { account: ACC.PPV, credit: variance } : { account: ACC.PPV, debit: -variance });
    received.push({ po_line_id: line.po_line_id, qty_received: qty, over_received: over });
  }

  const journal_id = await postJournal(c, 'GOODS_RECEIPT', grId, legs);
  const outstanding = (await c.query(
    'SELECT po_line_id,qty_outstanding,has_over_receipt FROM po_line_status WHERE po_id=$1 ORDER BY po_line_id',
    [poId])).rows;
  return { gr_id: grId, journal_id, received, outstanding };
});
