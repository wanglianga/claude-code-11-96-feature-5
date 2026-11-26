// 照片存储工具：File -> IndexedDB Blob，预览用 ObjectURL
import { deleteBlob, getBlob, putBlob } from '../db/idb';
import { uid } from './id';

export async function storePhoto(file: File): Promise<string> {
  const id = uid('photo');
  await putBlob({ id, mime: file.type, size: file.size, createdAt: new Date().toISOString(), blob: file });
  return id;
}

export async function photoUrl(id: string): Promise<string | null> {
  const rec = await getBlob(id);
  if (!rec) return null;
  return URL.createObjectURL(rec.blob);
}

export async function removePhoto(id: string): Promise<void> {
  await deleteBlob(id);
}
