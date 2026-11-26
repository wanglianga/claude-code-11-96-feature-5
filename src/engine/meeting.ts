// 家长会谈可行性引擎（纯函数，worker 与测试共用）
// 比较“联合一场”与“分开两场”两种家长可选安排：
// - 联合 15:30-16:10：少一次往返，但只有家长与两位学生都明确同意共享议题才可讨论共同事项
// - 分开 15:30-15:50 / 15:50-16:10：信息边界清楚，教师需分别确认、家长切换议题
// 所有窗口约束来自种子 MEETING_WINDOW，资源（接待室/口译员）做重叠硬校验

import type {
  Family,
  MeetingMode,
  MeetingRoom,
  ResourceBooking,
  Snapshot,
  Interpreter,
  TeacherLink,
} from '../types';
import { MEETING_WINDOW } from '../lib/seed';
import { overlaps } from '../lib/time';

export interface SessionPlan {
  key: string;
  title: string;
  joint: boolean;
  studentIds: string[];
  startMin: number;
  endMin: number;
  roomId: string;
  interpreterRequired: boolean;
  teacherIds: string[];
  hostTeacherId: string;
}

export interface MeetingOption {
  mode: MeetingMode;
  feasible: boolean;
  reasons: string[];
  sessions: SessionPlan[];
  /** 参会人去重统计与逐场名单，用于和分开方案比较 */
  attendees: {
    parent: number;
    teachers: string[];
    interpreters: string[];
    students: string[];
  };
  /** 通知对象：联合一场通知一次，分开两场教师需分别确认/通知 */
  notifications: {
    teacherConfirmCount: number; // 需要分别确认的教师-场次次数
    parentNoticeCount: number; // 家长收到的场次通知次数
    interpreterNoticeCount: number;
    rosterCount: number; // 门岗名册批次
  };
  trips: number; // 家长往返/议题切换成本说明用
}

function activeBookings(snap: Snapshot): ResourceBooking[] {
  return Object.values(snap.bookings).filter((b) => b.status === 'held');
}

function roomFree(
  snap: Snapshot,
  roomId: string,
  startMin: number,
  endMin: number,
  ignoreSessionId?: string,
): boolean {
  return !activeBookings(snap).some(
    (b) =>
      b.resourceType === 'room' &&
      b.resourceId === roomId &&
      b.sessionId !== ignoreSessionId &&
      overlaps(startMin, endMin, b.startMin, b.endMin),
  );
}

function interpreterFree(
  snap: Snapshot,
  interpreterId: string,
  startMin: number,
  endMin: number,
  ignoreSessionId?: string,
): boolean {
  return !activeBookings(snap).some(
    (b) =>
      b.resourceType === 'interpreter' &&
      b.resourceId === interpreterId &&
      b.sessionId !== ignoreSessionId &&
      overlaps(startMin, endMin, b.startMin, b.endMin),
  );
}

function withinWindow(startMin: number, endMin: number, winStart: number, winEnd: number): boolean {
  return startMin >= winStart && endMin <= winEnd;
}

/** 两位学生共同的参会教师（班主任 + 数学教师均教两位学生时参加联合场） */
function commonTeachers(snap: Snapshot, studentIds: string[]): string[] {
  const sets = studentIds.map(
    (id) => new Set(snap.teachings.filter((t) => t.studentId === id).map((t) => t.teacherId)),
  );
  const [first, ...rest] = sets;
  return [...first].filter((tid) => rest.every((set) => set.has(tid)));
}

function pickRoom(snap: Snapshot, family: Family): MeetingRoom | undefined {
  // 题目接待室整段可用；仍按家庭窗口与房间窗口校验
  return Object.values(snap.meetingRooms).find(
    (r) =>
      withinWindow(
        Math.max(family.availableStartMin, r.startMin),
        Math.min(family.availableEndMin, r.endMin),
        r.startMin,
        r.endMin,
      ) && r.endMin - r.startMin > 0,
  );
}

function pickInterpreter(snap: Snapshot, family: Family): Interpreter | undefined {
  if (!family.needsInterpreter) return undefined;
  return Object.values(snap.interpreters).find(
    (i) => i.startMin <= MEETING_WINDOW.interpreterStart && i.endMin >= MEETING_WINDOW.interpreterEnd,
  );
}

