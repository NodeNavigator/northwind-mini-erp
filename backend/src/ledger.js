import { httpError } from './db.js';

export const ACC = { INVENTORY: '1300_INVENTORY', GRNI: '2100_GRNI', PPV: '5150_PPV', COGS: '5000_COGS' };

/** One balanced journal inside the caller's transaction, so the financial record
 *  and the operational event commit together or not at all. Zero-value legs are
 *  dropped: a nil variance should not create a row. */
export async function postJournal(c, sourceType, sourceId, legs, reverses = null) {
  const kept = legs.filter((l) => Number(l.debit ?? 0) !== 0 || Number(l.credit ?? 0) !== 0);
  const dr = kept.reduce((s, l) => s + Number(l.debit ?? 0), 0);
  const cr = kept.reduce((s, l) => s + Number(l.credit ?? 0), 0);
  if (Math.abs(dr - cr) > 1e-9) throw httpError(500, 'UNBALANCED_JOURNAL', `debit=${dr} credit=${cr}`);
  let j;
  try {
    j = await c.query('INSERT INTO journals (source_type,source_id,reverses) VALUES ($1,$2,$3) RETURNING journal_id',
      [sourceType, sourceId, reverses]);
  } catch (e) {
    // UNIQUE(source_type,source_id): a retried event must not post twice.
    if (e.code === '23505') throw httpError(409, 'ALREADY_POSTED', `${sourceType}:${sourceId}`);
    throw e;
  }
  const id = j.rows[0].journal_id;
  for (const l of kept) {
    await c.query('INSERT INTO ledger_entries (journal_id,account,debit,credit) VALUES ($1,$2,$3,$4)',
      [id, l.account, l.debit ?? 0, l.credit ?? 0]);
  }
  return id;
}

/** A posted journal is never edited. A correction is a NEW journal with debit and
 *  credit swapped, linked by `reverses`, so the trail shows error and fix. */
export async function reverseJournal(c, journalId, reason) {
  const orig = await c.query('SELECT account,debit,credit FROM ledger_entries WHERE journal_id=$1', [journalId]);
  if (orig.rowCount === 0) throw httpError(404, 'NO_SUCH_JOURNAL');
  const legs = orig.rows.map((e) => ({ account: e.account, debit: e.credit, credit: e.debit }));
  return postJournal(c, 'REVERSAL', journalId, legs, journalId);
}

/** R3. Movements vs ledger. Exact equality; a tolerance hides the first bug. */
export const RECONCILE_SQL = `
WITH m AS (SELECT COALESCE(SUM(qty_delta*unit_cost),0) v FROM stock_movements),
     l AS (SELECT COALESCE(SUM(debit-credit),0) v FROM ledger_entries WHERE account='${ACC.INVENTORY}')
SELECT m.v AS movements_value, l.v AS ledger_value, m.v - l.v AS drift,
       (SELECT COALESCE(SUM(debit),0) FROM ledger_entries) AS total_debits,
       (SELECT COALESCE(SUM(credit),0) FROM ledger_entries) AS total_credits,
       -- The Stage 5 rollup (db/02-scale-fix.sql) is a cache of SUM(qty_delta),
       -- and a cache nobody checks is just a second source of truth. Reported
       -- here rather than left as a view somebody might run: any non-zero value
       -- means the trigger and the log have diverged and stock figures are lying.
       (SELECT count(*) FROM balance_drift) AS stock_balance_drift_rows
FROM m, l`;
