# Northwind Mini-ERP

Procurement, inventory, sales and a double-entry ledger, built across four prior
stages and deployed here as one system. Roughly 2,400 lines of Node and SQL, no
framework, no ORM.

- **Console** — `FRONTEND_URL`
- **API** — `BACKEND_URL` (`/` service info, `/health` readiness)

Sign in by picking a role in the console; the six demo tokens are seeded by
`ops/seed.mjs` and listed under [Demo roles](#demo-roles).

---

## 1. Architecture

Three processes and a database. The console never talks to the API directly.

```
browser ──► console (Node, :3200) ──► api (Node, :3100) ──► postgres :5432
            static files                stateless               all invariants
            + /api/* proxy              no session state        live here
```

**Why the console proxies instead of the API enabling CORS.** The browser only
ever sees one origin, so there is no preflight, no `Access-Control-Allow-*`
anywhere in the codebase, and no second origin for a token to leak to. The proxy
forwards the `Authorization` header untouched and adds no authority of its own —
it cannot authorise anything the API would refuse.

**Layers.** `server.js` is the composition root: a route table of
`[method, pattern, capability, handler]`. Authentication and authorisation both
run before any handler, so a handler is unreachable by a role lacking its
capability regardless of what the UI renders. Domain logic sits in
`procurement.js`, `sales.js`, `transfers.js`, `inventory.js`, `ledger.js`.
`db.js` owns the pool, the transaction wrapper, and — deliberately — the only
implementation of the position lock ordering.

**The invariants live in the database, not the service layer**, because a bug in
one code path must not be able to corrupt stock or the ledger:

| Invariant | Enforced by |
|---|---|
| A journal's debits equal its credits | `DEFERRABLE INITIALLY DEFERRED` constraint trigger — legs may be inserted in any order, but an unbalanced journal cannot commit |
| Posted entries and movements are never edited | `BEFORE UPDATE OR DELETE` triggers that raise; a correction is a new reversing journal |
| A retried event cannot post twice | `UNIQUE (source_type, source_id)` on `journals` |
| High-value POs need a second approver | `CHECK (approved_by IS NULL OR amount < 10000 OR approved_by <> created_by)` |
| Stock cannot reference a position that was never established | composite FK from `stock_movements` to `stock_positions` |

### Trade-offs across the four stages

**Stage 1 — stock is derived, never stored.** On-hand is `SUM(qty_delta)` over an
append-only table. No code path can write a wrong balance because no balance
column exists to write. The cost is that every read recomputes — which is exactly
what [section 6](#6-at-100x) had to fix.

**Stage 2 — the ledger posts inside the caller's transaction.** A goods receipt
and its journal commit together or not at all. An asynchronous outbox is what you
need across services and buys nothing where both writes are in one database.

**Stage 3 — the console renders server state rather than keeping a second model.**
No client-side cache of stock; every mutation re-fetches. Slower, much harder to
get wrong. Role-based nav hides views the API would refuse anyway — hiding is a
courtesy, the API is the boundary, and `frontend/test/ui.test.mjs` asserts a
hidden route still returns 403.

**Stage 4 — transfers extend the movement ledger rather than adding a mechanism.**
A header plus two linked movements, `-qty` at source and `+qty` at destination at
the same `unit_cost`. No journal is posted: both legs hit the same inventory
account with equal and opposite value, so it is a guaranteed no-op — asserted, not
assumed, by checking drift and total inventory value across a transfer. It becomes
a real journal only if warehouses map to separate inventory accounts.

---

## 2. Run it locally

Requires Docker and Docker Compose. Nothing else — no Node, no `psql`.

```bash
git clone <repo> && cd mini-erp
docker compose up --build
```

Then open **http://localhost:3200**.

`up` runs five services in a fixed order, which `depends_on` conditions make
deterministic rather than lucky:

```
db      → healthy (pg_isready -d erp)
migrate → applies db/*.sql, exits 0
api     → healthy (/health, which checks Postgres)
seed    → drives the real API, asserts drift = 0, exits 0
console → serves the UI and proxies /api
```

**If you use `-d`, wait for the one-shot jobs.** `docker compose up -d` returns
as soon as containers are *created*, not when `seed` has finished, so a script
that curls straight afterwards races it:

```bash
docker compose up -d --build
docker compose wait migrate seed     # both must exit 0
```

Do **not** use `--abort-on-container-exit` here: `migrate` and `seed` exit 0 by
design, and that flag tears the whole stack down when they do.

### Ports and configuration

Every port is overridable because fixed host ports collide — `55432` was already
taken on the machine this was built on, and the failure looks like a broken
compose file rather than a busy port.

| Variable | Default | Notes |
|---|---|---|
| `CONSOLE_PORT` | 3200 | the UI |
| `API_PORT` | 3100 | |
| `DB_PORT` | 55432 | host-side only; nothing in the stack needs it |
| `POSTGRES_PASSWORD` | `erp` | local dev default; no credential is hard-coded in source |
| `PG_POOL` | 20 | lowered to 5 on Render, whose free tier caps connections |
| `RESET` | 0 | `RESET=1 docker compose up migrate` rebuilds the schema, destroying data |

### Demo roles

| Token | Role | Can |
|---|---|---|
| `tok-ops` | Warehouse operator | receive stock, transfer stock |
| `tok-buyer` | Buyer | raise POs |
| `tok-pm` | Procurement manager | approve POs |
| `tok-sales` | Sales agent | raise and reserve sales orders |
| `tok-ship` | Fulfilment | ship reserved orders |
| `tok-acct` | Accountant | read and post to the ledger |

### Tests

```bash
cd backend && npm install && npm test
#  test/run.mjs         31 acceptance assertions
#  test/regression.mjs  21 regression assertions (the three Stage 4 bugs)
#  test/deadlock.mjs     6 concurrency assertions
#                       ── 58 total, all against a real Postgres

node ../ops/loadtest.mjs          # section 6 baseline
FIX=1 node ../ops/loadtest.mjs    # section 6 with the rollup
```

The suites apply the same `db/*.sql` set the deployed system does. Testing a
schema the server never runs is how a passing suite starts lying.

---

## 3. How it was deployed

Render, from `render.yaml` in this repo — a Blueprint rather than dashboard
fields, for the same reason compose is in the repo: a deployment nobody can diff
is a deployment nobody can review. Three resources: a managed Postgres, the API,
and the console.

Four things had to change to go from "runs locally" to "runs hosted":

**1. `GET /` returned 404.** There was no unauthenticated route at all, so every
uptime check saw a 404. There are now two probes answering deliberately different
questions. `/` is *reachability* and does not touch Postgres — "did this process
start" should not be answered no because a dependency is slow. `/health` is
*readiness* and does hit the database, because a backend that cannot reach
Postgres must not be routed traffic. Collapsing the two gets a healthy service
restarted, or a dead one kept in rotation.

**2. `01-schema.sql` opens with `DROP SCHEMA IF EXISTS erp CASCADE`.** Correct
for a test harness that wants a known-empty database; catastrophic for a hosted
service, where the container restarts on every deploy, every OOM and every
platform-initiated move. `ops/migrate.mjs` applies the schema **only when it is
absent**. Rebuilding is an explicit, loud act (`RESET=1`), never a side effect of
starting the process. Verified by restarting the stack and confirming the ledger
value was unchanged and `migrate` logged `already present, leaving it alone`.

**3. Managed Postgres requires TLS** with a certificate the container has no CA
for. `ssl` is relaxed only when `PGSSL=require` or the DSN says
`sslmode=require` — never unconditionally, which would silently disable
verification against a database that could have offered a verifiable chain.

**4. There is no orchestrator on Render.** Compose expresses ordering with
`depends_on`; a single Render service has none, so `ops/boot.mjs` sequences
migrate → listen → seed. Seeding runs *after* `listen`, because the platform
health-checks the port and kills a container that binds too slowly — demo data is
not worth failing a deploy over, so a seed failure is logged and the service
stays up. Compose overrides this back to `node src/server.js`, so the sequence
lives in exactly one place per environment.

**Free-tier consequence, stated plainly:** free Render services sleep after
inactivity and cold-start in roughly 30–60 seconds, and the free Postgres expires
after 30 days. The first request to a sleeping console will be slow.

---

## 4. Concurrency safety — what actually stops overselling

One mechanism, in `db.js`:

```js
export async function lockPosition(c, skuId, whId) {
  const r = await c.query('SELECT 1 FROM stock_positions WHERE sku_id=$1 AND warehouse_id=$2 FOR UPDATE', [skuId, whId]);
  if (r.rowCount === 0) throw httpError(404, 'NO_SUCH_STOCK_POSITION');
  const a = await c.query('SELECT available FROM available_stock WHERE sku_id=$1 AND warehouse_id=$2', [skuId, whId]);
  return Number(a.rows[0].available);
}
```

`stock_positions` holds no quantity. Its only job is to be one row per
(SKU, warehouse) that transactions can serialise on, which is why reserving,
fulfilling and transferring all take the same lock and therefore contend with
each other rather than only with themselves.

**The ordering is the whole mechanism, and it is the part that was wrong.** An
earlier version read `available_stock` first and *then* took `FOR UPDATE`. The
lock was present and the writes were serialised — into agreeing on the same stale
number. Every concurrent transaction read availability before holding the lock,
queued, and then wrote on a value another transaction had already invalidated.
It looks correct in review and passes any single-threaded test. Twelve concurrent
reservations against three units gave **10 successes and `available = -7.0000`**.
With the lock taken first, the same test gives **3 successes and
`available = 0.0000`**.

`SERIALIZABLE` would also prevent it, by aborting transactions rather than
ordering them — a retry storm on a hot SKU under contention — and would leave the
actual defect, a decision made on data read outside the section protecting it,
sitting in the code for whoever next lowers the isolation level.

**Deadlock.** `transfers.js` touches two positions, so simultaneous A→B and B→A
could each hold what the other needs. Both anchors are locked in ascending
`warehouse_id`, so no cycle can form. Deterministic ordering makes the deadlock
impossible rather than unlikely.

---

## 5. Ledger consistency

**Every stock movement that has financial meaning posts a balanced journal in the
same transaction that writes the movement.** Not afterwards, not in a queue. A
receipt debits inventory and credits GRNI; a fulfilment moves value to COGS; a
price difference goes to PPV. Because both writes are in one transaction, there
is no window in which stock exists that the ledger has not accounted for.

Three things keep it true rather than merely intended:

1. **A deferred constraint trigger** recomputes debits and credits per journal at
   commit. Legs can be inserted in any order; an unbalanced journal cannot
   commit, whatever the calling code does.
2. **Append-only triggers** refuse `UPDATE` and `DELETE` on `journals`,
   `ledger_entries` and `stock_movements`. A correction is a new journal with
   debit and credit swapped, linked by `reverses`, so the trail shows both the
   error and the fix.
3. **`GET /ledger/reconciliation` proves it from the outside**, comparing
   `SUM(qty_delta * unit_cost)` across all movements against the inventory
   account balance, with **exact equality — a tolerance would hide the first
   bug**. It returns `drift` and, since section 6, `stock_balance_drift_rows`.
   Both are `0` on a seeded system:

```json
{"movements_value":"3250.00000000","ledger_value":"3250.0000","drift":"0.00000000",
 "total_debits":"3750.0000","total_credits":"3750.0000","stock_balance_drift_rows":"0"}
```

`ops/seed.mjs` creates demo data **through the HTTP API rather than by inserting
rows**, for this reason specifically: inserting movements directly would produce
inventory the ledger has never heard of, so every fresh deploy would open onto a
system reporting non-zero drift. A seed that uses the endpoints cannot
desynchronise them, and its last assertion is that drift is still zero.

---

## 6. At 100x

**What breaks first: reserve throughput on a hot SKU — and it degrades with the
SKU's age, not with traffic.**

`lockPosition()` takes `FOR UPDATE` and *then* recomputes availability from that
position's entire movement history, while still holding the lock. Cost is linear
in history depth and is paid inside the critical section, so every concurrent
reservation for that SKU queues behind an increasingly expensive read. A SKU that
has traded for two years is slow even at 3am.

I assumed the problem was that `available_stock` aggregates the whole
`stock_movements` table on every read. **`EXPLAIN` said otherwise** — Postgres
pushes the `(sku_id, warehouse_id)` predicate into the aggregate subquery, so a
busy warehouse does not slow an unrelated SKU. The real exposure is narrower and
worse than the guess.

`ops/loadtest.mjs` varies exactly one thing — history depth for one position —
holding concurrency (40), seeding and code constant. Measured, on Postgres 16.15:

| history depth | availability p50 | p95 | reserve/s |
|---|---|---|---|
| 100 | 0.422 ms | 1.130 ms | 239.5 |
| 1,000 | 0.471 ms | 1.028 ms | 468.5 |
| 10,000 | 1.345 ms | 1.546 ms | 319.2 |
| 50,000 | 5.077 ms | 6.672 ms | 130.4 |
| 200,000 | **15.202 ms** | 17.389 ms | **55.5** |

At 200k the planner abandons the index for a `Parallel Seq Scan`. Availability
reads slow **36x** and throughput falls **4.3x**. (The 100→1,000 row is warm-up,
not a real improvement — worth saying, because reading it as a win would be
reading noise as signal.)

### The fix, shipped

`db/02-scale-fix.sql` adds `stock_position_balance`, a per-position rollup
maintained by an `AFTER INSERT` trigger, and points `available_stock` at it.
Re-running the identical script with `FIX=1`:

| history depth | availability p50 | reserve/s |
|---|---|---|
| 100 | 0.368 ms | 223.8 |
| 10,000 | 0.338 ms | 497.9 |
| 50,000 | 0.407 ms | 471.5 |
| 200,000 | **0.381 ms** | **294.5** |

**Flat.** 40x faster at 200k depth, 5.3x the throughput, and the curve no longer
has a slope — depth stops being a variable rather than merely mattering less.

**This is not a mutable balance, which the whole system exists to avoid.**
`stock_movements` remains the sole source of truth and remains append-only; the
rollup is a cache of an aggregate the database can recompute at any moment. The
difference from a hand-maintained balance is that the invariant is *checkable*:
`balance_drift` compares the cache against `SUM(qty_delta)`, and
`/ledger/reconciliation` reports its row count alongside ledger drift, so nothing
relies on someone remembering to run a view. After 200,000 trigger firings under
concurrent load: `balance_drift` **0 rows**, `cached = recomputed = 396.0000`.
There is no `UPDATE`/`DELETE` branch in the trigger because the immutability
triggers already make those impossible.

**What it costs, honestly.** The rollup `UPDATE` takes a row lock, so concurrent
movements for the same position now serialise on it as well as on the anchor row.
For reservations that is free — they already hold the anchor lock — but two
unrelated receipts into the same position that previously proceeded in parallel
now queue. At the volumes measured this is invisible; it is a real trade of write
parallelism for read cost, not a free win.

**What breaks second**, unmeasured and therefore stated as reasoning rather than
result: the single anchor row per (SKU, warehouse) caps a hot position at one
reservation at a time. Beyond that the fix is not another index but splitting the
position into N lock stripes and summing them, which trades exact availability
for throughput — a product decision, not a technical one.

---

## 7. Known limitations and scope cuts

Two items that were on this list are gone, because writing them down was cheaper
than fixing them and that is the wrong trade. **Deadlock freedom was an
argument**; `test/deadlock.mjs` now runs the two-way race with request-order
locking, asserts Postgres reports `40P01`, then shows canonical order completing
both. And **`lockPosition` conflated acquiring the lock with measuring
availability**, forcing `transfers.js` to choose between two returned numbers —
now `lockPositions()` and `readAvailable()`. That fixed something worse than the
awkwardness: the lock *ordering* had been implemented three times (a JS sort in
`reserve`, a SQL `ORDER BY` in `fulfil`, a ternary in `transfer`), so a fourth
caller had to know the rule existed. There is one implementation now.

What remains:

- **`ref_type`/`ref_id` is a loose polymorphic link** with no foreign key. A
  typo'd `ref_type` is not caught, and the database cannot enforce that both legs
  of a transfer exist. Fixing it means a table per reference kind or an enum plus
  per-kind FKs — a migration with a backfill, not a patch.
- **Only journals are idempotent** (`UNIQUE (source_type, source_id)`).
  Deliberately not bolted onto the newest endpoint alone: retry safety covering
  one write and not its neighbours is worse than none, because it reads as
  covered.
- **The rollup trades write parallelism for read cost** — two receipts into one
  position now serialise on the balance row. Invisible at the volumes measured,
  real in principle, and stated in section 6 rather than sold as a free win.
- **Deliberate scope cuts:** static seeded tokens rather than sessions (no
  expiry, rotation or revocation); single currency; standard costing; no period
  close; no partial-shipment invoicing.
- **The free tier sleeps** — 30–60s cold start, free Postgres expires after 30
  days. A hosting consequence, not a design one.
