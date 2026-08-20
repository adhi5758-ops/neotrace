/**
 * Menu Administrator — peran/hak akses WMS (dari matriks CSV), manajemen
 * peran pengguna, dan data induk lewat unggah Excel.
 *
 * Gerbang akses sesungguhnya ada di database (RLS: hanya profiles.role =
 * 'ADMIN' boleh menulis wms_roles/wms_modules/wms_role_permissions dan
 * mengubah profiles orang lain). Layar ini juga disembunyikan dari Beranda
 * untuk peran selain ADMIN — dua lapis, bukan satu.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase, parseDbError } from '../lib/api';
import {
  listWmsRoles, listWmsModules, listWmsPermissions, setPermission,
  listUsers, setUserRole, setUserWmsRole, setUserActive, createUser, resetUserPassword, APP_ROLES,
  type WmsRole, type WmsModule, type WmsRolePermission, type PermissionLevel, type UserRow, type NewUserInput,
} from '../lib/admin';
import { MASTER_TABLES, coerceRow, type MasterTableConfig } from '../lib/masterData';
import { parseExcelFile, downloadTemplate } from '../lib/excel';
import { listItems, type Item } from '../lib/queries';
import { C, MONO, s, pill } from '../ui';

type Tab = 'pengguna' | 'akses' | 'induk' | 'uom';
const TABS: [Tab, string][] = [
  ['pengguna', 'Pengguna'], ['akses', 'Hak akses'], ['induk', 'Data induk'], ['uom', 'Konversi UOM'],
];

export default function Admin() {
  const [tab, setTab] = useState<Tab>('pengguna');
  return (
    <div style={s.pageWide}>
      <h1 style={s.h1}>Administrator</h1>
      <p style={s.sub}>Pengguna · hak akses WMS · data induk</p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(140px, 220px))', gap: 6, marginBottom: 8 }}>
        {TABS.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
                  style={{ ...s.btnGhost, fontSize: 11, fontFamily: MONO, padding: '10px 4px',
                           borderColor: tab === k ? C.neo : C.line, color: tab === k ? C.neo : C.slate }}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'pengguna' && <Users />}
      {tab === 'akses' && <Permissions />}
      {tab === 'induk' && <MasterData />}
      {tab === 'uom' && <UomConversions />}
    </div>
  );
}

/* --------------------------------------------------------------- pengguna */

