// 命令层：把用户操作翻译为事件；所有规则校验集中在这里，worker 唯一入口

import type {
  AppEvent,
  Draft,
  FaultType,
  ReassignmentMove,
  Snapshot,
} from '../types';
import { replay } from './reducer';
import { computePlans, validateMoves, type PlanProposal } from './scheduling';
import { uid } from '../lib/id';
import { minToHM, todayISO } from '../lib/time';

export interface CommandResult {
  ok: boolean;
  error?: string;
  events: AppEvent[];
}

let seqCounter = 0;
export function setSeqStart(n: number): void {
  seqCounter = n;
}

type DistributiveOmit<T, K extends string> = T extends unknown ? Omit<T, K> : never;
export type EventBody = DistributiveOmit<AppEvent, 'seq' | 'at'>;

function ev(partial: EventBody, atMin: number): AppEvent {
  seqCounter += 1;
  return { seq: seqCounter, at: todayISO(atMin), ...partial } as AppEvent;
}

/** 会谈命令模块复用同一 seq 计数器，保证全站事件序号连续 */
export function makeEvent(partial: EventBody, atMin: number): AppEvent {
  return ev(partial, atMin);
}

/**
 * 查找同故障类型、尚未复测关闭的事故（重复报修合并依据）。
 * 同一冷凝水主管会波及多间教室：同类型的后续报修并入同一事故，
 * reducer 会把新房间追加到事故边界，等待设施统一核准。
 */
function findOpenIncident(
  snap: Snapshot,
  _roomId: string,
  faultType: FaultType,
): string | null {
  for (const inc of Object.values(snap.incidents)) {
    if (inc.status === 'verified') continue;
    if (inc.faultType === faultType) return inc.id;
  }
  return null;
}

/**
 * 提交报修。
 * - 同主管同类型重复报修 -> 合并到既有事故，report.duplicate = true
 * - 新报修 -> incident.created + report.submitted
 */
export function submitReport(
  snap: Snapshot,
  input: {
    roomId: string;
    faultType: FaultType;
    description: string;
    photoIds: string[];
    teacherId: string;
    atMin: number;
  },
): CommandResult {
  const events: AppEvent[] = [];
  const existingId = findOpenIncident(snap, input.roomId, input.faultType);
  let incidentId = existingId;
  if (!incidentId) {
    incidentId = uid('inc');
    events.push(
      ev(
        {
          type: 'incident.created',
          incidentId,
          roomIds: [input.roomId],
          faultType: input.faultType,
          sourceReportId: 'pending',
        },
        input.atMin,
      ),
    );
  }
  const reportId = uid('rep');
  const created = events.find((e) => e.type === 'incident.created');
  if (created && created.type === 'incident.created') created.sourceReportId = reportId;
  events.push(
    ev(
      {
        type: 'report.submitted',
        reportId,
        incidentId: incidentId!,
        roomId: input.roomId,
        faultType: input.faultType,
        description: input.description,
        photoIds: input.photoIds,
        teacherId: input.teacherId,
        duplicate: existingId !== null,
      },
      input.atMin,
    ),
  );
  return { ok: true, events };
}

/** 设施核准事故边界与预计修复时间，封闭房间 */
export function confirmBoundary(
  snap: Snapshot,
  input: { incidentId: string; roomIds: string[]; estimatedEndMin: number; atMin: number; by: string },
): CommandResult {
  const inc = snap.incidents[input.incidentId];
  if (!inc) return { ok: false, error: '事故不存在', events: [] };
  if (inc.status === 'verified') return { ok: false, error: '事故已复测关闭', events: [] };
  const events: AppEvent[] = [
    ev(
      {
        type: 'incident.boundaryConfirmed',
        incidentId: input.incidentId,
        roomIds: input.roomIds,
        estimatedEndMin: input.estimatedEndMin,
        sinceMin: input.atMin,
        by: input.by,
      },
      input.atMin,
    ),
  ];
  return { ok: true, events };
}

export function createWorkOrder(
  snap: Snapshot,
  input: { incidentId: string; summary: string; assignee: string; atMin: number },
): CommandResult {
  const inc = snap.incidents[input.incidentId];
  if (!inc) return { ok: false, error: '事故不存在', events: [] };
  if (inc.status !== 'confirmed')
    return { ok: false, error: '事故边界尚未核准，不能生成工单', events: [] };
  return {
    ok: true,
    events: [
      ev(
        {
          type: 'workorder.created',
          workOrderId: uid('wo'),
          incidentId: input.incidentId,
          summary: input.summary,
          assignee: input.assignee,
        },
        input.atMin,
      ),
    ],
  };
}

