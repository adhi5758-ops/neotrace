/**
 * Konsol gudang desktop (P22, P30–P32).
 *
 * Peta okupansi disusun per rak × level, bukan sebagai tabel: supervisor
 * mencari "rak mana yang penuh" secara visual, dan warna alergen harus
 * terbaca dalam sekali lihat karena itu yang memicu relokasi.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase, parseDbError } from '../lib/api';
import {
  warehouseMap, dockToStock, putawayCompliance, pickPerformance, listLocations,
  type WarehouseMapRow, type DockToStockRow, type PutawayComplianceRow,
  type PickPerformanceRow, type Location,
} from '../lib/queries';
import { listPickLists, assignPicker, type PickList } from '../lib/picking';
import { printLocationLabels } from '../lib/labels';
import { C, MONO, s, pill } from '../ui';

type Tab = 'peta' | 'dock' | 'pick' | 'label';

export default function WarehouseConsole() {
  const [tab, setTab] = useState<Tab>('peta');
  return (
    <div style={s.page}>
      <h1 style={s.h1}>Konsol gudang</h1>
      <p style={s.sub}>Okupansi rak · dock-to-stock · kepatuhan · kinerja picking</p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, marginBottom: 8 }}>
        {([['peta', 'Peta rak'], ['dock', 'Dock-to-stock'], ['pick', 'Picking'], ['label', 'Label rak']] as const)
          .map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
                    style={{ ...s.btnGhost, fontSize: 11, fontFamily: MONO, padding: '10px 4px',
                             borderColor: tab === k ? C.neo : C.line, color: tab === k ? C.neo : C.slate }}>
              {label}
            </button>
          ))}
      </div>

      {tab === 'peta' && <MapPanel />}
      {tab === 'dock' && <DockPanel />}
      {tab === 'pick' && <PickPanel />}
      {tab === 'label' && <LabelPanel />}
    </div>
  );
}

/* ---------------------------------------------------------------- peta */

