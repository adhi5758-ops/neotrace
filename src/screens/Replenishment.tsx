/**
 * Layar Replenishment — rak primer di bawah stok minimum, lokasi cadangan
 * yang bisa dipakai mengisi ulang, dan aksi transfer langsung dari sini.
 *
 * RPC generate_replenishment_suggestions() menghitung langsung (tanpa
 * rencana tersimpan) rak primer mana yang sudah di bawah stok minimum,
 * dan lokasi cadangan mana yang masih punya stok released untuk mengisinya.
 * Saran tidak pernah menunjuk satu lokasi tujuan tunggal — skema tidak
 * menjamin cuma ada satu rak primer per item — sehingga operator memilih
 * sendiri rak tujuan sebelum transfer dieksekusi.
 */
import { useCallback, useEffect, useState } from 'react';
import { parseDbError } from '../lib/api';
import { replenishmentSuggestions, type ReplenishmentSuggestion } from '../lib/api-phase6';
import { transferHu } from '../lib/putaway';
import { listLocations, type Location } from '../lib/queries';
import { C, MONO, s } from '../ui';

export default function Replenishment() {
  const [rows, setRows] = useState<ReplenishmentSuggestion[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [locations, setLocations] = useState<Location[]>([]);
  const [dest, setDest] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [cardErr, setCardErr] = useState<Record<string, string | null>>({});
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await replenishmentSuggestions());
      setErr(null);
    } catch (e) {
      setErr(parseDbError(e).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadLocations = useCallback(async () => {
    try {
      setLocations(await listLocations());
    } catch (e) {
      setErr(parseDbError(e).message);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadLocations(); }, [loadLocations]);

  const primaryLocations = locations.filter((l) => l.is_primary_pick);

  const handleTransfer = useCallback(async (r: ReplenishmentSuggestion) => {
    const toLocationId = dest[r.item_id];
    if (!toLocationId) return;
    setBusy((b) => ({ ...b, [r.item_id]: true }));
    setCardErr((e) => ({ ...e, [r.item_id]: null }));
    try {
      await transferHu(r.source_hu_id, toLocationId);
      const loc = primaryLocations.find((l) => l.id === toLocationId);
      setOkMsg(`Transfer ${r.suggested_qty} ${r.uom} ${r.item_code} ke ${loc?.code ?? toLocationId} berhasil.`);
      await load();
    } catch (e) {
      setCardErr((ce) => ({ ...ce, [r.item_id]: parseDbError(e).message }));
    } finally {
      setBusy((b) => ({ ...b, [r.item_id]: false }));
    }
  }, [dest, primaryLocations, load]);

  return (
    <div style={s.pageWide}>
      <div style={s.rowBetween}>
        <div>
          <h1 style={s.h1}>Isi Ulang Rak Primer</h1>
          <p style={s.sub}>
            Rak primer di bawah stok minimum, beserta lokasi cadangan yang bisa dipakai mengisi ulang
          </p>
        </div>
        <button style={s.btnGhost} disabled={loading} onClick={() => void load()}>
          {loading ? 'Memuat…' : 'Muat ulang'}
        </button>
      </div>

      {err && <div style={s.err}>{err}</div>}
      {okMsg && <div style={s.ok}>{okMsg}</div>}
      {loading && rows.length === 0 && !err && <div style={s.empty}>Memuat saran replenishment…</div>}

      {!loading && !err && rows.length === 0 && (
        <div style={s.empty}>
          Tidak ada rak yang perlu diisi ulang. Semua rak primer di atas stok minimum.
        </div>
      )}

      {rows.length > 0 && (
        <>
          <div style={s.secHead}>{rows.length} item perlu diisi ulang</div>
          <div style={s.cardGrid}>
            {rows.map((r) => {
              const shortfall = r.min_stock - r.primary_qty;
              const chosenDest = dest[r.item_id] ?? '';
              const isBusy = busy[r.item_id] ?? false;
              const rowErr = cardErr[r.item_id];
              return (
                <div key={r.item_id} style={{ ...s.card, borderTop: `3px solid ${C.chili}` }}>
                  <div style={s.rowBetween}>
                    <div style={s.code}>{r.item_code}</div>
                    <div style={{ ...s.code, color: C.chili }}>−{shortfall.toFixed(3)} {r.uom}</div>
                  </div>
                  <div style={{ ...s.meta, color: C.ink, fontSize: 13, marginTop: 6 }}>{r.item_name}</div>

                  <dl style={kv}>
                    <dt>Stok rak primer</dt>
                    <dd style={{ color: C.chili }}>{r.primary_qty} {r.uom}</dd>
                    <dt>Stok minimum</dt>
                    <dd>{r.min_stock} {r.uom}</dd>
                    <dt>Jumlah disarankan pindah</dt>
                    <dd style={{ color: C.neo, fontWeight: 700 }}>{r.suggested_qty} {r.uom}</dd>
                    <dt>Dari lokasi</dt>
                    <dd>{r.source_location_code}</dd>
                    <dt>Kemasan sumber</dt>
                    <dd>{r.source_hu_id.slice(0, 8)}</dd>
                  </dl>

                  <label style={s.label} htmlFor={`dest-${r.item_id}`}>Lokasi tujuan (rak primer)</label>
                  <select
                    id={`dest-${r.item_id}`}
                    style={s.input}
                    value={chosenDest}
                    disabled={isBusy}
                    onChange={(e) => setDest((d) => ({ ...d, [r.item_id]: e.target.value }))}
                  >
                    <option value="">Pilih lokasi…</option>
                    {primaryLocations.map((l) => (
                      <option key={l.id} value={l.id}>{l.code}{l.name ? ` · ${l.name}` : ''}</option>
                    ))}
                  </select>

                  {rowErr && <div style={s.err}>{rowErr}</div>}

                  <button
                    style={s.btn}
                    disabled={!chosenDest || isBusy}
                    onClick={() => void handleTransfer(r)}
                  >
                    {isBusy ? 'Memproses…' : 'Buat transfer'}
                  </button>

                  <div style={{ ...s.meta, marginTop: 10, paddingTop: 8, borderTop: `1px solid ${C.line}` }}>
                    Atau pindahkan manual lewat layar Gudang / Put-away
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

const kv: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '5px 14px',
  fontSize: 12, fontFamily: MONO, margin: '8px 0 0',
};
