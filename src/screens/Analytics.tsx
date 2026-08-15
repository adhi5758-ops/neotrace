/**
 * Konsol analitik & integrasi (W13–W15 Fase 3, E10 & E16 Fase 4).
 *
 * Lima tab untuk manajemen, planner, dan admin. Dipisah dari konsol gudang
 * karena pembacanya berbeda: yang di sini melihat tren, bukan tugas hari ini.
 *
 * Dua aturan yang dibawa dari RAID:
 *   R32 — KPI tim adalah tampilan utama; angka per orang ada di bawahnya dan
 *         diberi label sebagai bahan coaching, bukan penilaian.
 *   R44 — saran reorder disembunyikan untuk item yang datanya belum cukup.
 */
import { useCallback, useEffect, useState } from 'react';
import { parseDbError } from '../lib/api';
import {
  opsScorecard, inventoryTurnover, slowMoving, warehouseUtilisation,
  teamKpi, labourKpi, pickAccuracy, wavePerformance, runAbcClassification,
} from '../lib/api-phase3';
import {
  syncHealth, outboxRows, requeueMessage, skipMessage, reclaimStuck,
  forecasts, runForecast, backfillActuals, forecastAccuracy, reorderSuggestions,
  MIN_PERIODS_FOR_REORDER,
  type SyncHealthRow, type OutboxRow, type ForecastRow, type ForecastAccuracyRow, type ReorderRow,
} from '../lib/api-phase4';
import { activeSessions, forceEndSession, isStaleSession, sessionAgeHours, type ActiveSession } from '../lib/labour';
import { C, MONO, s, pill } from '../ui';

type Tab = 'skor' | 'perputaran' | 'tenaga' | 'ramalan' | 'sinkron';

const TABS: [Tab, string][] = [
  ['skor', 'Scorecard'],
  ['perputaran', 'Perputaran'],
  ['tenaga', 'Tenaga kerja'],
  ['ramalan', 'Peramalan'],
  ['sinkron', 'Sinkronisasi'],
];

export default function Analytics() {
  const [tab, setTab] = useState<Tab>('skor');
  return (
    <div style={s.page}>
      <h1 style={s.h1}>Analitik</h1>
      <p style={s.sub}>Perputaran · produktivitas · peramalan · integrasi ERP</p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 5, marginBottom: 8 }}>
        {TABS.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
                  style={{ ...s.btnGhost, fontSize: 10, fontFamily: MONO, padding: '10px 2px',
                           borderColor: tab === k ? C.neo : C.line, color: tab === k ? C.neo : C.slate }}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'skor' && <Scorecard />}
      {tab === 'perputaran' && <Turnover />}
      {tab === 'tenaga' && <Labour />}
      {tab === 'ramalan' && <Forecast />}
      {tab === 'sinkron' && <Sync />}
    </div>
  );
}

/* ------------------------------------------------------------- scorecard */

