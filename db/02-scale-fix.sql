-- R4 fix. ops/loadtest.mjs applies this only when FIX=1, so the before/after
-- differs by exactly this file. The problem is not that stock is derived, it is
-- that it is re-derived from a position's full history on every availability
-- check, inside the FOR UPDATE section: cost grows with how long a SKU has
-- traded, and it is paid while holding the lock.
--
-- NOT a mutable balance. stock_movements stays the sole source of truth and
-- stays append-only; this is a trigger-maintained cache of an aggregate the
-- database can recompute at will, and `rollup == SUM(qty_delta)` is checkable
-- (balance_drift, below). An application-maintained balance would be a second
-- source of truth; this is one source with an index.
SET search_path = erp, public;

CREATE TABLE stock_position_balance (
  sku_id bigint NOT NULL,
  warehouse_id bigint NOT NULL,
  on_hand numeric(14,4) NOT NULL DEFAULT 0,
  PRIMARY KEY (sku_id, warehouse_id),
  FOREIGN KEY (sku_id, warehouse_id) REFERENCES stock_positions);

-- Backfill every existing position, including ones with no movements yet.
INSERT INTO stock_position_balance (sku_id, warehouse_id, on_hand)
SELECT p.sku_id, p.warehouse_id, COALESCE(m.total, 0)
  FROM stock_positions p
  LEFT JOIN (SELECT sku_id, warehouse_id, SUM(qty_delta) AS total
               FROM stock_movements GROUP BY 1, 2) m USING (sku_id, warehouse_id);

-- AFTER INSERT only: no UPDATE/DELETE branch, because the immutability triggers
-- already refuse those on stock_movements, so no divergence path needs one.
CREATE FUNCTION bump_position_balance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO stock_position_balance (sku_id, warehouse_id, on_hand)
  VALUES (NEW.sku_id, NEW.warehouse_id, NEW.qty_delta)
  ON CONFLICT (sku_id, warehouse_id)
  DO UPDATE SET on_hand = stock_position_balance.on_hand + EXCLUDED.on_hand;
  RETURN NULL;
END $$;

CREATE TRIGGER trg_bump_balance AFTER INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION bump_position_balance();

-- Same columns, same semantics, O(1) lookup instead of an aggregate over history.
CREATE OR REPLACE VIEW available_stock AS
SELECT p.sku_id, p.warehouse_id,
       COALESCE(b.on_hand, 0) AS on_hand,
       COALESCE(r.reserved, 0) AS reserved,
       COALESCE(b.on_hand, 0) - COALESCE(r.reserved, 0) AS available
FROM stock_positions p
LEFT JOIN stock_position_balance b USING (sku_id, warehouse_id)
LEFT JOIN (SELECT sku_id, warehouse_id, SUM(qty) reserved
             FROM stock_reservations WHERE status = 'ACTIVE' GROUP BY 1, 2) r
     USING (sku_id, warehouse_id);

-- The cache is only legitimate if its agreement with the log is checkable.
-- Any non-empty result is a bug, and this is cheap enough to run on a schedule.
CREATE VIEW balance_drift AS
SELECT b.sku_id, b.warehouse_id, b.on_hand AS cached,
       COALESCE(m.total, 0) AS recomputed,
       b.on_hand - COALESCE(m.total, 0) AS drift
FROM stock_position_balance b
LEFT JOIN (SELECT sku_id, warehouse_id, SUM(qty_delta) AS total
             FROM stock_movements GROUP BY 1, 2) m USING (sku_id, warehouse_id)
WHERE b.on_hand <> COALESCE(m.total, 0);
