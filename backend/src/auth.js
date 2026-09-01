import { pool, httpError } from './db.js';

// Capability per role, checked by the API; the UI is irrelevant to security.
const CAN = {
  WAREHOUSE_OPERATOR:  ['stock:read', 'receipt:create', 'stock:transfer'],
  BUYER:               ['stock:read', 'po:create', 'receipt:create'],
  PROCUREMENT_MANAGER: ['stock:read', 'po:approve'],
  SALES_AGENT:         ['stock:read', 'so:create', 'so:reserve'],
  FULFILMENT:          ['stock:read', 'so:fulfil'],
  ACCOUNTANT:          ['stock:read', 'ledger:read', 'ledger:post'],
};

/** Identity comes from a bearer token looked up server-side, never from a
 *  client-supplied user id header, which the client controls. */
export async function authenticate(req) {
  const h = req.headers.authorization ?? '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : null;
  if (!token) throw httpError(401, 'MISSING_TOKEN');
  const r = await pool.query(
    'SELECT user_id, email, role FROM users WHERE token=$1', [token]);
  if (r.rowCount === 0) throw httpError(401, 'INVALID_TOKEN');
  return r.rows[0];
}

export function authorize(user, capability) {
  const allowed = CAN[user.role] ?? [];
  if (!allowed.includes(capability)) {
    throw httpError(403, 'FORBIDDEN',
      `role ${user.role} lacks ${capability}`);
  }
}
