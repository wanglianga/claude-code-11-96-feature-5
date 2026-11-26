// 排课引擎：候选教室过滤、两种改排方案、重叠/容量/设备校验
// 全部为纯函数，worker 与测试共用

import type { Course, ReassignmentMove, Room, Snapshot } from '../types';
import { overlaps } from '../lib/time';
import { DISTANCE } from '../lib/seed';

export interface PlanProposal {
  strategy: 'minimal' | 'swap';
  feasible: boolean;
  moves: ReassignmentMove[];
  studentMinutes: number;
  notifiedClassIds: string[];
  affectedRoomIds: string[];
  reasons: string[];
}

export interface RoomCheck {
  room: Room;
  eligible: boolean;
  reasons: string[];
  distance: number;
}

/** 静态条件：容量、设备、无障碍、安全 */
export function roomSatisfies(room: Room, course: Course): string[] {
  const reasons: string[] = [];
  if (room.capacity < course.size) reasons.push(`容量不足（${room.capacity}<${course.size}）`);
  for (const req of course.requirements) {
    if (req === 'accessible') {
      if (!room.accessible) reasons.push('无无障碍通道');
    } else if (req === 'safety') {
      if (!room.safety) reasons.push('安全条件不满足');
    } else if (!room.equipment.includes(req)) {
      reasons.push(`缺少设备：${req}`);
    }
  }
  if (!room.safety) reasons.push('安全条件不满足');
  return [...new Set(reasons)];
}

export function distanceBetween(fromRoomId: string, toRoomId: string): number {
  const d = DISTANCE[fromRoomId]?.[toRoomId];
  if (d === undefined) throw new Error(`距离矩阵缺失: ${fromRoomId} -> ${toRoomId}`);
  return d;
}

function isClosed(snap: Snapshot, roomId: string): boolean {
  return snap.closures[roomId]?.closed === true;
}

interface Occupancy {
  roomId: string;
  course: Course;
}

/** 当前占用（可附带回放中的改排移动） */
function buildOccupancy(snap: Snapshot, moves: ReassignmentMove[] = []): Occupancy[] {
  const roomOf = new Map<string, string>();
  for (const c of Object.values(snap.courses)) roomOf.set(c.id, c.roomId);
  for (const m of moves) roomOf.set(m.courseId, m.toRoomId);
  return Object.values(snap.courses).map((c) => ({
    roomId: roomOf.get(c.id)!,
    course: c,
  }));
}

/** 房间在课程全时段是否空闲（忽略课程自身） */
function roomFreeFor(
  occupancy: Occupancy[],
  roomId: string,
  course: Course,
  ignoreCourseIds: Set<string>,
): boolean {
  return !occupancy.some(
    (o) =>
      o.roomId === roomId &&
      !ignoreCourseIds.has(o.course.id) &&
      overlaps(course.startMin, course.endMin, o.course.startMin, o.course.endMin),
  );
}

/** 列出一间教室对某课程的全部判定（供 UI 展示过滤原因） */
export function evaluateRooms(snap: Snapshot, course: Course): RoomCheck[] {
  const occupancy = buildOccupancy(snap);
  return Object.values(snap.rooms)
    .map((room) => {
      const reasons = roomSatisfies(room, course);
      if (isClosed(snap, room.id)) reasons.push('教室已封闭');
      if (!roomFreeFor(occupancy, room.id, course, new Set([course.id]))) {
        reasons.push('课程全时段不空闲');
      }
      return {
        room,
        eligible: reasons.length === 0,
        reasons,
        distance: distanceBetween(course.originalRoomId, room.id),
      };
    })
    .sort((a, b) => a.distance - b.distance);
}

function moveMinutes(course: Course, toRoomId: string, fromRoomId: string): number {
  return course.size * distanceBetween(fromRoomId, toRoomId);
}

/**
 * 方案级校验：目标房间不封闭、满足条件、且任意同房课程时段不重叠
 */
