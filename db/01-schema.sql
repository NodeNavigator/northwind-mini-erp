-- Northwind Mini-ERP stage 2. Invariants live here, not only in the service layer:
-- a bug in one code path must not be able to corrupt stock or the ledger.
DROP SCHEMA IF EXISTS erp CASCADE;
CREATE SCHEMA erp;
SET search_path = erp, public;

-- identity is looked up by token server-side, never asserted by the client
CREATE TABLE users (user_id bigserial PRIMARY KEY, email text NOT NULL UNIQUE,
  token text NOT NULL UNIQUE, role text NOT NULL);
CREATE TABLE products (sku_id bigserial PRIMARY KEY, sku text NOT NULL UNIQUE,
  standard_cost numeric(14,4) NOT NULL CHECK (standard_cost >= 0));
CREATE TABLE warehouses (warehouse_id bigserial PRIMARY KEY, code text NOT NULL UNIQUE);
CREATE TABLE suppliers (supplier_id bigserial PRIMARY KEY, name text NOT NULL);

-- Lock anchor. Holds NO quantity: one row per (sku,warehouse) to serialise on,
-- and the FK target so nothing can reference a pair that was never established.
CREATE TABLE stock_positions (sku_id bigint NOT NULL REFERENCES products,
  warehouse_id bigint NOT NULL REFERENCES warehouses,
  PRIMARY KEY (sku_id, warehouse_id));

-- Append-only. Stock is SUM(qty_delta); a correction is an opposite movement.
CREATE TABLE stock_movements (movement_id bigserial PRIMARY KEY,
  sku_id bigint NOT NULL, warehouse_id bigint NOT NULL,
  qty_delta numeric(14,4) NOT NULL CHECK (qty_delta <> 0),
  unit_cost numeric(14,4) NOT NULL CHECK (unit_cost >= 0),
  reason text NOT NULL, ref_type text, ref_id bigint,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (sku_id, warehouse_id) REFERENCES stock_positions);

CREATE TABLE stock_reservations (reservation_id bigserial PRIMARY KEY,
  so_line_id bigint, sku_id bigint NOT NULL, warehouse_id bigint NOT NULL,
  qty numeric(14,4) NOT NULL CHECK (qty > 0),
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','RELEASED','CONSUMED')),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '15 minutes',
  FOREIGN KEY (sku_id, warehouse_id) REFERENCES stock_positions);

CREATE TABLE purchase_orders (po_id bigserial PRIMARY KEY,
  supplier_id bigint NOT NULL REFERENCES suppliers,
  amount numeric(14,4) NOT NULL CHECK (amount > 0),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','APPROVED','CANCELLED')),
  created_by bigint NOT NULL REFERENCES users, approved_by bigint REFERENCES users,
  -- SoD in the database, so no code path can bypass a financial control
  CONSTRAINT sod_high_value_needs_second_person
    CHECK (approved_by IS NULL OR amount < 10000 OR approved_by <> created_by));

CREATE TABLE purchase_order_lines (po_line_id bigserial PRIMARY KEY,
  po_id bigint NOT NULL REFERENCES purchase_orders,
  sku_id bigint NOT NULL REFERENCES products,
  warehouse_id bigint NOT NULL REFERENCES warehouses,
  qty_ordered numeric(14,4) NOT NULL CHECK (qty_ordered > 0),
  unit_price numeric(14,4) NOT NULL CHECK (unit_price >= 0));