function Scorecard() {
  const [card, setCard] = useState<Awaited<ReturnType<typeof opsScorecard>> | null>(null);
  const [util, setUtil] = useState<Awaited<ReturnType<typeof warehouseUtilisation>>>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    opsScorecard().then(setCard).catch((e) => setErr(parseDbError(e).message));
    warehouseUtilisation().then(setUtil).catch(() => setUtil([]));
  }, []);

  if (err) return <div style={s.err}>{err}</div>;
  if (!card) return <div style={s.empty}>Memuat scorecard…</div>;

  return (
    <>
      <div style={s.secHead}>Pekerjaan terbuka</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
        <Stat label="Put-away" value={card.open_putaway} />
        <Stat label="Pick list" value={card.open_picks} />
        <Stat label="Gelombang" value={card.open_waves} />
      </div>

      <div style={s.secHead}>Kualitas proses</div>
      <Metric label="Dock-to-stock rata-rata" value={card.avg_dock_to_stock_hours} unit="jam"
              good={(v) => v <= 4} note="target Fase 2: di bawah 4 jam" />
      <Metric label="Kepatuhan put-away" value={card.putaway_compliance_pct} unit="%"
              good={(v) => v >= 90} note="penempatan sesuai saran sistem" />
      <Metric label="Kepatuhan FEFO" value={card.fefo_compliance_pct} unit="%"
              good={(v) => v >= 95} note="pengambilan tanpa override" />
      <Metric label="Baris per jam (wave)" value={card.avg_wave_lines_per_hour} unit="baris/jam"
              good={() => true} note="bandingkan dengan baseline discrete (W01)" />

      <div style={s.secHead}>Persediaan</div>
      <Metric label="Barang mati" value={card.slow_moving_items} unit="item"
              good={(v) => v === 0} note="tidak bergerak lebih dari 90 hari" />
      <div style={s.card}>
        <div style={s.meta}>Nilai persediaan</div>
        <div style={{ fontSize: 24, fontFamily: MONO, fontWeight: 700 }}>
          Rp {card.total_inventory_value?.toLocaleString('id-ID') ?? '—'}
        </div>
      </div>

      <div style={s.secHead}>Utilisasi gudang</div>
      {util.length === 0 && <div style={s.empty}>Belum ada data lokasi.</div>}
      {(util as Record<string, number | string | null>[]).map((u, i) => (
        <div key={i} style={{ ...s.card, ...s.rowBetween }}>
          <div>
            <div style={s.code}>{String(u.rack_code ?? u.type)}</div>
            <div style={s.meta}>
              {u.location_count} lokasi · {u.empty_locations} kosong · {u.near_full} hampir penuh
            </div>
          </div>
          <div style={{ ...s.code, color: Number(u.occupancy_pct) > 90 ? C.amber : C.ink }}>
            {u.occupancy_pct ?? '—'}%
          </div>
        </div>
      ))}
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ ...s.card, textAlign: 'center', marginBottom: 0 }}>
      <div style={{ fontSize: 26, fontFamily: MONO, fontWeight: 700, color: value > 0 ? C.ink : C.slate }}>
        {value}
      </div>
      <div style={{ ...s.meta, marginTop: 2 }}>{label}</div>
    </div>
  );
}

function Metric({ label, value, unit, good, note }: {
  label: string; value: number | null; unit: string; good: (v: number) => boolean; note: string;
}) {
  const ok = value != null && good(value);
  return (
    <div style={{ ...s.card, borderTop: `3px solid ${value == null ? C.line : ok ? C.neo : C.amber}` }}>
      <div style={s.rowBetween}>
        <div style={{ fontSize: 13.5, fontWeight: 700 }}>{label}</div>
        <div style={{ ...s.code, fontSize: 16, color: value == null ? C.slate : ok ? C.neo : C.amber }}>
          {value ?? '—'} <span style={{ fontSize: 10, color: C.slate }}>{unit}</span>
        </div>
      </div>
      <div style={s.meta}>{note}</div>
    </div>
  );
}

/* ------------------------------------------------------------ perputaran */

