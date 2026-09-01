/**
 * One place for configuration that is read from the environment, because it was
 * previously read in five: db.js, ops/migrate.mjs, ops/loadtest.mjs and two test
 * suites each built the DSN and decided about TLS independently. Five copies of
 * one rule is five chances for them to drift, and the drift would show up as a
 * connection that works locally and fails hosted.
 */

/**
 * A numeric setting must be a number. `Number('abc')` is NaN, and NaN silently
 * becomes a pool with no usable size or a `listen()` on an arbitrary port, which
 * fails far from its cause. Every numeric env var goes through here — validating
 * some and not others reads as an oversight rather than a policy.
 */
export function numEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive number, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/**
 * DATABASE_URL wins. Otherwise the parts come from the same variables
 * docker-compose.yml uses, so local defaults and deployed config are one
 * mechanism rather than two. No credential is fixed in source.
 */
export const dsn = () => process.env.DATABASE_URL
  ?? `postgres://postgres:${process.env.POSTGRES_PASSWORD ?? 'erp'}`
   + `@localhost:${numEnv('DB_PORT', 55432)}/erp`;

/**
 * Managed Postgres (Render, Neon, Supabase) presents a certificate this container
 * has no CA for. Verification is relaxed for those hosts and only those: enabling
 * `ssl` unconditionally would silently stop verifying a database that could have
 * offered a chain worth checking.
 */
export const sslFor = (url) =>
  (process.env.PGSSL === 'require' || /sslmode=require/.test(url)
    ? { ssl: { rejectUnauthorized: false } }
    : {});
