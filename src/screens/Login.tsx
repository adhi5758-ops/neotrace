import { useState } from 'react';
import { supabase } from '../lib/api';
import { C, MONO, s } from '../ui';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (error) setErr(error.message === 'Invalid login credentials'
      ? 'Email atau kata sandi salah.'
      : error.message);
    setBusy(false);
  }

  return (
    <div style={wrap}>
      <form onSubmit={submit} style={card}>
        <div style={brand}>NEOTRACE</div>
        <div style={{ ...s.sub, marginBottom: 22 }}>Neofood · Sauce Division</div>

        <label style={s.label} htmlFor="email">Email</label>
        <input
          id="email" style={s.input} type="email" required autoComplete="username"
          inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)}
        />

        <label style={s.label} htmlFor="pw">Kata sandi</label>
        <input
          id="pw" style={s.input} type="password" required autoComplete="current-password"
          value={password} onChange={(e) => setPassword(e.target.value)}
        />

        {err && <div style={s.err}>{err}</div>}

        <button style={{ ...s.btn, opacity: busy ? 0.6 : 1 }} disabled={busy}>
          {busy ? 'Memeriksa…' : 'Masuk'}
        </button>
        <p style={{ fontSize: 11, color: C.slate, fontFamily: MONO, marginTop: 16, lineHeight: 1.5 }}>
          Akun dibuat oleh admin. Hubungi supervisor bila belum punya akses.
        </p>
      </form>
    </div>
  );
}

const wrap: React.CSSProperties = {
  minHeight: '100%', display: 'grid', placeItems: 'center', padding: 20, background: C.ink,
};
const card: React.CSSProperties = {
  width: '100%', maxWidth: 380, background: '#fff', padding: '28px 24px 32px',
  borderTop: `5px solid ${C.neo}`,
};
const brand: React.CSSProperties = {
  fontSize: 22, fontWeight: 800, letterSpacing: '.18em', color: C.ink,
};
