/**
 * NEOTRACE Fase 3 — sesi kerja yang mengikuti layar (W09, W10, W11).
 *
 * Prinsipnya: operator tidak menekan tombol clock in/out. Sesi dimulai saat
 * layar tugas dibuka dan ditutup saat ditinggalkan — beban tambahan adalah
 * cara tercepat membuat pencatatan produktivitas ditinggalkan.
 *
 * Database mengizinkan satu sesi terbuka per orang. Kalau sesi lama masih
 * menggantung (HP mati, browser ditutup paksa), hook ini mengambil alih bila
 * tugasnya sama, atau melaporkannya supaya bisa ditutup manual.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from './api';
import { startLabour, endLabour, openSession, type TaskType } from './api-phase3';

export interface OpenSessionRow {
  id: string;
  task_type: string;
  reference_no: string | null;
  started_at: string;
}

/** Sesi menggantung dianggap basi setelah satu shift penuh. */
export const STALE_SESSION_HOURS = 8;

export function sessionAgeHours(startedAt: string, now = Date.now()): number {
  return (now - new Date(startedAt).getTime()) / 3_600_000;
}

export function isStaleSession(startedAt: string, now = Date.now()): boolean {
  return sessionAgeHours(startedAt, now) >= STALE_SESSION_HOURS;
}

interface UseLabourSession {
  sessionId: string | null;
  /** Sesi milik tugas lain yang menghalangi — operator harus memutuskan. */
  conflict: OpenSessionRow | null;
  /** Tutup sesi yang menghalangi lalu mulai sesi untuk layar ini. */
  resolveConflict: () => Promise<void>;
  /** Tutup lebih awal dengan jumlah pekerjaan, mis. saat gelombang selesai. */
  finish: (units?: number, lines?: number) => Promise<void>;
}

export function useLabourSession(
  taskType: TaskType,
  referenceId?: string,
  referenceNo?: string
): UseLabourSession {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [conflict, setConflict] = useState<OpenSessionRow | null>(null);
  const idRef = useRef<string | null>(null);
  const closedRef = useRef(false);

  const begin = useCallback(async () => {
    try {
      const id = await startLabour(taskType, referenceId, referenceNo);
      idRef.current = id;
      setSessionId(id);
      setConflict(null);
    } catch (e) {
      if ((e as { code?: string }).code !== 'SESSION_OPEN') throw e;
      const open = (await openSession()) as OpenSessionRow | null;
      if (!open) return;
      // sesi lama untuk tugas yang sama → ambil alih, jangan buat baru
      if (referenceNo && open.reference_no === referenceNo) {
        idRef.current = open.id;
        setSessionId(open.id);
        setConflict(null);
      } else {
        setConflict(open);
      }
    }
  }, [taskType, referenceId, referenceNo]);

  useEffect(() => {
    closedRef.current = false;
    void begin().catch(() => {});
    return () => {
      const id = idRef.current;
      idRef.current = null;
      if (id && !closedRef.current) void endLabour(id).catch(() => {});
    };
  }, [begin]);

  const resolveConflict = useCallback(async () => {
    if (!conflict) return;
    await endLabour(conflict.id);
    await begin();
  }, [conflict, begin]);

  const finish = useCallback(async (units?: number, lines?: number) => {
    const id = idRef.current;
    if (!id) return;
    closedRef.current = true;
    idRef.current = null;
    setSessionId(null);
    await endLabour(id, units, lines);
  }, []);

  return { sessionId, conflict, resolveConflict, finish };
}

/* -------------------------------------------------- papan supervisor (W11) */

export interface ActiveSession {
  id: string;
  user_id: string;
  task_type: string;
  reference_no: string | null;
  started_at: string;
  profiles: { full_name: string | null; role: string } | null;
}

/** Siapa mengerjakan apa saat ini. Dipakai supervisor, bukan untuk sanksi. */
export async function activeSessions(): Promise<ActiveSession[]> {
  const { data, error } = await supabase
    .from('labour_sessions')
    .select('id, user_id, task_type, reference_no, started_at, profiles(full_name, role)')
    .is('ended_at', null)
    .order('started_at');
  if (error) throw error;
  return (data ?? []) as unknown as ActiveSession[];
}

/** Tutup paksa sesi menggantung. Supervisor only — RLS yang menegakkan. */
export async function forceEndSession(sessionId: string) {
  await endLabour(sessionId);
}
