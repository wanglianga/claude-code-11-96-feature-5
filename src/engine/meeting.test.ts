import { describe, expect, it } from 'vitest';
import { initialSnapshot, replay } from './reducer';
import { setSeqStart } from './commands';
import {
  evaluateMeetingOptions,
  evaluateJoint,
  evaluateSeparate,
  validateReschedule,
  type SessionPlan,
} from './meeting';
import {
  bookMeeting,
  cancelSession,
  cancelVisit,
  changeSession,
  checkInVisitor,
  clearPlanReview,
  endSession,
  finalizeMinutes,
  grantConsent,
  markInterpreterAbsent,
  recordMinutes,
  recordPrivateEntry,
  recordSessionOutcome,
  recordSharedConclusion,
  reduceSharedScope,
  revokeConsentAndSplit,
  startSession,
  visitorLeave,
} from './meetingCommands';
import {
  canTeacherReadStudent,
  denyReasonForStudent,
  readPrivateEntry,
  readStudentPlan,
} from './access';
import type { AppEvent, AttendanceRecord, Snapshot } from '../types';
import { hmToMin } from '../lib/time';

const FAMILY = 'fam_wang';
const MING = 'stu_ming'; // 甲
const HUA = 'stu_hua'; // 乙
const HOMEROOM = 'u_teacher_a'; // 班主任（教两位）
const MATH = 'u_teacher_b'; // 数学教师（教两位）
const SEMINAR = 'u_teacher_s'; // 只教王小明
const PARENT = 'p_wang';
const INTERP = 'int_ai';
const ROOM = 'mr_reception';

// 题目样例文本：共同结论 80 字；甲、乙各 20 字私有补充
const SHARED_80 = '共'.repeat(80);
const PRIV_MING_20 = '甲'.repeat(20);
const PRIV_HUA_20 = '乙'.repeat(20);

class World {
  snap: Snapshot = initialSnapshot();
  events: AppEvent[] = [];

  run(fn: (snap: Snapshot) => { ok: boolean; error?: string; events: AppEvent[] }): AppEvent[] {
    setSeqStart(this.snap.seq);
    const r = fn(this.snap);
    if (!r.ok) throw new Error(r.error ?? '命令失败');
    this.snap = replay(r.events, this.snap);
    this.events.push(...r.events);
    return r.events;
  }

  tryRun(fn: (snap: Snapshot) => { ok: boolean; error?: string; events: AppEvent[] }): string {
    setSeqStart(this.snap.seq);
    const r = fn(this.snap);
    if (r.ok) throw new Error('预期失败但命令成功了');
    return r.error!;
  }

  latestMeeting() {
    return Object.values(this.snap.meetings).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }
  sessionsOf(meetingId: string) {
    return Object.values(this.snap.sessions)
      .filter((s) => s.meetingId === meetingId)
      .sort((a, b) => a.startMin - b.startMin);
  }
  consent() {
    return Object.values(this.snap.consents).find((c) => c.familyId === FAMILY);
  }
}

function grantBoth(w: World) {
  w.run((s) =>
    grantConsent(s, {
      familyId: FAMILY,
      grantedBy: PARENT,
      studentApprovals: { [MING]: true, [HUA]: true },
      atMin: hmToMin('15:00'),
    }),
  );
}

function attendance(sessionId: string): Record<string, AttendanceRecord> {
  return {
    [PARENT]: { personId: PARENT, name: '王家长', role: 'parent', attended: true, arrivedLate: false, leftEarly: false, cancelled: false },
  };
}