function Turnover() {
  const [rows, setRows] = useState<Record<string, string | number | null>[]>([]);
  const [slow, setSlow] = useState<Record<string, string | number | null>[]>([]);
  const [cls, setCls] = useState<'' | 'A' | 'B' | 'C'>('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void inventoryTurnover(cls || undefined)
      .then((d) => setRows(d as Record<string, string | number | null>[]))
      .catch((e) => setMsg(parseDbError(e).message));
    void slowMoving()
      .then((d) => setSlow(d as Record<string, string | number | null>[]))
      .catch(() => setSlow([]));
  }, [cls]);
  useEffect(load, [load]);

  return (
    <>
      {msg && <div style={s.err}>{msg}</div>}
      <div style={{ ...s.card, borderTop: `3px solid ${C.amber}` }}>
        <div style={s.meta}>
          RAID R34 — klasifikasi ABC bersifat indikatif sampai data pemakaian 12 bulan penuh
          tersedia. Validasi bersama planner sebelum dipakai mengambil keputusan.
        </div>
        <button style={{ ...s.btnGhost, width: '100%', marginTop: 10 }} disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void runAbcClassification()
                    .then((n) => { setMsg(`${n} item diklasifikasi ulang.`); load(); })
                    .catch((e) => setMsg(parseDbError(e).message))
                    .finally(() => setBusy(false));
                }}>
          {busy ? 'Menghitung…' : 'Jalankan klasifikasi ABC'}
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 5, margin: '12px 0' }}>
        {(['', 'A', 'B', 'C'] as const).map((k) => (
          <button key={k} onClick={() => setCls(k)}
                  style={{ ...s.btnGhost, fontFamily: MONO, fontSize: 11, padding: '8px 4px',
                           borderColor: cls === k ? C.neo : C.line, color: cls === k ? C.neo : C.slate }}>
            {k === '' ? 'Semua' : `Kelas ${k}`}
          </button>
        ))}
      </div>

      <div style={s.secHead}>Perputaran & hari persediaan</div>
      {rows.length === 0 && <div style={s.empty}>Belum ada data pemakaian.</div>}
      {rows.slice(0, 40).map((r, i) => {
        const doh = Number(r.days_on_hand);
        return (
          <div key={i} style={s.card}>
            <div style={s.rowBetween}>
              <div style={s.code}>{r.code}</div>
              <span style={pill(r.abc_class === 'A' ? 'ok' : r.abc_class === 'B' ? 'warn' : 'mute')}>
                {r.abc_class ?? 'belum'}
              </span>
            </div>
            <div style={s.meta}>{r.name}</div>
            <dl style={kv}>
              <dt>Perputaran</dt><dd>{r.turnover_ratio ?? '—'} ×/tahun</dd>
              <dt>Hari persediaan</dt>
              <dd style={{ color: doh > 180 ? C.amber : C.ink }}>{r.days_on_hand ?? '—'}</dd>
              <dt>Nilai stok</dt><dd>Rp {Number(r.value_on_hand ?? 0).toLocaleString('id-ID')}</dd>
            </dl>
          </div>
        );
      })}

      <div style={s.secHead}>Barang mati ({slow.length})</div>
      {slow.length === 0 && <div style={s.empty}>Tidak ada barang mati. Bagus.</div>}
      {slow.map((r, i) => (
        <div key={i} style={{ ...s.card, borderTop: `3px solid ${C.chili}` }}>
          <div style={s.rowBetween}>
            <div style={s.code}>{r.code}</div>
            <div style={{ ...s.code, color: C.chili }}>{r.days_since_movement} hari</div>
          </div>
          <div style={s.meta}>
            {r.name} · {r.qty_on_hand} unit · Rp {Number(r.value_on_hand ?? 0).toLocaleString('id-ID')}
            {r.nearest_expiry ? ` · exp terdekat ${r.nearest_expiry}` : ''}
          </div>
        </div>
      ))}
    </>
  );
}

/* ---------------------------------------------------------- tenaga kerja */

const monthAgo = () => new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);

