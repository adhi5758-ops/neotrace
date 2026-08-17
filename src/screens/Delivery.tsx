/**
 * Layar Pengiriman (DO) — sisi outbound yang sebelumnya tidak ada sama
 * sekali. Alur: buat DO (manual atau impor CSV pesanan) → terbitkan pick
 * list (FEFO, sama seperti batch produksi) → petugas memetik lewat layar
 * Pick list → di sini juga baru bisa "Tandai terkirim" setelah picking
 * selesai. Ekspor CSV pesanan terkirim untuk disetorkan balik ke ERP/sales.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  createDeliveryOrder, shipDeliveryOrder, parseDbError,
} from '../lib/api';
import {
  listDeliveryOrders, listItems, listPartners,
  type DeliveryOrder, type Item, type Partner,
} from '../lib/queries';
import { listPickLists, generatePickListFromDo, type PickList } from '../lib/picking';
import { parseExcelFile, downloadTemplate, exportRows } from '../lib/excel';
import { C, s, pill } from '../ui';

export default function Delivery() {
  const [orders, setOrders] = useState<DeliveryOrder[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [customers, setCustomers] = useState<Partner[]>([]);
  const [open, setOpen] = useState<DeliveryOrder | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    listDeliveryOrders()
      .then(setOrders)
      .catch((e) => setErr(parseDbError(e).message))
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    Promise.all([listItems(), listPartners('CUSTOMER')])
      .then(([i, c]) => { setItems(i); setCustomers(c); })
      .catch((e) => setErr(parseDbError(e).message));
  }, []);

  async function importCsv(file: File) {
    setImporting(true);
    setErr(null);
    setMsg(null);
    try {
      const rows = await parseExcelFile(file);
      const groups = new Map<string, Record<string, unknown>[]>();
      for (const r of rows) {
        const key = String(r.so_no ?? `BARIS-${groups.size + 1}`);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(r);
      }
      let created = 0;
      const errors: string[] = [];
      for (const [soNo, lines] of groups) {
        try {
          const customerCode = String(lines[0].customer_code ?? '').trim();
          const customer = customers.find((c) => c.code === customerCode);
          if (!customer) throw new Error(`kode pelanggan "${customerCode}" tidak ditemukan`);
          const doLines = lines.map((l) => {
            const itemCode = String(l.item_code ?? '').trim();
            const item = items.find((i) => i.code === itemCode);
            if (!item) throw new Error(`kode barang "${itemCode}" tidak ditemukan`);
            return { itemId: item.id, qty: Number(l.qty) || 0, uom: String(l.uom ?? item.base_uom) };
          });
          await createDeliveryOrder({ customerId: customer.id, soNo, lines: doLines });
          created++;
        } catch (e) {
          errors.push(`${soNo}: ${(e as Error).message}`);
        }
      }
      setMsg(`${created} DO dibuat dari CSV.${errors.length ? ` Gagal: ${errors.join('; ')}` : ''}`);
      load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setImporting(false);
    }
  }

  async function exportShipped() {
    const shipped = orders.filter((o) => o.status === 'POSTED');
    const rows = shipped.flatMap((o) =>
      o.delivery_order_lines.map((l) => ({
        do_no: o.doc_no,
        so_no: o.so_no ?? '',
        pelanggan: o.partners?.name ?? '',
        item_code: l.items?.code ?? '',
        item_name: l.items?.name ?? '',
        lot_code: l.lots?.lot_code ?? '',
        qty: l.qty,
        uom: l.uom,
        dikirim_at: o.shipped_at ?? '',
      }))
    );
    if (!rows.length) { setMsg('Belum ada DO berstatus terkirim untuk diekspor.'); return; }
    await exportRows(`pesanan-terkirim-${Date.now()}.csv`, rows);
  }

  if (open) return <DoDetail order={open} onBack={() => { setOpen(null); load(); }} />;

  return (
    <div style={s.pageWide}>
      <h1 style={s.h1}>Pengiriman</h1>
      <p style={s.sub}>{orders.length} delivery order</p>
      {err && <div style={s.err}>{err}</div>}
      {msg && <div style={s.ok}>{msg}</div>}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {!showNew && (
          <button style={{ ...s.btn, maxWidth: 260 }} onClick={() => setShowNew(true)}>+ Buat DO baru</button>
        )}
        <label style={{ ...s.btnGhost, maxWidth: 260, textAlign: 'center', cursor: 'pointer' }}>
          {importing ? 'Mengimpor…' : 'Impor CSV pesanan'}
          <input type="file" accept=".csv,.xlsx,.xls" style={{ display: 'none' }} disabled={importing}
                 onChange={(e) => { const f = e.target.files?.[0]; if (f) void importCsv(f); e.target.value = ''; }} />
        </label>
        <button style={{ ...s.btnGhost, maxWidth: 260 }}
                onClick={() => void downloadTemplate('template-pesanan.csv',
                  ['so_no', 'customer_code', 'item_code', 'qty', 'uom'],
                  ['SO-0001', customers[0]?.code ?? 'CUST01', items[0]?.code ?? 'ITEM01', 100, items[0]?.base_uom ?? 'KG'])}>
          Unduh templat CSV
        </button>
        <button style={{ ...s.btnGhost, maxWidth: 260 }} onClick={() => void exportShipped()}>
          Ekspor pesanan terkirim
        </button>
      </div>

      {showNew && (
        <NewDo items={items} customers={customers} onCancel={() => setShowNew(false)}
               onCreated={() => { setShowNew(false); load(); }} />
      )}

      {loading && <div style={s.empty}>Memuat…</div>}
      {!loading && orders.length === 0 && <div style={s.empty}>Belum ada delivery order.</div>}

      <div style={s.cardGrid}>
        {orders.map((o) => (
          <button key={o.id} style={{ ...s.card, marginBottom: 0, width: '100%', textAlign: 'left', cursor: 'pointer' }}
                  onClick={() => setOpen(o)}>
            <div style={s.rowBetween}>
              <div style={s.code}>{o.doc_no}</div>
              <span style={pill(o.status === 'POSTED' ? 'ok' : 'mute')}>{o.status}</span>
            </div>
            <div style={s.meta}>
              {o.partners?.name ?? '—'} · {o.delivery_order_lines.length} baris
              {o.so_no ? ` · SO ${o.so_no}` : ''}
              {o.shipped_at ? ` · kirim ${o.shipped_at.slice(0, 10)}` : ''}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ baru */

