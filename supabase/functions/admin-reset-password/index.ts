/**
 * NEOTRACE — reset password pengguna lain dari layar Administrator
 * Supabase Edge Function (Deno)
 *
 * auth.admin.updateUserById() hanya bisa dipanggil dengan service role key —
 * kunci itu tidak boleh pernah ada di bundle klien, jadi reset password
 * pengguna lain harus lewat sini. Pemanggil harus login DAN berperan ADMIN
 * aktif; kedua hal itu diperiksa lewat sesi pemanggil sendiri (klien
 * anon+JWT, tunduk RLS) sebelum service role client disentuh sama sekali.
 * Ini beda dari ganti password sendiri (Account.tsx) yang mewajibkan
 * password lama — di sini admin memang berwenang set password baru untuk
 * akun orang lain tanpa tahu password lamanya.
 *
 * Deploy: supabase functions deploy admin-reset-password
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
  userId: string;
  newPassword: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'UNAUTHENTICATED' }, 401);

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
    return json({ error: 'FORBIDDEN: hanya admin aktif yang boleh mereset password pengguna' }, 403);
  }

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Body harus JSON valid' }, 400);
  }

  const userId = body.userId ?? '';
  const newPassword = body.newPassword ?? '';

  if (!userId) return json({ error: 'userId wajib diisi' }, 400);
  if (newPassword.length < 6) return json({ error: 'Password baru minimal 6 karakter' }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const { data: targetProfile } = await admin
    .from('profiles')
    .select('id')
    .eq('id', userId)
    .maybeSingle();
  if (!targetProfile) return json({ error: 'Pengguna tidak ditemukan' }, 404);

  const { error: updateErr } = await admin.auth.admin.updateUserById(userId, { password: newPassword });
  if (updateErr) return json({ error: updateErr.message }, 400);

  return json({ ok: true });
});