function MapPanel() {
  const [rows, setRows] = useState<WarehouseMapRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    warehouseMap().then(setRows).catch((e) => setErr(parseDbError(e).message)).finally(() => setLoading(false));
  }, []);

  // rak → level → posisi. Level tinggi digambar di atas, seperti rak sebenarnya.
  const racks = useMemo(() => {
    const m = new Map<string, WarehouseMapRow[]>();
    for (const r of rows) {
      const list = m.get(r.rack_code) ?? [];
      list.push(r);
      m.set(r.rack_code, list);
    }
    return [...m.entries()].map(([rack, cells]) => ({
      rack,
      levels: [...new Set(cells.map((c) => c.level_no))].sort((a, b) => b - a),
      cells,
    }));
  }, [rows]);

  if (loading) return <div style={s.empty}>Memuat peta…</div>;
  if (err) return <div style={s.err}>{err}</div>;
  if (!rows.length) return <div style={s.empty}>Belum ada lokasi ber-rack_code. Import denah gudang dulu (P01, P06).</div>;

  return (
    <>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', margin: '4px 0 14px' }}>
        <Legend color={C.amber} text="menyimpan alergen" />
        <Legend color={C.neo} text="non-alergen" />
        <Legend color={C.line} text="kosong" />
      </div>

      {racks.map(({ rack, levels, cells }) => (
        <div key={rack} style={{ marginBottom: 18 }}>
          <div style={s.secHead}>Rak {rack}</div>
          {levels.map((lv) => (
            <div key={lv} style={{ display: 'flex', gap: 6, alignItems: 'stretch', marginBottom: 6 }}>
              <div style={{ ...s.meta, width: 30, flex: 'none', marginTop: 0, alignSelf: 'center' }}>L{lv}</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', flex: 1 }}>
                {cells.filter((c) => c.level_no === lv)
                      .sort((a, b) => (a.position_no ?? 0) - (b.position_no ?? 0))
                      .map((c) => <Cell key={c.code} cell={c} />)}
              </div>
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

function Cell({ cell }: { cell: WarehouseMapRow }) {
  const empty = !cell.current_hu_count;
  const accent = empty ? C.line : cell.holds_allergen ? C.amber : C.neo;
  const util = cell.utilisation_pct ?? 0;
  return (
    <div title={cell.contents ?? 'kosong'}
         style={{
           minWidth: 132, flex: '1 1 132px', background: '#fff',
           border: `1px solid ${C.line}`, borderTop: `3px solid ${accent}`, padding: '8px 9px',
         }}>
      <div style={{ ...s.code, fontSize: 11.5 }}>{cell.code}</div>
      <div style={{ ...s.meta, fontSize: 9.5 }}>
        {cell.current_hu_count ?? 0} kemasan · {util}%
      </div>
      <div style={{ height: 4, background: C.lab, marginTop: 5 }}>
        <div style={{ height: '100%', width: `${Math.min(100, util)}%`, background: accent }} />
      </div>
      <div style={{ ...s.meta, fontSize: 9, marginTop: 5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {cell.contents ?? '—'}
      </div>
      {cell.allergen_policy !== 'MIXED' && (
        <div style={{ ...s.meta, fontSize: 8.5, color: C.slate }}>{cell.allergen_policy}</div>
      )}
    </div>
  );
}

function Legend({ color, text }: { color: string; text: string }) {
  return (
    <span style={{ ...s.meta, marginTop: 0, display: 'flex', gap: 5, alignItems: 'center' }}>
      <span style={{ width: 14, height: 4, background: color, display: 'inline-block' }} />
      {text}
    </span>
  );
}

/* --------------------------------------------------------- dock-to-stock */

function DockPanel() {
  const [rows, setRows] = useState<DockToStockRow[]>([]);
  const [comp, setComp] = useState<PutawayComplianceRow[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([dockToStock(), putawayCompliance()])
      .then(([d, c]) => { setRows(d); setComp(c); })
      .catch((e) => setErr(parseDbError(e).message));
  }, []);

  const avg = rows.length
    ? rows.reduce((a, r) => a + (r.hours_to_stock ?? 0), 0) / rows.length
    : null;
  const overTarget = avg != null && avg > 4;   // exit criteria Fase 2: di bawah 4 jam

  if (err) return <div style={s.err}>{err}</div>;

  return (
    <>
      <div style={{ ...s.card, borderTop: `3px solid ${overTarget ? C.amber : C.neo}` }}>
        <div style={s.rowBetween}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>Rata-rata dock-to-stock</div>
          <span style={pill(overTarget ? 'warn' : 'ok')}>target &lt; 4 jam</span>
        </div>
        <div style={{ fontSize: 30, fontFamily: MONO, fontWeight: 700, color: overTarget ? C.amber : C.neo }}>
          {avg == null ? '—' : `${avg.toFixed(1)} jam`}
        </div>
        <div style={s.meta}>{rows.length} put-away terakhir</div>
      </div>

      <div style={s.secHead}>Kepatuhan put-away per minggu</div>
      {comp.length === 0 && <div style={s.empty}>Belum ada put-away selesai.</div>}
      {comp.map((c) => (
        <div key={c.week} style={{ ...s.card, ...s.rowBetween }}>
          <div>
            <div style={s.code}>{c.week.slice(0, 10)}</div>
            <div style={s.meta}>{c.tasks_done} tugas · {c.deviations} menyimpang</div>
          </div>
          <div style={{ ...s.code, color: (c.compliance_pct ?? 0) < 90 ? C.amber : C.neo }}>
            {c.compliance_pct ?? '—'}%
          </div>
        </div>
      ))}

      <div style={s.secHead}>Put-away terakhir</div>
      {rows.slice(0, 20).map((r, i) => (
        <div key={i} style={{ ...s.card, ...s.rowBetween }}>
          <div>
            <div style={s.code}>{r.item_name}</div>
            <div style={s.meta}>
              {r.receipt_no ?? 'tanpa GRN'} · {r.supplier_name ?? '—'} → {r.location_code ?? '—'}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={s.code}>{r.hours_to_stock} jam</div>
            {r.deviated && <span style={pill('warn')}>MENYIMPANG</span>}
          </div>
        </div>
      ))}
    </>
  );
}

/* ------------------------------------------------------------- picking */

function PickPanel() {
  const [perf, setPerf] = useState<PickPerformanceRow[]>([]);
  const [lists, setLists] = useState<PickList[]>([]);
  const [pickers, setPickers] = useState<{ id: string; full_name: string | null; role: string }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    Promise.all([pickPerformance(), listPickLists(true), listPickers()])
      .then(([p, l, u]) => { setPerf(p); setLists(l); setPickers(u); })
      .catch((e) => setErr(parseDbError(e).message));
  }, []);
  useEffect(load, [load]);

  if (err) return <div style={s.err}>{err}</div>;

  return (
    <>
      <div style={s.secHead}>Penugasan pick list</div>
      {lists.length === 0 && <div style={s.empty}>Tidak ada pick list terbuka.</div>}
      {lists.map((p) => (
        <div key={p.id} style={s.card}>
          <div style={s.rowBetween}>
            <div style={s.code}>{p.doc_no}</div>
            <span style={pill(p.status === 'IN_PROGRESS' ? 'warn' : 'mute')}>{p.status}</span>
          </div>
          <div style={s.meta}>
            {p.production_batches?.batch_no ?? '—'} · {p.production_batches?.items?.name ?? '—'}
          </div>
          <select
            style={{ ...s.input, marginTop: 8 }}
            value={p.assigned_to ?? ''}
            disabled={busy}
            onChange={(e) => {
              setBusy(true);
              void assignPicker(p.id, e.target.value || null)
                .then(load)
                .catch((ex) => setErr(parseDbError(ex).message))
                .finally(() => setBusy(false));
            }}
          >
            <option value="">— belum ditugaskan —</option>
            {pickers.map((u) => (
              <option key={u.id} value={u.id}>{u.full_name ?? u.id.slice(0, 8)} · {u.role}</option>
            ))}
          </select>
        </div>
      ))}

      <div style={s.secHead}>Kinerja picking</div>
      {perf.length === 0 && <div style={s.empty}>Belum ada data picking.</div>}
      {perf.map((p) => {
        const short = p.lines_short > 0;
        return (
          <div key={p.pick_list_id} style={{ ...s.card, borderTop: `3px solid ${short ? C.amber : C.line}` }}>
            <div style={s.rowBetween}>
              <div style={s.code}>{p.doc_no}</div>
              <div style={s.code}>{p.minutes_taken != null ? `${p.minutes_taken} mnt` : '—'}</div>
            </div>
            <div style={s.meta}>
              {p.batch_no ?? '—'} · {p.product_name ?? '—'} · petugas {p.picker ?? '—'}
            </div>
            <div style={s.meta}>
              {p.lines_done}/{p.total_lines} baris
              {p.lines_short > 0 ? ` · ${p.lines_short} kurang` : ''}
              {p.fefo_overrides > 0 ? ` · ${p.fefo_overrides} override FEFO` : ''}
            </div>
          </div>
        );
      })}
    </>
  );
}

/* ---------------------------------------------------------- label rak */

function LabelPanel() {
  const [locs, setLocs] = useState<Location[]>([]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    listLocations().then(setLocs).catch((e) => setErr(parseDbError(e).message));
  }, []);

  const toggle = (id: string) =>
    setSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  return (
    <>
      <p style={{ fontSize: 12.5, color: C.slate, lineHeight: 1.5 }}>
        Cetak QR untuk ditempel di rak. Label inilah yang dipindai pada langkah kedua put-away.
        Pakai stiker sintetis — area basah merusak kertas biasa.
      </p>
      {err && <div style={s.err}>{err}</div>}

      <div style={{ ...s.rowBetween, margin: '12px 0' }}>
        <span style={s.meta}>{sel.size} dipilih</span>
        <button style={s.btnGhost} onClick={() => setSel(new Set(locs.map((l) => l.id)))}>Pilih semua</button>
      </div>

      {locs.map((l) => (
        <button key={l.id}
                style={{ ...s.card, ...s.rowBetween, width: '100%', cursor: 'pointer',
                         borderColor: sel.has(l.id) ? C.neo : C.line }}
                onClick={() => toggle(l.id)}>
          <div style={{ textAlign: 'left' }}>
            <div style={s.code}>{l.code}</div>
            <div style={s.meta}>{l.name} · {l.type}</div>
          </div>
          <span style={pill(sel.has(l.id) ? 'ok' : 'mute')}>{sel.has(l.id) ? 'PILIH' : '—'}</span>
        </button>
      ))}

      <button
        style={{ ...s.btn, opacity: sel.size ? 1 : 0.5 }}
        disabled={!sel.size}
        onClick={() => {
          const chosen = locs.filter((l) => sel.has(l.id));
          void printLocationLabels(chosen.map((l) => ({ code: l.code, name: l.name })))
            .catch((e) => setErr((e as Error).message));
        }}
      >
        Cetak {sel.size} label rak
      </button>
    </>
  );
}

/* ponytail: daftar petugas diambil dari profiles aktif; kalau nanti butuh
   filter shift atau zona, tambahkan kolomnya di profiles dulu. */
async function listPickers() {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, role')
    .eq('is_active', true)
    .in('role', ['WAREHOUSE', 'OPERATOR', 'ADMIN'])
    .order('full_name');
  if (error) throw error;
  return (data ?? []) as { id: string; full_name: string | null; role: string }[];
}