export function markRepaired(
  snap: Snapshot,
  input: { incidentId: string; atMin: number; by: string },
): CommandResult {
  const inc = snap.incidents[input.incidentId];
  if (!inc) return { ok: false, error: '事故不存在', events: [] };
  if (inc.status !== 'work_order')
    return { ok: false, error: '只有维修中的工单可以标记已修复', events: [] };
  return {
    ok: true,
    events: [ev({ type: 'repair.marked', incidentId: input.incidentId, by: input.by }, input.atMin)],
  };
}

export function failRetest(
  snap: Snapshot,
  input: { incidentId: string; atMin: number; by: string; note: string },
): CommandResult {
  const inc = snap.incidents[input.incidentId];
  if (!inc) return { ok: false, error: '事故不存在', events: [] };
  if (inc.status !== 'repaired')
    return { ok: false, error: '只有标记已修复的事故才能复测', events: [] };
  return {
    ok: true,
    events: [
      ev(
        {
          type: 'retest.failed',
          incidentId: input.incidentId,
          by: input.by,
          note: input.note,
        },
        input.atMin,
      ),
    ],
  };
}

/** 复测通过：解除封闭的唯一路径 */
export function passRetest(
  snap: Snapshot,
  input: { incidentId: string; atMin: number; by: string },
): CommandResult {
  const inc = snap.incidents[input.incidentId];
  if (!inc) return { ok: false, error: '事故不存在', events: [] };
  if (inc.status !== 'repaired')
    return { ok: false, error: '只有标记已修复的事故才能复测', events: [] };
  return {
    ok: true,
    events: [ev({ type: 'retest.passed', incidentId: input.incidentId, by: input.by }, input.atMin)],
  };
}

/** 调度员生成候选方案（不落事件，只做计算） */
export function evaluatePlans(snap: Snapshot): { minimal: PlanProposal; swap: PlanProposal } {
  return computePlans(snap);
}

/** 把方案转为 proposed 事件；发布前再做一次重叠硬校验 */
export function proposePlan(
  snap: Snapshot,
  input: { proposal: PlanProposal; atMin: number; by: string },
): CommandResult {
  const p = input.proposal;
  if (!p.feasible) return { ok: false, error: '方案不可行：' + p.reasons.join('；'), events: [] };
  const errors = validateMoves(snap, p.moves);
  if (errors.length) return { ok: false, error: errors.join('；'), events: [] };
  const planId = uid('plan');
  return {
    ok: true,
    events: [
      ev(
        {
          type: 'reassignment.proposed',
          planId,
          strategy: p.strategy,
          moves: p.moves,
          studentMinutes: p.studentMinutes,
          notifiedClassIds: p.notifiedClassIds,
          affectedRoomIds: p.affectedRoomIds,
          by: input.by,
        },
        input.atMin,
      ),
    ],
  };
}

export function confirmPlan(
  snap: Snapshot,
  input: { planId: string; courseId: string; atMin: number; by: string },
): CommandResult {
  const plan = snap.plans[input.planId];
  if (!plan) return { ok: false, error: '方案不存在', events: [] };
  if (plan.status !== 'proposed') return { ok: false, error: '方案已发布或取消', events: [] };
  if (!plan.moves.some((m) => m.courseId === input.courseId))
    return { ok: false, error: '该课程不在方案中', events: [] };
  if (plan.confirmedCourseIds.includes(input.courseId))
    return { ok: false, error: '该课程教师已确认', events: [] };
  return {
    ok: true,
    events: [
      ev(
        {
          type: 'reassignment.confirmed',
          planId: input.planId,
          courseId: input.courseId,
          by: input.by,
        },
        input.atMin,
      ),
    ],
  };
}

/**
 * 发布：所有被移动课程的教师都确认后才允许；
 * 为每个班级生成带版本的通知，同学若有旧通知则标记 superseded。
 */
