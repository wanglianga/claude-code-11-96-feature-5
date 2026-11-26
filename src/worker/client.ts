// Worker Promise 客户端：请求/响应配对，向 React 层暴露 async API

import type { AppEvent, Draft, Snapshot } from '../types';
import type { WorkerRequest, WorkerResponse } from './incident.worker';
import type { PlanProposal, RoomCheck } from '../engine/scheduling';
import type { DraftCheck } from '../engine/commands';
import type { MeetingOption } from '../engine/meeting';
import { setSeqStart } from '../engine/commands';

let reqSeq = 0;
const pending = new Map<number, { resolve: (r: WorkerResponse) => void; reject: (e: Error) => void }>();

let worker: Worker | null = null;

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./incident.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (msg: MessageEvent<WorkerResponse>) => {
    const res = msg.data;
    const p = pending.get(res.reqId);
    if (!p) return;
    pending.delete(res.reqId);
    p.resolve(res);
  };
  worker.onerror = (e) => {
    for (const [, p] of pending) p.reject(new Error(e.message));
    pending.clear();
  };
  return worker;
}

type DistributiveOmit<T, K extends string> = T extends unknown ? Omit<T, K> : never;
type ClientRequest = DistributiveOmit<WorkerRequest, 'reqId'>;

function call<T = unknown>(req: ClientRequest): Promise<{ snapshot?: Snapshot; payload?: T }> {
  const w = ensureWorker();
  const reqId = ++reqSeq;
  return new Promise((resolve, reject) => {
    pending.set(reqId, {
      resolve: (res) => {
        if (!res.ok) reject(new Error(res.error));
        else resolve({ snapshot: res.snapshot, payload: res.payload as T | undefined });
      },
      reject,
    });
    w.postMessage({ reqId, ...req } as WorkerRequest);
  });
}

export const workerClient = {
  boot(): Promise<Snapshot> {
    return call({ type: 'boot' }).then((r) => r.snapshot!);
  },
  append(events: AppEvent[]): Promise<Snapshot> {
    // 事件 seq 在主线程命令层已确定；同步命令模块的计数器，避免测试/重建冲突
    if (events.length) setSeqStart(Math.max(...events.map((e) => e.seq)));
    return call<never>({ type: 'append', events }).then((r) => r.snapshot!);
  },
  replay(untilSeq: number): Promise<Snapshot> {
    return call<never>({ type: 'replay', untilSeq }).then((r) => r.snapshot!);
  },
  computePlans(): Promise<{ minimal: PlanProposal; swap: PlanProposal }> {
    return call<{ minimal: PlanProposal; swap: PlanProposal }>({ type: 'compute-plans' }).then((r) => r.payload!);
  },
  evaluateRooms(courseId: string): Promise<RoomCheck[]> {
    return call<RoomCheck[]>({ type: 'evaluate-rooms', courseId }).then((r) => r.payload!);
  },
  checkDraft(draft: Draft, nowMin: number): Promise<DraftCheck> {
    return call<DraftCheck>({ type: 'check-draft', draft, nowMin }).then((r) => r.payload!);
  },
  meetingOptions(familyId: string): Promise<{ joint: MeetingOption; separate: MeetingOption }> {
    return call<{ joint: MeetingOption; separate: MeetingOption }>({ type: 'meeting-options', familyId }).then(
      (r) => r.payload!,
    );
  },
  listEvents(): Promise<AppEvent[]> {
    return call<AppEvent[]>({ type: 'list-events' }).then((r) => r.payload!);
  },
  reset(): Promise<Snapshot> {
    return call<never>({ type: 'reset' }).then((r) => r.snapshot!);
  },
};