describe('可行性：联合 vs 分开的窗口、参会人与通知差别', () => {
  it('未取得共享同意时联合不可行，分开两场始终可行', () => {
    const w = new World();
    const joint = evaluateJoint(w.snap, FAMILY);
    expect(joint.feasible).toBe(false);
    expect(joint.reasons.join('；')).toContain('共享同意');
    const separate = evaluateSeparate(w.snap, FAMILY);
    expect(separate.feasible).toBe(true);
    expect(separate.sessions).toHaveLength(2);
  });

  it('授予同意后联合可行：一场 40 分钟 15:30-16:10，参会教师为班主任+数学', () => {
    const w = new World();
    grantBoth(w);
    const joint = evaluateJoint(w.snap, FAMILY);
    expect(joint.feasible).toBe(true);
    expect(joint.sessions).toHaveLength(1);
    const sp = joint.sessions[0];
    expect(sp.startMin).toBe(hmToMin('15:30'));
    expect(sp.endMin).toBe(hmToMin('16:10'));
    expect(sp.endMin - sp.startMin).toBe(40);
    expect(sp.studentIds.sort()).toEqual([HUA, MING]);
    expect(sp.teacherIds.sort()).toEqual([HOMEROOM, MATH]);
  });

  it('联合与分开的参会人、确认次数、通知与名册批次差异符合题意', () => {
    const w = new World();
    grantBoth(w);
    const { joint, separate } = evaluateMeetingOptions(w.snap, FAMILY);
    // 联合：少一次往返、教师一次确认、家长一份通知、一批名册
    expect(joint.trips).toBe(1);
    expect(joint.notifications.teacherConfirmCount).toBe(2);
    expect(joint.notifications.parentNoticeCount).toBe(1);
    expect(joint.notifications.rosterCount).toBe(1);
    // 分开：两场分别确认、家长两份通知并切换议题、两批名册
    expect(separate.trips).toBe(2);
    expect(separate.notifications.teacherConfirmCount).toBe(4); // 每场两位教师
    expect(separate.notifications.parentNoticeCount).toBe(2);
    expect(separate.notifications.rosterCount).toBe(2);
    // 参会人去重后教师集合一致（都为班主任+数学），但确认/通知次数不同
    expect(joint.attendees.teachers.sort()).toEqual([HOMEROOM, MATH]);
    expect(separate.attendees.teachers.sort()).toEqual([HOMEROOM, MATH]);
    expect(separate.sessions.map((s) => s.endMin - s.startMin)).toEqual([20, 20]);
  });

  it('15:00 开始的安排超出口译员 15:30 窗口被拒；接待室整段可用', () => {
    const w = new World();
    const sp: SessionPlan = {
      key: 'x',
      title: '过早场',
      joint: false,
      studentIds: [MING],
      startMin: hmToMin('15:00'),
      endMin: hmToMin('15:20'),
      roomId: ROOM,
      interpreterRequired: true,
      teacherIds: [HOMEROOM, MATH],
      hostTeacherId: HOMEROOM,
    };
    const errors = validateReschedule(w.snap, sp, 'x');
    expect(errors.join('；')).toContain('口译员');
  });
});

describe('预约、资源占用与门岗名册', () => {
  it('联合预约：房间与口译各 1 个 held 占用；名册只含家长与口译，不含教师；通知覆盖家长/两教师/口译', () => {
    const w = new World();
    grantBoth(w);
    w.run((s) => bookMeeting(s, { familyId: FAMILY, mode: 'joint', atMin: hmToMin('15:00'), by: 'u_coordinator' }));
    const meeting = w.latestMeeting();
    const session = w.sessionsOf(meeting.id)[0];
    const held = Object.values(w.snap.bookings).filter((b) => b.status === 'held');
    expect(held.filter((b) => b.resourceType === 'room')).toHaveLength(1);
    expect(held.filter((b) => b.resourceType === 'interpreter')).toHaveLength(1);
    const roster = Object.values(w.snap.visitorEntries).filter((e) => e.status === 'active');
    expect(roster.map((e) => e.personRole).sort()).toEqual(['interpreter', 'parent']);
    expect(roster.some((e) => e.personRole === 'teacher')).toBe(false);
    const notes = Object.values(w.snap.meetingNotifications).filter((n) => n.meetingId === meeting.id);
    const recipients = new Set(notes.map((n) => n.recipientId));
    expect(recipients.has(PARENT)).toBe(true);
    expect(recipients.has(HOMEROOM)).toBe(true);
    expect(recipients.has(MATH)).toBe(true);
    expect(recipients.has(INTERP)).toBe(true);
    expect(session.activeRosterEntryIds).toHaveLength(2);
  });

  it('变更场次：旧占用释放、旧名册失效、旧通知作废，新占用/名册/通知重建', () => {
    const w = new World();
    w.run((s) => bookMeeting(s, { familyId: FAMILY, mode: 'separate', atMin: hmToMin('15:00'), by: 'u_coordinator' }));
    const meeting = w.latestMeeting();
    const [first, second] = w.sessionsOf(meeting.id);
    // 先取消第二场，腾出 15:50-16:10，再把第一场改期到该空档（仍在教师 15:30-16:10 窗口内）
    w.run((s) => cancelSession(s, { sessionId: second.id, reason: '合并议题调整', atMin: hmToMin('15:05') }));
    const oldRoster = first.activeRosterEntryIds.length;
    // 捕获改期前的旧占用 id，改期后这些必须全部释放
    const oldBookingIds = Object.values(w.snap.bookings)
      .filter((b) => b.sessionId === first.id && b.status === 'held')
      .map((b) => b.id);
    expect(oldBookingIds.length).toBeGreaterThan(0);
    const oldParentNote = Object.values(w.snap.meetingNotifications).find(
      (n) => n.sessionId === first.id && n.recipientId === PARENT,
    )!;

    w.run((s) =>
      changeSession(s, {
        sessionId: first.id,
        newStartMin: hmToMin('15:50'),
        newEndMin: hmToMin('16:10'),
        atMin: hmToMin('15:10'),
        reason: '家长临时调整',
      }),
    );
    // 旧房间/口译占用均释放（按改期前的占用 id 核对，不含改期新建的占用）
    expect(oldBookingIds.every((id) => w.snap.bookings[id].status === 'released')).toBe(true);
    // 旧名册失效
    const voided = Object.values(w.snap.visitorEntries).filter(
      (e) => e.sessionId === first.id && e.status === 'void',
    );
    expect(voided.length).toBe(oldRoster);
    // 旧通知被新版取代
    expect(w.snap.meetingNotifications[oldParentNote.id].superseded).toBe(true);
    // 新占用与新名册
    const refreshed = w.snap.sessions[first.id];
    expect(refreshed.startMin).toBe(hmToMin('15:50'));
    const newHeld = Object.values(w.snap.bookings).filter((b) => b.sessionId === first.id && b.status === 'held');
    expect(newHeld.length).toBe(2);
    expect(refreshed.activeRosterEntryIds).toHaveLength(oldRoster);
  });

  it('取消场次同步释放口译员、房间并使名册失效', () => {
    const w = new World();
    w.run((s) => bookMeeting(s, { familyId: FAMILY, mode: 'separate', atMin: hmToMin('15:00'), by: 'u_coordinator' }));
    const meeting = w.latestMeeting();
    const target = w.sessionsOf(meeting.id)[0];
    w.run((s) => cancelSession(s, { sessionId: target.id, reason: '家长来电取消', atMin: hmToMin('15:20') }));
    expect(w.snap.sessions[target.id].status).toBe('cancelled');
    expect(
      Object.values(w.snap.bookings).filter((b) => b.sessionId === target.id).every((b) => b.status === 'released'),
    ).toBe(true);
    expect(
      Object.values(w.snap.visitorEntries)
        .filter((e) => e.sessionId === target.id)
        .every((e) => e.status === 'void'),
    ).toBe(true);
  });
});

