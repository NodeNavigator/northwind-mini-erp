import { api } from './api.js';

export const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (n) => Number(n).toFixed(2);
const rows = (arr, cells) => arr.map((r) => `<tr>${cells(r)}</tr>`).join('');

// Submit results live OUTSIDE the view HTML: the first version set the message
// then re-rendered, erasing it. Anything the operator reads must outlive a render.
const notice = { so: null, po: null };
const noticeHtml = (k) => notice[k]
  ? `<p class="${notice[k].bad ? 'err' : 'ok'}" data-f="${k}-msg"
        data-state="${notice[k].bad ? 'error' : 'reserved'}"
  ${notice[k].bad ? 'role="alert"' : ''}>${esc(notice[k].text)}</p>`
  : `<p class="muted" data-f="${k}-msg"></p>`;

export const VIEWS = {
  warehouse: {
    title: 'Warehouse',
    live: true,
    emptyText: 'No stock positions yet.',
    load: async () => ({
      stock: await api('GET', '/stock'),
      moves: await api('GET', '/movements'),
    }),
    isEmpty: (d) => d.stock.length === 0,
    render: (d) => `
      <table data-t="stock"><thead><tr><th>SKU</th><th>Warehouse</th>
  <th>On hand</th><th>Reserved</th><th>Available</th></tr></thead><tbody>
  ${rows(d.stock, (r) => `<td>${esc(r.sku)}</td><td>${esc(r.warehouse)}</td>
  <td>${num(r.on_hand)}</td><td>${num(r.reserved)}</td>
  <td data-avail="${esc(r.sku)}">${num(r.available)}</td>`)}
      </tbody></table>
      <h3>Movement history</h3>
      ${d.moves.length === 0 ? '<p class="muted" data-state="empty">No movements recorded.</p>' : `
      <table data-t="moves"><thead><tr><th>#</th><th>SKU</th><th>Qty</th>
  <th>Unit cost</th><th>Reason</th><th>Ref</th></tr></thead><tbody>
  ${rows(d.moves.slice(0, 25), (m) => `<td>${m.movement_id}</td><td>${m.sku_id}</td>
  <td>${num(m.qty_delta)}</td><td>${num(m.unit_cost)}</td>
  <td>${esc(m.reason)}</td><td>${esc(m.ref_type ?? '')} ${m.ref_id ?? ''}</td>`)}
      </tbody></table>`}`,
  },

  procurement: {
    title: 'Procurement',
    live: true,
    emptyText: 'No purchase orders yet - create one below.',
    load: async () => {
      // From the backend, never this browser's storage: a fresh session or a
      // different operator must see the same purchase orders.
      const [stock, heads] = await Promise.all([api('GET', '/stock'), api('GET', '/purchase-orders')]);
      const pos = await Promise.all(heads.slice(0, 10).map(async (h) => ({
        id: h.po_id, status: h.status, lines: await api('GET', `/purchase-orders/${h.po_id}`),
      })));
      return { stock, pos };
    },
    isEmpty: () => false,
    render: (d) => `
      <form data-f="po">
  <label>SKU<select name="sku_id">${d.stock.map((s) =>
  `<option value="${s.sku_id}">${esc(s.sku)}</option>`).join('')}</select></label>
  <label>Qty<input name="qty" type="number" value="100" min="1" required></label>
  <label>Unit price<input name="price" type="number" step="0.01" value="9.50" required></label>
  <button class="go" type="submit">Create PO</button>
      </form>
      ${noticeHtml('po')}
      ${d.pos.length === 0 ? '<p class="muted" data-state="empty">No purchase orders yet.</p>' : `
      <table data-t="po"><thead><tr><th>PO</th><th>Status</th><th>Line</th><th>Ordered</th>
  <th>Received</th><th>Outstanding</th><th>Over</th><th></th></tr></thead><tbody>
  ${d.pos.flatMap((p) => p.lines.map((l) => `<tr>
  <td>${p.id}</td><td>${esc(p.status)}</td><td>${l.po_line_id}</td><td>${num(l.qty_ordered)}</td>
  <td>${num(l.qty_received)}</td>
  <td data-outstanding="${l.po_line_id}">${num(l.qty_outstanding)}</td>
  <td>${l.has_over_receipt ? '<span class="pill no">yes</span>' : ''}</td>
  <td><form data-f="gr" data-po="${p.id}" data-line="${l.po_line_id}">
  <input name="qty" type="number" value="40" min="1" style="width:70px">
  <label style="flex-direction:row;gap:4px"><input type="checkbox" name="over">allow over</label>
  <button class="go" type="submit">Receive</button></form></td></tr>`)).join('')}
      </tbody></table>`}`,
    bind(root, d) {
      root.querySelector('[data-f="po"]')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = new FormData(e.target);
        try {
          const po = await api('POST', '/purchase-orders', {
            supplier_id: 1,
            lines: [{ sku_id: +f.get('sku_id'), warehouse_id: 1,
              qty_ordered: +f.get('qty'), unit_price: +f.get('price') }],
          });
          notice.po = { bad: false,
            text: `PO ${po.po_id} created (DRAFT) - a Procurement Manager must approve it.` };
          window.render('procurement');
        } catch (err) {
          notice.po = { bad: true, text: `${err.status} ${err.code}` };
          window.render('procurement');
        }
      });
      root.querySelectorAll('[data-f="gr"]').forEach((form) =>
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const f = new FormData(form);
          try {
            await api('POST', `/purchase-orders/${form.dataset.po}/receipts`, {
              allow_over_receipt: f.get('over') === 'on',
              lines: [{ po_line_id: +form.dataset.line, qty_received: +f.get('qty') }],
            });
            notice.po = { bad: false, text: 'Receipt posted.' };
          } catch (err) {
            notice.po = { bad: true,
              text: `${err.status} ${err.code}${err.detail ? ` - ${typeof err.detail === 'string' ? err.detail : JSON.stringify(err.detail)}` : ''}` };
          }
          window.render('procurement');
        }));
    },
  },

  sales: {
    title: 'Sales',
    live: true,
    emptyText: 'No stock to sell.',
    load: async () => ({ stock: await api('GET', '/stock') }),
    isEmpty: (d) => d.stock.length === 0,
    render: (d) => `
      <p class="muted">Availability is re-read every 2s and again at submit; the
        server is the authority, not this table.</p>
      <table data-t="avail"><thead><tr><th>SKU</th><th>Available now</th></tr></thead><tbody>
  ${rows(d.stock, (s) => `<td>${esc(s.sku)}</td>
  <td data-avail="${esc(s.sku)}">${num(s.available)}</td>`)}
      </tbody></table>
      <form data-f="so">
  <label>SKU<select name="sku_id">${d.stock.map((s) =>
  `<option value="${s.sku_id}">${esc(s.sku)}</option>`).join('')}</select></label>
  <label>Qty<input name="qty" type="number" value="1" min="1" required></label>
  <button class="go" type="submit">Create + reserve</button>
      </form>
      ${noticeHtml('so')}`,
    bind(root) {
      root.querySelector('[data-f="so"]')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = new FormData(e.target);
        notice.so = null;
        try {
          const so = await api('POST', '/sales-orders', {
            customer: 'walk-in',
            lines: [{ sku_id: +f.get('sku_id'), warehouse_id: 1, qty: +f.get('qty'), unit_price: 20 }],
          });
          const r = await api('POST', `/sales-orders/${so.so_id}/reserve`);
          const back = r.backordered.length
            ? ` ${r.backordered.map((b) => `${b.requested - b.available} backordered`).join(', ')}` : '';
          notice.so = { bad: false,
            text: `SO ${so.so_id}: reserved ${r.reservations.map((x) => num(x.qty)).join(',')}.${back}` };
        } catch (err) {
          // 409 INSUFFICIENT_STOCK is the case the brief asks to surface.
          notice.so = { bad: true,
            text: `${err.status} ${err.code}${err.detail ? ` - ${JSON.stringify(err.detail)}` : ''}` };
        }
        window.render('sales', { silent: true });
      });
    },
  },

  finance: {
    title: 'Finance',
    live: true,
    emptyText: 'No ledger entries posted yet.',
    load: async () => ({
      recon: await api('GET', '/ledger/reconciliation'),
      entries: await api('GET', '/ledger/entries'),
    }),
    isEmpty: (d) => d.entries.length === 0,
    render: (d) => {
      const ok = Number(d.recon.drift) === 0;
      return `
      <p>Inventory value from movements <strong>${num(d.recon.movements_value)}</strong>
         vs ledger <strong>${num(d.recon.ledger_value)}</strong> -
         drift <strong data-drift>${num(d.recon.drift)}</strong>
  <span class="pill ${ok ? 'yes' : 'no'}" data-recon="${ok ? 'yes' : 'no'}">
  ${ok ? 'matches' : 'DIVERGED'}</span></p>
      <p class="muted">Debits ${num(d.recon.total_debits)} / credits ${num(d.recon.total_credits)}</p>
      <table data-t="ledger"><thead><tr><th>#</th><th>Journal</th><th>Source</th>
  <th>Account</th><th>Debit</th><th>Credit</th><th>Reverses</th></tr></thead><tbody>
  ${rows(d.entries, (e) => `<td>${e.entry_id}</td><td>${e.journal_id}</td>
  <td>${esc(e.source_type)}:${e.source_id}</td><td>${esc(e.account)}</td>
  <td>${num(e.debit)}</td><td>${num(e.credit)}</td><td>${e.reverses ?? ''}</td>`)}
      </tbody></table>`;
    },
  },
};
