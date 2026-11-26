// 会谈预约与接待命令层：操作 -> 事件，规则校验集中于此（worker 唯一写入口）
// 与故障域共用同一 seq 计数器（makeEvent），保证全站事件流连续可回放

import type {
  AppEvent,
  AttendanceRecord,
  MeetingMode,
  SharedStorageMode,
  Snapshot,
} from '../types';
import { makeEvent, type CommandResult } from './commands';
import { replay } from './reducer';
import { evaluateJoint, evaluateSeparate, validateReschedule, type SessionPlan } from './meeting';
import { canTeacherReadStudent } from './access';
import { uid } from '../lib/id';
import { SEED_USERS } from '../lib/seed';

const USER_NAME: Record<string, string> = Object.fromEntries(SEED_USERS.map((u) => [u.id, u.name]));

function ok(events: AppEvent[]): CommandResult {
  return { ok: true, events };
}
function fail(error: string): CommandResult {
  return { ok: false, error, events: [] };
}

function familyOf(snap: Snapshot, familyId: string) {
  const family = snap.families[familyId];
  if (!family) throw new Error(`家庭不存在：${familyId}`);
  return family;
}

function interpreterIdFor(snap: Snapshot, familyId: string): string | null {
  const family = snap.families[familyId];
  if (!family.needsInterpreter) return null;
  return Object.values(snap.interpreters)[0]?.id ?? null;
}

/** 同一会谈同一场次同一接收人的通知版本号（按场次隔离，改期时精确取代旧版） */
function nextNotifVersion(
  snap: Snapshot,
  meetingId: string,
  sessionId: string,
  recipientId: string,
): { version: number; supersedesId: string | null } {
  const prior = Object.values(snap.meetingNotifications)
    .filter(
      (n) =>
        n.meetingId === meetingId &&
        n.sessionId === sessionId &&
        n.recipientId === recipientId &&
        !n.superseded,
    )
    .sort((a, b) => b.version - a.version)[0];
  return { version: prior ? prior.version + 1 : 1, supersedesId: prior?.id ?? null };
}

interface ScheduleBundle {
  events: AppEvent[];
  rosterEntryIds: string[];
  notificationIds: string[];
}

/**
 * 为单场生成资源占用、门岗名册、通知事件（不落 session.scheduled，由调用方统一发）。
 * 名册只登记外部访客：家长与口译员；教师为校内人员，不在访客名册。
 */