describe('口译员临时缺席', () => {
  it('两场转为待改期，口译标记缺席，资源释放且旧访客名单立即失效', () => {
    const w = new World();
    w.run((s) => bookMeeting(s, { familyId: FAMILY, mode: 'separate', atMin: hmToMin('15:00'), by: 'u_coordinator' }));
    const meeting = w.latestMeeting();
    w.run((s) =>
      markInterpreterAbsent(s, { meetingId: meeting.id, atMin: hmToMin('15:25'), reason: '口译员突发状况无法到场' }),
    );
    const sessions = w.sessionsOf(meeting.id);
    expect(sessions.every((x) => x.status === 'reschedule_pending')).toBe(true);
    expect(sessions.every((x) => x.interpreterServiceStatus === 'absent')).toBe(true);
    expect(
      Object.values(w.snap.bookings)
        .filter((b) => b.meetingId === meeting.id)
        .every((b) => b.status === 'released'),
    ).toBe(true);
    // 旧名单立即失效：该会谈两场的全部名册条目均为 void
    expect(
      Object.values(w.snap.visitorEntries)
        .filter((e) => sessions.some((x) => x.id === e.sessionId))
        .every((e) => e.status === 'void'),
    ).toBe(true);
    expect(w.snap.meetings[meeting.id].status).toBe('reschedule_pending');
  });
});

