import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  appendEvent,
  clearEvents,
  getAllEvents,
  getAllDrafts,
  getBlob,
  putBlob,
  putDraft,
  resetDatabase,
} from '../db/idb';
import { replay } from './reducer';
import { initialSnapshot } from './reducer';
import { setSeqStart, submitReport, confirmBoundary } from './commands';
import { hmToMin } from '../lib/time';
import type { Draft } from '../types';

describe('IndexedDB 持久化与可回放', () => {
  it('事件写入后可全部读出，按 seq 排序并重放出封闭状态', async () => {
    await clearEvents();
    let snap = initialSnapshot();
    setSeqStart(0);

    const r1 = submitReport(snap, {
      roomId: 'r_B201',
      faultType: 'leak',
      description: '主管滴水',
      photoIds: [],
      teacherId: 'u_teacher_a',
      atMin: hmToMin('09:40'),
    });
    for (const e of r1.events) await appendEvent(e);
    snap = replay(r1.events, snap);

    const r2 = submitReport(snap, {
      roomId: 'r_B202',
      faultType: 'leak',
      description: '同主管渗水',
      photoIds: [],
      teacherId: 'u_teacher_b',
      atMin: hmToMin('09:45'),
    });
    for (const e of r2.events) await appendEvent(e);
    snap = replay(r2.events, snap);

    const inc = Object.values(snap.incidents)[0];
    const r3 = confirmBoundary(snap, {
      incidentId: inc.id,
      roomIds: ['r_B201', 'r_B202'],
      estimatedEndMin: hmToMin('12:00'),
      atMin: hmToMin('09:50'),
      by: 'u_facility',
    });
    for (const e of r3.events) await appendEvent(e);

    // 模拟刷新页面：重新从 IndexedDB 读取全量事件回放
    const stored = await getAllEvents();
    expect(stored.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    const rebuilt = replay(stored);
    expect(rebuilt.seq).toBe(4);
    expect(rebuilt.closures.r_B201.closed).toBe(true);
    expect(rebuilt.closures.r_B202.closed).toBe(true);
    expect(Object.values(rebuilt.incidents)[0].roomIds.sort()).toEqual(['r_B201', 'r_B202']);
  });

  it('草稿与照片 Blob 可独立存取，resetDatabase 清空全部 store', async () => {
    const draft: Draft = {
      id: 'd_test',
      teacherId: 'u_teacher_a',
      roomId: 'r_B201',
      courseId: 'c_A',
      faultType: 'leak',
      description: '离线草稿',
      photoIds: ['ph_test'],
      status: 'draft',
      baseSeq: 2,
      conflictReason: null,
      createdAt: '',
      updatedAt: '',
    };
    await putDraft(draft);
    const drafts = await getAllDrafts();
    expect(drafts.find((d) => d.id === 'd_test')?.baseSeq).toBe(2);

    const blob = new Blob(['x'], { type: 'image/png' });
    await putBlob({ id: 'ph_test', mime: 'image/png', size: 1, createdAt: '', blob });
    const got = await getBlob('ph_test');
    expect(got?.mime).toBe('image/png');
    expect(got?.blob.size).toBe(1);

    await resetDatabase();
    expect(await getAllEvents()).toEqual([]);
    expect(await getAllDrafts()).toEqual([]);
    expect(await getBlob('ph_test')).toBeUndefined();
  });
});
