// 事件溯源 reducer：纯函数，把事件流回放成当前快照
// 浏览器 WebWorker 与 vitest 共用同一份逻辑，保证“可回放”

import type {
  AppEvent,
  Course,
  Incident,
  Meeting,
  MeetingMinutes,
  MeetingNotification,
  MeetingSession,
  NotificationDoc,
  ReassignmentPlan,
  Report,
  ResourceBooking,
  RoomClosure,
  SharedConclusion,
  Snapshot,
  SupportPlan,
  VisitorEntry,
  WorkOrder,
} from '../types';
import {
  SEED_COURSES,
  SEED_FAMILIES,
  SEED_INTERPRETERS,
  SEED_MEETING_ROOMS,
  SEED_ROOMS,
  SEED_STUDENTS,
  SEED_TEACHINGS,
} from '../lib/seed';

export function initialSnapshot(): Snapshot {
  const rooms: Snapshot['rooms'] = {};
  for (const r of SEED_ROOMS) rooms[r.id] = structuredClone(r);
  const courses: Snapshot['courses'] = {};
  for (const c of SEED_COURSES) courses[c.id] = structuredClone(c);
  const families: Snapshot['families'] = {};
  for (const f of SEED_FAMILIES) families[f.id] = structuredClone(f);
  const students: Snapshot['students'] = {};
  for (const st of SEED_STUDENTS) students[st.id] = structuredClone(st);
  const interpreters: Snapshot['interpreters'] = {};
  for (const i of SEED_INTERPRETERS) interpreters[i.id] = structuredClone(i);
  const meetingRooms: Snapshot['meetingRooms'] = {};
  for (const m of SEED_MEETING_ROOMS) meetingRooms[m.id] = structuredClone(m);
  return {
    seq: 0,
    rooms,
    closures: {},
    courses,
    incidents: {},
    reports: {},
    workOrders: {},
    plans: {},
    notifications: {},
    families,
    students,
    interpreters,
    meetingRooms,
    teachings: structuredClone(SEED_TEACHINGS),
    meetings: {},
    sessions: {},
    bookings: {},
    visitorEntries: {},
    consents: {},
    minutes: {},
    sharedConclusions: {},
    privateEntries: {},
    supportPlans: {},
    meetingNotifications: {},
  };
}