CREATE TABLE goods_receipts (gr_id bigserial PRIMARY KEY,
  po_id bigint NOT NULL REFERENCES purchase_orders,
  received_by bigint NOT NULL REFERENCES users,
  received_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE goods_receipt_lines (gr_line_id bigserial PRIMARY KEY,
  gr_id bigint NOT NULL REFERENCES goods_receipts,
  po_line_id bigint NOT NULL REFERENCES purchase_order_lines,
  qty_received numeric(14,4) NOT NULL CHECK (qty_received > 0),
  unit_cost numeric(14,4) NOT NULL CHECK (unit_cost >= 0),
  over_received boolean NOT NULL DEFAULT false);   -- R4: flagged, never silent

CREATE TABLE sales_orders (so_id bigserial PRIMARY KEY, customer text NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','CONFIRMED','PARTIALLY_SHIPPED','SHIPPED','CANCELLED')),
  created_by bigint NOT NULL REFERENCES users);

CREATE TABLE sales_order_lines (so_line_id bigserial PRIMARY KEY,
  so_id bigint NOT NULL REFERENCES sales_orders,
  sku_id bigint NOT NULL REFERENCES products,
  warehouse_id bigint NOT NULL REFERENCES warehouses,
  qty numeric(14,4) NOT NULL CHECK (qty > 0),
  unit_price numeric(14,4) NOT NULL CHECK (unit_price >= 0));

-- UNIQUE(source_type,source_id) makes posting idempotent: a retried event cannot
-- double-post. `reverses` records that a correction is a journal, not an edit.
CREATE TABLE journals (journal_id bigserial PRIMARY KEY, source_type text NOT NULL,
  source_id bigint NOT NULL, reverses bigint REFERENCES journals,
  posted_at timestamptz NOT NULL DEFAULT now(), UNIQUE (source_type, source_id));

CREATE TABLE ledger_entries (entry_id bigserial PRIMARY KEY,
  journal_id bigint NOT NULL REFERENCES journals, account text NOT NULL,
  debit numeric(14,4) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit numeric(14,4) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  CHECK (debit = 0 OR credit = 0));   -- an entry is one side, never both

-- A transfer is a header for a linked PAIR of movements, never a balance edit.
-- The pair is what makes it auditable: both legs carry ref_type='TRANSFER' and
-- this id, so the out-leg and in-leg can never be read in isolation.
CREATE TABLE stock_transfers (transfer_id bigserial PRIMARY KEY,
  sku_id bigint NOT NULL REFERENCES products,
  from_warehouse_id bigint NOT NULL REFERENCES warehouses,
  to_warehouse_id bigint NOT NULL REFERENCES warehouses,
  qty numeric(14,4) NOT NULL CHECK (qty > 0),
  moved_by bigint NOT NULL REFERENCES users,
  moved_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transfer_needs_two_places CHECK (from_warehouse_id <> to_warehouse_id));

CREATE INDEX ON stock_movements (sku_id, warehouse_id);
CREATE INDEX ON stock_reservations (sku_id, warehouse_id) WHERE status = 'ACTIVE';
CREATE INDEX ON ledger_entries (journal_id);

-- Derived stock: no caller can read a stale balance because none is stored.
CREATE VIEW available_stock AS
SELECT p.sku_id, p.warehouse_id, COALESCE(m.on_hand,0) AS on_hand,
       COALESCE(r.reserved,0) AS reserved,
       COALESCE(m.on_hand,0) - COALESCE(r.reserved,0) AS available
FROM stock_positions p
LEFT JOIN (SELECT sku_id, warehouse_id, SUM(qty_delta) on_hand
           FROM stock_movements GROUP BY 1,2) m USING (sku_id, warehouse_id)
LEFT JOIN (SELECT sku_id, warehouse_id, SUM(qty) reserved
           FROM stock_reservations WHERE status='ACTIVE' GROUP BY 1,2) r
     USING (sku_id, warehouse_id);

-- Outstanding PO qty is derived, never a mutable column (R4).
CREATE VIEW po_line_status AS
SELECT l.po_line_id, l.po_id, l.sku_id, l.warehouse_id, l.qty_ordered,
       COALESCE(g.qty_received, 0) AS qty_received,
       l.qty_ordered - COALESCE(g.qty_received, 0) AS qty_outstanding,
       COALESCE(g.has_over, false) AS has_over_receipt
FROM purchase_order_lines l
LEFT JOIN (SELECT po_line_id, SUM(qty_received) AS qty_received,
                  bool_or(over_received) AS has_over
             FROM goods_receipt_lines GROUP BY po_line_id) g USING (po_line_id);

-- Shipped/backordered per sales order line (R5), also derived from movements.
-- Pre-aggregated for the same reason as po_line_status. This view is correct
-- today with one join, but it is the same shape the seeded bug exploited: a
-- GROUP BY summing across a join. Adding one more join (customer name, say)
-- would silently multiply qty_shipped. Aggregating first removes the hazard
-- rather than relying on nobody ever joining here again.
CREATE VIEW so_line_status AS
SELECT l.so_line_id, l.so_id, l.sku_id, l.warehouse_id, l.qty AS qty_ordered,
       COALESCE(m.shipped, 0) AS qty_shipped,
       l.qty - COALESCE(m.shipped, 0) AS qty_backordered
FROM sales_order_lines l
LEFT JOIN (SELECT ref_id AS so_line_id, -SUM(qty_delta) AS shipped
             FROM stock_movements WHERE ref_type='SO_LINE' GROUP BY ref_id) m
       USING (so_line_id);

-- DEFERRED so legs may be inserted in any order, but no unbalanced commit.
CREATE FUNCTION assert_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d numeric; c numeric; j bigint;
BEGIN
  j := COALESCE(NEW.journal_id, OLD.journal_id);
  SELECT COALESCE(SUM(debit),0), COALESCE(SUM(credit),0) INTO d, c
    FROM ledger_entries WHERE journal_id = j;
  IF d <> c THEN RAISE EXCEPTION 'journal % unbalanced: debit=% credit=%', j, d, c; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER trg_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_balanced();

-- Posted entries and movements are immutable; corrections are new rows.
CREATE FUNCTION deny_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ledger is append-only: % on % denied, post a reversing journal',
  TG_OP, TG_TABLE_NAME; END $$;
CREATE TRIGGER trg_immutable_entries BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();
CREATE TRIGGER trg_immutable_journals BEFORE UPDATE OR DELETE ON journals
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();
CREATE TRIGGER trg_immutable_movements BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

INSERT INTO users (email, token, role) VALUES
  ('ops@nw.test','tok-ops','WAREHOUSE_OPERATOR'), ('buyer@nw.test','tok-buyer','BUYER'),
  ('pm@nw.test','tok-pm','PROCUREMENT_MANAGER'), ('sales@nw.test','tok-sales','SALES_AGENT'),
  ('ship@nw.test','tok-ship','FULFILMENT'), ('acct@nw.test','tok-acct','ACCOUNTANT');
INSERT INTO products (sku, standard_cost) VALUES
  ('WIDGET-1',10.00), ('GADGET-2',25.00), ('WIDGET-3',5.00);
INSERT INTO warehouses (code) VALUES ('MAIN');
INSERT INTO suppliers (name) VALUES ('Acme Supply');
INSERT INTO stock_positions VALUES (1,1),(2,1),(3,1);
