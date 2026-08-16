/**
 * NEOTRACE — buat pengguna baru dari layar Administrator
 * Supabase Edge Function (Deno)
 *
 * auth.admin.createUser() hanya bisa dipanggil dengan service role key —
 * kunci itu tidak boleh pernah ada di bundle klien, jadi pembuatan user
 * harus lewat sini. Pemanggil harus login DAN berperan ADMIN aktif; kedua
 * hal itu diperiksa lewat sesi pemanggil sendiri (klien anon+JWT, tunduk
 * RLS) sebelum service role client disentuh sama sekali.
 *
 * Deploy: supabase functions deploy admin-create-user
 * (verify_jwt tetap aktif — gateway menolak permintaan tanpa sesi login
 * sebelum kode ini jalan sama sekali; jangan matikan)
 */
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

interface Body {
  email: string;
  password: string;
  fullName: string;
  employeeNo?: string;
  department?: string;
  role: string;
  wmsRoleId?: string | null;
}

const APP_ROLES = ['OPERATOR', 'WAREHOUSE', 'QA', 'PLANNER', 'FINANCE', 'ADMIN', 'VIEWER'];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'UNAUTHENTICATED' }, 401);

  // klien terikat sesi pemanggil — RLS (p_profile_self) yang menegakkan
  // siapa boleh baca profil siapa, konsisten dengan current_role_is() di DB
  const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: { user: caller } } = await callerClient.auth.getUser();
  if (!caller) return json({ error: 'UNAUTHENTICATED' }, 401);

  const { data: callerProfile } = await callerClient
    .from('profiles')
    .select('role, is_active')
    .eq('id', caller.id)
    .maybeSingle();
  if (!callerProfile?.is_active || callerProfile.role !== 'ADMIN') {
    return json({ error: 'FORBIDDEN: hanya admin aktif yang boleh membuat pengguna' }, 403);
  }

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Body harus JSON valid' }, 400);
  }

  const email = (body.email ?? '').trim().toLowerCase();
  const password = body.password ?? '';
  const fullName = (body.fullName ?? '').trim();
  const role = body.role;

  if (!email || !email.includes('@')) return json({ error: 'Email tidak valid' }, 400);
  if (password.length < 6) return json({ error: 'Kata sandi minimal 6 karakter' }, 400);
  if (!fullName) return json({ error: 'Nama lengkap wajib diisi' }, 400);
  if (!APP_ROLES.includes(role)) return json({ error: `Peran tidak dikenal: ${role}` }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true, // alat kerja internal — tidak ada alur verifikasi email publik
  });
  if (createErr || !created.user) {
    return json({ error: createErr?.message ?? 'Gagal membuat akun' }, 400);
  }

  const { error: profileErr } = await admin.from('profiles').insert({
    id: created.user.id,
    full_name: fullName,
    employee_no: body.employeeNo?.trim() || null,
    department: body.department?.trim() || null,
    role,
    wms_role_id: body.wmsRoleId || null,
    is_active: true,
  });

  if (profileErr) {
    // jangan tinggalkan akun auth tanpa profil — bersihkan supaya email
    // itu bisa dicoba lagi, bukan tersangkut selamanya
    await admin.auth.admin.deleteUser(created.user.id);
    return json({ error: profileErr.message }, 400);
  }

  return json({ id: created.user.id, email });
});