export function publishPlan(
  snap: Snapshot,
  input: { planId: string; atMin: number },
): CommandResult {
  const plan = snap.plans[input.planId];
  if (!plan) return { ok: false, error: '方案不存在', events: [] };
  if (plan.status !== 'proposed') return { ok: false, error: '方案已发布或取消', events: [] };
  const all = plan.moves.map((m) => m.courseId);
  const missing = all.filter((id) => !plan.confirmedCourseIds.includes(id));
  if (missing.length) {
    return {
      ok: false,
      error: `仍有教师未确认：${missing.map((id) => snap.courses[id]?.className ?? id).join('、')}`,
      events: [],
    };
  }
  const errors = validateMoves(snap, plan.moves);
  if (errors.length) return { ok: false, error: errors.join('；'), events: [] };

  const events: AppEvent[] = [];
  const notificationIds: string[] = [];
  for (const move of plan.moves) {
    const course = snap.courses[move.courseId];
    const room = snap.rooms[move.toRoomId];
    const prior = Object.values(snap.notifications)
      .filter((n) => n.courseId === course.id && !n.superseded)
      .sort((a, b) => b.version - a.version)[0];
    const version = prior ? prior.version + 1 : 1;
    const notificationId = uid('ntf');
    notificationIds.push(notificationId);
    events.push(
      ev(
        {
          type: 'notification.sent',
          notificationId,
          version,
          courseId: course.id,
          className: course.className,
          teacherId: course.teacherId,
          roomId: room.id,
          roomName: room.name,
          startMin: course.startMin,
          endMin: course.endMin,
          title: `【临时改排 v${version}】${course.className} 教室变更`,
          body: `${course.className} 于 ${minToHM(course.startMin)}-${minToHM(
            course.endMin,
          )} 的课程改至 ${room.name}，请师生前往同一地点。`,
          planId: plan.id,
          supersedesId: prior?.id ?? null,
        },
        input.atMin,
      ),
    );
  }
  events.push(
    ev(
      {
        type: 'reassignment.published',
        planId: plan.id,
        notificationIds,
      },
      input.atMin,
    ),
  );
  return { ok: true, events };
}

export function cancelPlan(
  snap: Snapshot,
  input: { planId: string; reason: string; atMin: number },
): CommandResult {
  const plan = snap.plans[input.planId];
  if (!plan) return { ok: false, error: '方案不存在', events: [] };
  if (plan.status === 'published') return { ok: false, error: '已发布方案不能取消', events: [] };
  return {
    ok: true,
    events: [
      ev(
        { type: 'reassignment.cancelled', planId: input.planId, reason: input.reason },
        input.atMin,
      ),
    ],
  };
}

// ---------- 草稿冲突判定（离线教师联网后） ----------

export type DraftCheck =
  | { kind: 'ok' }
  | { kind: 'expired'; reason: string }
  | { kind: 'conflict'; reason: string };

/**
 * 离线草稿恢复联网后提交前的检查：
 * - 草稿对应课程时段已过 -> 过期，禁止发布
 * - baseSeq 之后该课程已被改排 -> 冲突，草稿不能覆盖新安排
 */
export function checkDraft(snap: Snapshot, draft: Draft, nowMin: number): DraftCheck {
  const course = draft.courseId ? snap.courses[draft.courseId] : undefined;
  if (course && nowMin >= course.endMin) {
    return {
      kind: 'expired',
      reason: `课程 ${course.className} 的时段已结束（${course.endMin / 60}:00 前有效），不能再发布过期教室的报修`,
    };
  }
  if (course && course.status === 'reassigned' && snap.seq > draft.baseSeq) {
    const room = snap.rooms[course.roomId];
    return {
      kind: 'conflict',
      reason: `保存草稿期间 ${course.className} 已被改排至 ${room.name}，旧草稿进入冲突处理，不能覆盖新安排`,
    };
  }
  // 房间已被其他事故封闭且复测关闭之外的情况仍允许报修；重复报修走合并
  return { kind: 'ok' };
}

/** 一次性把命令产生的事件应用到快照（测试与 worker 复用） */
export function applyCommands(seed: Snapshot, lists: AppEvent[][]): Snapshot {
  const all = lists.flat();
  setSeqStart(Math.max(seed.seq, ...all.map((e) => e.seq), 0));
  return replay(all, seed);
}

export function movesOfProposal(p: PlanProposal): ReassignmentMove[] {
  return p.moves;
}