function Labour() {
  const [team, setTeam] = useState<Awaited<ReturnType<typeof teamKpi>>>([]);
  const [individual, setIndividual] = useState<Record<string, string | number | null>[]>([]);
  const [waves, setWaves] = useState<Record<string, string | number | null>[]>([]);
  const [accuracy, setAccuracy] = useState<Record<string, string | number | null>[]>([]);
  const [active, setActive] = useState<ActiveSession[]>([]);
  const [showIndividual, setShowIndividual] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    const from = monthAgo();
    const to = today();
    void teamKpi(from, to).then(setTeam).catch((e) => setErr(parseDbError(e).message));
    void labourKpi(from, to).then((d) => setIndividual(d as Record<string, string | number | null>[])).catch(() => {});
    void wavePerformance().then((d) => setWaves(d as Record<string, string | number | null>[])).catch(() => {});
    void pickAccuracy(from).then((d) => setAccuracy(d as Record<string, string | number | null>[])).catch(() => {});
    void activeSessions().then(setActive).catch(() => setActive([]));
  }, []);
  useEffect(load, [load]);

  return (
    <>
      {err && <div style={s.err}>{err}</div>}

      <div style={s.secHead}>Sedang berjalan ({active.length})</div>
      {active.length === 0 && <div style={s.empty}>Tidak ada sesi kerja terbuka.</div>}
      {active.map((a) => {
        const stale = isStaleSession(a.started_at);
        return (
          <div key={a.id} style={{ ...s.card, borderTop: `3px solid ${stale ? C.amber : C.neo}` }}>
            <div style={s.rowBetween}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>{a.profiles?.full_name ?? a.user_id.slice(0, 8)}</div>
              <span style={pill(stale ? 'warn' : 'ok')}>{a.task_type}</span>
            </div>
            <div style={s.meta}>
              {a.reference_no ?? 'tanpa referensi'} · {sessionAgeHours(a.started_at).toFixed(1)} jam
              {stale ? ' · sesi menggantung' : ''}
            </div>
            {stale && (
              <button style={{ ...s.btnGhost, width: '100%', marginTop: 8, borderColor: C.amber, color: C.amber }}
                      onClick={() => void forceEndSession(a.id).then(load)}>
                Tutup paksa sesi
              </button>
            )}
          </div>
        );
      })}

      <div style={s.secHead}>KPI tim · 30 hari</div>
      {team.length === 0 && <div style={s.empty}>Belum ada sesi kerja tercatat.</div>}
      {team.map((t) => (
        <div key={t.task_type} style={s.card}>
          <div style={s.rowBetween}>
            <div style={s.code}>{t.task_type}</div>
            <div style={s.code}>{t.lines_per_hour ?? '—'} baris/jam</div>
          </div>
          <div style={s.meta}>
            {t.people} orang · {t.total_hours} jam · {t.total_lines} baris
          </div>
        </div>
      ))}

      <div style={s.secHead}>Kinerja gelombang</div>
      {waves.length === 0 && <div style={s.empty}>Belum ada gelombang selesai.</div>}
      {waves.slice(0, 15).map((w, i) => (
        <div key={i} style={{ ...s.card, ...s.rowBetween }}>
          <div>
            <div style={s.code}>{w.wave_no}</div>
            <div style={s.meta}>
              {w.batches} batch · {w.total_lines} baris · {w.stops} perhentian · {w.picker ?? '—'}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={s.code}>{w.lines_per_hour ?? '—'}</div>
            <div style={{ ...s.meta, marginTop: 0 }}>baris/jam</div>
          </div>
        </div>
      ))}

      <div style={{ ...s.card, borderTop: `3px solid ${C.amber}`, marginTop: 18 }}>
        <div style={s.meta}>
          RAID R32 — angka per individu adalah bahan coaching, bukan dasar sanksi.
          Bandingkan tren orang terhadap dirinya sendiri, bukan peringkat antar petugas.
        </div>
        <button style={{ ...s.btnGhost, width: '100%', marginTop: 10 }}
                onClick={() => setShowIndividual((v) => !v)}>
          {showIndividual ? 'Sembunyikan angka per orang' : 'Tampilkan angka per orang'}
        </button>
      </div>

      {showIndividual && (
        <>
          <div style={s.secHead}>Per petugas · 30 hari</div>
          {individual.slice(0, 40).map((r, i) => (
            <div key={i} style={{ ...s.card, ...s.rowBetween }}>
              <div>
                <div style={s.code}>{r.full_name ?? '—'}</div>
                <div style={s.meta}>{r.task_type} · {String(r.day).slice(0, 10)} · {r.total_min} menit</div>
              </div>
              <div style={s.code}>{r.lines_per_hour ?? '—'}</div>
            </div>
          ))}

          <div style={s.secHead}>Akurasi pick per minggu</div>
          {accuracy.slice(0, 20).map((r, i) => (
            <div key={i} style={s.card}>
              <div style={s.rowBetween}>
                <div style={s.code}>{r.full_name ?? '—'}</div>
                <div style={s.code}>{r.suggestion_match_pct ?? '—'}% sesuai saran</div>
              </div>
              <div style={s.meta}>
                {String(r.week).slice(0, 10)} · {r.lines_picked} baris · {r.lines_short} kurang ·
                {' '}{r.fefo_overrides} override FEFO
              </div>
            </div>
          ))}
        </>
      )}
    </>
  );
}

