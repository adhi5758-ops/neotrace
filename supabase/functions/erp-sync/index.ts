/**
 * NEOTRACE — worker sinkronisasi ERP (Fase 4)
 * Supabase Edge Function (Deno)
 *
 * Menguras sync_outbox: klaim → kirim ke ERP → ack atau fail dengan backoff.
 *
 * Prinsip yang tidak boleh dilanggar:
 *   1. Setiap pesan membawa idempotency_key. Kirim ulang TIDAK boleh
 *      menghasilkan dokumen ganda di ERP — worker mengirimkannya sebagai
 *      header, dan ERP wajib menolak duplikat.
 *   2. Klaim memakai FOR UPDATE SKIP LOCKED di database, sehingga beberapa
 *      instance worker aman berjalan bersamaan.
 *   3. Kegagalan tidak dihapus diam-diam. Setelah max_attempts, pesan
 *      berstatus DEAD dan memicu notifikasi CRITICAL ke admin.
 *
 * Deploy:
 *   supabase functions deploy erp-sync --no-verify-jwt
 *   supabase secrets set ERP_BASE_URL=... ERP_TOKEN=...
 * Jadwalkan tiap 2 menit lewat pg_cron + pg_net, atau scheduler eksternal.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ERP_BASE_URL = Deno.env.get('ERP_BASE_URL') ?? '';
const ERP_TOKEN    = Deno.env.get('ERP_TOKEN') ?? '';
const WORKER_ID    = `edge-${crypto.randomUUID().slice(0, 8)}`;
const BATCH_SIZE   = Number(Deno.env.get('SYNC_BATCH_SIZE') ?? 20);
const TIMEOUT_MS   = 20_000;

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

interface OutboxRow {
  id: number;
  endpoint_id: string;
  entity_type: string;
  entity_id: string;
  operation: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  attempts: number;
}

/** Jalur endpoint per jenis entitas. Sesuaikan dengan ERP tujuan. */
const ROUTES: Record<string, string> = {
  GRN:        '/inventory/receipts',
  DO:         '/inventory/shipments',
  BATCH:      '/production/work-orders',
  ADJUSTMENT: '/inventory/adjustments',
};

/** Ambil ID eksternal dari respons ERP — bentuknya berbeda antar sistem. */
function extractExternalId(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const o = body as Record<string, unknown>;
  for (const k of ['id', 'internalId', 'documentId', 'tranId', 'externalId']) {
    if (typeof o[k] === 'string' || typeof o[k] === 'number') return String(o[k]);
  }
  const nested = o['data'] ?? o['result'] ?? o['record'];
  return nested ? extractExternalId(nested) : null;
}

/**
 * Terjemahkan ID lokal jadi ID ERP sebelum kirim. Payload menyimpan
 * localId; ERP hanya mengenal ID-nya sendiri.
 */
async function resolveMappings(endpointId: string, payload: Record<string, unknown>) {
  const localIds = new Set<string>();
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k.endsWith('LocalId') && typeof v === 'string') localIds.add(v);
        else walk(v);
      }
    }
  };
  walk(payload);
  if (localIds.size === 0) return payload;

  const { data } = await db
    .from('entity_mappings')
    .select('local_id, external_id')
    .eq('endpoint_id', endpointId)
    .in('local_id', [...localIds]);

  const map = new Map((data ?? []).map((m) => [m.local_id as string, m.external_id as string]));
  const missing = [...localIds].filter((id) => !map.has(id));
  if (missing.length) {
    throw new Error(`MAPPING_MISSING: ${missing.length} master belum terpetakan ke ERP (${missing[0]}…)`);
  }

  const replace = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(replace);
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k.endsWith('LocalId') && typeof v === 'string') {
          out[k.replace('LocalId', 'Id')] = map.get(v);
        } else {
          out[k] = replace(v);
        }
      }
      return out;
    }
    return node;
  };
  return replace(payload) as Record<string, unknown>;
}

async function send(row: OutboxRow): Promise<{ ok: boolean; externalId?: string; error?: string; status?: number; body?: unknown; ms: number }> {
  const started = Date.now();
  const route = ROUTES[row.entity_type];
  if (!route) return { ok: false, error: `NO_ROUTE: ${row.entity_type}`, ms: 0 };

  try {
    const payload = await resolveMappings(row.endpoint_id, row.payload);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

    const res = await fetch(`${ERP_BASE_URL}${route}`, {
      method: row.operation === 'CANCEL' ? 'DELETE' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ERP_TOKEN}`,
        // kunci anti-duplikat — ERP wajib menghormati header ini
        'Idempotency-Key': row.idempotency_key,
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    const ms = Date.now() - started;
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* respons bukan JSON */ }

    if (!res.ok) {
      return { ok: false, error: `HTTP_${res.status}: ${text.slice(0, 400)}`, status: res.status, body, ms };
    }
    const externalId = extractExternalId(body);
    if (!externalId) {
      return { ok: false, error: 'NO_EXTERNAL_ID: respons ERP tidak memuat ID dokumen', status: res.status, body, ms };
    }
    return { ok: true, externalId, status: res.status, body, ms };
  } catch (e) {
    const msg = (e as Error).name === 'AbortError'
      ? `TIMEOUT: tidak ada respons dalam ${TIMEOUT_MS / 1000} detik`
      : (e as Error).message;
    return { ok: false, error: msg, ms: Date.now() - started };
  }
}

async function drain() {
  // lepas klaim worker yang mati di tengah jalan
  await db.rpc('reclaim_stuck_outbox');

  const { data: claimed, error } = await db.rpc('claim_outbox', {
    p_worker: WORKER_ID,
    p_limit: BATCH_SIZE,
  });
  if (error) throw error;

  const rows = (claimed ?? []) as OutboxRow[];
  let acked = 0, failed = 0;

  for (const row of rows) {
    const result = await send(row);

    await db.from('sync_log').insert({
      outbox_id: row.id,
      attempt: row.attempts + 1,
      http_status: result.status ?? null,
      request_body: row.payload,
      response_body: result.body ? { body: result.body } : null,
      duration_ms: result.ms,
    });

    if (result.ok) {
      await db.rpc('ack_outbox', { p_id: row.id, p_external_id: result.externalId });
      acked++;
    } else {
      await db.rpc('fail_outbox', { p_id: row.id, p_error: result.error ?? 'UNKNOWN' });
      failed++;
    }
  }

  return { worker: WORKER_ID, claimed: rows.length, acked, failed };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }
  try {
    const summary = await drain();
    return new Response(JSON.stringify(summary), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('[erp-sync] gagal:', e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
});

/* ---------------------------------------------------------------------
 * Jadwalkan lewat pg_cron + pg_net (jalankan sekali di SQL Editor):
 *
 *   select cron.schedule(
 *     'erp-sync', '*∕2 * * * *',
 *     $$ select net.http_post(
 *          url := 'https://<project-ref>.supabase.co/functions/v1/erp-sync',
 *          headers := jsonb_build_object('Authorization', 'Bearer <service-role-key>')
 *        ) $$
 *   );
 *
 * Pantau kesehatan lewat view v_sync_health. Pesan berstatus DEAD tidak
 * akan dicoba ulang otomatis — perlu keputusan manusia, karena mengirim
 * ulang dokumen keuangan tanpa memeriksa penyebabnya berisiko lebih besar
 * daripada membiarkannya tertahan.
 * ------------------------------------------------------------------- */
