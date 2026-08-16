/** NEOTRACE — token tampilan bersama (dipakai seluruh layar). */
import type { CSSProperties } from 'react';

export const C = {
  ink: '#0E2A20',
  neo: '#1B7A4B',
  amber: '#D0870A',
  chili: '#C13A22',
  line: '#CFDAD4',
  slate: '#6A7F76',
  lab: '#EEF3F0',
  white: '#FFFFFF',
};

export const MONO = 'var(--font-code)';

export const s: Record<string, CSSProperties> = {
  page: { padding: 16, paddingBottom: 88, minHeight: '100%', maxWidth: 760, margin: '0 auto' },
  /** Layar desktop: konsol, dasbor, daftar tugas untuk supervisor/QA/planner —
   *  bukan layar pindai HP. Lebih lebar supaya lebih banyak info per layar. */
  pageWide: { padding: '20px 24px 60px', minHeight: '100%', maxWidth: 1400, margin: '0 auto' },
  /** Layar formulir desktop (Terima bahan): lebih lega dari HP tapi tetap
   *  dibatasi supaya baris teks tidak melebar tak terbaca. */
  pageForm: { padding: '20px 24px 60px', minHeight: '100%', maxWidth: 900, margin: '0 auto' },
  /** Grid kartu responsif — 1 kolom di layar sempit, otomatis bertambah kolom
   *  di layar lebar. Tidak perlu media query: auto-fill yang mengurus. */
  cardGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 10, alignItems: 'start' },
  h1: { fontSize: 20, fontWeight: 800, color: C.ink, margin: '0 0 4px' },
  sub: { fontSize: 12, color: C.slate, fontFamily: MONO, margin: '0 0 18px' },
  secHead: {
    fontSize: 10, letterSpacing: '.14em', textTransform: 'uppercase',
    color: C.slate, fontFamily: MONO, margin: '20px 0 8px',
  },
  card: { background: C.white, border: `1px solid ${C.line}`, padding: '12px 14px', marginBottom: 8 },
  rowBetween: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 },
  code: { fontFamily: MONO, fontSize: 13, fontWeight: 600, color: C.ink },
  meta: { fontFamily: MONO, fontSize: 10.5, color: C.slate, marginTop: 3 },
  label: { display: 'block', fontSize: 11, color: C.slate, fontFamily: MONO, marginBottom: 4, marginTop: 12 },
  input: { width: '100%', padding: 11, border: `1px solid ${C.line}`, background: C.white, fontSize: 14 },
  btn: {
    width: '100%', padding: 15, background: C.neo, color: '#fff', border: 'none',
    fontSize: 14, fontWeight: 700, cursor: 'pointer', marginTop: 16,
  },
  btnGhost: {
    padding: '11px 14px', background: 'transparent', color: C.ink,
    border: `1px solid ${C.line}`, fontSize: 13, fontWeight: 600, cursor: 'pointer',
  },
  err: {
    fontSize: 12.5, color: C.chili, background: C.white,
    border: `1px solid ${C.chili}`, padding: '10px 12px', margin: '12px 0',
  },
  ok: {
    fontSize: 12.5, color: C.neo, background: C.white,
    border: `1px solid ${C.neo}`, padding: '10px 12px', margin: '12px 0',
  },
  empty: { fontSize: 12.5, color: C.slate, padding: '14px 0' },
  grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 },
};

export function pill(tone: 'ok' | 'warn' | 'bad' | 'mute'): CSSProperties {
  const color = { ok: C.neo, warn: C.amber, bad: C.chili, mute: C.slate }[tone];
  return {
    fontSize: 9.5, fontFamily: MONO, letterSpacing: '.08em', color,
    border: `1px solid ${color}`, padding: '3px 6px', whiteSpace: 'nowrap',
  };
}

/** Nada status lot untuk pewarnaan konsisten di semua layar. */
export function lotTone(status?: string): 'ok' | 'warn' | 'bad' | 'mute' {
  switch (status) {
    case 'RELEASED': return 'ok';
    case 'QUARANTINE': return 'warn';
    case 'HOLD':
    case 'BLOCKED': return 'bad';
    default: return 'mute';
  }
}
