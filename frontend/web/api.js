/** Every call goes through here so auth, error shape and the "never swallow"
 *  rule are enforced in one place rather than per view. */
export const session = { token: localStorage.getItem('tok') ?? 'tok-sales' };

export function setToken(t) {
  session.token = t;
  localStorage.setItem('tok', t);
}

export class ApiError extends Error {
  constructor(status, code, detail) {
    super(code);
    Object.assign(this, { status, code, detail });
  }
}

export async function api(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload;
  try { payload = await res.json(); } catch { payload = { error: 'BAD_RESPONSE' }; }
  if (!res.ok) throw new ApiError(res.status, payload.error ?? 'ERROR', payload.detail);
  return payload;
}

/** The server is the authority on what a role may do; this map only decides what
 *  is worth showing. Hiding a view is a courtesy, never the security boundary -
 *  test/ui.test.mjs proves a hidden route is still refused 403 by the API. */
export const NAV = {
  'tok-ops':   ['warehouse', 'procurement'],
  'tok-buyer': ['warehouse', 'procurement'],
  'tok-pm':    ['warehouse', 'procurement'],
  'tok-sales': ['warehouse', 'sales'],
  'tok-ship':  ['warehouse', 'sales'],
  'tok-acct':  ['warehouse', 'finance'],
};
