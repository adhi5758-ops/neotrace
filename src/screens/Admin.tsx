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
  listUsers, setUserRole, setUserWmsRole, setUserActive, APP_ROLES,
  type WmsRole, type WmsModule, type WmsRolePermission, type PermissionLevel, type UserRow,
} from '../lib/admin';
import { MASTER_TABLES, coerceRow, type MasterTableConfig } from '../lib/masterData';
import { parseExcelFile, downloadTemplate } from '../lib/excel';
import { C, MONO, s, pill } from '../ui';

type Tab = 'pengguna' | 'akses' | 'induk';
const TABS: [Tab, string][] = [['pengguna', 'Pengguna'], ['akses', 'Hak akses'], ['induk', 'Data induk']];

export default function Admin() {
  const [tab, setTab] = useState<Tab>('pengguna');
  return (
    <div style={s.page}>
      <h1 style={s.h1}>Administrator</h1>
      <p style={s.sub}>Pengguna · hak akses WMS · data induk</p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginBottom: 8 }}>
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
    </div>
  );
}

/* --------------------------------------------------------------- pengguna */

function Users() {
  const [rows, setRows] = useState<UserRow[]>([]);
  const [roles, setRoles] = useState<WmsRole[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

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
      <div style={{ ...s.card, borderTop: `3px solid ${C.amber}` }}>
        <div style={s.meta}>
          Pengguna baru dibuat lewat Supabase Auth, bukan di sini — perlu service role, tidak
          tersedia di aplikasi klien. Layar ini hanya mengatur peran pengguna yang sudah ada.
        </div>
      </div>
      {err && <div style={s.err}>{err}</div>}

      {rows.map((u) => (
        <div key={u.id} style={s.card}>
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

          <button style={{ ...s.btnGhost, width: '100%', marginTop: 8 }} disabled={busyId === u.id}
                  onClick={() => void change(u.id, () => setUserActive(u.id, !u.is_active))}>
            {u.is_active ? 'Nonaktifkan' : 'Aktifkan'}
          </button>
        </div>
      ))}
    </>
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

  let lastCategory = '';
  return (
    <>
      <label style={s.label} htmlFor="role-pick">Peran</label>
      <select id="role-pick" style={s.input} value={roleId} onChange={(e) => setRoleId(e.target.value)}>
        {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
      </select>
      {err && <div style={s.err}>{err}</div>}

      {modules.map((m) => {
        const showCategory = m.category !== lastCategory;
        lastCategory = m.category;
        const level = levelFor(m.id);
        const key = `${roleId}:${m.id}`;
        return (
          <div key={m.id}>
            {showCategory && <div style={s.secHead}>{m.category}</div>}
            <div style={{ ...s.card, ...s.rowBetween }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{m.name}</div>
              <select
                style={{ ...pill(LEVEL_TONE[level]), background: '#fff', fontFamily: MONO, border: `1px solid ${C.line}`, padding: '5px 6px' }}
                value={level} disabled={busy === key}
                onChange={(e) => void change(m.id, e.target.value as PermissionLevel)}
              >
                {LEVELS.map((l) => <option key={l} value={l}>{LEVEL_LABEL[l]}</option>)}
              </select>
            </div>
          </div>
        );
      })}
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

      <div style={s.secHead}>{rows.length} baris di {sel.label}</div>
      {rows.length === 0 && <div style={s.empty}>Belum ada data.</div>}
      {rows.map((r, i) => (
        <div key={i} style={{ ...s.card, ...s.rowBetween }}>
          <div>
            <div style={s.code}>{String(r[sel.conflictKey] ?? '—')}</div>
            <div style={s.meta}>{String(r.name ?? '')}</div>
          </div>
          {'type' in r && <span style={pill('mute')}>{String(r.type)}</span>}
        </div>
      ))}
    </>
  );
}