function buildSessionBundle(
  snap: Snapshot,
  sp: SessionPlan,
  meetingId: string,
  atMin: number,
  kind: 'invite' | 'change' | 'reschedule',
): ScheduleBundle {
  const events: AppEvent[] = [];
  const rosterEntryIds: string[] = [];
  const notificationIds: string[] = [];
  const familyId = resolveFamilyId(snap, sp);
  const fam = snap.families[familyId];
  const interpreterId = sp.interpreterRequired ? interpreterIdFor(snap, familyId) : null;

  // 1) 资源占用：接待室 + 口译员
  events.push(
    makeEvent(
      {
        type: 'resource.booked',
        bookingId: uid('bk_room'),
        resourceType: 'room',
        resourceId: sp.roomId,
        sessionId: sp.key,
        meetingId,
        startMin: sp.startMin,
        endMin: sp.endMin,
      },
      atMin,
    ),
  );
  if (sp.interpreterRequired && interpreterId) {
    events.push(
      makeEvent(
        {
          type: 'resource.booked',
          bookingId: uid('bk_int'),
          resourceType: 'interpreter',
          resourceId: interpreterId,
          sessionId: sp.key,
          meetingId,
          startMin: sp.startMin,
          endMin: sp.endMin,
        },
        atMin,
      ),
    );
  }

  // 2) 门岗访客名册（家长 + 口译员）
  const rosterPersons: { id: string; name: string; role: 'parent' | 'interpreter' }[] = [
    { id: fam.parentId, name: fam.parentName, role: 'parent' },
  ];
  if (sp.interpreterRequired && interpreterId) {
    rosterPersons.push({
      id: interpreterId,
      name: snap.interpreters[interpreterId].name,
      role: 'interpreter',
    });
  }
  const entries = rosterPersons.map((p) => {
    const id = uid('ve');
    rosterEntryIds.push(id);
    return {
      id,
      sessionId: sp.key,
      personId: p.id,
      personName: p.name,
      personRole: p.role,
    };
  });
  events.push(makeEvent({ type: 'visitor.roster.issued', entries }, atMin));

  // 3) 通知：家长、每位参会教师、口译员
  const recipients: { id: string; role: 'parent' | 'teacher' | 'interpreter'; name: string }[] = [
    { id: fam.parentId, role: 'parent', name: fam.parentName },
    ...sp.teacherIds.map((tid) => ({
      id: tid,
      role: 'teacher' as const,
      name: USER_NAME[tid] ?? tid,
    })),
  ];
  if (sp.interpreterRequired && interpreterId) {
    recipients.push({
      id: interpreterId,
      role: 'interpreter',
      name: snap.interpreters[interpreterId].name,
    });
  }
  const kindTitle = kind === 'invite' ? '预约邀请' : kind === 'change' ? '时间/安排变更' : '改期通知';
  for (const r of recipients) {
    const { version, supersedesId } = nextNotifVersion(snap, meetingId, sp.key, r.id);
    const nid = uid('mn');
    notificationIds.push(nid);
    events.push(
      makeEvent(
        {
          type: 'meeting.notification.sent',
          notificationId: nid,
          meetingId,
          sessionId: sp.key,
          recipientId: r.id,
          recipientRole: r.role,
          kind,
          version,
          title: `【${kindTitle}】${sp.title} ${fmt(sp.startMin)}-${fmt(sp.endMin)}`,
          body: `${r.name} 您好：${sp.title}定于接待室 ${fmt(sp.startMin)}-${fmt(
            sp.endMin,
          )} 举行，请准时出席；门岗名册已同步。`,
          supersedesId,
        },
        atMin,
      ),
    );
  }

  return { events, rosterEntryIds, notificationIds };
}

function resolveFamilyId(snap: Snapshot, sp: SessionPlan): string {
  // SessionPlan 不直接带 familyId，从学生反查
  const anyStudent = sp.studentIds[0];
  return snap.students[anyStudent]?.familyId ?? '';
}

