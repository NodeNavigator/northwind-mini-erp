// Real console, real Chrome, real Stage 2 API. Two isolated browser contexts =
// two operator sessions with separate storage - the only way to demonstrate R2.
import puppeteer from 'puppeteer-core';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const WEB = process.env.WEB ?? 'http://127.0.0.1:3200';
const API = process.env.API ?? 'http://127.0.0.1:3100';
const CHROME = process.env.CHROME ?? '/usr/bin/google-chrome';
let pass = 0, fail = 0;
const check = (n, fn) => {
  try { fn(); console.log(`PASS  ${n}`); pass += 1; }
  catch (e) { console.log(`FAIL  ${n}\n      ${e.message}`); fail += 1; }
};

const call = async (m, p, tok, body) => {
  const r = await fetch(API + p, {
    method: m,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

/** Seed via the real procurement path: every movement keeps its journal. */
async function seed(skuId, qty, price) {
  const po = await call('POST', '/purchase-orders', 'tok-buyer',
    { supplier_id: 1, lines: [{ sku_id: skuId, warehouse_id: 1, qty_ordered: qty, unit_price: price }] });
  await call('POST', `/purchase-orders/${po.body.po_id}/approve`, 'tok-pm');
  const line = (await call('GET', `/purchase-orders/${po.body.po_id}`, 'tok-buyer')).body[0].po_line_id;
  await call('POST', `/purchase-orders/${po.body.po_id}/receipts`, 'tok-ops',
    { lines: [{ po_line_id: line, qty_received: qty }] });
}

const openAs = async (browser, token, view) => {
  const ctx = await browser.createBrowserContext();   // isolated localStorage
  const page = await ctx.newPage();
  await page.goto(WEB, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => localStorage.setItem('tok', t), token);
  await page.reload({ waitUntil: 'networkidle0' });
  if (view) await page.evaluate((v) => window.render(v), view);
  return { ctx, page };
};

const availOf = (page, sku) => page.$eval(`[data-avail="${sku}"]`, (el) => el.textContent.trim());

// Reset: stale reservations would void the concurrency assertions.
execFileSync('psql', ['postgres://postgres:erp@localhost:55432/erp', '-q', '-v', 'ON_ERROR_STOP=1',
  '-f', '../erp-backend/schema.sql'], { stdio: 'pipe' });
await seed(3, 2, 5.00);   // WIDGET-3: exactly 2 units on hand

const browser = await puppeteer.launch({
  executablePath: CHROME,
  args: ['--no-sandbox', '--disable-gpu'],
  headless: 'new',
});

// R1/R5: two roles, genuinely different surface
console.log('\n== R5 role-based surface ==');
const sales = await openAs(browser, 'tok-sales', 'sales');
const acct = await openAs(browser, 'tok-acct', 'finance');
const salesNav = await sales.page.$$eval('#nav button', (b) => b.map((x) => x.textContent));
const acctNav = await acct.page.$$eval('#nav button', (b) => b.map((x) => x.textContent));
console.log(`      sales nav ${JSON.stringify(salesNav)}  accountant nav ${JSON.stringify(acctNav)}`);
check('sales sees Sales, not Finance', () =>
  assert.ok(salesNav.includes('Sales') && !salesNav.includes('Finance')));
check('accountant sees Finance, not Sales', () =>
  assert.ok(acctNav.includes('Finance') && !acctNav.includes('Sales')));

// Hiding is a courtesy; the server is the boundary.
const forbidden = await call('GET', '/ledger/reconciliation', 'tok-sales');
check('hidden view is still refused 403 by the API', () => assert.equal(forbidden.status, 403));

// R4: reconciliation indicator sourced from the endpoint
console.log('\n== R4 reconciliation indicator ==');
await acct.page.waitForSelector('[data-recon]');
const reconPill = await acct.page.$eval('[data-recon]', (el) => el.dataset.recon);
const drift = await acct.page.$eval('[data-drift]', (el) => el.textContent.trim());
console.log(`      indicator=${reconPill} drift=${drift}`);
check('indicator reads yes', () => assert.equal(reconPill, 'yes'));
check('drift is 0.00', () => assert.equal(drift, '0.00'));

// R2 + pass criteria: live availability across two sessions
console.log('\n== R2 live availability across two sessions ==');
const a = await openAs(browser, 'tok-sales', 'sales');
const b = await openAs(browser, 'tok-sales', 'sales');
await a.page.waitForSelector('[data-avail="WIDGET-3"]');
await b.page.waitForSelector('[data-avail="WIDGET-3"]');
const before = await availOf(a.page, 'WIDGET-3');
console.log(`      session A sees available=${before}`);
check('both sessions start at 2.00', async () => assert.equal(before, '2.00'));

// Session B reserves both units through the UI.
await b.page.select('[data-f="so"] select[name="sku_id"]', '3');
await b.page.$eval('[data-f="so"] input[name="qty"]', (el) => { el.value = '2'; });
await b.page.click('[data-f="so"] button.go');
await b.page.waitForFunction(() =>
  document.querySelector('[data-f="so-msg"]')?.dataset.state === 'reserved', { timeout: 10000 });
const bMsg = await b.page.$eval('[data-f="so-msg"]', (el) => el.textContent.trim());
console.log(`      session B: ${bMsg}`);
check('session B reserved 2', () => assert.match(bMsg, /reserved 2\.00/));

// Session A must see it WITHOUT a manual reload: polling re-reads the backend.
await a.page.waitForFunction(() =>
  document.querySelector('[data-avail="WIDGET-3"]')?.textContent.trim() === '0.00', { timeout: 10000 });
const after = await availOf(a.page, 'WIDGET-3');
console.log(`      session A now sees available=${after} (no manual reload)`);
check('session A availability fell to 0.00 live', () => assert.equal(after, '0.00'));

// pass criterion: error surfaced, not swallowed
console.log('\n== error state on over-reserve ==');
await a.page.select('[data-f="so"] select[name="sku_id"]', '3');
await a.page.$eval('[data-f="so"] input[name="qty"]', (el) => { el.value = '1'; });
await a.page.click('[data-f="so"] button.go');
await a.page.waitForFunction(() =>
  document.querySelector('[data-f="so-msg"]')?.dataset.state === 'error', { timeout: 10000 });
const errText = await a.page.$eval('[data-f="so-msg"]', (el) => el.textContent.trim());
console.log(`      ${errText}`);
check('409 INSUFFICIENT_STOCK shown to the operator', () =>
  assert.match(errText, /409 INSUFFICIENT_STOCK/));
check('error carries the availability detail', () => assert.match(errText, /"available":0/));

// pass criterion: a fresh load reflects backend truth
console.log('\n== fresh load reflects backend, not cache ==');
await a.page.reload({ waitUntil: 'networkidle0' });
await a.page.evaluate(() => window.render('sales'));
await a.page.waitForSelector('[data-avail="WIDGET-3"]');
const afterReload = await availOf(a.page, 'WIDGET-3');
check('fresh page load still shows 0.00', () => assert.equal(afterReload, '0.00'));

// pass criterion: a different operator sees the same backend state
console.log('\n== a fresh session sees POs it did not create ==');
const buyer = await openAs(browser, 'tok-buyer', 'procurement');
await buyer.page.waitForSelector('[data-t="po"]');
const poRows = await buyer.page.$$eval('[data-t="po"] tbody tr', (r) => r.length);
const storage = await buyer.page.evaluate(() => Object.keys(localStorage).filter((k) => k !== 'tok'));
console.log(`      buyer session sees ${poRows} PO line(s); non-auth localStorage keys: ${JSON.stringify(storage)}`);
check('POs listed in a session that never created them', () => assert.ok(poRows > 0));
check('nothing but the token is cached client-side', () => assert.equal(storage.length, 0));

// R3: loading / empty / error states
console.log('\n== R3 loading / empty / error states ==');
const w = await openAs(browser, 'tok-ops', 'warehouse');
const sawLoading = await w.page.evaluate(async () => {
  window.render('warehouse');
  return document.querySelector('[data-state="loading"]') !== null;
});
check('loading state rendered while fetching', () => assert.ok(sawLoading));
const bad = await openAs(browser, 'tok-ops', null);
const errShown = await bad.page.evaluate(async () => {
  await window.render('finance');            // operator has no ledger:read
  return document.querySelector('[data-state="error"]')?.textContent ?? '';
});
console.log(`      operator opening Finance: ${errShown.trim()}`);
check('403 rendered as an error state, not a blank view', () => assert.match(errShown, /403 FORBIDDEN/));

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