describe('签到、迟到/取消回执与主持人结束门控', () => {
  it('迟到回执不等于完成；非主持人不能开始；只有主持人开始并记录结束才关闭，提前离场不影响另一场', () => {
    const w = new World();
    w.run((s) => bookMeeting(s, { familyId: FAMILY, mode: 'separate', atMin: hmToMin('15:00'), by: 'u_coordinator' }));
    const meeting = w.latestMeeting();
    const [a, b] = w.sessionsOf(meeting.id);

    // 家长 15:35 迟到签到（A 场 15:30 开始）
    w.run((s) => checkInVisitor(s, { sessionId: a.id, personId: PARENT, atMin: hmToMin('15:35') }));
    const entry = Object.values(w.snap.visitorEntries).find(
      (e) => e.sessionId === a.id && e.personId === PARENT,
    )!;
    expect(entry.checkIn).toBe('checked_in');
    expect(entry.late).toBe(true);
    expect(w.snap.sessions[a.id].status).toBe('scheduled'); // 签到不改变会议状态

    // 未开始不能记录结束
    expect(w.tryRun((s) => endSession(s, { sessionId: a.id, hostTeacherId: HOMEROOM, atMin: hmToMin('15:40') }))).toContain('进行中');
    // 非主持人不能开始
    expect(w.tryRun((s) => startSession(s, { sessionId: a.id, hostTeacherId: MATH, atMin: hmToMin('15:30') }))).toContain('主持人');

    // 主持人开始 A、家长提前离场，不自动关闭 A，也不影响 B
    w.run((s) => startSession(s, { sessionId: a.id, hostTeacherId: HOMEROOM, atMin: hmToMin('15:30') }));
    w.run((s) => visitorLeave(s, { sessionId: a.id, personId: PARENT, atMin: hmToMin('15:40') }));
    expect(w.snap.sessions[a.id].status).toBe('in_progress');
    expect(w.snap.sessions[b.id].status).toBe('scheduled');

    // 主持人记录结束 A；B 未结束，会谈整体未完成
    w.run((s) => endSession(s, { sessionId: a.id, hostTeacherId: HOMEROOM, atMin: hmToMin('15:50') }));
    expect(w.snap.sessions[a.id].status).toBe('completed');
    expect(w.snap.meetings[meeting.id].status).not.toBe('completed');

    // B 场也结束后，会谈才关闭
    w.run((s) => startSession(s, { sessionId: b.id, hostTeacherId: HOMEROOM, atMin: hmToMin('15:50') }));
    w.run((s) => endSession(s, { sessionId: b.id, hostTeacherId: HOMEROOM, atMin: hmToMin('16:10') }));
    expect(w.snap.meetings[meeting.id].status).toBe('completed');
  });

  it('取消到访只是回执，场次不会被关闭', () => {
    const w = new World();
    w.run((s) => bookMeeting(s, { familyId: FAMILY, mode: 'separate', atMin: hmToMin('15:00'), by: 'u_coordinator' }));
    const a = w.sessionsOf(w.latestMeeting().id)[0];
    w.run((s) => cancelVisit(s, { sessionId: a.id, personId: PARENT, reason: '临时有事', atMin: hmToMin('15:20') }));
    expect(w.snap.sessions[a.id].status).not.toBe('completed');
    const entry = Object.values(w.snap.visitorEntries).find(
      (e) => e.sessionId === a.id && e.personId === PARENT,
    )!;
    expect(entry.checkIn).toBe('cancelled');
  });
});

describe('纪要门控与主持人记录范围', () => {
  it('未结束不能记纪要；结束后只记录参加情况与授权范围内结论', () => {
    const w = new World();
    grantBoth(w);
    w.run((s) => bookMeeting(s, { familyId: FAMILY, mode: 'joint', atMin: hmToMin('15:00'), by: 'u_coordinator' }));
    const session = w.sessionsOf(w.latestMeeting().id)[0];
    expect(
      w.tryRun((s) =>
        recordMinutes(s, {
          sessionId: session.id,
          hostTeacherId: HOMEROOM,
          attendance: attendance(session.id),
          sharedConclusionIds: [],
          privateContents: [],
          atMin: hmToMin('15:35'),
        }),
      ),
    ).toContain('记录结束');

    w.run((s) => startSession(s, { sessionId: session.id, hostTeacherId: HOMEROOM, atMin: hmToMin('15:30') }));
    w.run((s) => endSession(s, { sessionId: session.id, hostTeacherId: HOMEROOM, atMin: hmToMin('16:10') }));
    w.run((s) =>
      recordMinutes(s, {
        sessionId: session.id,
        hostTeacherId: HOMEROOM,
        attendance: attendance(session.id),
        sharedConclusionIds: [],
        privateContents: [
          { studentId: MING, content: PRIV_MING_20 },
          { studentId: HUA, content: PRIV_HUA_20 },
        ],
        atMin: hmToMin('16:15'),
      }),
    );
    const minutes = Object.values(w.snap.minutes)[0];
    expect(minutes.attendance[PARENT].attended).toBe(true);
    expect(minutes.privateEntryIds).toHaveLength(2);
    w.run((s) => finalizeMinutes(s, { minutesId: minutes.id, hostTeacherId: HOMEROOM, atMin: hmToMin('16:20') }));
    expect(w.snap.minutes[minutes.id].status).toBe('finalized');
    expect(w.snap.sessions[session.id].minutesStatus).toBe('finalized');
  });
});

