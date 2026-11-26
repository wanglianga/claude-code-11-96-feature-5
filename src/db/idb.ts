// 手写 IndexedDB Promise 封装（不依赖第三方库）
// stores:
//   events   事件日志，keyPath = seq（事件溯源，只追加）
//   blobs    照片，{ id, mime, size, blob }
//   drafts   教师报修草稿，keyPath = id
//   kv       通用键值（快照缓存、在线状态等），keyPath = key

import type { AppEvent, BlobMeta, Draft } from '../types';

const DB_NAME = 'incident-workbench-db';
const DB_VERSION = 1;
export const STORES = ['events', 'blobs', 'drafts', 'kv'] as const;

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('events')) {
        const s = db.createObjectStore('events', { keyPath: 'seq' });
        s.createIndex('at', 'at');
      }
      if (!db.objectStoreNames.contains('blobs')) {
        db.createObjectStore('blobs', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('drafts')) {
        db.createObjectStore('drafts', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

// ---------- 事件日志 ----------
export async function appendEvent(event: AppEvent): Promise<void> {
  await tx('events', 'readwrite', (s) => s.put(event));
}

export async function getAllEvents(): Promise<AppEvent[]> {
  const rows = await tx<AppEvent[]>('events', 'readonly', (s) => s.getAll());
  return rows.sort((a, b) => a.seq - b.seq);
}

export async function maxSeq(): Promise<number> {
  return new Promise((resolve, reject) => {
    openDb().then((db) => {
      const t = db.transaction('events', 'readonly');
      const idx = t.objectStore('events').index('at');
      // 用 openCursor 倒序取最大 seq
      const req = t.objectStore('events').openCursor(null, 'prev');
      req.onsuccess = () => {
        const cur = req.result;
        resolve(cur ? (cur.value as AppEvent).seq : 0);
      };
      req.onerror = () => reject(req.error);
    });
  });
}

export async function clearEvents(): Promise<void> {
  await tx('events', 'readwrite', (s) => s.clear());
}

// ---------- 照片 Blob ----------
export interface StoredBlob extends BlobMeta {
  blob: Blob;
}

export async function putBlob(record: StoredBlob): Promise<void> {
  await tx('blobs', 'readwrite', (s) => s.put(record));
}

export async function getBlob(id: string): Promise<StoredBlob | undefined> {
  return tx<StoredBlob | undefined>('blobs', 'readonly', (s) => s.get(id));
}

export async function deleteBlob(id: string): Promise<void> {
  await tx('blobs', 'readwrite', (s) => s.delete(id));
}

// ---------- 草稿 ----------
export async function putDraft(draft: Draft): Promise<void> {
  await tx('drafts', 'readwrite', (s) => s.put(draft));
}

export async function getAllDrafts(): Promise<Draft[]> {
  return tx<Draft[]>('drafts', 'readonly', (s) => s.getAll());
}

export async function deleteDraft(id: string): Promise<void> {
  await tx('drafts', 'readwrite', (s) => s.delete(id));
}

// ---------- KV ----------
export async function kvGet<T>(key: string): Promise<T | undefined> {
  const row = await tx<{ key: string; value: T } | undefined>(
    'kv',
    'readonly',
    (s) => s.get(key),
  );
  return row?.value;
}

export async function kvSet<T>(key: string, value: T): Promise<void> {
  await tx('kv', 'readwrite', (s) => s.put({ key, value }));
}

export async function resetDatabase(): Promise<void> {
  const db = await openDb();
  await Promise.all(STORES.map((name) => tx(name, 'readwrite', (s) => s.clear())));
  db.close();
  dbPromise = null;
}
