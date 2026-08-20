/**
 * Layar Stock Opname (cycle count).
 *
 * Alur: (1) pilih lokasi lalu buat rencana hitung — satu baris OPEN per
 * kemasan aktif di lokasi itu. (2) Petugas gudang menghitung fisik dan
 * submit qty hasil hitung → status COUNTED. (3) QA/gudang meninjau baris
 * COUNTED dan approve (memposting penyesuaian stok otomatis di server) atau
 * reject (minta hitung ulang). Peran tidak disembunyikan di UI — server
 * yang menolak lewat current_role_is(...), pesannya cukup mengajari siapa
 * yang berwenang, sama seperti Qc.tsx.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  listCycleCounts, generateCycleCounts, submitCycleCount, approveCycleCount, rejectCycleCount, getCycleCount,
  type CycleCountRow, type CycleCountStatus,
} from '../lib/api-phase6';
import { parseDbError } from '../lib/api';
import { listLocations, type Location } from '../lib/queries';
import { C, MONO, s, pill } from '../ui';

const STATUSES: CycleCountStatus[] = ['OPEN', 'COUNTED', 'APPROVED', 'REJECTED', 'CANCELLED'];

const toneOf = (st: CycleCountStatus) =>
  st === 'APPROVED' ? 'ok' : st === 'COUNTED' ? 'warn' : st === 'REJECTED' ? 'bad' : 'mute';

type Props = { role?: string };

export default function CycleCount({ role }: Props) {
  const [status, setStatus] = useState<CycleCountStatus>('OPEN');
  const [rowsList, setRowsList] = useState<CycleCountRow[]>([]);
  const [open, setOpen] = useState<CycleCountRow | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [locationId, setLocationId] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [planMsg, setPlanMsg] = useState<string | null>(null);
  const [planBusy, setPlanBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setRowsList(await listCycleCounts(status));
      setErr(null);
    } catch (e) {
      setErr(parseDbError(e).message);
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { void listLocations().then(setLocations).catch((e) => setErr(parseDbError(e).message)); }, []);

  async function makePlan() {
    if (!locationId) return;
    setPlanBusy(true);
    setPlanMsg(null);
    try {
      const n = await generateCycleCounts(locationId);
      setPlanMsg(`${n} rencana hitung dibuat.`);
      void refresh();
    } catch (e) {
      setErr(parseDbError(e).message);
    } finally {
      setPlanBusy(false);
    }
  }

  if (open) {
    return (
      <CountDetail
        row={open}
        role={role}
        onBack={() => { setOpen(null); void refresh(); }}
      />
    );
  }

  return (
    <div style={s.pageWide}>
      <h1 style={s.h1}>Stock opname</h1>
      <p style={s.sub}>Rencana hitung per lokasi dan keputusan penyesuaian stok</p>

      <div style={s.secHead}>Buat rencana hitung</div>
      <div style={{ ...s.card, maxWidth: 480 }}>
        <label style={s.label} htmlFor="loc">Lokasi</label>
        <select id="loc" style={s.input} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
          <option value="">— pilih lokasi —</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>{l.code}{l.name ? ` · ${l.name}` : ''}</option>
          ))}
        </select>
        {planMsg && <div style={s.ok}>{planMsg}</div>}
        <button style={{ ...s.btn, opacity: planBusy || !locationId ? 0.5 : 1 }}
                disabled={planBusy || !locationId} onClick={() => void makePlan()}>
          {planBusy ? 'Membuat…' : 'Buat rencana hitung untuk lokasi ini'}
        </button>
      </div>

      <div style={s.secHead}>Daftar hitung</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        {STATUSES.map((st) => (
          <button key={st}
                  style={{ ...s.btnGhost, padding: '6px 10px', fontSize: 11.5, ...(st === status ? { borderColor: C.neo, color: C.neo } : {}) }}
                  onClick={() => setStatus(st)}>
            {st}
          </button>
        ))}
      </div>

      {err && <div style={s.err}>{err}</div>}
      {loading && <div style={s.empty}>Memuat…</div>}
      {!loading && rowsList.length === 0 && <div style={s.empty}>Tidak ada hitung berstatus {status}.</div>}

      <div style={s.cardGrid}>
        {rowsList.map((r) => (
          <button key={r.id} style={{ ...s.card, marginBottom: 0, width: '100%', textAlign: 'left', cursor: 'pointer' }}
                  onClick={() => setOpen(r)}>
            <div style={s.rowBetween}>
              <div style={s.code}>{r.doc_no}</div>
              <span style={pill(toneOf(r.status))}>{r.status}</span>
            </div>
            <div style={s.meta}>
              {r.items?.name ?? '—'} · {r.handling_units?.hu_code ?? '—'} · {r.locations?.code ?? '—'}
            </div>
            <div style={s.meta}>
              sistem {r.system_qty} {r.items?.base_uom ?? ''}
              {r.counted_qty != null ? ` · hitung ${r.counted_qty} ${r.items?.base_uom ?? ''}` : ''}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ detail */