describe('教师只读自己所教学生：跨学生私有内容拒绝', () => {
  it('苏老师只教王小明，读王小华计划/私有 20 字被拒；班主任两位都可读', () => {
    const w = new World();
    grantBoth(w);
    w.run((s) => bookMeeting(s, { familyId: FAMILY, mode: 'joint', atMin: hmToMin('15:00'), by: 'u_coordinator' }));
    const session = w.sessionsOf(w.latestMeeting().id)[0];
    w.run((s) => startSession(s, { sessionId: session.id, hostTeacherId: HOMEROOM, atMin: hmToMin('15:30') }));
    w.run((s) => endSession(s, { sessionId: session.id, hostTeacherId: HOMEROOM, atMin: hmToMin('16:10') }));
    w.run((s) =>
      recordMinutes(s, {
        sessionId: session.id,
        hostTeacherId: HOMEROOM,
        attendance: attendance(session.id),
        sharedConclusionIds: [],
        privateContents: [
          { studentId: MING, content: PRIV_MING_20 },
          { studentId: HUA, content: PRIV_HUA_20 },
        ],
        atMin: hmToMin('16:15'),
      }),
    );
    const huaPrivate = Object.values(w.snap.privateEntries).find((e) => e.studentId === HUA)!;
    const mingPrivate = Object.values(w.snap.privateEntries).find((e) => e.studentId === MING)!;

    // 任教关系
    expect(canTeacherReadStudent(w.snap, SEMINAR, MING)).toBe(true);
    expect(canTeacherReadStudent(w.snap, SEMINAR, HUA)).toBe(false);
    expect(denyReasonForStudent(w.snap, SEMINAR, HUA)).not.toBe(null);

    // 苏老师读小华私有 20 字 -> 抛错拒绝
    expect(() => readPrivateEntry(w.snap, huaPrivate.id, SEMINAR)).toThrow(/访问被拒/);
    // 苏老师读小华整份计划 -> 抛错
    expect(() => readStudentPlan(w.snap, HUA, SEMINAR)).toThrow(/访问被拒/);
    // 苏老师可读小明自己的私有 20 字
    expect(readPrivateEntry(w.snap, mingPrivate.id, SEMINAR).content).toBe(PRIV_MING_20);
    // 班主任两位都可读，且小明计划里绝不会出现小华的私有条目
    const mingView = readStudentPlan(w.snap, MING, HOMEROOM);
    expect(mingView.privateEntries.map((e) => e.studentId)).toEqual([MING]);
    const huaView = readStudentPlan(w.snap, HUA, HOMEROOM);
    expect(huaView.privateEntries.map((e) => e.content)).toEqual([PRIV_HUA_20]);
  });

  it('教师不能给不任教的学生写个别记录', () => {
    const w = new World();
    const err = w.tryRun((s) =>
      recordPrivateEntry(s, {
        studentId: HUA,
        minutesId: 'min_x',
        content: PRIV_HUA_20,
        teacherId: SEMINAR,
        atMin: hmToMin('16:15'),
      }),
    );
    expect(err).toContain('不任教');
  });
});

