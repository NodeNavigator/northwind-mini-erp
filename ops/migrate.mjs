/**
 * db/01-schema.sql opens with `DROP SCHEMA IF EXISTS erp CASCADE` — right for a
 * test harness wanting a known-empty database, catastrophic for a hosted service
 * that restarts on every deploy, every OOM and every platform-initiated move.
 * So the schema is applied only when absent; rebuilding is an explicit, loud act
 * (RESET=1), never a side effect of starting the process.
 */
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
// No credential fixed in source: DATABASE_URL wins, otherwise the parts come
// from the same env vars docker-compose.yml uses.
const dsn = process.env.DATABASE_URL
  ?? `postgres://postgres:${process.env.POSTGRES_PASSWORD ?? 'erp'}`
   + `@localhost:${process.env.DB_PORT ?? 55432}/erp`;
const needsSsl = process.env.PGSSL === 'require' || /sslmode=require/.test(dsn);
const reset = process.env.RESET === '1';

const client = new pg.Client({
  connectionString: dsn,
  ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
});

// The database may still be accepting connections a second or two after the
// container reports ready, so a single failed connect is not a failed migration.
async function connectWithRetry(attempts = 30) {
  for (let i = 1; i <= attempts; i += 1) {
    try { await client.connect(); return; }
    catch (e) {
      if (i === attempts) throw e;
      process.stdout.write(`  waiting for postgres (${i}/${attempts}): ${e.code ?? e.message}\n`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

await connectWithRetry();

const { rows } = await client.query(
  `SELECT to_regclass('erp.users') IS NOT NULL AS present`);

if (rows[0].present && !reset) {
  console.log('migrate: erp schema already present, leaving it alone (RESET=1 to rebuild)');
} else {
  if (rows[0].present) console.log('migrate: RESET=1 — dropping and rebuilding erp schema');
  // Every db/*.sql in filename order, so adding a migration is adding a file
  // rather than editing this script and hoping the two stay in step.
  const dir = join(here, '..', 'db');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    await client.query(await readFile(join(dir, f), 'utf8'));
    console.log(`migrate: applied ${f}`);
  }
}

await client.end();
