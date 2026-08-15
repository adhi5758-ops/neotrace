/**
 * NEOTRACE — antrean offline
 *
 * Sinyal di lantai produksi tidak bisa diandalkan. Setiap aksi yang mengubah
 * data ditulis ke IndexedDB dulu, lalu dikirim saat jaringan kembali.
 *
 * Batasan yang disengaja: aksi yang butuh keputusan server (resolve_qr untuk
 * validasi expiry/halal, release_lot) TIDAK diantrekan — operator harus tahu
 * saat itu juga apakah bahan boleh dipakai. Yang diantrekan hanya pencatatan.
 */

const DB_NAME = 'neotrace';
const STORE = 'outbox';
const DB_VERSION = 1;

export type QueuedKind = 'CONSUME' | 'CCP' | 'MOVEMENT' | 'SCAN_LOG' | 'COUNT_LINE';

export interface QueuedItem {
  id?: number;
  kind: QueuedKind;
  payload: Record<string, unknown>;
  clientTs: string;
  attempts: number;
  lastError?: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });
}

export async function enqueue(kind: QueuedKind, payload: Record<string, unknown>) {
  const item: QueuedItem = {
    kind,
    payload,
    clientTs: new Date().toISOString(),
    attempts: 0,
  };
  return tx<number>('readwrite', (s) => s.add(item));
}

export async function pending(): Promise<QueuedItem[]> {
  return tx<QueuedItem[]>('readonly', (s) => s.getAll());
}

export async function pendingCount(): Promise<number> {
  return tx<number>('readonly', (s) => s.count());
}

async function remove(id: number) {
  return tx<undefined>('readwrite', (s) => s.delete(id));
}

async function bump(item: QueuedItem, err: string) {
  item.attempts += 1;
  item.lastError = err;
  return tx<IDBValidKey>('readwrite', (s) => s.put(item));
}

type Sender = (item: QueuedItem) => Promise<void>;

let flushing = false;

/**
 * Kirim seluruh antrean. Dipanggil saat online kembali, saat app dibuka,
 * dan berkala. Aman dipanggil berulang — ada guard anti-tumpang tindih.
 */
export async function flush(send: Sender): Promise<{ sent: number; failed: number }> {
  if (flushing || !navigator.onLine) return { sent: 0, failed: 0 };
  flushing = true;
  let sent = 0, failed = 0;
  try {
    const items = await pending();
    // urutan penting: konsumsi bahan harus terkirim sebelum penutupan batch
    items.sort((a, b) => a.clientTs.localeCompare(b.clientTs));
    for (const item of items) {
      try {
        await send(item);
        if (item.id != null) await remove(item.id);
        sent++;
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        // error permanen (data ditolak aturan bisnis) jangan diulang selamanya
        const permanent = /LOT_EXPIRED|HALAL_EXPIRED|LOT_NOT_RELEASED|FEFO_VIOLATION|duplicate key/i.test(msg);
        if (permanent || item.attempts >= 5) {
          if (item.id != null) await remove(item.id);
          console.warn('[outbox] dibuang, perlu tindak lanjut manual:', item.kind, msg);
        } else {
          await bump(item, msg);
        }
        failed++;
      }
    }
  } finally {
    flushing = false;
  }
  return { sent, failed };
}

/** Pasang listener otomatis: online, visibilitas tab, dan interval 60 detik. */
export function startAutoFlush(send: Sender, intervalMs = 60_000) {
  const run = () => void flush(send);
  window.addEventListener('online', run);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') run();
  });
  const timer = setInterval(run, intervalMs);
  run();
  return () => {
    window.removeEventListener('online', run);
    clearInterval(timer);
  };
}