function Users() {
  const [rows, setRows] = useState<UserRow[]>([]);
  const [roles, setRoles] = useState<WmsRole[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [resettingId, setResettingId] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.all([listUsers(), listWmsRoles()])
      .then(([u, r]) => { setRows(u); setRoles(r); })
      .catch((e) => setErr(parseDbError(e).message));
  }, []);
  useEffect(load, [load]);

  async function change(id: string, fn: () => Promise<void>) {
    setBusyId(id); setErr(null);
    try { await fn(); load(); } catch (e) { setErr(parseDbError(e).message); } finally { setBusyId(null); }
  }

  return (
    <>
      {err && <div style={s.err}>{err}</div>}

      {!showAdd && (
        <button style={{ ...s.btn, maxWidth: 320 }} onClick={() => setShowAdd(true)}>
          + Tambah pengguna baru
        </button>
      )}
      {showAdd && (
        <AddUser roles={roles} onCancel={() => setShowAdd(false)}
                 onCreated={() => { setShowAdd(false); load(); }} />
      )}

      <div style={s.cardGrid}>
        {rows.map((u) => (
          <div key={u.id} style={{ ...s.card, marginBottom: 0 }}>
            <div style={s.rowBetween}>
              <div>
                <div style={s.code}>{u.full_name ?? u.id.slice(0, 8)}</div>
                <div style={s.meta}>{u.employee_no ?? '—'} · {u.department ?? '—'}</div>
              </div>
              <span style={pill(u.is_active ? 'ok' : 'bad')}>{u.is_active ? 'AKTIF' : 'NONAKTIF'}</span>
            </div>

            <div style={s.grid2}>
              <div>
                <label style={s.label} htmlFor={`role-${u.id}`}>Peran aplikasi</label>
                <select id={`role-${u.id}`} style={s.input} value={u.role} disabled={busyId === u.id}
                        onChange={(e) => void change(u.id, () => setUserRole(u.id, e.target.value))}>
                  {APP_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <div>
                <label style={s.label} htmlFor={`wms-${u.id}`}>Peran WMS (matriks)</label>
                <select id={`wms-${u.id}`} style={s.input} value={u.wms_role_id ?? ''} disabled={busyId === u.id}
                        onChange={(e) => void change(u.id, () => setUserWmsRole(u.id, e.target.value || null))}>
                  <option value="">— belum ditetapkan —</option>
                  {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </div>
            </div>

            <div style={{ ...s.grid2, marginTop: 8 }}>
              <button style={s.btnGhost} disabled={busyId === u.id}
                      onClick={() => void change(u.id, () => setUserActive(u.id, !u.is_active))}>
                {u.is_active ? 'Nonaktifkan' : 'Aktifkan'}
              </button>
              <button style={s.btnGhost} disabled={busyId === u.id}
                      onClick={() => setResettingId(resettingId === u.id ? null : u.id)}>
                {resettingId === u.id ? 'Batal' : 'Reset password'}
              </button>
            </div>

            {resettingId === u.id && (
              <ResetPasswordForm userId={u.id} onDone={() => setResettingId(null)} />
            )}
          </div>
        ))}
      </div>
    </>
  );
}

/** Admin menetapkan langsung password baru — beda dari Akun Saya (Account.tsx)
 * yang mewajibkan password lama; di sini admin tak perlu tahu password lama
 * pengguna itu sama sekali. Password baru tidak pernah bisa "dilihat lagi"
 * setelah form ini ditutup, sama seperti password mana pun di sistem ini. */
function ResetPasswordForm({ userId, onDone }: { userId: string; onDone: () => void }) {
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  const canSubmit = pw.length >= 6 && pw === confirm;

  async function submit() {
    setBusy(true);
    setMsg(null);
    try {
      await resetUserPassword(userId, pw);
      setMsg({ tone: 'ok', text: 'Password berhasil direset.' });
      setPw(''); setConfirm('');
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as { message?: string }).message ?? parseDbError(e).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${C.line}` }}>
      <label style={s.label} htmlFor={`pw-${userId}`}>Password baru (minimal 6 karakter)</label>
      <input id={`pw-${userId}`} style={s.input} type="password" autoComplete="new-password"
             value={pw} onChange={(e) => setPw(e.target.value)} />

      <label style={s.label} htmlFor={`pwc-${userId}`}>Ulangi password baru</label>
      <input id={`pwc-${userId}`} style={s.input} type="password" autoComplete="new-password"
             value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      {confirm.length > 0 && pw !== confirm && (
        <div style={{ ...s.meta, color: C.chili, marginTop: 6 }}>Password tidak sama.</div>
      )}

      {msg && <div style={msg.tone === 'ok' ? s.ok : s.err}>{msg.text}</div>}

      <div style={{ ...s.grid2, marginTop: 8 }}>
        <button style={s.btnGhost} disabled={busy} onClick={onDone}>Tutup</button>
        <button style={{ ...s.btnGhost, borderColor: C.neo, color: C.neo, opacity: busy || !canSubmit ? 0.5 : 1 }}
                disabled={busy || !canSubmit} onClick={() => void submit()}>
          {busy ? 'Menyimpan…' : 'Simpan password baru'}
        </button>
      </div>
    </div>
  );
}

/** Sandi awal acak — huruf/angka campur, cukup panjang untuk diketikkan sekali
 * lalu diganti pengguna sendiri saat login pertama (belum ada alur ganti-sandi
 * paksa, jadi ini nilai awal, bukan sandi permanen yang harus dihafal admin). */
function randomPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

function AddUser({ roles, onCancel, onCreated }: {
  roles: WmsRole[]; onCancel: () => void; onCreated: () => void;
}) {
  const [f, setF] = useState({
    email: '', password: randomPassword(), fullName: '', employeeNo: '', department: '',
    role: 'OPERATOR' as string, wmsRoleId: '',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ email: string; password: string } | null>(null);
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));

  if (done) {
    return (
      <div style={{ ...s.card, maxWidth: 480, borderTop: `3px solid ${C.neo}` }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: C.neo }}>Pengguna dibuat</div>
        <p style={{ fontSize: 12.5, color: C.slate, lineHeight: 1.5 }}>
          Sampaikan kredensial ini ke pengguna secara langsung — tidak dikirim lewat email dan
          tidak ditampilkan lagi setelah ini.
        </p>
        <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px', fontFamily: MONO, fontSize: 13 }}>
          <dt style={{ color: C.slate }}>Email</dt><dd>{done.email}</dd>
          <dt style={{ color: C.slate }}>Sandi</dt><dd style={{ fontWeight: 700 }}>{done.password}</dd>
        </dl>
        <button style={{ ...s.btn, marginTop: 14 }} onClick={onCreated}>Selesai</button>
      </div>
    );
  }

  const canSubmit = f.email.includes('@') && f.password.length >= 6 && f.fullName.trim().length > 0;

  async function submit() {
    setBusy(true); setErr(null);
    try {
      const input: NewUserInput = {
        email: f.email.trim(), password: f.password, fullName: f.fullName.trim(),
        employeeNo: f.employeeNo.trim() || undefined, department: f.department.trim() || undefined,
        role: f.role, wmsRoleId: f.wmsRoleId || null,
      };
      const created = await createUser(input);
      setDone({ email: created.email, password: f.password });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ ...s.card, maxWidth: 480, borderTop: `3px solid ${C.neo}` }}>
      <div style={s.rowBetween}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>Pengguna baru</div>
        <button style={{ ...s.btnGhost, padding: '5px 10px', fontSize: 11 }} onClick={onCancel}>Batal</button>
      </div>

      <label style={s.label} htmlFor="nu-name">Nama lengkap</label>
      <input id="nu-name" style={s.input} value={f.fullName} onChange={(e) => set('fullName', e.target.value)} />

      <label style={s.label} htmlFor="nu-email">Email</label>
      <input id="nu-email" style={s.input} type="email" value={f.email} onChange={(e) => set('email', e.target.value)} />

      <label style={s.label} htmlFor="nu-pass">Sandi awal (minimal 6 karakter)</label>
      <div style={{ display: 'flex', gap: 6 }}>
        <input id="nu-pass" style={s.input} value={f.password} onChange={(e) => set('password', e.target.value)} />
        <button type="button" style={s.btnGhost} onClick={() => set('password', randomPassword())}>Acak</button>
      </div>

      <div style={s.grid2}>
        <div>
          <label style={s.label} htmlFor="nu-emp">No. karyawan (opsional)</label>
          <input id="nu-emp" style={s.input} value={f.employeeNo} onChange={(e) => set('employeeNo', e.target.value)} />
        </div>
        <div>
          <label style={s.label} htmlFor="nu-dept">Departemen (opsional)</label>
          <input id="nu-dept" style={s.input} value={f.department} onChange={(e) => set('department', e.target.value)} />
        </div>
      </div>

      <div style={s.grid2}>
        <div>
          <label style={s.label} htmlFor="nu-role">Peran aplikasi</label>
          <select id="nu-role" style={s.input} value={f.role} onChange={(e) => set('role', e.target.value)}>
            {APP_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div>
          <label style={s.label} htmlFor="nu-wms">Peran WMS (opsional)</label>
          <select id="nu-wms" style={s.input} value={f.wmsRoleId} onChange={(e) => set('wmsRoleId', e.target.value)}>
            <option value="">— belum ditetapkan —</option>
            {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>
      </div>

      {err && <div style={s.err}>{err}</div>}

      <button style={{ ...s.btn, opacity: busy || !canSubmit ? 0.5 : 1 }} disabled={busy || !canSubmit}
              onClick={() => void submit()}>
        {busy ? 'Membuat…' : 'Buat pengguna'}
      </button>
    </div>
  );
}

/* ---------------------------------------------------------------- akses */

const LEVEL_TONE: Record<PermissionLevel, 'ok' | 'warn' | 'bad' | 'mute'> = {
  FULL_CONTROL: 'ok', VIEW_EDIT: 'warn', VIEW_ONLY: 'mute', NO_ACCESS: 'bad',
};
const LEVEL_LABEL: Record<PermissionLevel, string> = {
  FULL_CONTROL: 'Kontrol penuh', VIEW_EDIT: 'Lihat/ubah', VIEW_ONLY: 'Lihat saja', NO_ACCESS: 'Tanpa akses',
};
const LEVELS: PermissionLevel[] = ['NO_ACCESS', 'VIEW_ONLY', 'VIEW_EDIT', 'FULL_CONTROL'];

function Permissions() {
  const [roles, setRoles] = useState<WmsRole[]>([]);
  const [modules, setModules] = useState<WmsModule[]>([]);
  const [perms, setPerms] = useState<WmsRolePermission[]>([]);
  const [roleId, setRoleId] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([listWmsRoles(), listWmsModules(), listWmsPermissions()])
      .then(([r, m, p]) => {
        setRoles(r); setModules(m); setPerms(p);
        setRoleId((current) => current || r[0]?.id || '');
      })
      .catch((e) => setErr(parseDbError(e).message));
  }, []);

  const levelFor = (moduleId: string): PermissionLevel =>
    perms.find((p) => p.role_id === roleId && p.module_id === moduleId)?.level ?? 'NO_ACCESS';

  async function change(moduleId: string, level: PermissionLevel) {
    const key = `${roleId}:${moduleId}`;
    setBusy(key); setErr(null);
    try {
      await setPermission(roleId, moduleId, level);
      setPerms((p) => [
        ...p.filter((x) => !(x.role_id === roleId && x.module_id === moduleId)),
        { role_id: roleId, module_id: moduleId, level },
      ]);
    } catch (e) {
      setErr(parseDbError(e).message);
    } finally {
      setBusy(null);
    }
  }

  // dikelompokkan per kategori supaya judul kategori tetap selebar layar,
  // bukan ikut jadi satu sel dalam grid kartu
  const byCategory = new Map<string, WmsModule[]>();
  for (const m of modules) {
    const list = byCategory.get(m.category) ?? [];
    list.push(m);
    byCategory.set(m.category, list);
  }

  return (
    <>
      <div style={{ maxWidth: 420 }}>
        <label style={s.label} htmlFor="role-pick">Peran</label>
        <select id="role-pick" style={s.input} value={roleId} onChange={(e) => setRoleId(e.target.value)}>
          {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </div>
      {err && <div style={s.err}>{err}</div>}

      {[...byCategory.entries()].map(([category, mods]) => (
        <div key={category}>
          <div style={s.secHead}>{category}</div>
          <div style={s.cardGrid}>
            {mods.map((m) => {
              const level = levelFor(m.id);
              const key = `${roleId}:${m.id}`;
              return (
                <div key={m.id} style={{ ...s.card, ...s.rowBetween, marginBottom: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{m.name}</div>
                  <select
                    style={{ ...pill(LEVEL_TONE[level]), background: '#fff', fontFamily: MONO, border: `1px solid ${C.line}`, padding: '5px 6px' }}
                    value={level} disabled={busy === key}
                    onChange={(e) => void change(m.id, e.target.value as PermissionLevel)}
                  >
                    {LEVELS.map((l) => <option key={l} value={l}>{LEVEL_LABEL[l]}</option>)}
                  </select>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </>
  );
}

/* -------------------------------------------------------------- data induk */

function MasterData() {
  const [sel, setSel] = useState<MasterTableConfig>(MASTER_TABLES[0]);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    void supabase.from(sel.table).select('*').order(sel.conflictKey).limit(200)
      .then(({ data, error }) => {
        if (error) { setMsg({ tone: 'bad', text: parseDbError(error).message }); return; }
        setRows(data ?? []);
      });
  }, [sel]);
  useEffect(load, [load]);

  async function handleUpload(file: File) {
    setBusy(true); setMsg(null);
    try {
      const parsed = await parseExcelFile(file);
      if (parsed.length === 0) throw new Error('File kosong atau format tidak terbaca.');
      const coerced = parsed.map((row) => coerceRow(row, sel));
      const { error } = await supabase.from(sel.table).upsert(coerced, { onConflict: sel.conflictKey });
      if (error) throw error;
      setMsg({ tone: 'ok', text: `${coerced.length} baris diunggah ke ${sel.label}.` });
      load();
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message ?? parseDbError(e).message });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <>
      <div style={{ maxWidth: 480 }}>
        <label style={s.label} htmlFor="table-pick">Tabel data induk</label>
        <select id="table-pick" style={s.input} value={sel.key}
                onChange={(e) => setSel(MASTER_TABLES.find((t) => t.key === e.target.value) ?? MASTER_TABLES[0])}>
          {MASTER_TABLES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>

        <div style={s.grid2}>
          <button style={s.btnGhost} onClick={() => void downloadTemplate(`templat-${sel.key}.xlsx`, sel.headers, sel.example)}>
            Unduh templat
          </button>
          <button style={{ ...s.btnGhost, borderColor: C.neo, color: C.neo }} disabled={busy}
                  onClick={() => fileRef.current?.click()}>
            {busy ? 'Mengunggah…' : 'Unggah Excel'}
          </button>
        </div>
        <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
               onChange={(e) => e.target.files?.[0] && void handleUpload(e.target.files[0])} />
        <p style={{ ...s.meta, marginTop: 6, lineHeight: 1.5 }}>
          Kolom <code>{sel.conflictKey}</code> jadi kunci — baris dengan kode yang sudah ada akan
          diperbarui, kode baru akan ditambahkan.
        </p>

        {msg && <div style={msg.tone === 'ok' ? s.ok : s.err}>{msg.text}</div>}
      </div>

      <div style={s.secHead}>{rows.length} baris di {sel.label}</div>
      {rows.length === 0 && <div style={s.empty}>Belum ada data.</div>}
      <div style={s.cardGrid}>
        {rows.map((r, i) => (
          <div key={i} style={{ ...s.card, ...s.rowBetween, marginBottom: 0 }}>
            <div>
              <div style={s.code}>{String(r[sel.conflictKey] ?? '—')}</div>
              <div style={s.meta}>{String(r.name ?? '')}</div>
            </div>
            {'type' in r && <span style={pill('mute')}>{String(r.type)}</span>}
          </div>
        ))}
      </div>
    </>
  );
}

/* --------------------------------------------------------- konversi uom */

interface UomConversionRow { id: string; uom: string; factor: number }

function UomConversions() {
  const [items, setItems] = useState<Item[]>([]);
  const [itemId, setItemId] = useState('');
  const [rows, setRows] = useState<UomConversionRow[]>([]);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [uomInput, setUomInput] = useState('');
  const [factorInput, setFactorInput] = useState('');

  useEffect(() => {
    listItems().catch((e) => { setMsg({ tone: 'bad', text: parseDbError(e).message }); return []; }).then(setItems);
  }, []);

  const item = items.find((i) => i.id === itemId) ?? null;

  const load = useCallback(() => {
    if (!itemId) { setRows([]); return; }
    void supabase.from('item_uom_conversions').select('id, uom, factor').eq('item_id', itemId).order('uom')
      .then(({ data, error }) => {
        if (error) { setMsg({ tone: 'bad', text: parseDbError(error).message }); return; }
        setRows((data ?? []) as UomConversionRow[]);
      });
  }, [itemId]);
  useEffect(load, [load]);

  async function remove(id: string) {
    setBusy(true); setMsg(null);
    try {
      const { error } = await supabase.from('item_uom_conversions').delete().eq('id', id);
      if (error) throw error;
      load();
    } catch (e) {
      setMsg({ tone: 'bad', text: parseDbError(e).message });
    } finally {
      setBusy(false);
    }
  }

  const factorNum = Number(factorInput);
  const canSubmit = uomInput.trim().length > 0 && factorInput.trim().length > 0 && factorNum > 0;

  async function submit() {
    if (!itemId) return;
    setBusy(true); setMsg(null);
    const code = uomInput.trim().toUpperCase();
    try {
      const { error } = await supabase.from('item_uom_conversions')
        .upsert({ item_id: itemId, uom: code, factor: factorNum }, { onConflict: 'item_id,uom' });
      if (error) throw error;
      setUomInput(''); setFactorInput('');
      setMsg({ tone: 'ok', text: `Konversi ${code} disimpan.` });
      load();
    } catch (e) {
      setMsg({ tone: 'bad', text: parseDbError(e).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div style={{ maxWidth: 480 }}>
        <label style={s.label} htmlFor="item-pick">Bahan / produk</label>
        <select id="item-pick" style={s.input} value={itemId} onChange={(e) => setItemId(e.target.value)}>
          <option value="">— pilih —</option>
          {items.map((i) => <option key={i.id} value={i.id}>{i.code} · {i.name} ({i.base_uom})</option>)}
        </select>
      </div>

      {!itemId && <div style={s.empty}>Pilih bahan/produk dulu utk melihat & mengatur konversi satuannya.</div>}

      {itemId && item && (
        <>
          {msg && <div style={msg.tone === 'ok' ? s.ok : s.err}>{msg.text}</div>}

          <div style={s.secHead}>{rows.length} konversi satuan</div>
          {rows.length === 0 && <div style={s.empty}>Belum ada konversi untuk bahan ini.</div>}
          <div style={s.cardGrid}>
            {rows.map((r) => (
              <div key={r.id} style={{ ...s.card, ...s.rowBetween, marginBottom: 0 }}>
                <div>
                  <div style={s.code}>{r.uom}</div>
                  <div style={s.meta}>1 {r.uom} = {r.factor} {item.base_uom}</div>
                </div>
                <button style={s.btnGhost} disabled={busy} onClick={() => void remove(r.id)}>Hapus</button>
              </div>
            ))}
          </div>

          <div style={{ ...s.card, maxWidth: 480, marginTop: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>Tambah konversi</div>
            <div style={s.grid2}>
              <div>
                <label style={s.label} htmlFor="uom-code">Satuan (mis. DRUM, DUS)</label>
                <input id="uom-code" style={s.input} value={uomInput} onChange={(e) => setUomInput(e.target.value)} />
              </div>
              <div>
                <label style={s.label} htmlFor="uom-factor">1 satuan = ? {item.base_uom}</label>
                <input id="uom-factor" style={s.input} type="number" value={factorInput}
                       onChange={(e) => setFactorInput(e.target.value)} />
              </div>
            </div>
            <button style={{ ...s.btn, opacity: busy || !canSubmit ? 0.5 : 1 }} disabled={busy || !canSubmit}
                    onClick={() => void submit()}>
              {busy ? 'Menyimpan…' : 'Simpan konversi'}
            </button>
          </div>
        </>
      )}
    </>
  );
}