/* -------------------------------------------------------------- ramalan */

function Forecast() {
  const [rows, setRows] = useState<ForecastRow[]>([]);
  const [acc, setAcc] = useState<ForecastAccuracyRow[]>([]);
  const [reorder, setReorder] = useState<ReorderRow[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void forecasts().then(setRows).catch((e) => setMsg(parseDbError(e).message));
    void forecastAccuracy().then(setAcc).catch(() => setAcc([]));
    void reorderSuggestions().then(setReorder).catch(() => setReorder([]));
  }, []);
  useEffect(load, [load]);

  // R44: sembunyikan saran untuk item yang periode historisnya belum cukup
  const periodsFor = (code: string) => acc.find((a) => a.item_code === code)?.periods ?? 0;
  const trusted = reorder.filter((r) => periodsFor(r.code) >= MIN_PERIODS_FOR_REORDER);
  const untrusted = reorder.filter((r) => periodsFor(r.code) < MIN_PERIODS_FOR_REORDER);

  return (
    <>
      {msg && <div style={s.ok}>{msg}</div>}

      <div style={s.grid2}>
        <button style={{ ...s.btnGhost }} disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void runForecast(3)
                    .then((n) => { setMsg(`${n} ramalan diperbarui.`); load(); })
                    .catch((e) => setMsg(parseDbError(e).message))
                    .finally(() => setBusy(false));
                }}>
          Jalankan peramalan
        </button>
        <button style={{ ...s.btnGhost }} disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void backfillActuals()
                    .then((n) => { setMsg(`${n} realisasi diisi.`); load(); })
                    .catch((e) => setMsg(parseDbError(e).message))
                    .finally(() => setBusy(false));
                }}>
          Isi realisasi
        </button>
      </div>

      <div style={s.secHead}>Saran pemesanan ulang</div>
      {reorder.length === 0 && (
        <div style={s.empty}>Belum ada item dengan titik pemesanan ulang. Isi tabel reorder_points (E17).</div>
      )}
      {trusted.filter((r) => r.needs_reorder).map((r) => (
        <div key={r.code} style={{ ...s.card, borderTop: `3px solid ${C.chili}` }}>
          <div style={s.rowBetween}>
            <div style={s.code}>{r.code}</div>
            <span style={pill('bad')}>PESAN SEKARANG</span>
          </div>
          <div style={s.meta}>{r.name}</div>
          <dl style={kv}>
            <dt>Stok</dt><dd>{r.qty_on_hand}</dd>
            <dt>Titik pesan</dt><dd>{r.reorder_level}</dd>
            <dt>Ramalan bulan depan</dt><dd>{r.forecast_next_month}</dd>
            <dt>Cukup untuk</dt><dd>{r.days_of_cover ?? '—'} hari</dd>
            <dt>Lead time</dt><dd>{r.lead_time_days} hari</dd>
          </dl>
        </div>
      ))}
      {trusted.filter((r) => !r.needs_reorder).length > 0 && (
        <div style={s.empty}>
          {trusted.filter((r) => !r.needs_reorder).length} item lain masih di atas titik pesan.
        </div>
      )}

      {untrusted.length > 0 && (
        <div style={{ ...s.card, borderTop: `3px solid ${C.amber}` }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: C.amber }}>
            {untrusted.length} item disembunyikan
          </div>
          <div style={s.meta}>
            RAID R44 — datanya belum {MIN_PERIODS_FOR_REORDER} periode, jadi saran pemesanannya belum
            boleh dipakai sebagai angka perencanaan. Item: {untrusted.map((r) => r.code).join(', ')}
          </div>
        </div>
      )}

      <div style={s.secHead}>Akurasi peramalan</div>
      {acc.length === 0 && <div style={s.empty}>Belum ada periode dengan realisasi terisi.</div>}
      {acc.map((a, i) => {
        const bad = (a.mape_pct ?? 0) > 30;
        return (
          <div key={i} style={{ ...s.card, ...s.rowBetween }}>
            <div>
              <div style={s.code}>{a.item_code}</div>
              <div style={s.meta}>
                {a.item_name} · {a.periods} periode · bias {a.bias ?? '—'}
              </div>
            </div>
            <div style={{ ...s.code, color: bad ? C.amber : C.neo }}>
              MAPE {a.mape_pct ?? '—'}%
            </div>
          </div>
        );
      })}

      <div style={s.secHead}>Ramalan terbit</div>
      {rows.length === 0 && <div style={s.empty}>Belum ada ramalan. Jalankan peramalan di atas.</div>}
      {rows.slice(0, 30).map((f) => (
        <div key={f.id} style={s.card}>
          <div style={s.rowBetween}>
            <div style={s.code}>{f.items?.code ?? '—'}</div>
            <div style={s.code}>{f.forecast_qty} {f.items?.base_uom ?? ''}</div>
          </div>
          <div style={s.meta}>
            {f.items?.name} · {f.period_start} … {f.period_end} · {f.method}
            {f.confidence_low != null ? ` · rentang ${f.confidence_low}–${f.confidence_high}` : ''}
            {f.actual_qty != null ? ` · realisasi ${f.actual_qty}` : ''}
          </div>
        </div>
      ))}
    </>
  );
}