export function validateMoves(snap: Snapshot, moves: ReassignmentMove[]): string[] {
  const errors: string[] = [];
  const occupancy = buildOccupancy(snap, moves);
  const moved = new Set(moves.map((m) => m.courseId));

  for (const m of moves) {
    const course = snap.courses[m.courseId];
    const room = snap.rooms[m.toRoomId];
    if (!course || !room) {
      errors.push(`移动 ${m.courseId} -> ${m.toRoomId} 引用了不存在的数据`);
      continue;
    }
    if (isClosed(snap, m.toRoomId)) errors.push(`${room.name} 已封闭，不能排入`);
    const sat = roomSatisfies(room, course);
    if (sat.length) errors.push(`${room.name} 不满足 ${course.className}：${sat.join('、')}`);
    if (m.studentMinutes !== moveMinutes(course, m.toRoomId, m.fromRoomId)) {
      errors.push(`${course.className} 的学生分钟计算与距离矩阵不一致`);
    }
  }

  // 两两重叠检查（同一房间、时间相交即拒绝）
  for (let i = 0; i < occupancy.length; i++) {
    for (let j = i + 1; j < occupancy.length; j++) {
      if (occupancy[i].roomId !== occupancy[j].roomId) continue;
      const a = occupancy[i].course;
      const b = occupancy[j].course;
      if (overlaps(a.startMin, a.endMin, b.startMin, b.endMin)) {
        errors.push(
          `课程重叠：${a.className} 与 ${b.className} 同时段占用 ${snap.rooms[occupancy[i].roomId].name}`,
        );
      }
    }
  }
  return errors;
}

function sumMinutes(moves: ReassignmentMove[]): number {
  return moves.reduce((acc, m) => acc + m.studentMinutes, 0);
}

/**
 * 受封闭影响、尚未改排的课程（按开始时间排序）。
 * 只统计与当前已核准封闭窗口 [sinceMin, estimatedEndMin] 相交的课程：
 * 窗口之后的课程（如 14:00 的午后课）等待复测结果，复测失败延长封闭时再重新调度。
 */
export function affectedCourses(snap: Snapshot): Course[] {
  return Object.values(snap.courses)
    .filter((c) => {
      if (c.status !== 'normal') return false;
      const closure = snap.closures[c.roomId];
      if (!closure || !closure.closed) return false;
      const end = closure.estimatedEndMin ?? Number.MAX_SAFE_INTEGER;
      return overlaps(c.startMin, c.endMin, closure.sinceMin, end);
    })
    .sort((a, b) => a.startMin - b.startMin);
}

/** 在快照上叠加假设移动，便于链式选房 */
function snapWithMoves(snap: Snapshot, moves: ReassignmentMove[]): Snapshot {
  if (!moves.length) return snap;
  const next = structuredClone(snap);
  for (const m of moves) {
    const c = next.courses[m.courseId];
    if (c) c.roomId = m.toRoomId;
  }
  return next;
}

function toMove(course: Course, toRoomId: string): ReassignmentMove {
  return {
    courseId: course.id,
    fromRoomId: course.roomId,
    toRoomId,
    studentMinutes: moveMinutes(course, toRoomId, course.roomId),
  };
}

/**
 * 方案一 minimal：只移动受影响课程，各自选当前全时段空闲且合格的最近教室，
 * 不允许触动弹性课程。
 */
export function buildMinimalPlan(snap: Snapshot): PlanProposal {
  const affected = affectedCourses(snap);
  const reasons: string[] = [];
  const moves: ReassignmentMove[] = [];
  const simulated: ReassignmentMove[] = [];

  for (const course of affected) {
    const checks = evaluateRooms(snapWithMoves(snap, simulated), course).filter(
      (c) => c.eligible,
    );
    const pick = checks[0];
    if (!pick) {
      reasons.push(`${course.className} 找不到全时段空闲且满足容量/设备/无障碍/安全的教室`);
      continue;
    }
    const m = toMove(course, pick.room.id);
    moves.push(m);
    simulated.push(m);
  }

  const errors = validateMoves(snap, moves);
  reasons.push(...errors);
  return {
    strategy: 'minimal',
    feasible: reasons.length === 0 && moves.length === affected.length,
    moves,
    studentMinutes: sumMinutes(moves),
    notifiedClassIds: moves.map((m) => snap.courses[m.courseId].id),
    affectedRoomIds: [...new Set(affected.map((c) => c.roomId))],
    reasons,
  };
}

interface ChainOption {
  targetRoomId: string;
  /** 腾出目标房间所需的弹性课链式搬迁 */
  chain: ReassignmentMove[];
}