function fmt(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// ---------- 共享议题授权 ----------

/** 家长代表并附两位学生明确同意；缺一不可 */
export function grantConsent(
  snap: Snapshot,
  input: {
    familyId: string;
    grantedBy: string;
    studentApprovals: Record<string, boolean>;
    atMin: number;
  },
): CommandResult {
  const family = familyOf(snap, input.familyId);
  const allApproved = family.studentIds.every((id) => input.studentApprovals[id] === true);
  if (!allApproved) return fail('共同议题须家长与两位学生全部明确同意，当前同意不完整');
  const already = Object.values(snap.consents).some(
    (c) => c.familyId === input.familyId && c.granted,
  );
  if (already) return fail('该家庭已有生效中的共同议题授权，请勿重复授予');
  return ok([
    makeEvent(
      {
        type: 'consent.granted',
        consentId: uid('cs'),
        familyId: input.familyId,
        studentIds: [...family.studentIds],
        grantedBy: input.grantedBy,
        studentApprovals: { ...input.studentApprovals },
      },
      input.atMin,
    ),
  ]);
}

// ---------- 预约（联合 / 分开） ----------

export function bookMeeting(
  snap: Snapshot,
  input: { familyId: string; mode: MeetingMode; atMin: number; by: string },
): CommandResult {
  const family = familyOf(snap, input.familyId);
  const option = input.mode === 'joint' ? evaluateJoint(snap, input.familyId) : evaluateSeparate(snap, input.familyId);
  if (!option.feasible) return fail(option.reasons.join('；'));

  const meetingId = uid('mtg');
  const events: AppEvent[] = [];

  // 先占坑真实 session id：把 SessionPlan.key 替换为稳定 id
  const sessionIds = option.sessions.map(() => uid('ses'));
  events.push(
    makeEvent(
      {
        type: 'meeting.created',
        meetingId,
        familyId: family.id,
        parentId: family.parentId,
        mode: input.mode,
        sessionIds,
        splitFromMeetingId: null,
      },
      input.atMin,
    ),
  );

  option.sessions.forEach((sp, idx) => {
    const sessionId = sessionIds[idx];
    const withId: SessionPlan = { ...sp, key: sessionId };
    const bundle = buildSessionBundle(snap, withId, meetingId, input.atMin, 'invite');
    events.push(...bundle.events);
    events.push(
      makeEvent(
        {
          type: 'session.scheduled',
          sessionId,
          meetingId,
          familyId: family.id,
          studentIds: [...sp.studentIds],
          joint: sp.joint,
          title: sp.title,
          startMin: sp.startMin,
          endMin: sp.endMin,
          roomId: sp.roomId,
          interpreterRequired: sp.interpreterRequired,
          interpreterId: sp.interpreterRequired ? interpreterIdFor(snap, family.id) : null,
          hostTeacherId: sp.hostTeacherId,
          teacherIds: [...sp.teacherIds],
          parentId: family.parentId,
          rosterEntryIds: bundle.rosterEntryIds,
          notificationIds: bundle.notificationIds,
        },
        input.atMin,
      ),
    );
  });

  return ok(events);
}

// ---------- 变更：同步释放口译员、房间、门岗名册 ----------

function releaseSessionResources(
  snap: Snapshot,
  sessionId: string,
  atMin: number,
  reason: string,
): AppEvent[] {
  const events: AppEvent[] = [];
  for (const booking of Object.values(snap.bookings)) {
    if (booking.sessionId === sessionId && booking.status === 'held') {
      events.push(makeEvent({ type: 'resource.released', bookingId: booking.id, reason }, atMin));
    }
  }
  const rosterIds = Object.values(snap.visitorEntries)
    .filter((e) => e.sessionId === sessionId && e.status === 'active')
    .map((e) => e.id);
  if (rosterIds.length) {
    events.push(makeEvent({ type: 'visitor.roster.voided', entryIds: rosterIds, reason }, atMin));
  }
  return events;
}

/**
 * 变更场次时间（改期）。旧占用先释放、旧名册立即失效、旧通知被新版取代，
 * 再按新窗口重新占用房间/口译员并签发新名册与通知。
 */
export function changeSession(
  snap: Snapshot,
  input: {
    sessionId: string;
    newStartMin: number;
    newEndMin: number;
    atMin: number;
    reason: string;
  },
): CommandResult {
  const session = snap.sessions[input.sessionId];
  if (!session) return fail('场次不存在');
  if (session.status === 'completed') return fail('已结束场次不能变更，请新建预约');
  const family = snap.families[session.familyId];
  const interpreterId = session.interpreterRequired ? interpreterIdFor(snap, family.id) : null;

  const candidate: SessionPlan = {
    key: session.id,
    title: session.title,
    joint: session.joint,
    studentIds: [...session.studentIds],
    startMin: input.newStartMin,
    endMin: input.newEndMin,
    roomId: session.roomId,
    interpreterRequired: session.interpreterRequired,
    teacherIds: [...session.teacherIds],
    hostTeacherId: session.hostTeacherId,
  };
  const errors = validateReschedule(snap, candidate, session.id);
  if (errors.length) return fail(errors.join('；'));

  const events: AppEvent[] = [];
  events.push(...releaseSessionResources(snap, session.id, input.atMin, input.reason));

  const sp = candidate;
  const bundle = buildSessionBundle(snap, sp, session.meetingId, input.atMin, 'change');
  events.push(...bundle.events);
  events.push(
    makeEvent(
      {
        type: 'session.rescheduled',
        sessionId: session.id,
        oldStartMin: session.startMin,
        oldEndMin: session.endMin,
        newStartMin: input.newStartMin,
        newEndMin: input.newEndMin,
        roomId: session.roomId,
        interpreterId,
        rosterEntryIds: bundle.rosterEntryIds,
        notificationIds: bundle.notificationIds,
      },
      input.atMin,
    ),
  );
  return ok(events);
}

/** 取消场次：释放资源、名册失效、通知取消 */
export function cancelSession(
  snap: Snapshot,
  input: { sessionId: string; reason: string; atMin: number },
): CommandResult {
  const session = snap.sessions[input.sessionId];
  if (!session) return fail('场次不存在');
  if (session.status === 'completed') return fail('已结束场次不能取消');
  const events: AppEvent[] = releaseSessionResources(snap, session.id, input.atMin, input.reason);
  events.push(
    makeEvent({ type: 'session.cancelled', sessionId: session.id, reason: input.reason }, input.atMin),
  );
  return ok(events);
}

// ---------- 口译员临时缺席：两场转待改期，旧名册立即失效 ----------

export function markInterpreterAbsent(
  snap: Snapshot,
  input: { meetingId: string; atMin: number; reason: string },
): CommandResult {
  const meeting = snap.meetings[input.meetingId];
  if (!meeting) return fail('会谈不存在');
  const sessions = meeting.sessionIds.map((id) => snap.sessions[id]).filter(Boolean);
  const affected = sessions.filter((s) => s.interpreterRequired && s.status !== 'completed' && s.status !== 'cancelled');
  if (!affected.length) return fail('该会谈没有需要口译且仍可改期的场次');

  const events: AppEvent[] = [];
  for (const session of affected) {
    events.push(
      makeEvent(
        {
          type: 'interpreter.absent',
          sessionId: session.id,
          interpreterId: session.interpreterId ?? Object.values(snap.interpreters)[0]?.id ?? 'int_ai',
        },
        input.atMin,
      ),
    );
    events.push(...releaseSessionResources(snap, session.id, input.atMin, input.reason));
    events.push(
      makeEvent(
        { type: 'session.pending_reschedule', sessionId: session.id, reason: input.reason },
        input.atMin,
      ),
    );
  }
  return ok(events);
}

// ---------- 门岗：签到 / 提前离场 / 取消到访（均不等于会议完成） ----------

export function checkInVisitor(
  snap: Snapshot,
  input: { sessionId: string; personId: string; atMin: number },
): CommandResult {
  const session = snap.sessions[input.sessionId];
  if (!session) return fail('场次不存在');
  const entry = Object.values(snap.visitorEntries).find(
    (e) => e.sessionId === input.sessionId && e.personId === input.personId && e.status === 'active',
  );
  if (!entry) return fail('门岗名册中没有该访客的有效记录（旧名单已失效或未登记）');
  const late = input.atMin > session.startMin;
  return ok([
    makeEvent({ type: 'visit.checked_in', sessionId: input.sessionId, personId: input.personId, late }, input.atMin),
  ]);
}

export function visitorLeave(
  snap: Snapshot,
  input: { sessionId: string; personId: string; atMin: number },
): CommandResult {
  const session = snap.sessions[input.sessionId];
  if (!session) return fail('场次不存在');
  const early = input.atMin < session.endMin;
  return ok([
    makeEvent({ type: 'visit.left', sessionId: input.sessionId, personId: input.personId, early }, input.atMin),
  ]);
}

export function cancelVisit(
  snap: Snapshot,
  input: { sessionId: string; personId: string; reason: string; atMin: number },
): CommandResult {
  const session = snap.sessions[input.sessionId];
  if (!session) return fail('场次不存在');
  return ok([
    makeEvent(
      { type: 'visit.cancelled', sessionId: input.sessionId, personId: input.personId, reason: input.reason },
      input.atMin,
    ),
  ]);
}

// ---------- 主持人开始 / 记录结束（唯一关闭路径） ----------

export function startSession(
  snap: Snapshot,
  input: { sessionId: string; hostTeacherId: string; atMin: number },
): CommandResult {
  const session = snap.sessions[input.sessionId];
  if (!session) return fail('场次不存在');
  if (session.hostTeacherId !== input.hostTeacherId) return fail('只有本场主持人（班主任）可以开始会议');
  if (session.status === 'completed') return fail('场次已结束');
  if (session.status === 'reschedule_pending') return fail('场次待改期，不能开始');
  return ok([
    makeEvent(
      { type: 'session.started', sessionId: input.sessionId, hostTeacherId: input.hostTeacherId },
      input.atMin,
    ),
  ]);
}

/** 主持人记录结束：迟到/取消/提前离场回执都不触发关闭，只有这里能关闭场次 */
export function endSession(
  snap: Snapshot,
  input: { sessionId: string; hostTeacherId: string; atMin: number },
): CommandResult {
  const session = snap.sessions[input.sessionId];
  if (!session) return fail('场次不存在');
  if (session.hostTeacherId !== input.hostTeacherId) return fail('只有本场主持人（班主任）可以记录结束');
  if (session.status !== 'in_progress') return fail('只有进行中的场次可以记录结束');
  return ok([
    makeEvent(
      { type: 'session.ended', sessionId: input.sessionId, hostTeacherId: input.hostTeacherId },
      input.atMin,
    ),
  ]);
}

// ---------- 纪要：参加情况 + 各自授权范围内的结论 ----------

export function recordMinutes(
  snap: Snapshot,
  input: {
    sessionId: string;
    hostTeacherId: string;
    attendance: Record<string, AttendanceRecord>;
    sharedConclusionIds: string[];
    /** 个别（私有）补充内容；逐条做任教授权后生成私有条目，再挂到本纪要 */
    privateContents: { studentId: string; content: string }[];
    atMin: number;
  },
): CommandResult {
  const session = snap.sessions[input.sessionId];
  if (!session) return fail('场次不存在');
  if (session.hostTeacherId !== input.hostTeacherId) return fail('只有本场主持人可以记录纪要');
  if (session.status !== 'completed') return fail('须先由主持人记录结束，才能撰写会议纪要');
  // 联合场引用共同结论前，授权必须仍然有效；结论须真实存在
  for (const cid of input.sharedConclusionIds) {
    const c = snap.sharedConclusions[cid];
    if (!c) return fail(`共同结论不存在：${cid}`);
  }
  // 个别补充只能写给本场涉及的学生，且主持人须任教该学生
  for (const pc of input.privateContents) {
    if (!session.studentIds.includes(pc.studentId)) {
      return fail(`学生 ${pc.studentId} 不在本场，不能写入其个别记录`);
    }
    if (!canTeacherReadStudent(snap, input.hostTeacherId, pc.studentId)) {
      return fail('主持人不任教该学生，不能写入其个别记录');
    }
  }

  const minutesId = uid('min');
  const events: AppEvent[] = [];
  const privateEntryIds: string[] = [];
  for (const pc of input.privateContents) {
    const entryId = uid('pe');
    privateEntryIds.push(entryId);
    events.push(
      makeEvent(
        {
          type: 'private.entry.recorded',
          entryId,
          studentId: pc.studentId,
          minutesId,
          content: pc.content,
        },
        input.atMin,
      ),
    );
  }
  events.push(
    makeEvent(
      {
        type: 'minutes.created',
        minutesId,
        sessionId: input.sessionId,
        meetingId: session.meetingId,
        hostTeacherId: input.hostTeacherId,
        attendance: input.attendance,
        sharedConclusionIds: [...input.sharedConclusionIds],
        privateEntryIds,
      },
      input.atMin,
    ),
  );
  return ok(events);
}

export function finalizeMinutes(
  snap: Snapshot,
  input: { minutesId: string; hostTeacherId: string; atMin: number },
): CommandResult {
  const doc = snap.minutes[input.minutesId];
  if (!doc) return fail('纪要不存在');
  if (doc.hostTeacherId !== input.hostTeacherId) return fail('只有记录该纪要的主持人可以定稿');
  if (doc.status === 'finalized') return fail('纪要已定稿');
  return ok([makeEvent({ type: 'minutes.finalized', minutesId: input.minutesId }, input.atMin)]);
}

// ---------- 共同结论：引用 / 复制 两种结构，更正生成新修订 ----------

/**
 * 记录（或更正）一份经双方允许共享、同时影响两位学生支持计划的结论。
 * - reference：保存 1 份不可变结论，两份计划各持引用，权限沿引用执行
 * - copy：结论分别复制进两份计划，以 pairedCopyId 建立必须共同核对的副本关系
 * 更正（带 supersedesConclusionId）时两种结构都生成新修订，并把两份当前计划置为待核。
 */
export function recordSharedConclusion(
  snap: Snapshot,
  input: {
    familyId: string;
    content: string;
    storageMode: SharedStorageMode;
    consentId: string;
    supersedesConclusionId?: string | null;
    atMin: number;
  },
): CommandResult {
  const family = familyOf(snap, input.familyId);
  const consent = snap.consents[input.consentId];
  if (!consent || !consent.granted) return fail('共同结论必须基于生效中的共享授权');
  if (!family.studentIds.every((id) => consent.studentApprovals[id] === true)) {
    return fail('授权范围未覆盖两位学生，不能记录共同结论');
  }
  if (input.supersedesConclusionId) {
    const prior = snap.sharedConclusions[input.supersedesConclusionId];
    if (!prior) return fail('被更正的旧结论不存在');
  }
  const revision =
    Object.values(snap.sharedConclusions)
      .filter((c) => c.familyId === input.familyId)
      .reduce((max, c) => Math.max(max, c.revision), 0) + 1;
  const conclusionId = uid('sc');

  const refs =
    input.storageMode === 'reference'
      ? family.studentIds.map((studentId) => ({ studentId, conclusionId, revision }))
      : [];
  let copies: {
    id: string;
    studentId: string;
    conclusionId: string;
    revision: number;
    content: string;
    pairedCopyId: string;
  }[] = [];
  if (input.storageMode === 'copy') {
    const pairA = uid('cp');
    const pairB = uid('cp');
    const pairIds = [pairA, pairB];
    copies = family.studentIds.map((studentId, idx) => ({
      id: pairIds[idx],
      studentId,
      conclusionId,
      revision,
      content: input.content,
      pairedCopyId: pairIds[1 - idx], // 两份副本互相指向，强制共同核对
    }));
  }

  return ok([
    makeEvent(
      {
        type: 'shared.conclusion.recorded',
        conclusionId,
        familyId: input.familyId,
        revision,
        content: input.content,
        storageMode: input.storageMode,
        supersedesId: input.supersedesConclusionId ?? null,
        authorizedStudentIds: [...family.studentIds],
        consentId: input.consentId,
        refs,
        copies,
      },
      input.atMin,
    ),
  ]);
}

// ---------- 个别（私有）补充：写入对应学生记录，教师须任教该学生 ----------

/** 单独写入一条私有补充（要求纪要已存在、教师任教该学生） */
export function recordPrivateEntry(
  snap: Snapshot,
  input: {
    studentId: string;
    minutesId: string;
    content: string;
    teacherId: string;
    atMin: number;
  },
): CommandResult {
  if (!canTeacherReadStudent(snap, input.teacherId, input.studentId)) {
    return fail('教师不任教该学生，不能写入其个别支持记录');
  }
  if (!snap.minutes[input.minutesId]) return fail('关联纪要不存在');
  return ok([
    makeEvent(
      {
        type: 'private.entry.recorded',
        entryId: uid('pe'),
        studentId: input.studentId,
        minutesId: input.minutesId,
        content: input.content,
      },
      input.atMin,
    ),
  ]);
}

/**
 * 原子化的“一场会议成果”记录：在同一事件批次内完成
 * （可选）共同结论（引用/复制）→ 各学生私有补充 → 纪要引用。
 * 避免 UI 分多次 dispatch 时读取到尚未更新的快照。
 */
export function recordSessionOutcome(
  snap: Snapshot,
  input: {
    sessionId: string;
    hostTeacherId: string;
    attendance: Record<string, AttendanceRecord>;
    shared?: {
      content: string;
      storageMode: SharedStorageMode;
      consentId: string;
    } | null;
    privateContents: { studentId: string; content: string }[];
    atMin: number;
  },
): CommandResult {
  const session = snap.sessions[input.sessionId];
  if (!session) return fail('场次不存在');
  if (session.hostTeacherId !== input.hostTeacherId) return fail('只有本场主持人可以记录纪要');
  if (session.status !== 'completed') return fail('须先由主持人记录结束，才能撰写会议纪要');
  for (const pc of input.privateContents) {
    if (!session.studentIds.includes(pc.studentId)) {
      return fail(`学生 ${pc.studentId} 不在本场，不能写入其个别记录`);
    }
    if (!canTeacherReadStudent(snap, input.hostTeacherId, pc.studentId)) {
      return fail('主持人不任教该学生，不能写入其个别记录');
    }
  }

  const events: AppEvent[] = [];
  let conclusionId: string | null = null;

  if (input.shared && input.shared.content.trim()) {
    const family = snap.families[session.familyId];
    const consent = snap.consents[input.shared.consentId];
    if (!consent || !consent.granted) return fail('共同结论必须基于生效中的共享授权');
    if (!family.studentIds.every((id) => consent.studentApprovals[id] === true)) {
      return fail('授权范围未覆盖两位学生，不能记录共同结论');
    }
    const revision =
      Object.values(snap.sharedConclusions).filter((c) => c.familyId === family.id).length + 1;
    conclusionId = uid('sc');
    const refs =
      input.shared.storageMode === 'reference'
        ? family.studentIds.map((studentId) => ({ studentId, conclusionId: conclusionId!, revision }))
        : [];
    let copies: {
      id: string;
      studentId: string;
      conclusionId: string;
      revision: number;
      content: string;
      pairedCopyId: string;
    }[] = [];
    if (input.shared.storageMode === 'copy') {
      const pairA = uid('cp');
      const pairB = uid('cp');
      const pairIds = [pairA, pairB];
      copies = family.studentIds.map((studentId, idx) => ({
        id: pairIds[idx],
        studentId,
        conclusionId: conclusionId!,
        revision,
        content: input.shared!.content,
        pairedCopyId: pairIds[1 - idx],
      }));
    }
    events.push(
      makeEvent(
        {
          type: 'shared.conclusion.recorded',
          conclusionId,
          familyId: family.id,
          revision,
          content: input.shared.content,
          storageMode: input.shared.storageMode,
          supersedesId: null,
          authorizedStudentIds: [...family.studentIds],
          consentId: input.shared.consentId,
          refs,
          copies,
        },
        input.atMin,
      ),
    );
  }

  const minutesId = uid('min');
  const privateEntryIds: string[] = [];
  for (const pc of input.privateContents) {
    const entryId = uid('pe');
    privateEntryIds.push(entryId);
    events.push(
      makeEvent(
        {
          type: 'private.entry.recorded',
          entryId,
          studentId: pc.studentId,
          minutesId,
          content: pc.content,
        },
        input.atMin,
      ),
    );
  }
  events.push(
    makeEvent(
      {
        type: 'minutes.created',
        minutesId,
        sessionId: input.sessionId,
        meetingId: session.meetingId,
        hostTeacherId: input.hostTeacherId,
        attendance: input.attendance,
        sharedConclusionIds: conclusionId ? [conclusionId] : [],
        privateEntryIds,
      },
      input.atMin,
    ),
  );
  return ok(events);
}

/** 主持人/任课教师核对更正后，清除该学生计划的待核标记 */
export function clearPlanReview(
  snap: Snapshot,
  input: { studentId: string; conclusionId: string; teacherId: string; atMin: number },
): CommandResult {
  if (!canTeacherReadStudent(snap, input.teacherId, input.studentId)) {
    return fail('教师不任教该学生，不能核对其计划');
  }
  return ok([
    makeEvent(
      { type: 'plan.review.cleared', studentId: input.studentId, conclusionId: input.conclusionId },
      input.atMin,
    ),
  ]);
}

/**
 * 一方仅保留自身支持事项：解除其计划与该共同结论的引用/副本关系。
 * 不可变结论、旧纪要与另一方计划保持不变；当前计划读取时该共同内容不再可见。
 */
export function reduceSharedScope(
  snap: Snapshot,
  input: { studentId: string; conclusionId: string; reason: string; atMin: number },
): CommandResult {
  const plan = snap.supportPlans[input.studentId];
  if (!plan) return fail('该学生尚无支持计划');
  const has =
    plan.sharedRefs.some((r) => r.conclusionId === input.conclusionId && !r.detached) ||
    plan.copies.some((c) => c.conclusionId === input.conclusionId && !c.detached);
  if (!has) return fail('该计划未引用此共同结论，无需收窄');
  return ok([
    makeEvent(
      {
        type: 'plan.shared_scope.reduced',
        studentId: input.studentId,
        conclusionId: input.conclusionId,
        reason: input.reason,
      },
      input.atMin,
    ),
  ]);
}

// ---------- 撤回共同议题同意：后续会谈立即拆分，旧纪要按原授权保留 ----------

export function revokeConsentAndSplit(
  snap: Snapshot,
  input: { familyId: string; reason: string; atMin: number },
): CommandResult {
  const family = familyOf(snap, input.familyId);
  const consent = Object.values(snap.consents).find((c) => c.familyId === input.familyId && c.granted);
  if (!consent) return fail('没有生效中的共同议题授权可撤回');

  const events: AppEvent[] = [
    makeEvent({ type: 'consent.revoked', consentId: consent.id, reason: input.reason }, input.atMin),
  ];

  // 找到仍待举行/进行中的联合会谈，拆成两场个别会谈
  const jointMeeting = Object.values(snap.meetings).find(
    (m) =>
      m.familyId === input.familyId &&
      (m.status === 'scheduled' || m.status === 'in_progress') &&
      m.sessionIds.some((sid) => snap.sessions[sid]?.joint),
  );
  if (!jointMeeting) return ok(events);

  // 释放原联合场资源、旧名册失效
  for (const sid of jointMeeting.sessionIds) {
    events.push(...releaseSessionResources(snap, sid, input.atMin, input.reason));
    const session = snap.sessions[sid];
    if (session && session.status !== 'completed') {
      events.push(makeEvent({ type: 'session.cancelled', sessionId: sid, reason: input.reason }, input.atMin));
    }
  }

  // 把已生成的释放/取消事件投影到临时快照，再评估分场，避免旧占用造成误判冲突
  const projected = replay(events, snap);
  const option = evaluateSeparate(projected, input.familyId);
  if (!option.feasible) {
    // 无法立即重排时仍完成撤回，只是不新建会谈
    return ok(events);
  }
  const newMeetingId = uid('mtg');
  const newSessionIds = option.sessions.map(() => uid('ses'));
  events.push(
    makeEvent(
      {
        type: 'meeting.created',
        meetingId: newMeetingId,
        familyId: family.id,
        parentId: family.parentId,
        mode: 'separate',
        sessionIds: newSessionIds,
        splitFromMeetingId: jointMeeting.id,
      },
      input.atMin,
    ),
  );
  option.sessions.forEach((sp, idx) => {
    const sessionId = newSessionIds[idx];
    const bundle = buildSessionBundle(snap, { ...sp, key: sessionId }, newMeetingId, input.atMin, 'change');
    events.push(...bundle.events);
    events.push(
      makeEvent(
        {
          type: 'session.scheduled',
          sessionId,
          meetingId: newMeetingId,
          familyId: family.id,
          studentIds: [...sp.studentIds],
          joint: false,
          title: sp.title,
          startMin: sp.startMin,
          endMin: sp.endMin,
          roomId: sp.roomId,
          interpreterRequired: sp.interpreterRequired,
          interpreterId: sp.interpreterRequired ? interpreterIdFor(snap, family.id) : null,
          hostTeacherId: sp.hostTeacherId,
          teacherIds: [...sp.teacherIds],
          parentId: family.parentId,
          rosterEntryIds: bundle.rosterEntryIds,
          notificationIds: bundle.notificationIds,
        },
        input.atMin,
      ),
    );
  });
  events.push(
    makeEvent(
      {
        type: 'meeting.split',
        oldMeetingId: jointMeeting.id,
        newMeetingId,
        newSessionIds,
        reason: input.reason,
      },
      input.atMin,
    ),
  );
  return ok(events);
}