describe('共同结论：引用 vs 复制两种结构、更正与待核', () => {
  function completedJoint(w: World) {
    grantBoth(w);
    w.run((s) => bookMeeting(s, { familyId: FAMILY, mode: 'joint', atMin: hmToMin('15:00'), by: 'u_coordinator' }));
    const session = w.sessionsOf(w.latestMeeting().id)[0];
    w.run((s) => startSession(s, { sessionId: session.id, hostTeacherId: HOMEROOM, atMin: hmToMin('15:30') }));
    w.run((s) => endSession(s, { sessionId: session.id, hostTeacherId: HOMEROOM, atMin: hmToMin('16:10') }));
    return w.consent()!.id;
  }

  it('引用结构：共同内容只存 1 份，两份计划各持引用，私有各 1 份不串', () => {
    const w = new World();
    const consentId = completedJoint(w);
    w.run((s) =>
      recordSharedConclusion(s, {
        familyId: FAMILY,
        content: SHARED_80,
        storageMode: 'reference',
        consentId,
        atMin: hmToMin('16:12'),
      }),
    );
    // 共同结论母本只有 1 份、80 字
    const conclusions = Object.values(w.snap.sharedConclusions);
    expect(conclusions).toHaveLength(1);
    expect(conclusions[0].content).toHaveLength(80);
    // 两份计划各 1 条引用、0 副本
    const mingPlan = w.snap.supportPlans[MING];
    const huaPlan = w.snap.supportPlans[HUA];
    expect(mingPlan.sharedRefs).toHaveLength(1);
    expect(huaPlan.sharedRefs).toHaveLength(1);
    expect(mingPlan.copies).toHaveLength(0);
    expect(huaPlan.copies).toHaveLength(0);
    // 沿引用读取：两位学生都能看到同一份结论
    expect(readStudentPlan(w.snap, MING, HOMEROOM).sharedConclusions).toHaveLength(1);
    expect(readStudentPlan(w.snap, HUA, MATH).sharedConclusions[0].id).toBe(conclusions[0].id);
  });

  it('复制结构：经批准内容在两份计划中各存 1 份（共 2 份），副本互相配对必须共同核对', () => {
    const w = new World();
    const consentId = completedJoint(w);
    w.run((s) =>
      recordSharedConclusion(s, {
        familyId: FAMILY,
        content: SHARED_80,
        storageMode: 'copy',
        consentId,
        atMin: hmToMin('16:12'),
      }),
    );
    const copies = Object.values(w.snap.supportPlans).flatMap((p) => p.copies);
    expect(copies).toHaveLength(2); // 共同内容在计划层面存 2 份
    expect(copies.every((c) => c.content.length === 80)).toBe(true);
    // 配对关系互指
    const [c1, c2] = copies;
    expect(c1.pairedCopyId).toBe(c2.id);
    expect(c2.pairedCopyId).toBe(c1.id);
    // 不可变母本仍只 1 条
    expect(Object.values(w.snap.sharedConclusions)).toHaveLength(1);
    // 单份计划可独立读到共同内容
    expect(readStudentPlan(w.snap, MING, HOMEROOM).copies).toHaveLength(1);
  });

  it('更正：两种结构都生成新修订并把两份当前计划置为待核，核对后清除；旧修订保留可历史复现', () => {
    for (const mode of ['reference', 'copy'] as const) {
      const w = new World();
      const consentId = completedJoint(w);
      w.run((s) =>
        recordSharedConclusion(s, { familyId: FAMILY, content: SHARED_80, storageMode: mode, consentId, atMin: hmToMin('16:12') }),
      );
      const rev1 = Object.values(w.snap.sharedConclusions)[0];
      const seqAfterRev1 = w.snap.seq;

      const SHARED_80_V2 = '改'.repeat(80);
      w.run((s) =>
        recordSharedConclusion(s, {
          familyId: FAMILY,
          content: SHARED_80_V2,
          storageMode: mode,
          consentId,
          supersedesConclusionId: rev1.id,
          atMin: hmToMin('16:30'),
        }),
      );
      // 两份当前计划都置待核
      expect(w.snap.supportPlans[MING].reviewState).toBe('pending_review');
      expect(w.snap.supportPlans[HUA].reviewState).toBe('pending_review');
      const rev2 = Object.values(w.snap.sharedConclusions).find((c) => c.revision === 2)!;
      expect(rev2.supersedesId).toBe(rev1.id);
      expect(rev1.content).toBe(SHARED_80); // 旧修订原样保留

      // 两位教师分别核对后清除待核
      w.run((s) => clearPlanReview(s, { studentId: MING, conclusionId: rev2.id, teacherId: HOMEROOM, atMin: hmToMin('16:35') }));
      w.run((s) => clearPlanReview(s, { studentId: HUA, conclusionId: rev2.id, teacherId: MATH, atMin: hmToMin('16:36') }));
      expect(w.snap.supportPlans[MING].reviewState).toBe('current');
      expect(w.snap.supportPlans[HUA].reviewState).toBe('current');

      // 历史复现：回放到 rev1 之后、rev2 之前的快照，只见修订 1、计划非待核
      const historical = replay(w.events.filter((e) => e.seq <= seqAfterRev1));
      const histConclusions = Object.values(historical.sharedConclusions);
      expect(histConclusions).toHaveLength(1);
      expect(histConclusions[0].revision).toBe(1);
      expect(historical.supportPlans[MING].reviewState).toBe('current');
    }
  });

  it('一方仅保留自身支持事项后，其计划不再暴露该共同结论，另一方与旧纪要/母本保留', () => {
    const w = new World();
    const consentId = completedJoint(w);
    w.run((s) =>
      recordSharedConclusion(s, { familyId: FAMILY, content: SHARED_80, storageMode: 'reference', consentId, atMin: hmToMin('16:12') }),
    );
    const conclusion = Object.values(w.snap.sharedConclusions)[0];
    w.run((s) =>
      reduceSharedScope(s, { studentId: MING, conclusionId: conclusion.id, reason: '小明家长仅保留其自身支持事项', atMin: hmToMin('16:40') }),
    );
    // 小明当前计划读不到该共同结论
    expect(readStudentPlan(w.snap, MING, HOMEROOM).sharedConclusions).toHaveLength(0);
    // 小华计划仍可见
    expect(readStudentPlan(w.snap, HUA, HOMEROOM).sharedConclusions).toHaveLength(1);
    // 不可变母本与授权范围保留
    expect(w.snap.sharedConclusions[conclusion.id].authorizedStudentIds.sort()).toEqual([HUA, MING]);

    // 撤权后任何教师读另一学生的私有 20 字仍被拒（私有边界不因共同结论收窄而变化）
    w.run((s) =>
      recordMinutes(s, {
        sessionId: w.sessionsOf(w.latestMeeting().id)[0].id,
        hostTeacherId: HOMEROOM,
        attendance: {},
        sharedConclusionIds: [conclusion.id],
        privateContents: [{ studentId: HUA, content: PRIV_HUA_20 }],
        atMin: hmToMin('16:45'),
      }),
    );
    const huaPrivate = Object.values(w.snap.privateEntries).find((e) => e.studentId === HUA)!;
    expect(() => readPrivateEntry(w.snap, huaPrivate.id, SEMINAR)).toThrow(/访问被拒/);
  });
});

