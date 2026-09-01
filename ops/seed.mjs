/**
 * Demo data is created by driving the real HTTP API, not by INSERTing rows.
 *
 * That is not fastidiousness. Stock is `SUM(qty_delta)` over stock_movements and
 * the ledger is posted alongside each movement, so INSERTing movements directly
 * produces inventory the ledger has never heard of: `/ledger/reconciliation`
 * reports non-zero drift and the console opens onto a system that looks broken.
 * A seed that goes through the endpoints cannot desynchronise them, because it
 * uses the same transactions the application does.
 *
 * It is therefore also a smoke test: every step asserts its status, and the last
 * assertion is that drift is still exactly zero.
 */
const BASE = process.env.API_BASE ?? 'http://127.0.0.1:3100';
const T = { ops: 'tok-ops', buyer: 'tok-buyer', pm: 'tok-pm', sales: 'tok-sales', ship: 'tok-ship', acct: 'tok-acct' };

let step = 0;
async function call(method, path, token, body, expect = 200) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  step += 1;
  const ok = res.status === expect;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${String(step).padStart(2)} ${method} ${path} -> ${res.status}`);
  if (!ok) {
    console.error(`     expected ${expect}, body: ${JSON.stringify(payload)}`);
    process.exit(1);
  }
  return payload;
}

async function waitForApi(attempts = 30) {
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    process.stdout.write(`  waiting for api (${i}/${attempts})\n`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`api at ${BASE} never became healthy`);
}

await waitForApi();

// Idempotent: re-running must not pile up duplicate demo orders on every deploy.
const existing = await call('GET', '/stock', T.ops);
if (existing.some((r) => Number(r.on_hand) > 0)) {
  console.log('seed: stock already present, nothing to do');
  process.exit(0);
}

console.log('seed: procurement');
const po = await call('POST', '/purchase-orders', T.buyer, {
  supplier_id: 1,
  lines: [
    { sku_id: 1, warehouse_id: 1, qty_ordered: 200, unit_price: 9.50 },
    { sku_id: 2, warehouse_id: 1, qty_ordered: 60, unit_price: 24.00 },
  ],
});
await call('POST', `/purchase-orders/${po.po_id}/approve`, T.pm);
const lines = await call('GET', `/purchase-orders/${po.po_id}`, T.buyer);

// Two partial receipts on the same line, on purpose: this is the exact path that
// carried the Stage 4 fan-out bug, so the demo data exercises it every deploy.
await call('POST', `/purchase-orders/${po.po_id}/receipts`, T.ops,
  { lines: [{ po_line_id: lines[0].po_line_id, qty_received: 120 }] });
await call('POST', `/purchase-orders/${po.po_id}/receipts`, T.ops,
  { lines: [{ po_line_id: lines[0].po_line_id, qty_received: 80 },
            { po_line_id: lines[1].po_line_id, qty_received: 60 }] });

console.log('seed: sales');
const so = await call('POST', '/sales-orders', T.sales, {
  customer: 'Blue Ridge Hardware',
  lines: [{ sku_id: 1, warehouse_id: 1, qty: 25, unit_price: 18.00 }],
});
await call('POST', `/sales-orders/${so.so_id}/reserve`, T.sales);
await call('POST', `/sales-orders/${so.so_id}/fulfil`, T.ship);

// A second order left reserved but unfulfilled, so the console shows the
// difference between on_hand and available rather than two identical columns.
const so2 = await call('POST', '/sales-orders', T.sales, {
  customer: 'Cedar Point Supply',
  lines: [{ sku_id: 2, warehouse_id: 1, qty: 10, unit_price: 39.00 }],
});
await call('POST', `/sales-orders/${so2.so_id}/reserve`, T.sales);

console.log('seed: verifying the ledger still agrees with the movements');
const recon = await call('GET', '/ledger/reconciliation', T.acct);
console.log(`  reconciliation: ${JSON.stringify(recon)}`);
if (Number(recon.drift) !== 0) {
  console.error(`seed FAILED: drift is ${recon.drift}, expected 0`);
  process.exit(1);
}
console.log('seed: done, drift 0.00000000');