/** 校验单场的窗口与资源占用，返回不合格原因 */
function validateSession(
  snap: Snapshot,
  family: Family,
  room: MeetingRoom | undefined,
  interpreter: Interpreter | undefined,
  sp: SessionPlan,
  ignoreSessionId?: string,
): string[] {
  const reasons: string[] = [];
  const W = MEETING_WINDOW;

  if (!withinWindow(sp.startMin, sp.endMin, family.availableStartMin, family.availableEndMin)) {
    reasons.push(`${sp.title} 超出家长可到校窗口 15:00-16:30`);
  }
  if (!room) {
    reasons.push(`${sp.title} 无可用接待室`);
  } else if (!withinWindow(sp.startMin, sp.endMin, room.startMin, room.endMin)) {
    reasons.push(`${sp.title} 超出接待室可用时段`);
  } else if (!roomFree(snap, room.id, sp.startMin, sp.endMin, ignoreSessionId)) {
    reasons.push(`${sp.title} 接待室时段与既有预约重叠`);
  }
  if (sp.interpreterRequired) {
    if (!interpreter) {
      reasons.push(`${sp.title} 需要口译但无可用口译员`);
    } else if (!withinWindow(sp.startMin, sp.endMin, interpreter.startMin, interpreter.endMin)) {
      reasons.push(`${sp.title} 超出口译员可服务窗口 15:30-16:30`);
    } else if (!interpreterFree(snap, interpreter.id, sp.startMin, sp.endMin, ignoreSessionId)) {
      reasons.push(`${sp.title} 口译员时段与既有预约重叠`);
    }
  }
  // 教师可参加窗口 15:30-16:10
  for (const tid of sp.teacherIds) {
    void tid;
    if (!withinWindow(sp.startMin, sp.endMin, W.teacherStart, W.teacherEnd)) {
      reasons.push(`${sp.title} 超出班主任/数学教师可参加窗口 15:30-16:10`);
      break;
    }
  }
  return reasons;
}

/** 改期前的公共校验：忽略本场旧占用后，检查新窗口与资源是否仍可行 */
export function validateReschedule(
  snap: Snapshot,
  sp: SessionPlan,
  ignoreSessionId: string,
): string[] {
  const familyId = snap.students[sp.studentIds[0]]?.familyId;
  const family = familyId ? snap.families[familyId] : undefined;
  if (!family) return ['家庭数据缺失，无法改期'];
  const room = snap.meetingRooms[sp.roomId];
  const interp = family.needsInterpreter ? Object.values(snap.interpreters)[0] : undefined;
  return validateSession(snap, family, room, interp, sp, ignoreSessionId);
}

function buildAttendees(snap: Snapshot, family: Family, sessions: SessionPlan[]) {
  const teachers = new Set<string>();
  const interpreters = new Set<string>();
  const students = new Set<string>();
  for (const sp of sessions) {
    sp.teacherIds.forEach((t) => teachers.add(t));
    if (sp.interpreterRequired) {
      const interp = pickInterpreter(snap, family);
      if (interp) interpreters.add(interp.id);
    }
    sp.studentIds.forEach((s) => students.add(s));
  }
  return {
    parent: 1,
    teachers: [...teachers],
    interpreters: [...interpreters],
    students: [...students],
  };
}

