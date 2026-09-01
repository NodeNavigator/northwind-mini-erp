import http from 'node:http';
import { authenticate, authorize } from './auth.js';
import { pool, tx, httpError } from './db.js';
import { RECONCILE_SQL, reverseJournal, postJournal } from './ledger.js';
import * as inv from './inventory.js';
import * as proc from './procurement.js';
import * as sales from './sales.js';
import { transfer } from './transfers.js';

// Composition root: every route names the capability it needs, so authorisation
// is a property of the table, not something each handler must remember.
const ROUTES = [
  ['GET',  /^\/stock$/,                      'stock:read',    (u, m, q) => inv.getStock(q)],
  ['GET',  /^\/movements$/,                  'stock:read',    (u, m, q) => inv.listMovements(q)],
  ['POST', /^\/purchase-orders$/,            'po:create',     (u, m, q, b) => proc.createPO(u, b)],
  ['POST', /^\/purchase-orders\/(\d+)\/approve$/, 'po:approve', (u, m) => proc.approvePO(u, +m[1])],
  ['GET',  /^\/purchase-orders$/,             'stock:read',    () => proc.listPOs()],
  ['GET',  /^\/purchase-orders\/(\d+)$/,     'stock:read',    (u, m) => proc.poStatus(+m[1])],
  ['POST', /^\/purchase-orders\/(\d+)\/receipts$/, 'receipt:create', (u, m, q, b) => proc.receive(u, +m[1], b)],
  ['POST', /^\/stock\/transfers$/,           'stock:transfer', (u, m, q, b) => transfer(u, b)],
  ['POST', /^\/sales-orders$/,               'so:create',     (u, m, q, b) => sales.createSO(u, b)],
  ['POST', /^\/sales-orders\/(\d+)\/reserve$/, 'so:reserve',  (u, m) => sales.reserve(u, +m[1])],
  ['POST', /^\/sales-orders\/(\d+)\/fulfil$/, 'so:fulfil',    (u, m) => sales.fulfil(u, +m[1])],
  ['GET',  /^\/sales-orders\/(\d+)$/,        'stock:read',    (u, m) => sales.soStatus(+m[1])],
  ['POST', /^\/ledger\/journals$/,           'ledger:post',
      (u, m, q, b) => tx(async (c) => ({ journal_id: await postJournal(c, 'MANUAL', b.ref, b.legs) }))],
  ['POST', /^\/ledger\/journals\/(\d+)\/reverse$/, 'ledger:post',
      (u, m, q, b) => tx(async (c) => ({ journal_id: await reverseJournal(c, +m[1], b.reason) }))],
  ['GET',  /^\/ledger\/reconciliation$/,     'ledger:read',   async () =>
      (await pool.query(RECONCILE_SQL)).rows[0]],
  ['GET',  /^\/ledger\/entries$/,            'ledger:read',   async () =>
      (await pool.query(`SELECT e.entry_id, e.journal_id, j.source_type, j.source_id,
                                e.account, e.debit, e.credit, j.reverses
                           FROM ledger_entries e JOIN journals j USING (journal_id)
                          ORDER BY e.entry_id`)).rows],
];

// The bug was a copy-paste: a ledger route kept the stock capability, which every
// role holds. A capability table cannot catch that, so the invariant is asserted
// where it is cheap - at module load, before the server can accept a request.
for (const [, re, capability] of ROUTES) {
  if (re.source.includes('ledger') && !capability.startsWith('ledger:')) {
    throw new Error(`route ${re} guards a ledger endpoint with '${capability}'`);
  }
}

async function body(req) {
  if (req.method === 'GET') return {};
  const chunks = [];
  let size = 0;
  for await (const ch of req) {
    size += ch.length;
    if (size > 1_000_000) throw httpError(413, 'BODY_TOO_LARGE');
    chunks.push(ch);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'INVALID_JSON');
  }
}

export const server = http.createServer(async (req, res) => {
  const send = (status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
  try {
    const url = new URL(req.url, 'http://x');

    // Two unauthenticated probes, deliberately answering different questions.
    // `/` is reachability and must not depend on Postgres: a load balancer or an
    // uptime check asking "did this process start" should not be told "no"
    // because a dependency is slow. `/health` is readiness and DOES hit the
    // database, because a backend that cannot reach Postgres can serve nothing
    // and must not be routed traffic. Collapsing the two is how a degraded
    // service either gets restarted for no reason or kept in rotation when dead.
    if (url.pathname === '/') {
      // The commit is reported because a platform that fails a build keeps
      // serving the previous image: without this, a green URL is not evidence
      // that the deployed code is the code in the repository.
      return send(200, {
        service: 'northwind-mini-erp',
        stage: 5,
        routes: ROUTES.length,
        commit: (process.env.RENDER_GIT_COMMIT ?? 'local').slice(0, 7),
      });
    }
    if (url.pathname === '/health') {
      try {
        const r = await pool.query('SELECT count(*)::int AS n FROM users');
        return send(200, { status: 'ok', db: 'up', users: r.rows[0].n });
      } catch (e) {
        return send(503, { status: 'degraded', db: 'down', detail: e.message });
      }
    }

    const route = ROUTES.find(([m, re]) => m === req.method && re.test(url.pathname));
    if (!route) return send(404, { error: 'NOT_FOUND' });
    const [, re, capability, handler] = route;

    // Authenticate then authorise before the handler runs: a handler is never
    // reachable by a role lacking the capability, whatever the UI shows.
    const user = await authenticate(req);
    authorize(user, capability);

    const out = await handler(user, re.exec(url.pathname),
      Object.fromEntries(url.searchParams), await body(req));
    send(200, out);
  } catch (err) {
    if (err.status) return send(err.status, { error: err.code, detail: err.detail });
    console.error('[unhandled]', err);
    send(500, { error: 'INTERNAL' });
  }
});

if (process.argv[1]?.endsWith('server.js')) {
  server.listen(Number(process.env.PORT ?? 3100), () =>
    console.log(`erp listening on ${process.env.PORT ?? 3100}`));
}