describe('撤回共同议题同意：立即拆分，旧纪要按原授权保留', () => {
  it('撤回后授权失效、联合场取消并拆成两场个别会谈，旧名册失效，且不能再基于旧授权写共同结论', () => {
    const w = new World();
    const consentId = (() => {
      grantBoth(w);
      return w.consent()!.id;
    })();
    w.run((s) => bookMeeting(s, { familyId: FAMILY, mode: 'joint', atMin: hmToMin('15:00'), by: 'u_coordinator' }));
    const oldMeeting = w.latestMeeting();
    const oldSession = w.sessionsOf(oldMeeting.id)[0];

    w.run((s) =>
      revokeConsentAndSplit(s, { familyId: FAMILY, reason: '家长撤回共同议题同意', atMin: hmToMin('15:20') }),
    );

    // 授权失效
    expect(w.snap.consents[consentId].granted).toBe(false);
    // 原联合场取消、资源释放、旧名册失效
    expect(w.snap.sessions[oldSession.id].status).toBe('cancelled');
    expect(
      Object.values(w.snap.visitorEntries)
        .filter((e) => e.sessionId === oldSession.id)
        .every((e) => e.status === 'void'),
    ).toBe(true);

    // 新建分开会谈，两场个别、各自 20 分钟
    const newMeeting = w.latestMeeting();
    expect(newMeeting.id).not.toBe(oldMeeting.id);
    expect(newMeeting.mode).toBe('separate');
    expect(newMeeting.splitFromMeetingId).toBe(oldMeeting.id);
    const newSessions = w.sessionsOf(newMeeting.id);
    expect(newSessions).toHaveLength(2);
    expect(newSessions.every((x) => x.joint === false)).toBe(true);

    // 旧授权不能再用于写共同结论
    expect(
      w.tryRun((s) =>
        recordSharedConclusion(s, {
          familyId: FAMILY,
          content: SHARED_80,
          storageMode: 'reference',
          consentId,
          atMin: hmToMin('15:25'),
        }),
      ),
    ).toContain('授权');
  });

  it('拆分前已定稿的旧纪要仍按原授权范围保存，不被删除', () => {
    const w = new World();
    const consentId = (() => {
      grantBoth(w);
      return w.consent()!.id;
    })();
    w.run((s) => bookMeeting(s, { familyId: FAMILY, mode: 'joint', atMin: hmToMin('15:00'), by: 'u_coordinator' }));
    const session = w.sessionsOf(w.latestMeeting().id)[0];
    w.run((s) => startSession(s, { sessionId: session.id, hostTeacherId: HOMEROOM, atMin: hmToMin('15:30') }));
    w.run((s) => endSession(s, { sessionId: session.id, hostTeacherId: HOMEROOM, atMin: hmToMin('16:10') }));
    w.run((s) =>
      recordMinutes(s, {
        sessionId: session.id,
        hostTeacherId: HOMEROOM,
        attendance: attendance(session.id),
        sharedConclusionIds: [],
        privateContents: [{ studentId: MING, content: PRIV_MING_20 }],
        atMin: hmToMin('16:15'),
      }),
    );
    const minutesId = Object.values(w.snap.minutes)[0].id;
    w.run((s) => finalizeMinutes(s, { minutesId, hostTeacherId: HOMEROOM, atMin: hmToMin('16:18') }));

    w.run((s) => revokeConsentAndSplit(s, { familyId: FAMILY, reason: '撤回', atMin: hmToMin('16:25') }));
    // 旧纪要与私有补充原样保留
    expect(w.snap.minutes[minutesId].status).toBe('finalized');
    expect(Object.values(w.snap.privateEntries).some((e) => e.content === PRIV_MING_20)).toBe(true);
    void consentId;
  });
});