/** 联合方案：一场 15:30-16:10，两位学生 + 共同教师 + 家长 + 口译员 */
export function evaluateJoint(snap: Snapshot, familyId: string): MeetingOption {
  const family = snap.families[familyId];
  const room = pickRoom(snap, family);
  const interpreter = pickInterpreter(snap, family);
  const studentIds = [...family.studentIds];
  const teacherIds = commonTeachers(snap, studentIds);
  const host = snap.students[studentIds[0]]?.homeroomTeacherId ?? teacherIds[0];

  const sp: SessionPlan = {
    key: 'joint',
    title: '联合会谈（共同议题）',
    joint: true,
    studentIds,
    startMin: MEETING_WINDOW.jointStart,
    endMin: MEETING_WINDOW.jointEnd,
    roomId: room?.id ?? 'mr_reception',
    interpreterRequired: family.needsInterpreter,
    teacherIds,
    hostTeacherId: host,
  };

  const reasons = validateSession(snap, family, room, interpreter, sp);
  // 联合场必须覆盖两位学生且时长 = 2 × 20 分钟
  if (sp.endMin - sp.startMin !== MEETING_WINDOW.perStudentMin * 2) {
    reasons.push('联合场时长应为 40 分钟（两位学生各 20 分钟）');
  }
  const consent = activeConsent(snap, familyId);
  if (!consent) {
    reasons.push('联合场讨论共同事项前，必须取得家长与两位学生的明确共享同意');
  }

  const sessions = reasons.length === 0 ? [sp] : [sp];
  return {
    mode: 'joint',
    feasible: reasons.length === 0,
    reasons,
    sessions,
    attendees: buildAttendees(snap, family, sessions),
    notifications: {
      teacherConfirmCount: teacherIds.length, // 一场一次确认
      parentNoticeCount: 1,
      interpreterNoticeCount: family.needsInterpreter ? 1 : 0,
      rosterCount: 1,
    },
    trips: 1,
  };
}

/** 分开方案：两场各 20 分钟，信息边界清楚，教师分别确认 */
export function evaluateSeparate(snap: Snapshot, familyId: string): MeetingOption {
  const family = snap.families[familyId];
  const room = pickRoom(snap, family);
  const interpreter = pickInterpreter(snap, family);
  const W = MEETING_WINDOW;
  const reasons: string[] = [];
  // 本次家长会的出席教师为两位学生共同的班主任与数学教师；
  // 只教一位学生的教师（如苏老师）不出席，但仍受任教关系可见性约束
  const familyTeachers = commonTeachers(snap, [...family.studentIds]);
  const sessions: SessionPlan[] = family.studentIds.map((studentId, idx) => {
    const startMin = idx === 0 ? W.splitAStart : W.splitBStart;
    const endMin = idx === 0 ? W.splitAEnd : W.splitBEnd;
    const host = snap.students[studentId]?.homeroomTeacherId ?? familyTeachers[0];
    return {
      key: `sep_${studentId}`,
      title: `个别会谈（${snap.students[studentId]?.name ?? studentId}）`,
      joint: false,
      studentIds: [studentId],
      startMin,
      endMin,
      roomId: room?.id ?? 'mr_reception',
      interpreterRequired: family.needsInterpreter,
      teacherIds: familyTeachers,
      hostTeacherId: host,
    };
  });

  for (const sp of sessions) reasons.push(...validateSession(snap, family, room, interpreter, sp));
  // 两场首尾相接、不可重叠
  if (sessions.length === 2 && overlaps(sessions[0].startMin, sessions[0].endMin, sessions[1].startMin, sessions[1].endMin)) {
    reasons.push('分开的两场时间不得重叠');
  }

  const teacherConfirmCount = sessions.reduce((acc, sp) => acc + sp.teacherIds.length, 0);
  return {
    mode: 'separate',
    feasible: reasons.length === 0,
    reasons,
    sessions,
    attendees: buildAttendees(snap, family, sessions),
    notifications: {
      teacherConfirmCount, // 教师按场次分别确认
      parentNoticeCount: 2, // 家长收到两场通知、需切换议题
      interpreterNoticeCount: family.needsInterpreter ? 2 : 0,
      rosterCount: 2,
    },
    trips: 2,
  };
}

export function activeConsent(snap: Snapshot, familyId: string) {
  return (
    Object.values(snap.consents).find((c) => c.familyId === familyId && c.granted) ?? null
  );
}

export function evaluateMeetingOptions(snap: Snapshot, familyId: string) {
  return {
    joint: evaluateJoint(snap, familyId),
    separate: evaluateSeparate(snap, familyId),
  };
}

/** 给 UI/通知用的任教关系描述 */
export function describeTeachings(links: TeacherLink[]): string {
  return links.map((l) => `${l.teacherId}:${l.subject}`).join('、');
}
