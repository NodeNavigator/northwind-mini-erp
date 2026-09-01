/**
 * Container entrypoint for hosts with no orchestrator (Render, Fly, Railway).
 *
 * docker-compose.yml expresses this ordering with `depends_on` conditions, which
 * is clearer locally because each step is a separate container with its own exit
 * code. A single Render service has no such thing, so the sequence lives here
 * instead of being duplicated as a shell one-liner in a dashboard field nobody
 * can review:
 *
 *   migrate (idempotent, refuses to rebuild an existing schema)
 *   -> listen
 *   -> seed once, in the background, only if the database is empty
 *
 * Seeding runs AFTER listen, not before, because a hosted platform health-checks
 * the port and will kill a container that takes too long to bind. Demo data is
 * not worth failing a deploy over, so a seed failure is logged and the service
 * stays up.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3100);

const run = (script, env = {}) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, [join(here, script)], {
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`))));
});

await run('migrate.mjs');

const { server } = await import('../backend/src/server.js');
await new Promise((r) => server.listen(PORT, r));
console.log(`erp listening on ${PORT}`);

// Fire and forget. `seed.mjs` is idempotent and exits 0 immediately when stock
// already exists, so this is a no-op on every deploy after the first.
run('seed.mjs', { API_BASE: `http://127.0.0.1:${PORT}` })
  .catch((e) => console.error(`[seed] skipped: ${e.message}`));