/* ----------------------------------------------------------- sinkronisasi */

function Sync() {
  const [health, setHealth] = useState<SyncHealthRow[]>([]);
  const [rows, setRows] = useState<OutboxRow[]>([]);
  const [filter, setFilter] = useState<'DEAD' | 'FAILED' | 'PENDING' | ''>('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void syncHealth().then(setHealth).catch((e) => setMsg(parseDbError(e).message));
    void outboxRows(filter || undefined).then(setRows).catch(() => setRows([]));
  }, [filter]);
  useEffect(load, [load]);

  async function act(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    try { await fn(); setMsg(ok); load(); }
    catch (e) { setMsg(parseDbError(e).message); }
    finally { setBusy(false); }
  }

  const totalDead = health.reduce((a, h) => a + Number(h.dead ?? 0), 0);

  return (
    <>
      {msg && <div style={s.ok}>{msg}</div>}
      {health.length === 0 && (
        <div style={s.empty}>
          Belum ada endpoint integrasi. Daftarkan ERP di tabel integration_endpoints (E04).
        </div>
      )}

      {totalDead > 0 && (
        <div style={{ ...s.card, borderTop: `3px solid ${C.chili}` }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: C.chili }}>{totalDead} pesan mati</div>
          <div style={s.meta}>
            Pesan berhenti setelah percobaan maksimum. Harus ditangani manual — dokumen ini
            belum sampai ke ERP.
          </div>
        </div>
      )}

      {health.map((h) => (
        <div key={h.endpoint} style={{ ...s.card, borderTop: `3px solid ${h.dead > 0 ? C.chili : h.failed > 0 ? C.amber : C.neo}` }}>
          <div style={s.rowBetween}>
            <div style={s.code}>{h.endpoint}</div>
            <span style={pill(h.dead > 0 ? 'bad' : h.failed > 0 ? 'warn' : 'ok')}>{h.direction}</span>
          </div>
          <dl style={kv}>
            <dt>Menunggu</dt><dd>{h.pending}</dd>
            <dt>Gagal</dt><dd style={{ color: h.failed > 0 ? C.amber : C.ink }}>{h.failed}</dd>
            <dt>Mati</dt><dd style={{ color: h.dead > 0 ? C.chili : C.ink }}>{h.dead}</dd>
            <dt>Sukses 24 jam</dt><dd>{h.acked_24h}</dd>
            <dt>Ack terakhir</dt><dd>{h.last_ack?.slice(0, 16).replace('T', ' ') ?? '—'}</dd>
          </dl>
          {h.last_error && <div style={{ ...s.meta, color: C.chili }}>{h.last_error}</div>}
        </div>
      ))}

      <button style={{ ...s.btnGhost, width: '100%', marginTop: 8 }} disabled={busy}
              onClick={() => void act(async () => {
                const n = await reclaimStuck();
                setMsg(`${n} pesan macet dikembalikan ke antrean.`);
              }, 'Selesai.')}>
        Lepas klaim worker yang macet
      </button>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 5, margin: '14px 0 8px' }}>
        {(['', 'PENDING', 'FAILED', 'DEAD'] as const).map((k) => (
          <button key={k} onClick={() => setFilter(k)}
                  style={{ ...s.btnGhost, fontFamily: MONO, fontSize: 10, padding: '8px 2px',
                           borderColor: filter === k ? C.neo : C.line, color: filter === k ? C.neo : C.slate }}>
            {k === '' ? 'Semua' : k}
          </button>
        ))}
      </div>

      {rows.length === 0 && <div style={s.empty}>Antrean kosong.</div>}
      {rows.map((r) => (
        <div key={r.id} style={s.card}>
          <div style={s.rowBetween}>
            <div style={s.code}>{r.entity_type} · {r.operation}</div>
            <span style={pill(r.status === 'ACKED' ? 'ok' : r.status === 'DEAD' ? 'bad' : r.status === 'FAILED' ? 'warn' : 'mute')}>
              {r.status}
            </span>
          </div>
          <div style={s.meta}>
            {r.integration_endpoints?.code ?? '—'} · percobaan {r.attempts} ·
            {' '}{r.created_at.slice(0, 16).replace('T', ' ')}
            {r.external_id ? ` · ERP ${r.external_id}` : ''}
          </div>
          <div style={{ ...s.meta, fontSize: 9.5 }}>key {r.idempotency_key}</div>
          {r.last_error && <div style={{ ...s.meta, color: C.chili }}>{r.last_error}</div>}
          {(r.status === 'DEAD' || r.status === 'FAILED') && (
            <div style={{ ...s.grid2, marginTop: 8 }}>
              <button style={{ ...s.btnGhost, borderColor: C.neo, color: C.neo }} disabled={busy}
                      onClick={() => void act(() => requeueMessage(r.id), `Pesan ${r.id} diantre ulang.`)}>
                Kirim ulang
              </button>
              <button style={{ ...s.btnGhost, borderColor: C.chili, color: C.chili }} disabled={busy}
                      onClick={() => {
                        const reason = prompt('Alasan melewati pesan ini?');
                        if (!reason || reason.trim().length < 4) return;
                        void act(() => skipMessage(r.id, reason.trim()), `Pesan ${r.id} dilewati.`);
                      }}>
                Lewati
              </button>
            </div>
          )}
        </div>
      ))}
    </>
  );
}

const kv: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '5px 14px',
  fontSize: 12, fontFamily: MONO, margin: '8px 0 0',
};