export function applyEvent(prev: Snapshot, ev: AppEvent): Snapshot {
  const s: Snapshot = structuredClone(prev);
  s.seq = ev.seq;

  switch (ev.type) {
    case 'incident.created': {
      const incident: Incident = {
        id: ev.incidentId,
        faultType: ev.faultType,
        roomIds: [...ev.roomIds],
        status: 'reported',
        reportIds: [],
        workOrderId: null,
        createdAt: ev.at,
        confirmedAt: null,
        estimatedEndMin: null,
        repairedAt: null,
        verifiedAt: null,
        retestFailures: [],
      };
      s.incidents[ev.incidentId] = incident;
      break;
    }

    case 'report.submitted': {
      const report: Report = {
        id: ev.reportId,
        incidentId: ev.incidentId,
        roomId: ev.roomId,
        faultType: ev.faultType,
        description: ev.description,
        photoIds: [...ev.photoIds],
        teacherId: ev.teacherId,
        at: ev.at,
        duplicate: ev.duplicate,
      };
      s.reports[ev.reportId] = report;
      const inc = s.incidents[ev.incidentId];
      if (inc) {
        inc.reportIds.push(ev.reportId);
        // 同一主管影响多间教室：报修房间并入事故边界（待设施核准）
        if (!inc.roomIds.includes(ev.roomId)) inc.roomIds.push(ev.roomId);
      }
      break;
    }

    case 'incident.boundaryConfirmed': {
      const inc = s.incidents[ev.incidentId];
      if (!inc) break;
      inc.status = 'confirmed';
      inc.confirmedAt = ev.at;
      inc.roomIds = [...ev.roomIds];
      inc.estimatedEndMin = ev.estimatedEndMin;
      for (const roomId of ev.roomIds) {
        const closure: RoomClosure = {
          incidentId: ev.incidentId,
          roomIds: [...ev.roomIds],
          sinceMin: ev.sinceMin,
          estimatedEndMin: ev.estimatedEndMin,
          closed: true,
          reopenedAt: null,
        };
        s.closures[roomId] = closure;
      }
      break;
    }

    case 'workorder.created': {
      const inc = s.incidents[ev.incidentId];
      const wo: WorkOrder = {
        id: ev.workOrderId,
        incidentId: ev.incidentId,
        summary: ev.summary,
        assignee: ev.assignee,
        createdAt: ev.at,
        completedAt: null,
      };
      s.workOrders[ev.workOrderId] = wo;
      if (inc) {
        inc.status = 'work_order';
        inc.workOrderId = ev.workOrderId;
      }
      break;
    }

    case 'repair.marked': {
      const inc = s.incidents[ev.incidentId];
      if (inc) {
        inc.status = 'repaired';
        inc.repairedAt = ev.at;
        if (inc.workOrderId) {
          s.workOrders[inc.workOrderId].completedAt = ev.at;
        }
      }
      // 关键规则：维修标记“已修复”不解除封闭，必须等设施复测
      break;
    }

    case 'retest.failed': {
      const inc = s.incidents[ev.incidentId];
      if (inc) {
        inc.retestFailures.push({ at: ev.at, note: ev.note });
        // 维持 repaired 状态等待返修后再次复测，封闭不解除
      }
      break;
    }

    case 'retest.passed': {
      const inc = s.incidents[ev.incidentId];
      if (inc) {
        inc.status = 'verified';
        inc.verifiedAt = ev.at;
        for (const roomId of inc.roomIds) {
          const closure = s.closures[roomId];
          if (closure && closure.incidentId === inc.id) {
            closure.closed = false;
            closure.reopenedAt = ev.at;
          }
        }
      }
      break;
    }

    case 'reassignment.proposed': {
      const plan: ReassignmentPlan = {
        id: ev.planId,
        strategy: ev.strategy,
        moves: ev.moves.map((m) => ({ ...m })),
        studentMinutes: ev.studentMinutes,
        notifiedClassIds: [...ev.notifiedClassIds],
        status: 'proposed',
        createdAt: ev.at,
        confirmedCourseIds: [],
        publishedAt: null,
        notificationIds: [],
        affectedRoomIds: [...ev.affectedRoomIds],
      };
      s.plans[ev.planId] = plan;
      break;
    }

    case 'reassignment.confirmed': {
      const plan = s.plans[ev.planId];
      if (plan && !plan.confirmedCourseIds.includes(ev.courseId)) {
        plan.confirmedCourseIds.push(ev.courseId);
      }
      break;
    }

    case 'reassignment.published': {
      const plan = s.plans[ev.planId];
      if (!plan) break;
      plan.status = 'published';
      plan.publishedAt = ev.at;
      plan.notificationIds = [...ev.notificationIds];
      for (const move of plan.moves) {
        const course = s.courses[move.courseId];
        if (course) {
          course.roomId = move.toRoomId;
          course.status = 'reassigned';
          course.planId = plan.id;
        }
      }
      break;
    }

    case 'reassignment.cancelled': {
      const plan = s.plans[ev.planId];
      if (plan) plan.status = 'cancelled';
      break;
    }

    case 'notification.sent': {
      if (ev.supersedesId && s.notifications[ev.supersedesId]) {
        s.notifications[ev.supersedesId].superseded = true;
      }
      const doc: NotificationDoc = {
        id: ev.notificationId,
        version: ev.version,
        courseId: ev.courseId,
        className: ev.className,
        teacherId: ev.teacherId,
        roomId: ev.roomId,
        roomName: ev.roomName,
        startMin: ev.startMin,
        endMin: ev.endMin,
        title: ev.title,
        body: ev.body,
        planId: ev.planId,
        createdAt: ev.at,
        superseded: false,
      };
      s.notifications[ev.notificationId] = doc;
      break;
    }

    // ---------- 会谈预约与接待 ----------

    case 'meeting.created': {
      const meeting: Meeting = {
        id: ev.meetingId,
        familyId: ev.familyId,
        parentId: ev.parentId,
        mode: ev.mode,
        status: 'scheduled',
        sessionIds: [...ev.sessionIds],
        createdAt: ev.at,
        splitFromMeetingId: ev.splitFromMeetingId,
      };
      s.meetings[ev.meetingId] = meeting;
      break;
    }

    case 'session.scheduled': {
      const session: MeetingSession = {
        id: ev.sessionId,
        meetingId: ev.meetingId,
        familyId: ev.familyId,
        studentIds: [...ev.studentIds],
        joint: ev.joint,
        title: ev.title,
        startMin: ev.startMin,
        endMin: ev.endMin,
        roomId: ev.roomId,
        interpreterRequired: ev.interpreterRequired,
        interpreterId: ev.interpreterId,
        hostTeacherId: ev.hostTeacherId,
        teacherIds: [...ev.teacherIds],
        parentId: ev.parentId,
        status: 'scheduled',
        checkInStatus: 'none',
        interpreterServiceStatus: ev.interpreterRequired ? 'booked' : 'not_required',
        minutesStatus: 'none',
        startedAt: null,
        endedAt: null,
        activeRosterEntryIds: [...ev.rosterEntryIds],
        notificationIds: [...ev.notificationIds],
      };
      s.sessions[ev.sessionId] = session;
      break;
    }

    case 'resource.booked': {
      const booking: ResourceBooking = {
        id: ev.bookingId,
        resourceType: ev.resourceType,
        resourceId: ev.resourceId,
        sessionId: ev.sessionId,
        meetingId: ev.meetingId,
        startMin: ev.startMin,
        endMin: ev.endMin,
        status: 'held',
        releasedAt: null,
        releaseReason: null,
      };
      s.bookings[ev.bookingId] = booking;
      break;
    }

    case 'resource.released': {
      const booking = s.bookings[ev.bookingId];
      if (booking) {
        booking.status = 'released';
        booking.releasedAt = ev.at;
        booking.releaseReason = ev.reason;
      }
      break;
    }

    case 'visitor.roster.issued': {
      for (const e of ev.entries) {
        const entry: VisitorEntry = {
          id: e.id,
          sessionId: e.sessionId,
          personId: e.personId,
          personName: e.personName,
          personRole: e.personRole,
          status: 'active',
          checkIn: 'none',
          late: false,
          early: false,
          createdAt: ev.at,
          voidedAt: null,
          voidReason: null,
        };
        s.visitorEntries[e.id] = entry;
      }
      break;
    }

    case 'visitor.roster.voided': {
      for (const id of ev.entryIds) {
        const entry = s.visitorEntries[id];
        if (entry) {
          entry.status = 'void';
          entry.voidedAt = ev.at;
          entry.voidReason = ev.reason;
          const session = s.sessions[entry.sessionId];
          if (session) {
            session.activeRosterEntryIds = session.activeRosterEntryIds.filter((x) => x !== id);
          }
        }
      }
      break;
    }

    case 'meeting.notification.sent': {
      if (ev.supersedesId && s.meetingNotifications[ev.supersedesId]) {
        s.meetingNotifications[ev.supersedesId].superseded = true;
      }
      const n: MeetingNotification = {
        id: ev.notificationId,
        meetingId: ev.meetingId,
        sessionId: ev.sessionId,
        recipientId: ev.recipientId,
        recipientRole: ev.recipientRole,
        kind: ev.kind,
        version: ev.version,
        title: ev.title,
        body: ev.body,
        superseded: false,
        createdAt: ev.at,
      };
      s.meetingNotifications[ev.notificationId] = n;
      const session = ev.sessionId ? s.sessions[ev.sessionId] : null;
      if (session && !session.notificationIds.includes(ev.notificationId)) {
        session.notificationIds.push(ev.notificationId);
      }
      break;
    }

    case 'consent.granted': {
      s.consents[ev.consentId] = {
        id: ev.consentId,
        familyId: ev.familyId,
        scope: 'joint_shared_topic',
        studentIds: [...ev.studentIds],
        grantedBy: ev.grantedBy,
        studentApprovals: { ...ev.studentApprovals },
        granted: true,
        grantedAt: ev.at,
        revokedAt: null,
        revokeReason: null,
      };
      break;
    }

    case 'consent.revoked': {
      const consent = s.consents[ev.consentId];
      if (consent) {
        consent.granted = false;
        consent.revokedAt = ev.at;
        consent.revokeReason = ev.reason;
      }
      break;
    }

    case 'meeting.split': {
      const old = s.meetings[ev.oldMeetingId];
      if (old) {
        const oldSessions = old.sessionIds.map((id) => s.sessions[id]).filter(Boolean);
        const hasCompleted = oldSessions.some((x) => x.status === 'completed');
        // 已完成过的场次保留“已完成”（旧纪要仍在）；纯未举行的联合场才标记取消
        old.status = hasCompleted ? 'completed' : 'cancelled';
      }
      const fresh = s.meetings[ev.newMeetingId];
      if (fresh) {
        fresh.sessionIds = [...ev.newSessionIds];
      }
      break;
    }

    case 'session.rescheduled': {
      const session = s.sessions[ev.sessionId];
      if (session) {
        session.startMin = ev.newStartMin;
        session.endMin = ev.newEndMin;
        session.roomId = ev.roomId;
        session.interpreterId = ev.interpreterId;
        session.status = 'scheduled';
        session.activeRosterEntryIds = [...ev.rosterEntryIds];
        for (const id of ev.notificationIds) {
          if (!session.notificationIds.includes(id)) session.notificationIds.push(id);
        }
      }
      break;
    }

    case 'session.pending_reschedule': {
      const session = s.sessions[ev.sessionId];
      if (session) {
        session.status = 'reschedule_pending';
        session.interpreterServiceStatus = 'absent';
      }
      const meeting = session ? s.meetings[session.meetingId] : null;
      if (meeting && meeting.status === 'scheduled') meeting.status = 'reschedule_pending';
      break;
    }

    case 'session.cancelled': {
      const session = s.sessions[ev.sessionId];
      if (session) session.status = 'cancelled';
      break;
    }

    case 'interpreter.absent': {
      const session = s.sessions[ev.sessionId];
      if (session) {
        session.interpreterServiceStatus = 'absent';
        session.interpreterId = ev.interpreterId;
      }
      break;
    }

    case 'visit.checked_in': {
      const session = s.sessions[ev.sessionId];
      if (session) {
        session.checkInStatus = 'checked_in';
        if (session.interpreterServiceStatus === 'booked') {
          // 口译到场以其本人签到为准；家长/教师签到不改变口译状态，故不在此切换
        }
      }
      const entry = Object.values(s.visitorEntries).find(
        (x) => x.sessionId === ev.sessionId && x.personId === ev.personId && x.status === 'active',
      );
      if (entry) {
        entry.checkIn = 'checked_in';
        entry.late = ev.late;
      }
      break;
    }

    case 'visit.left': {
      const entry = Object.values(s.visitorEntries).find(
        (x) => x.sessionId === ev.sessionId && x.personId === ev.personId && x.status === 'active',
      );
      if (entry) {
        entry.checkIn = 'left';
        entry.early = ev.early;
      }
      // 提前离场只改变该访客状态，不自动结束/关闭场次，更不影响同会谈另一场
      break;
    }

    case 'visit.cancelled': {
      const entry = Object.values(s.visitorEntries).find(
        (x) => x.sessionId === ev.sessionId && x.personId === ev.personId && x.status === 'active',
      );
      if (entry) entry.checkIn = 'cancelled';
      const session = s.sessions[ev.sessionId];
      if (session) session.checkInStatus = 'cancelled';
      // 取消回执不等于会议完成：场次状态保持，只有主持人记录结束才能关闭
      break;
    }

    case 'session.started': {
      const session = s.sessions[ev.sessionId];
      if (session) {
        session.status = 'in_progress';
        session.startedAt = ev.at;
        if (session.interpreterServiceStatus === 'booked') {
          session.interpreterServiceStatus = 'in_service';
        }
      }
      const meeting = session ? s.meetings[session.meetingId] : null;
      if (meeting && meeting.status === 'scheduled') meeting.status = 'in_progress';
      break;
    }

    case 'session.ended': {
      const session = s.sessions[ev.sessionId];
      if (session) {
        session.status = 'completed';
        session.endedAt = ev.at;
      }
      const meeting = session ? s.meetings[session.meetingId] : null;
      if (meeting) {
        const allDone = meeting.sessionIds.every(
          (id) => s.sessions[id]?.status === 'completed' || s.sessions[id]?.status === 'cancelled',
        );
        if (allDone) meeting.status = 'completed';
      }
      break;
    }

    case 'minutes.created': {
      const doc: MeetingMinutes = {
        id: ev.minutesId,
        sessionId: ev.sessionId,
        meetingId: ev.meetingId,
        hostTeacherId: ev.hostTeacherId,
        attendance: structuredClone(ev.attendance),
        sharedConclusionIds: [...ev.sharedConclusionIds],
        privateEntryIds: [...ev.privateEntryIds],
        status: 'draft',
        createdAt: ev.at,
        finalizedAt: null,
      };
      s.minutes[ev.minutesId] = doc;
      const session = s.sessions[ev.sessionId];
      if (session) session.minutesStatus = 'draft';
      break;
    }

    case 'minutes.finalized': {
      const doc = s.minutes[ev.minutesId];
      if (doc) {
        doc.status = 'finalized';
        doc.finalizedAt = ev.at;
      }
      const session = doc ? s.sessions[doc.sessionId] : null;
      if (session) session.minutesStatus = 'finalized';
      break;
    }

    case 'shared.conclusion.recorded': {
      const conclusion: SharedConclusion = {
        id: ev.conclusionId,
        familyId: ev.familyId,
        revision: ev.revision,
        content: ev.content,
        storageMode: ev.storageMode,
        supersedesId: ev.supersedesId,
        authorizedStudentIds: [...ev.authorizedStudentIds],
        consentIdAtCreation: ev.consentId,
        createdAt: ev.at,
      };
      s.sharedConclusions[ev.conclusionId] = conclusion;

      if (ev.storageMode === 'reference') {
        for (const ref of ev.refs) {
          const plan = ensurePlan(s, ref.studentId);
          // 更正场景：旧引用保留为历史（detached 由专门命令处理），新引用追加并置待核
          plan.sharedRefs.push({
            conclusionId: ref.conclusionId,
            revision: ref.revision,
            pendingReview: ev.supersedesId !== null,
            detached: false,
          });
          if (ev.supersedesId !== null) plan.reviewState = 'pending_review';
        }
      } else {
        for (const copy of ev.copies) {
          const plan = ensurePlan(s, copy.studentId);
          plan.copies.push({
            id: copy.id,
            studentId: copy.studentId,
            conclusionId: copy.conclusionId,
            revision: copy.revision,
            content: copy.content,
            pairedCopyId: copy.pairedCopyId,
            pendingReview: ev.supersedesId !== null,
            detached: false,
          });
          if (ev.supersedesId !== null) plan.reviewState = 'pending_review';
        }
      }
      break;
    }

    case 'private.entry.recorded': {
      s.privateEntries[ev.entryId] = {
        id: ev.entryId,
        studentId: ev.studentId,
        minutesId: ev.minutesId,
        content: ev.content,
        createdAt: ev.at,
      };
      const plan = ensurePlan(s, ev.studentId);
      if (!plan.privateEntryIds.includes(ev.entryId)) plan.privateEntryIds.push(ev.entryId);
      break;
    }

    case 'plan.review.cleared': {
      const plan = s.supportPlans[ev.studentId];
      if (plan) {
        plan.reviewState = 'current';
        for (const ref of plan.sharedRefs) {
          if (ref.conclusionId === ev.conclusionId) ref.pendingReview = false;
        }
        for (const copy of plan.copies) {
          if (copy.conclusionId === ev.conclusionId) copy.pendingReview = false;
        }
      }
      break;
    }

    case 'plan.shared_scope.reduced': {
      // 一方仅保留自身支持事项：解除其计划里指向该共同结论的引用/副本，
      // 但不可变结论、旧纪要与另一方计划保持不变（撤销共享不得遗留越权内容）
      const plan = s.supportPlans[ev.studentId];
      if (plan) {
        for (const ref of plan.sharedRefs) {
          if (ref.conclusionId === ev.conclusionId) ref.detached = true;
        }
        for (const copy of plan.copies) {
          if (copy.conclusionId === ev.conclusionId) copy.detached = true;
        }
      }
      break;
    }
  }

  return s;
}

function ensurePlan(s: Snapshot, studentId: string): SupportPlan {
  let plan = s.supportPlans[studentId];
  if (!plan) {
    plan = {
      studentId,
      sharedRefs: [],
      copies: [],
      privateEntryIds: [],
      reviewState: 'current',
    };
    s.supportPlans[studentId] = plan;
  }
  return plan;
}

export function replay(events: AppEvent[], base?: Snapshot): Snapshot {
  return events.reduce(applyEvent, base ?? initialSnapshot());
}

export function coursesAffectedByClosures(snap: Snapshot): Course[] {
  const closedRoomIds = Object.entries(snap.closures)
    .filter(([, c]) => c.closed)
    .map(([roomId]) => roomId);
  return Object.values(snap.courses).filter((c) => closedRoomIds.includes(c.roomId));
}