describe('记录数与逐学生可见范围总核对', () => {
  it('引用结构共同内容 1 份、复制结构 2 份；私有始终两学生各 1 份且互不串', () => {
    function build(mode: 'reference' | 'copy') {
      const w = new World();
      grantBoth(w);
      const consentId = w.consent()!.id;
      w.run((s) => bookMeeting(s, { familyId: FAMILY, mode: 'joint', atMin: hmToMin('15:00'), by: 'u_coordinator' }));
      const session = w.sessionsOf(w.latestMeeting().id)[0];
      w.run((s) => startSession(s, { sessionId: session.id, hostTeacherId: HOMEROOM, atMin: hmToMin('15:30') }));
      w.run((s) => endSession(s, { sessionId: session.id, hostTeacherId: HOMEROOM, atMin: hmToMin('16:10') }));
      w.run((s) =>
        recordSharedConclusion(s, { familyId: FAMILY, content: SHARED_80, storageMode: mode, consentId, atMin: hmToMin('16:12') }),
      );
      w.run((s) =>
        recordMinutes(s, {
          sessionId: session.id,
          hostTeacherId: HOMEROOM,
          attendance: {},
          sharedConclusionIds: [Object.values(w.snap.sharedConclusions)[0].id],
          privateContents: [
            { studentId: MING, content: PRIV_MING_20 },
            { studentId: HUA, content: PRIV_HUA_20 },
          ],
          atMin: hmToMin('16:15'),
        }),
      );
      return w;
    }

    const refWorld = build('reference');
    const copyWorld = build('copy');

    // 共同内容份数：引用 1（仅母本），复制 2（计划内副本）
    expect(Object.values(refWorld.snap.sharedConclusions)).toHaveLength(1);
    expect(Object.values(copyWorld.snap.supportPlans).flatMap((p) => p.copies)).toHaveLength(2);

    for (const w of [refWorld, copyWorld]) {
      const ming = readStudentPlan(w.snap, MING, HOMEROOM);
      const hua = readStudentPlan(w.snap, HUA, HOMEROOM);
      // 私有各 1 份、各 20 字、互不串
      expect(ming.privateEntries).toHaveLength(1);
      expect(hua.privateEntries).toHaveLength(1);
      expect(ming.privateEntries[0].content).toBe(PRIV_MING_20);
      expect(hua.privateEntries[0].content).toBe(PRIV_HUA_20);
      expect(ming.privateEntries[0].studentId).not.toBe(hua.privateEntries[0].studentId);
      // 每位学生当前计划都能看到共同结论
      expect(ming.sharedConclusions.length + ming.copies.length).toBeGreaterThan(0);
      expect(hua.sharedConclusions.length + hua.copies.length).toBeGreaterThan(0);
    }
  });
});

describe('原子化会议成果命令 recordSessionOutcome（UI 主路径）', () => {
  function finishedJoint(w: World) {
    grantBoth(w);
    w.run((s) => bookMeeting(s, { familyId: FAMILY, mode: 'joint', atMin: hmToMin('15:00'), by: 'u_coordinator' }));
    const session = w.sessionsOf(w.latestMeeting().id)[0];
    w.run((s) => startSession(s, { sessionId: session.id, hostTeacherId: HOMEROOM, atMin: hmToMin('15:30') }));
    w.run((s) => endSession(s, { sessionId: session.id, hostTeacherId: HOMEROOM, atMin: hmToMin('16:10') }));
    return { session, consentId: w.consent()!.id };
  }

  it('单次命令同时落共同结论（引用）、两学生各 20 字私有补充与纪要引用', () => {
    const w = new World();
    const { session, consentId } = finishedJoint(w);
    w.run((s) =>
      recordSessionOutcome(s, {
        sessionId: session.id,
        hostTeacherId: HOMEROOM,
        attendance: attendance(session.id),
        shared: { content: SHARED_80, storageMode: 'reference', consentId },
        privateContents: [
          { studentId: MING, content: PRIV_MING_20 },
          { studentId: HUA, content: PRIV_HUA_20 },
        ],
        atMin: hmToMin('16:15'),
      }),
    );
    const minutes = Object.values(w.snap.minutes)[0];
    expect(minutes.sharedConclusionIds).toHaveLength(1);
    expect(minutes.privateEntryIds).toHaveLength(2);
    expect(Object.values(w.snap.sharedConclusions)).toHaveLength(1);
    // 任教授权在读取视图中生效：苏老师看不到小华任何内容
    expect(() => readStudentPlan(w.snap, HUA, SEMINAR)).toThrow(/访问被拒/);
  });

  it('无共享授权时只记录个别内容，不产生共同结论；未结束场次被拒', () => {
    const w = new World();
    // 不授予同意，直接预约分开场
    w.run((s) => bookMeeting(s, { familyId: FAMILY, mode: 'separate', atMin: hmToMin('15:00'), by: 'u_coordinator' }));
    const session = w.sessionsOf(w.latestMeeting().id)[0];
    const r = recordSessionOutcome(w.snap, {
      sessionId: session.id,
      hostTeacherId: HOMEROOM,
      attendance: {},
      shared: null,
      privateContents: [{ studentId: MING, content: PRIV_MING_20 }],
      atMin: hmToMin('15:40'),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('记录结束');
  });
});
