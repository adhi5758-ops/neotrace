/**
 * Layar Terima Bahan (GRN).
 *
 * Hasil akhir bukan "data tersimpan", tapi setumpuk label QR tercetak dan
 * tertempel. Karena itu layar tidak selesai sampai operator menekan Cetak.
 * Lot lahir berstatus QUARANTINE — QA yang melepas, bukan gudang.
 */
import { useEffect, useMemo, useState } from 'react';
import { receiveGoods, parseDbError, type ReceiveResult } from '../lib/api';
import { listItems, listLocations, listPartners, listAllergens, type Item, type Partner, type Location, type Allergen } from '../lib/queries';
import { printLabels } from '../lib/labels';
import { C, MONO, s } from '../ui';

const today = () => new Date().toISOString().slice(0, 10);

export default function Receive() {
  const [items, setItems] = useState<Item[]>([]);
  const [suppliers, setSuppliers] = useState<Partner[]>([]);
  const [customers, setCustomers] = useState<Partner[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [allergens, setAllergens] = useState<Allergen[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const [f, setF] = useState({
    itemId: '', supplierId: '', supplierLotNo: '', supplierDoNo: '', poNo: '',
    qty: '', unitCost: '', landedCostPerUom: '', expiryDate: '', manufacturedOn: '',
    halalCertNo: '', halalValidUntil: '',
    ownerType: 'OWN' as 'OWN' | 'CONSIGNED', ownerPartnerId: '',
    huCount: '1', packageType: '', locationId: '', temperatureC: '',
    allergenIds: [] as number[],
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<ReceiveResult | null>(null);

  useEffect(() => {
    Promise.all([listItems(), listPartners('SUPPLIER'), listPartners('CUSTOMER'), listLocations(), listAllergens()])
      .then(([i, sp, cu, lo, al]) => { setItems(i); setSuppliers(sp); setCustomers(cu); setLocations(lo); setAllergens(al); })
      .catch((e) => setLoadErr(parseDbError(e).message));
  }, []);

  const item = useMemo(() => items.find((i) => i.id === f.itemId), [items, f.itemId]);
  const qty = Number(f.qty) || 0;
  const huCount = Math.max(1, Math.floor(Number(f.huCount) || 1));
  const perHu = qty / huCount;
  const set = (k: keyof typeof f, v: unknown) => setF((p) => ({ ...p, [k]: v }));
  // functional updater wajib di sini — computed di dalam callback, bukan dari
  // closure f.allergenIds di luar, supaya dua tap alergen yang berdekatan
  // (mis. React 18 automatic batching) tidak saling menimpa satu sama lain
  const toggleAllergen = (id: number) => setF((p) => ({
    ...p,
    allergenIds: p.allergenIds.includes(id)
      ? p.allergenIds.filter((x) => x !== id)
      : [...p.allergenIds, id],
  }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!f.itemId || !f.supplierId || !f.expiryDate || qty <= 0) {
      setErr('Bahan, supplier, jumlah, dan tanggal kedaluwarsa wajib diisi.');
      return;
    }
    if (f.ownerType === 'CONSIGNED' && !f.ownerPartnerId) {
      setErr('Bahan titipan wajib punya pemilik. Pilih klien.');
      return;
    }
    setBusy(true);
    try {
      const r = await receiveGoods({
        itemId: f.itemId,
        supplierId: f.supplierId,
        supplierLotNo: f.supplierLotNo.trim(),
        supplierDoNo: f.supplierDoNo || undefined,
        poNo: f.poNo || undefined,
        qty,
        uom: item?.base_uom ?? 'KG',
        unitCost: Number(f.unitCost) || 0,
        landedCostPerUom: Number(f.landedCostPerUom) || 0,
        expiryDate: f.expiryDate,
        manufacturedOn: f.manufacturedOn || undefined,
        halalCertNo: f.halalCertNo || undefined,
        halalValidUntil: f.halalValidUntil || undefined,
        ownerType: f.ownerType,
        ownerPartnerId: f.ownerPartnerId || undefined,
        temperatureC: f.temperatureC ? Number(f.temperatureC) : undefined,
        huCount,
        packageType: f.packageType || undefined,
        locationId: f.locationId || undefined,
        allergenIds: f.allergenIds.length ? f.allergenIds : undefined,
      });
      setDone(r);
    } catch (e) {
      setErr(parseDbError(e).message);
    } finally {
      setBusy(false);
    }
  }

  async function print() {
    if (!done) return;
    try {
      await printLabels(done.handlingUnits.map((h) => ({
        hu_id: h.id,
        hu_code: h.hu_code,
        qr_token: h.qr_token,
        lot_code: done.lotCode,
        item_name: item?.name ?? '',
        qty: h.qty_initial,
        uom: item?.base_uom ?? '',
        expiry_date: f.expiryDate,
        owner_name: f.ownerType === 'CONSIGNED'
          ? customers.find((c) => c.id === f.ownerPartnerId)?.name
          : null,
      })));
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  if (done) {
    return (
      <div style={s.pageForm}>
        <h1 style={s.h1}>Bahan diterima</h1>
        <p style={s.sub}>{done.lotCode} · {done.handlingUnits.length} kemasan · status QUARANTINE</p>

        <div style={{ ...s.card, borderTop: `3px solid ${C.amber}` }}>
          <div style={s.code}>Belum boleh dipakai produksi</div>
          <div style={s.meta}>Lot menunggu release QA. Tempel label lalu simpan di area karantina.</div>
        </div>

        <div style={s.secHead}>Label untuk dicetak</div>
        <div style={s.cardGrid}>
          {done.handlingUnits.map((h) => (
            <div key={h.id} style={{ ...s.card, ...s.rowBetween, marginBottom: 0 }}>
              <div>
                <div style={s.code}>{h.hu_code}</div>
                <div style={s.meta}>{h.qty_initial} {item?.base_uom}</div>
              </div>
              <span style={{ ...s.meta, marginTop: 0 }}>{h.qr_token.slice(0, 8)}…</span>
            </div>
          ))}
        </div>

        {err && <div style={s.err}>{err}</div>}
        <button style={s.btn} onClick={() => void print()}>Cetak {done.handlingUnits.length} label</button>
        <button
          style={{ ...s.btn, background: 'transparent', color: C.ink, border: `1px solid ${C.line}` }}
          onClick={() => { setDone(null); setF((p) => ({ ...p, supplierLotNo: '', qty: '', huCount: '1' })); }}
        >
          Terima bahan lain
        </button>
      </div>
    );
  }

  return (
    <form style={s.pageForm} onSubmit={submit}>
      <h1 style={s.h1}>Terima bahan</h1>
      <p style={s.sub}>GRN · lot masuk karantina sampai QA melepas</p>
      {loadErr && <div style={s.err}>Master gagal dimuat: {loadErr}</div>}

      <div style={s.secHead}>Bahan & pemasok</div>
      <label style={s.label} htmlFor="item">Bahan</label>
      <select id="item" style={s.input} value={f.itemId} onChange={(e) => set('itemId', e.target.value)}>
        <option value="">— pilih bahan —</option>
        {items.map((i) => <option key={i.id} value={i.id}>{i.code} · {i.name}</option>)}
      </select>

      <label style={s.label} htmlFor="sup">Supplier</label>
      <select id="sup" style={s.input} value={f.supplierId} onChange={(e) => set('supplierId', e.target.value)}>
        <option value="">— pilih supplier —</option>
        {suppliers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>

      <div style={s.grid2}>
        <div>
          <label style={s.label} htmlFor="slot">No. lot supplier</label>
          <input id="slot" style={s.input} value={f.supplierLotNo} onChange={(e) => set('supplierLotNo', e.target.value)} />
        </div>
        <div>
          <label style={s.label} htmlFor="do">No. surat jalan</label>
          <input id="do" style={s.input} value={f.supplierDoNo} onChange={(e) => set('supplierDoNo', e.target.value)} />
        </div>
      </div>

      <div style={s.secHead}>Jumlah & biaya</div>
      <div style={s.grid2}>
        <div>
          <label style={s.label} htmlFor="qty">Jumlah ({item?.base_uom ?? 'UoM'})</label>
          <input id="qty" style={s.input} type="number" inputMode="decimal" step="0.001"
                 value={f.qty} onChange={(e) => set('qty', e.target.value)} />
        </div>
        <div>
          <label style={s.label} htmlFor="cost">Harga satuan (Rp)</label>
          <input id="cost" style={s.input} type="number" inputMode="decimal" step="0.01"
                 value={f.unitCost} onChange={(e) => set('unitCost', e.target.value)} />
        </div>
      </div>

      <label style={s.label} htmlFor="landed">Landed cost per {item?.base_uom ?? 'unit'} (Rp, opsional)</label>
      <input id="landed" style={s.input} type="number" inputMode="decimal" step="0.01"
             placeholder="ongkos kirim / bea masuk per satuan - ikut masuk HPP produksi"
             value={f.landedCostPerUom} onChange={(e) => set('landedCostPerUom', e.target.value)} />

      <div style={s.grid2}>
        <div>
          <label style={s.label} htmlFor="hu">Jumlah kemasan fisik</label>
          <input id="hu" style={s.input} type="number" inputMode="numeric" min={1}
                 value={f.huCount} onChange={(e) => set('huCount', e.target.value)} />
        </div>
        <div>
          <label style={s.label} htmlFor="pkg">Jenis kemasan</label>
          <input id="pkg" style={s.input} placeholder="drum / sak / jerigen"
                 value={f.packageType} onChange={(e) => set('packageType', e.target.value)} />
        </div>
      </div>
      {qty > 0 && (
        <p style={{ ...s.meta, marginTop: 8 }}>
          → {huCount} label QR, masing-masing {perHu.toFixed(3)} {item?.base_uom ?? ''}
        </p>
      )}

      <div style={s.secHead}>Umur simpan & halal</div>
      <div style={s.grid2}>
        <div>
          <label style={s.label} htmlFor="exp">Kedaluwarsa</label>
          <input id="exp" style={s.input} type="date" min={today()}
                 value={f.expiryDate} onChange={(e) => set('expiryDate', e.target.value)} />
        </div>
        <div>
          <label style={s.label} htmlFor="mfg">Tanggal produksi</label>
          <input id="mfg" style={s.input} type="date" max={today()}
                 value={f.manufacturedOn} onChange={(e) => set('manufacturedOn', e.target.value)} />
        </div>
      </div>
      <div style={s.grid2}>
        <div>
          <label style={s.label} htmlFor="hc">No. sertifikat halal</label>
          <input id="hc" style={s.input} value={f.halalCertNo} onChange={(e) => set('halalCertNo', e.target.value)} />
        </div>
        <div>
          <label style={s.label} htmlFor="hv">Halal berlaku s/d</label>
          <input id="hv" style={s.input} type="date"
                 value={f.halalValidUntil} onChange={(e) => set('halalValidUntil', e.target.value)} />
        </div>
      </div>

      <div style={s.secHead}>Kepemilikan</div>
      <div style={s.grid2}>
        {(['OWN', 'CONSIGNED'] as const).map((t) => (
          <button
            key={t} type="button"
            onClick={() => set('ownerType', t)}
            style={{
              ...s.btnGhost,
              borderColor: f.ownerType === t ? C.neo : C.line,
              color: f.ownerType === t ? C.neo : C.slate,
              fontFamily: MONO, fontSize: 12,
            }}
          >
            {t === 'OWN' ? 'Milik Neofood' : 'Titipan klien'}
          </button>
        ))}
      </div>
      {f.ownerType === 'CONSIGNED' && (
        <>
          <label style={s.label} htmlFor="own">Pemilik bahan</label>
          <select id="own" style={s.input} value={f.ownerPartnerId} onChange={(e) => set('ownerPartnerId', e.target.value)}>
            <option value="">— pilih klien —</option>
            {customers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </>
      )}

      <div style={s.secHead}>Penyimpanan</div>
      <div style={s.grid2}>
        <div>
          <label style={s.label} htmlFor="loc">Lokasi simpan</label>
          <select id="loc" style={s.input} value={f.locationId} onChange={(e) => set('locationId', e.target.value)}>
            <option value="">— pilih lokasi —</option>
            {locations.filter((l) => l.is_staging).map((l) => (
              <option key={l.id} value={l.id}>{l.code} · {l.name ?? l.type} (staging)</option>
            ))}
            {locations.some((l) => l.is_staging) && locations.some((l) => !l.is_staging) && (
              <option disabled>──────────</option>
            )}
            {locations.filter((l) => !l.is_staging).map((l) => (
              <option key={l.id} value={l.id}>{l.code} · {l.name ?? l.type}</option>
            ))}
          </select>
          <p style={s.meta}>
            Sebaiknya simpan dulu di lokasi staging sampai lolos QA, baru dipindah ke rak permanen lewat Put-away.
          </p>
        </div>
        <div>
          <label style={s.label} htmlFor="temp">Suhu terima (°C)</label>
          <input id="temp" style={s.input} type="number" inputMode="decimal" step="0.1"
                 value={f.temperatureC} onChange={(e) => set('temperatureC', e.target.value)} />
        </div>
      </div>

      {allergens.length > 0 && (
        <>
          <div style={s.secHead}>Alergen pada lot ini</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {allergens.map((a) => {
              const on = f.allergenIds.includes(a.id);
              return (
                <button
                  key={a.id} type="button"
                  onClick={() => toggleAllergen(a.id)}
                  style={{
                    ...s.btnGhost, fontFamily: MONO, fontSize: 11, padding: '8px 10px',
                    borderColor: on ? C.amber : C.line, color: on ? C.amber : C.slate,
                  }}
                >
                  {a.name_id}
                </button>
              );
            })}
          </div>
        </>
      )}

      {err && <div style={s.err}>{err}</div>}
      <button style={{ ...s.btn, opacity: busy ? 0.6 : 1 }} disabled={busy}>
        {busy ? 'Menyimpan…' : `Terima & buat ${huCount} label`}
      </button>
    </form>
  );
}
