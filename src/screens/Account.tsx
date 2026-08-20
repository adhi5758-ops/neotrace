/**
 * Akun Saya — layar swadaya untuk melihat email login sendiri dan ganti
 * password sendiri. Password TIDAK PERNAH bisa ditampilkan di sini atau di
 * mana pun: Supabase Auth hanya menyimpan hash satu-arah (bcrypt), bukan
 * teks asli — menampilkan "password yang dipakai" secara teknis mustahil
 * dan kalau dipaksakan (mis. simpan teks asli terpisah) itu justru celah
 * keamanan serius. Ganti password di sini mewajibkan password lama dulu
 * (re-autentikasi via signInWithPassword) supaya sesi yang tertinggal
 * terbuka di perangkat lain tidak bisa dipakai orang lain mengganti sandi.
 */
import { useState } from 'react';
import { supabase, parseDbError } from '../lib/api';
import { C, s } from '../ui';

interface Props { email?: string | null; fullName?: string | null; role?: string }

export default function Account({ email, fullName, role }: Props) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  const canSubmit = current.length > 0 && next.length >= 6 && next === confirm;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email) return;
    setBusy(true);
    setMsg(null);
    try {
      const { error: reauthErr } = await supabase.auth.signInWithPassword({ email, password: current });
      if (reauthErr) throw new Error('Password lama salah.');

      const { error: updateErr } = await supabase.auth.updateUser({ password: next });
      if (updateErr) throw updateErr;

      setMsg({ tone: 'ok', text: 'Password berhasil diganti.' });
      setCurrent(''); setNext(''); setConfirm('');
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as { message?: string }).message ?? parseDbError(e).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={s.pageForm}>
      <h1 style={s.h1}>Akun Saya</h1>
      <p style={s.sub}>Detail login &amp; ganti password</p>

      <div style={s.secHead}>Detail akun</div>
      <div style={s.card}>
        <dl style={kv}>
          <dt>Email</dt><dd>{email ?? '—'}</dd>
          <dt>Nama</dt><dd>{fullName ?? '—'}</dd>
          <dt>Peran</dt><dd>{role ?? '—'}</dd>
        </dl>
      </div>
      <p style={{ ...s.meta, marginTop: -4, marginBottom: 20 }}>
        Password tidak bisa ditampilkan di sini — Supabase hanya menyimpan hash satu-arah, bukan teks
        aslinya. Kalau lupa, ganti lewat form di bawah (perlu password lama) atau minta Administrator
        mereset akun Anda.
      </p>

      <div style={s.secHead}>Ubah password</div>
      <form onSubmit={submit}>
        <label style={s.label} htmlFor="cur">Password lama</label>
        <input id="cur" style={s.input} type="password" autoComplete="current-password"
               value={current} onChange={(e) => setCurrent(e.target.value)} />

        <label style={s.label} htmlFor="new">Password baru (minimal 6 karakter)</label>
        <input id="new" style={s.input} type="password" autoComplete="new-password"
               value={next} onChange={(e) => setNext(e.target.value)} />

        <label style={s.label} htmlFor="conf">Ulangi password baru</label>
        <input id="conf" style={s.input} type="password" autoComplete="new-password"
               value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        {confirm.length > 0 && next !== confirm && (
          <div style={{ ...s.meta, color: C.chili, marginTop: 6 }}>Password baru tidak sama.</div>
        )}

        {msg && <div style={msg.tone === 'ok' ? s.ok : s.err}>{msg.text}</div>}

        <button style={{ ...s.btn, opacity: busy || !canSubmit ? 0.5 : 1 }} disabled={busy || !canSubmit}>
          {busy ? 'Menyimpan…' : 'Ganti password'}
        </button>
      </form>
    </div>
  );
}

const kv: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px',
  fontSize: 13, margin: 0,
};
