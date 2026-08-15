/**
 * NEOTRACE — kerangka aplikasi.
 *
 * Satu shell untuk dua konteks pemakaian:
 *   · HP di lantai produksi  → navigasi bawah, target sentuh besar
 *   · desktop QA/finance     → halaman yang sama, lebar dibatasi 760px
 *
 * Gerbang akses: tanpa sesi Supabase → layar masuk. Tanpa .env → layar setup.
 */
import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import type { Session } from '@supabase/supabase-js';
import { supabase, isConfigured, openNotifications, subscribeNotifications } from './lib/api';
import { pendingCount } from './lib/offlineQueue';
import { myProfile, type Profile } from './lib/queries';
import { C, MONO, s } from './ui';

import Login from './screens/Login';
import Home from './screens/Home';
import Receive from './screens/Receive';
import Qc from './screens/Qc';
import Production from './screens/Production';
import Trace from './screens/Trace';
import Notifications from './screens/Notifications';
import Scan from './screens/Scan';
import Warehouse from './screens/Warehouse';
import Putaway from './screens/Putaway';
import Picking from './screens/Picking';
import Staging from './screens/Staging';
import WarehouseConsole from './screens/WarehouseConsole';
import Waves from './screens/Waves';
import Analytics from './screens/Analytics';

const TABS = [
  { to: '/', label: 'Beranda', end: true },
  { to: '/gudang', label: 'Gudang' },
  { to: '/qc', label: 'QC' },
  { to: '/produksi', label: 'Produksi' },
  { to: '/telusur', label: 'Telusur' },
];

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [ready, setReady] = useState(!isConfigured);
  const [unread, setUnread] = useState(0);
  const [queued, setQueued] = useState(0);

  useEffect(() => {
    if (!isConfigured) return;
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, sess) => setSession(sess));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) { setProfile(null); return; }
    void myProfile().then(setProfile).catch(() => setProfile(null));
    const refresh = () => void openNotifications().then((n) => setUnread(n.length)).catch(() => {});
    refresh();
    const chan = subscribeNotifications(refresh);
    return () => { void supabase.removeChannel(chan); };
  }, [session]);

  useEffect(() => {
    const tick = () => void pendingCount().then(setQueued).catch(() => {});
    tick();
    const t = setInterval(tick, 15_000);
    return () => clearInterval(t);
  }, []);

  if (!isConfigured) return <Setup />;
  if (!ready) return <Splash text="Memuat…" />;
  if (!session) return <Login />;

  return (
    <>
      <TopBar
        name={profile?.full_name ?? session.user.email ?? '—'}
        role={profile?.role ?? '—'}
        unread={unread}
        queued={queued}
      />
      <Routes>
        <Route path="/" element={<Home unread={unread} queued={queued} role={profile?.role} />} />
        <Route path="/pindai" element={<Scan />} />
        <Route path="/gudang" element={<Warehouse />} />
        <Route path="/terima" element={<Receive />} />
        <Route path="/putaway" element={<Putaway />} />
        <Route path="/picking" element={<Picking />} />
        <Route path="/gelombang" element={<Waves />} />
        <Route path="/staging" element={<Staging />} />
        <Route path="/konsol" element={<WarehouseConsole />} />
        <Route path="/analitik" element={<Analytics />} />
        <Route path="/qc" element={<Qc role={profile?.role} />} />
        <Route path="/produksi" element={<Production />} />
        <Route path="/telusur" element={<Trace />} />
        <Route path="/notifikasi" element={<Notifications onRead={() => setUnread((n) => Math.max(0, n - 1))} />} />
        <Route path="/h/:token" element={<Scan />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <BottomNav />
    </>
  );
}

/* ------------------------------------------------------------- potongan */

function TopBar({ name, role, unread, queued }: { name: string; role: string; unread: number; queued: number }) {
  return (
    <header style={bar.wrap}>
      <div>
        <div style={bar.brand}>NEOTRACE</div>
        <div style={bar.who}>{name} · {role}</div>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {queued > 0 && <span style={bar.queued}>{queued} antre</span>}
        <NavLink to="/notifikasi" style={bar.bell}>
          Notifikasi{unread > 0 && <span style={bar.count}>{unread}</span>}
        </NavLink>
        <button style={bar.out} onClick={() => void supabase.auth.signOut()}>Keluar</button>
      </div>
    </header>
  );
}

function BottomNav() {
  return (
    <nav style={nav.wrap}>
      {TABS.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          style={({ isActive }) => ({
            ...nav.tab,
            color: isActive ? C.neo : C.slate,
            borderTop: `3px solid ${isActive ? C.neo : 'transparent'}`,
          })}
        >
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}

function Splash({ text }: { text: string }) {
  return <div style={{ display: 'grid', placeItems: 'center', height: '100%', fontFamily: MONO, color: C.slate, fontSize: 13 }}>{text}</div>;
}

function Setup() {
  return (
    <div style={s.page}>
      <h1 style={s.h1}>Konfigurasi belum lengkap</h1>
      <p style={s.sub}>NEOTRACE · Fase 1</p>
      <div style={s.card}>
        <p style={{ fontSize: 13.5, lineHeight: 1.5, margin: 0 }}>
          Buat file <b>.env</b> di akar proyek, lalu jalankan ulang <code>npm run dev</code>:
        </p>
        <pre style={{ fontFamily: MONO, fontSize: 12, background: C.lab, padding: 12, overflowX: 'auto', border: `1px solid ${C.line}` }}>
{`VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOi...`}
        </pre>
        <p style={{ fontSize: 12.5, color: C.slate, lineHeight: 1.5, marginBottom: 0 }}>
          Skema database: jalankan <code>neotrace_schema.sql</code> lalu <code>neotrace_phase1_delta.sql</code>
          {' '}(bagian 0 terpisah dari sisanya).
        </p>
      </div>
    </div>
  );
}

const bar: Record<string, React.CSSProperties> = {
  wrap: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10,
    padding: '10px 14px', background: C.ink, color: C.lab, position: 'sticky', top: 0, zIndex: 30,
  },
  brand: { fontSize: 13, fontWeight: 800, letterSpacing: '.16em' },
  who: { fontSize: 10, fontFamily: MONO, color: '#9FB5AA', marginTop: 2 },
  queued: { fontSize: 9.5, fontFamily: MONO, color: C.amber, border: `1px solid ${C.amber}`, padding: '3px 5px' },
  bell: { fontSize: 11, color: C.lab, textDecoration: 'none', fontFamily: MONO, display: 'flex', gap: 5, alignItems: 'center' },
  count: { background: C.chili, color: '#fff', fontSize: 9.5, padding: '1px 5px', fontWeight: 700 },
  out: { background: 'none', border: `1px solid #33564A`, color: '#9FB5AA', fontSize: 10.5, padding: '5px 8px', cursor: 'pointer' },
};

const nav: Record<string, React.CSSProperties> = {
  wrap: {
    position: 'fixed', bottom: 0, left: 0, right: 0, display: 'grid',
    gridTemplateColumns: `repeat(${TABS.length}, 1fr)`, background: '#fff',
    borderTop: `1px solid ${C.line}`, zIndex: 30,
  },
  tab: {
    padding: '13px 4px calc(13px + env(safe-area-inset-bottom))', textAlign: 'center',
    fontSize: 11, fontWeight: 700, textDecoration: 'none', fontFamily: MONO, letterSpacing: '.04em',
  },
};
