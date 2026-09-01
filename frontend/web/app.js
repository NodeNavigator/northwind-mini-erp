import { session, setToken, NAV, api, ApiError } from './api.js';
import { VIEWS, esc } from './views.js';

const nav = document.getElementById('nav');
const view = document.getElementById('view');
const roleSel = document.getElementById('role');
const recon = document.getElementById('recon');

let current = null;
let timer = null;

/** One render path for every view: loading/empty/error handled once, not
 *  re-implemented and forgotten per screen. */
export async function render(name, { silent = false } = {}) {
  current = name;
  paintNav();
  const v = VIEWS[name];
  if (!v) { view.innerHTML = '<p class="muted">Pick a view.</p>'; return; }
  if (!silent) view.innerHTML = '<p class="muted" data-state="loading">loading…</p>';
  try {
    const data = await v.load();
    const empty = v.isEmpty?.(data);
    view.innerHTML = empty
      ? `<h2>${v.title}</h2><p class="muted" data-state="empty">${v.emptyText}</p>`
      : `<h2>${v.title}</h2>${v.render(data)}`;
    v.bind?.(view, data);
  } catch (e) {
    // Shown, never swallowed: a 403 is information, not a blank screen.
    view.innerHTML = `<h2>${v.title}</h2><p class="err" data-state="error" role="alert">`
      + `${e instanceof ApiError ? `${e.status} ${esc(e.code)}` : 'UNEXPECTED'}`
      + `${e.detail ? ` — ${esc(typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail))}` : ''}</p>`;
  }
}

function paintNav() {
  const allowed = NAV[session.token] ?? [];
  nav.innerHTML = allowed.map((n) =>
    `<button data-nav="${n}" aria-current="${n === current}">${VIEWS[n].title}</button>`).join('');
}

async function paintRecon() {
  // Only the accountant may read the ledger; for others the indicator is absent.
  if (!(NAV[session.token] ?? []).includes('finance')) { recon.textContent = ''; return; }
  try {
    const r = await api('GET', '/ledger/reconciliation');
    const ok = Number(r.drift) === 0;
    recon.innerHTML = `ledger matches movements: <span class="pill ${ok ? 'yes' : 'no'}" `
      + `data-recon="${ok ? 'yes' : 'no'}">${ok ? 'yes' : 'no'}</span> `
      + `<span class="muted">drift ${Number(r.drift).toFixed(2)}</span>`;
  } catch {
    recon.innerHTML = '<span class="muted" data-recon="unknown">reconciliation unavailable</span>';
  }
}

nav.addEventListener('click', (e) => {
  const n = e.target.closest('[data-nav]');
  if (n) render(n.dataset.nav);
});

roleSel.addEventListener('change', () => {
  setToken(roleSel.value);
  const allowed = NAV[session.token] ?? [];
  render(allowed.includes(current) ? current : allowed[0]);
  paintRecon();
});

/** Fresh load always reads the backend: nothing cached, no optimistic writes.
 *  Polling keeps availability live across sessions. */
function startPolling() {
  clearInterval(timer);
  timer = setInterval(() => {
    if (!document.hidden && VIEWS[current]?.live) render(current, { silent: true });
    paintRecon();
  }, 2000);
}

roleSel.value = session.token;
render((NAV[session.token] ?? ['warehouse'])[0]);
paintRecon();
startPolling();
window.render = render;   // used by the browser test to force a deterministic refresh