function CountDetail({ row: initialRow, role, onBack }: { row: CycleCountRow; role?: string; onBack: () => void }) {
  const [row, setRow] = useState(initialRow);
  const [countedQty, setCountedQty] = useState(initialRow.system_qty.toString());
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const canDecide = !role || role === 'WAREHOUSE' || role === 'QA' || role === 'ADMIN' || role === 'PLANNER';
  const uom = row.items?.base_uom ?? '';
  const countedNum = Number(countedQty) || 0;
  const variance = countedNum - row.system_qty;
  const variancePct = row.system_qty !== 0 ? Math.abs(variance / row.system_qty) * 100 : (variance !== 0 ? 100 : 0);

  // baris ini menentukan tampilan mana yang muncul (input hitung vs keputusan),
  // jadi wajib disegarkan dari server setelah tiap aksi — bukan cuma pesan sukses
  async function run(fn: () => Promise<void>, okText: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setRow(await getCycleCount(row.id));
      setMsg({ tone: 'ok', text: okText });
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as { message?: string }).message ?? parseDbError(e).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={s.pageWide}>
      <button style={{ ...s.btnGhost, marginBottom: 14 }} onClick={onBack}>‹ Daftar hitung</button>
      <h1 style={s.h1}>{row.doc_no}</h1>
      <p style={s.sub}>
        {row.items?.name ?? '—'} · {row.handling_units?.hu_code ?? '—'} · {row.locations?.code ?? '—'}
      </p>

      {msg && <div style={msg.tone === 'ok' ? s.ok : s.err}>{msg.text}</div>}

      <div style={s.card}>
        <dl style={kv}>
          <dt>Qty sistem</dt><dd>{row.system_qty} {uom}</dd>
          <dt>Qty hitung</dt>
          <dd style={row.counted_qty != null && row.counted_qty !== row.system_qty ? { color: C.chili } : undefined}>
            {row.counted_qty != null ? `${row.counted_qty} ${uom}` : '—'}
          </dd>
          {row.counted_qty != null && (
            <>
              <dt>Selisih</dt>
              <dd style={{ color: row.counted_qty - row.system_qty === 0 ? C.ink : C.chili }}>
                {row.counted_qty - row.system_qty > 0 ? '+' : ''}{(row.counted_qty - row.system_qty).toFixed(3)} {uom}
              </dd>
            </>
          )}
        </dl>
      </div>

      {row.status === 'OPEN' && (
        <>
          <div style={s.secHead}>Input hasil hitung</div>
          <div style={{ maxWidth: 480 }}>
            <label style={s.label} htmlFor="cq">Qty hasil hitung fisik ({uom})</label>
            <input id="cq" style={s.input} type="number" inputMode="decimal" step="0.001"
                   value={countedQty} onChange={(e) => setCountedQty(e.target.value)} />
            {countedNum !== row.system_qty && (
              <div style={{ ...s.meta, color: C.chili, marginTop: 6 }}>
                Selisih {variance > 0 ? '+' : ''}{variance.toFixed(3)} {uom} ({variancePct.toFixed(1)}%)
                {variancePct > 20 ? ' — melebihi 20%, alasan wajib saat approve nanti.' : ''}
              </div>
            )}
            <button style={{ ...s.btn, opacity: busy || countedQty === '' ? 0.5 : 1 }}
                    disabled={busy || countedQty === ''}
                    onClick={() => void run(
                      () => submitCycleCount(row.id, countedNum),
                      'Hasil hitung disimpan.'
                    )}>
              {busy ? 'Menyimpan…' : 'Submit hasil hitung'}
            </button>
          </div>
        </>
      )}

      {row.status === 'COUNTED' && (
        <>
          <div style={s.secHead}>Keputusan</div>
          <div style={{ maxWidth: 480 }}>
            {!canDecide && <div style={s.empty}>Anda masuk sebagai {role}. Peran ini tidak berwenang memutuskan.</div>}
            <label style={s.label} htmlFor="reason">Alasan (wajib jika selisih &gt; 20%, atau saat reject)</label>
            <textarea id="reason" style={{ ...s.input, resize: 'vertical' }} rows={2}
                      value={reason} onChange={(e) => setReason(e.target.value)} />

            <button style={{ ...s.btn, opacity: busy ? 0.6 : 1 }} disabled={busy}
                    onClick={() => void run(
                      () => approveCycleCount(row.id, reason.trim() || undefined),
                      'Hitung disetujui — penyesuaian stok diposting.'
                    )}>
              Approve
            </button>
            <button style={{ ...s.btn, background: C.chili, opacity: busy || reason.trim().length < 8 ? 0.5 : 1 }}
                    disabled={busy || reason.trim().length < 8}
                    onClick={() => void run(
                      () => rejectCycleCount(row.id, reason.trim()),
                      'Hitung ditolak — perlu hitung ulang.'
                    )}>
              Reject (hitung ulang)
            </button>
          </div>
        </>
      )}

      {(row.status === 'APPROVED' || row.status === 'REJECTED') && (
        <div style={{ ...s.card, marginTop: 14 }}>
          <div style={s.code}>Sudah diputuskan — {row.status}</div>
          {row.remarks && <div style={s.meta}>{row.remarks}</div>}
        </div>
      )}
    </div>
  );
}

const kv: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px',
  fontSize: 12.5, fontFamily: MONO, margin: 0,
};