/** 找占用某房间、与课程时段重叠的弹性课程 */
function flexibleOccupant(snap: Snapshot, roomId: string, course: Course): Course | null {
  return (
    Object.values(snap.courses).find(
      (c) =>
        c.flexible &&
        c.id !== course.id &&
        c.roomId === roomId &&
        overlaps(c.startMin, c.endMin, course.startMin, course.endMin),
    ) ?? null
  );
}

/**
 * 方案二 swap：允许把尚未开始的弹性课程挤出，链式换房，最小化总学生分钟。
 * DFS 枚举每个受影响课程的可选房间（合格空闲房，或仅被弹性课占用的房间），
 * 弹性课递归安置到最近的合格空闲房，取总成本最小的组合。
 */
export function buildSwapPlan(snap: Snapshot): PlanProposal {
  const affected = affectedCourses(snap);
  const minimal = buildMinimalPlan(snap);
  const reasons: string[] = [...minimal.reasons];

  interface Best {
    moves: ReassignmentMove[];
    cost: number;
  }
  const bestRef: { current: Best | null } = { current: null };

  function solve(index: number, acc: ReassignmentMove[], displaced: Set<string>, cost: number): void {
    if (index === affected.length) {
      if (bestRef.current === null || cost < bestRef.current.cost) {
        bestRef.current = { moves: [...acc], cost };
      }
      return;
    }
    const course = affected[index];
    const virtual = snapWithMoves(snap, acc);
    const checks = evaluateRooms(virtual, course);
    const options: ChainOption[] = [];

    for (const chk of checks) {
      if (chk.eligible) {
        options.push({ targetRoomId: chk.room.id, chain: [] });
        continue;
      }
      // 仅“时段占用”不可用，且占用者是尚未开始的弹性课程时，才允许交换
      if (chk.reasons.length !== 1 || chk.reasons[0] !== '课程全时段不空闲') continue;
      const occupant = flexibleOccupant(virtual, chk.room.id, course);
      if (!occupant || displaced.has(occupant.id)) continue;
      const afterMove = snapWithMoves(virtual, [toMove(course, chk.room.id)]);
      const relay = evaluateRooms(afterMove, occupant).find((c) => c.eligible);
      if (!relay) continue;
      options.push({ targetRoomId: chk.room.id, chain: [toMove(occupant, relay.room.id)] });
    }

    if (options.length === 0) {
      reasons.push(`${course.className} 无法通过交换获得可行房间`);
      return; // 该分支无解
    }

    for (const opt of options) {
      const main = toMove(course, opt.targetRoomId);
      const nextAcc = [...acc, main, ...opt.chain];
      const nextDisplaced = new Set(displaced);
      for (const m of opt.chain) nextDisplaced.add(m.courseId);
      const nextCost =
        cost + main.studentMinutes + opt.chain.reduce((a, m) => a + m.studentMinutes, 0);
      solve(index + 1, nextAcc, nextDisplaced, nextCost);
    }
  }

  solve(0, [], new Set(), 0);

  const best = bestRef.current;
  if (!best) {
    return {
      strategy: 'swap',
      feasible: false,
      moves: [],
      studentMinutes: 0,
      notifiedClassIds: [],
      affectedRoomIds: [...new Set(affected.map((c) => c.roomId))],
      reasons: [...new Set(reasons)],
    };
  }

  const errors = validateMoves(snap, best.moves);
  const hasFlexMove = best.moves.some((m) => snap.courses[m.courseId].flexible);
  const improves = best.cost < minimal.studentMinutes;
  if (!hasFlexMove) reasons.push('交换方案未触动弹性课程，与方案一相同');
  if (!improves) reasons.push('交换方案未降低学生分钟数，无收益');

  return {
    strategy: 'swap',
    feasible: errors.length === 0 && hasFlexMove && improves,
    moves: best.moves,
    studentMinutes: best.cost,
    notifiedClassIds: best.moves.map((m) => snap.courses[m.courseId].id),
    affectedRoomIds: [...new Set(affected.map((c) => c.roomId))],
    reasons: [...new Set([...errors, ...reasons])],
  };
}

export function computePlans(snap: Snapshot): { minimal: PlanProposal; swap: PlanProposal } {
  return { minimal: buildMinimalPlan(snap), swap: buildSwapPlan(snap) };
}
