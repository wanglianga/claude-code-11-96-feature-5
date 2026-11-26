// WebWorker：事件日志的唯一写入口，负责持久化、回放快照与排课计算
// 主线程只通过消息与 worker 通信，保证 UI 渲染不被回放/计算阻塞

import type { AppEvent, Draft, Snapshot } from '../types';
import { appendEvent, clearEvents, getAllEvents } from '../db/idb';
import { initialSnapshot, replay } from '../engine/reducer';
import { computePlans, evaluateRooms } from '../engine/scheduling';
import { checkDraft } from '../engine/commands';
import { evaluateMeetingOptions } from '../engine/meeting';

export type WorkerRequest =
  | { reqId: number; type: 'boot' }
  | { reqId: number; type: 'append'; events: AppEvent[] }
  | { reqId: number; type: 'replay'; untilSeq: number }
  | { reqId: number; type: 'compute-plans' }
  | { reqId: number; type: 'evaluate-rooms'; courseId: string }
  | { reqId: number; type: 'check-draft'; draft: Draft; nowMin: number }
  | { reqId: number; type: 'meeting-options'; familyId: string }
  | { reqId: number; type: 'list-events' }
  | { reqId: number; type: 'reset' };

export type WorkerResponse =
  | { reqId: number; ok: true; snapshot?: Snapshot; payload?: unknown }
  | { reqId: number; ok: false; error: string };

let current: Snapshot = initialSnapshot();

async function rebuild(): Promise<Snapshot> {
  const events = await getAllEvents();
  current = replay(events);
  return current;
}

self.onmessage = async (msg: MessageEvent<WorkerRequest>) => {
  const req = msg.data;
  try {
    switch (req.type) {
      case 'boot': {
        const snapshot = await rebuild();
        self.postMessage({ reqId: req.reqId, ok: true, snapshot } satisfies WorkerResponse);
        break;
      }
      case 'append': {
        for (const e of req.events) await appendEvent(e);
        const snapshot = await rebuild();
        self.postMessage({ reqId: req.reqId, ok: true, snapshot } satisfies WorkerResponse);
        break;
      }
      case 'replay': {
        const all = await getAllEvents();
        const partial = all.filter((e) => e.seq <= req.untilSeq);
        const snapshot = replay(partial);
        self.postMessage({ reqId: req.reqId, ok: true, snapshot } satisfies WorkerResponse);
        break;
      }
      case 'compute-plans': {
        const plans = computePlans(current);
        self.postMessage({ reqId: req.reqId, ok: true, payload: plans } satisfies WorkerResponse);
        break;
      }
      case 'evaluate-rooms': {
        const course = current.courses[req.courseId];
        if (!course) throw new Error('课程不存在');
        const checks = evaluateRooms(current, course);
        self.postMessage({ reqId: req.reqId, ok: true, payload: checks } satisfies WorkerResponse);
        break;
      }
      case 'check-draft': {
        const verdict = checkDraft(current, req.draft, req.nowMin);
        self.postMessage({ reqId: req.reqId, ok: true, payload: verdict } satisfies WorkerResponse);
        break;
      }
      case 'meeting-options': {
        const options = evaluateMeetingOptions(current, req.familyId);
        self.postMessage({ reqId: req.reqId, ok: true, payload: options } satisfies WorkerResponse);
        break;
      }
      case 'list-events': {
        const events = await getAllEvents();
        self.postMessage({ reqId: req.reqId, ok: true, payload: events } satisfies WorkerResponse);
        break;
      }
      case 'reset': {
        await clearEvents();
        const snapshot = await rebuild();
        self.postMessage({ reqId: req.reqId, ok: true, snapshot } satisfies WorkerResponse);
        break;
      }
    }
  } catch (err) {
    self.postMessage({
      reqId: req.reqId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    } satisfies WorkerResponse);
  }
};