function NewDo({ items, customers, onCancel, onCreated }: {
  items: Item[]; customers: Partner[]; onCancel: () => void; onCreated: () => void;
}) {
  const [customerId, setCustomerId] = useState('');
  const [soNo, setSoNo] = useState('');
  const [shipTo, setShipTo] = useState('');
  const [lines, setLines] = useState<{ itemId: string; qty: string }[]>([{ itemId: '', qty: '' }]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const setLine = (i: number, k: 'itemId' | 'qty', v: string) =>
    setLines((p) => p.map((l, idx) => (idx === i ? { ...l, [k]: v } : l)));

  const canSubmit = customerId && lines.some((l) => l.itemId && Number(l.qty) > 0);

  return (
    <div style={{ ...s.card, maxWidth: 560 }}>
      <div style={s.secHead}>Delivery order baru</div>
      {err && <div style={s.err}>{err}</div>}

      <label style={s.label} htmlFor="do-cust">Pelanggan</label>
      <select id="do-cust" style={s.input} value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
        <option value="">— pilih pelanggan —</option>
        {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>

      <div style={s.grid2}>
        <div>
          <label style={s.label} htmlFor="do-so">No. SO (opsional)</label>
          <input id="do-so" style={s.input} value={soNo} onChange={(e) => setSoNo(e.target.value)} />
        </div>
        <div>
          <label style={s.label} htmlFor="do-ship">Alamat kirim (opsional)</label>
          <input id="do-ship" style={s.input} value={shipTo} onChange={(e) => setShipTo(e.target.value)} />
        </div>
      </div>

      <div style={s.secHead}>Baris pesanan</div>
      {lines.map((l, i) => {
        const item = items.find((it) => it.id === l.itemId);
        return (
          <div key={i} style={{ ...s.grid2, alignItems: 'end', marginBottom: 8 }}>
            <div>
              <label style={s.label} htmlFor={`do-item-${i}`}>Barang</label>
              <select id={`do-item-${i}`} style={s.input} value={l.itemId}
                      onChange={(e) => setLine(i, 'itemId', e.target.value)}>
                <option value="">— pilih barang —</option>
                {items.map((it) => <option key={it.id} value={it.id}>{it.code} · {it.name}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input style={{ ...s.input, flex: 1 }} type="number" inputMode="decimal" step="0.001"
                     placeholder={`qty (${item?.base_uom ?? '—'})`}
                     value={l.qty} onChange={(e) => setLine(i, 'qty', e.target.value)} />
              {lines.length > 1 && (
                <button style={{ ...s.btnGhost, flex: 'none', padding: '0 12px' }}
                        onClick={() => setLines((p) => p.filter((_, idx) => idx !== i))}>✕</button>
              )}
            </div>
          </div>
        );
      })}
      <button style={{ ...s.btnGhost, width: '100%' }} onClick={() => setLines((p) => [...p, { itemId: '', qty: '' }])}>
        + Tambah baris
      </button>

      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <button style={{ ...s.btnGhost, flex: 1 }} onClick={onCancel}>Batal</button>
        <button
          style={{ ...s.btn, flex: 2, opacity: busy || !canSubmit ? 0.5 : 1 }}
          disabled={busy || !canSubmit}
          onClick={() => {
            setBusy(true);
            setErr(null);
            createDeliveryOrder({
              customerId,
              soNo: soNo.trim() || undefined,
              shipToAddress: shipTo.trim() || undefined,
              lines: lines
                .filter((l) => l.itemId && Number(l.qty) > 0)
                .map((l) => ({ itemId: l.itemId, qty: Number(l.qty), uom: items.find((it) => it.id === l.itemId)?.base_uom ?? 'KG' })),
            })
              .then(onCreated)
              .catch((e) => setErr(parseDbError(e).message))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? 'Menyimpan…' : 'Buat DO'}
        </button>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- detail */

function DoDetail({ order, onBack }: { order: DeliveryOrder; onBack: () => void }) {
  const [pick, setPick] = useState<PickList | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [ship, setShip] = useState({ transporterId: '', vehicleNo: '', driverName: '' });

  const load = useCallback(() => {
    setLoading(true);
    listPickLists(false)
      .then((all) => setPick(all.find((p) => p.do_id === order.id && p.status !== 'CANCELLED') ?? null))
      .catch((e) => setErr(parseDbError(e).message))
      .finally(() => setLoading(false));
  }, [order.id]);
  useEffect(load, [load]);

  async function issue() {
    setBusy(true); setErr(null); setMsg(null);
    try {
      await generatePickListFromDo(order.id);
      setMsg('Pick list terbit. Tugaskan petugas di layar Pick list.');
      load();
    } catch (e) {
      setErr((e as { message?: string }).message ?? parseDbError(e).message);
    } finally {
      setBusy(false);
    }
  }

  async function doShip() {
    setBusy(true); setErr(null); setMsg(null);
    try {
      await shipDeliveryOrder({
        doId: order.id,
        transporterId: ship.transporterId || undefined,
        vehicleNo: ship.vehicleNo || undefined,
        driverName: ship.driverName || undefined,
      });
      setMsg('DO ditandai terkirim.');
      onBack();
    } catch (e) {
      setErr((e as { message?: string }).message ?? parseDbError(e).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={s.pageWide}>
      <button style={{ ...s.btnGhost, marginBottom: 14 }} onClick={onBack}>‹ Daftar DO</button>
      <h1 style={s.h1}>{order.doc_no}</h1>
      <p style={s.sub}>{order.partners?.name ?? '—'} · status {order.status}</p>
      {err && <div style={s.err}>{err}</div>}
      {msg && <div style={s.ok}>{msg}</div>}

      <div style={s.secHead}>Baris</div>
      <div style={s.cardGrid}>
        {order.delivery_order_lines.map((l) => (
          <div key={l.id} style={{ ...s.card, marginBottom: 0 }}>
            <div style={s.code}>{l.items?.name ?? '—'}</div>
            <div style={s.meta}>
              {l.qty} {l.uom}{l.lots?.lot_code ? ` · lot ${l.lots.lot_code}` : ' · belum dipetik'}
            </div>
          </div>
        ))}
      </div>

      <div style={s.secHead}>Pick list</div>
      {loading && <div style={s.empty}>Memeriksa…</div>}
      {!loading && !pick && order.status === 'DRAFT' && (
        <button style={{ ...s.btnGhost, width: '100%', maxWidth: 480 }} disabled={busy} onClick={() => void issue()}>
          {busy ? 'Menerbitkan…' : 'Terbitkan pick list'}
        </button>
      )}
      {pick && (
        <div style={{ ...s.card, maxWidth: 480, borderTop: `3px solid ${pick.status === 'COMPLETED' ? C.neo : C.amber}` }}>
          <div style={s.rowBetween}>
            <div style={s.code}>{pick.doc_no}</div>
            <span style={pill(pick.status === 'COMPLETED' ? 'ok' : 'warn')}>{pick.status}</span>
          </div>
          <div style={s.meta}>Petik lewat layar Pick list.</div>
        </div>
      )}

      {pick?.status === 'COMPLETED' && order.status === 'DRAFT' && (
        <>
          <div style={s.secHead}>Tandai terkirim</div>
          <div style={{ ...s.grid2, maxWidth: 480 }}>
            <div>
              <label style={s.label} htmlFor="ship-veh">No. kendaraan (opsional)</label>
              <input id="ship-veh" style={s.input} value={ship.vehicleNo}
                     onChange={(e) => setShip({ ...ship, vehicleNo: e.target.value })} />
            </div>
            <div>
              <label style={s.label} htmlFor="ship-drv">Sopir (opsional)</label>
              <input id="ship-drv" style={s.input} value={ship.driverName}
                     onChange={(e) => setShip({ ...ship, driverName: e.target.value })} />
            </div>
          </div>
          <button style={{ ...s.btn, maxWidth: 480, opacity: busy ? 0.5 : 1 }} disabled={busy} onClick={() => void doShip()}>
            {busy ? 'Menyimpan…' : 'Tandai terkirim'}
          </button>
        </>
      )}
    </div>
  );
}
