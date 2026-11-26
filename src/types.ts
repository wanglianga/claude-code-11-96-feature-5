// 领域类型定义：事件溯源模型，所有状态变更都通过事件回放得到

export type Role =
  | 'teacher'
  | 'facility'
  | 'dispatcher'
  | 'repair'
  | 'coordinator' // 校内接待协调员：预约、资源、名册、通知
  | 'guard' // 门岗：访客签到/签退/到场回执
  | 'interpreter'; // 口译员

export type FaultType = 'leak' | 'power' | 'equipment';

export type IncidentStatus =
  | 'reported' // 已报修，待设施核准
  | 'confirmed' // 已核准事故边界，教室封闭
  | 'work_order' // 已生成工单/维修中
  | 'repaired' // 维修人员标记已修复，待复测
  | 'verified'; // 设施复测通过，解除封闭

export type CourseStatus = 'normal' | 'reassigned';

export type PlanStatus = 'proposed' | 'published' | 'cancelled';

export type DraftStatus = 'draft' | 'submitted' | 'conflict' | 'expired';

export interface User {
  id: string;
  name: string;
  role: Role;
}

export interface Room {
  id: string;
  code: string; // 教室码，扫码用
  name: string;
  capacity: number;
  equipment: string[]; // projector / lab_bench
  accessible: boolean; // 无障碍通道
  safety: boolean; // 安全条件
}

export interface RoomClosure {
  incidentId: string;
  roomIds: string[];
  sinceMin: number;
  estimatedEndMin: number | null; // 预计修复时间，仅参考，不会自动解封
  closed: boolean;
  reopenedAt: string | null;
}

export interface Course {
  id: string;
  className: string;
  teacherId: string;
  roomId: string;
  originalRoomId: string;
  startMin: number;
  endMin: number;
  size: number;
  requirements: string[];
  flexible: boolean; // 弹性课程（可被交换）
  status: CourseStatus;
  planId: string | null;
}

export interface Report {
  id: string;
  incidentId: string;
  roomId: string;
  faultType: FaultType;
  description: string;
  photoIds: string[];
  teacherId: string;
  at: string;
  duplicate: boolean;
}

export interface Incident {
  id: string;
  faultType: FaultType;
  roomIds: string[];
  status: IncidentStatus;
  reportIds: string[];
  workOrderId: string | null;
  createdAt: string;
  confirmedAt: string | null;
  estimatedEndMin: number | null;
  repairedAt: string | null;
  verifiedAt: string | null;
  retestFailures: { at: string; note: string }[];
}

export interface WorkOrder {
  id: string;
  incidentId: string;
  summary: string;
  assignee: string;
  createdAt: string;
  completedAt: string | null;
}

export interface ReassignmentMove {
  courseId: string;
  fromRoomId: string;
  toRoomId: string;
  studentMinutes: number;
}

export interface ReassignmentPlan {
  id: string;
  strategy: 'minimal' | 'swap';
  moves: ReassignmentMove[];
  studentMinutes: number;
  notifiedClassIds: string[];
  status: PlanStatus;
  createdAt: string;
  confirmedCourseIds: string[];
  publishedAt: string | null;
  notificationIds: string[];
  affectedRoomIds: string[];
}

export interface NotificationDoc {
  id: string;
  version: number;
  courseId: string;
  className: string;
  teacherId: string;
  roomId: string;
  roomName: string;
  startMin: number;
  endMin: number;
  title: string;
  body: string;
  planId: string;
  createdAt: string;
  superseded: boolean;
}

// ==================================================================
// 家长会谈预约与校内接待领域（feature-5）
// 共同议题与个别记录分别建模；联合/分场都是家长可选功能
// ==================================================================

export type MeetingMode = 'joint' | 'separate';

export type MeetingStatus =
  | 'scheduled' // 已预约，房间/口译/名册均已占用或发出
  | 'in_progress' // 至少一场已开始
  | 'completed' // 全部场次由主持人记录结束
  | 'cancelled' // 取消
  | 'reschedule_pending'; // 待改期（如口译员临时缺席），资源已释放、旧名册失效

export type SessionStatus =
  | 'scheduled'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'reschedule_pending';

/** 访客签到状态（独立于口译服务状态、纪要状态） */
export type CheckInStatus = 'none' | 'checked_in' | 'left' | 'cancelled';

/** 口译服务状态（独立跟踪，预订不等于服务完成） */
export type InterpreterServiceStatus =
  | 'not_required'
  | 'booked' // 已预订
  | 'in_service' // 到场服务中
  | 'absent' // 临时缺席
  | 'released'; // 已释放

export type MinutesStatus = 'none' | 'draft' | 'finalized';

export interface Family {
  id: string;
  name: string; // 如：王姓家庭
  parentId: string;
  parentName: string;
  studentIds: string[];
  needsInterpreter: boolean; // 该家庭需要口译服务
  availableStartMin: number; // 家长可到校窗口起
  availableEndMin: number; // 家长可到校窗口止
}

export interface Student {
  id: string;
  name: string;
  familyId: string;
  homeroomTeacherId: string; // 班主任
}

/** 教师-学生任教关系：教师只可读自己所教学生的记录 */
export interface TeacherLink {
  teacherId: string;
  studentId: string;
  subject: string; // homeroom / math / ...
}

export interface Interpreter {
  id: string;
  name: string;
  startMin: number; // 可服务窗口起
  endMin: number; // 可服务窗口止
}

export interface MeetingRoom {
  id: string;
  name: string;
  startMin: number; // 整段可用窗口起
  endMin: number; // 整段可用窗口止
}

export interface Meeting {
  id: string;
  familyId: string;
  parentId: string;
  mode: MeetingMode;
  status: MeetingStatus;
  sessionIds: string[];
  createdAt: string;
  /** 撤回共同议题同意后，后续会谈拆分为新会谈；指向被拆分的原会谈 */
  splitFromMeetingId: string | null;
}

export interface MeetingSession {
  id: string;
  meetingId: string;
  familyId: string;
  /** 联合场为两位学生；分场为一位学生 */
  studentIds: string[];
  joint: boolean;
  title: string;
  startMin: number;
  endMin: number; // 每位学生 20 分钟；联合场 40 分钟
  roomId: string;
  interpreterRequired: boolean;
  interpreterId: string | null;
  hostTeacherId: string; // 主持人（班主任）
  teacherIds: string[]; // 参会教师（含主持人）
  parentId: string;
  status: SessionStatus;
  // 三个相互独立的状态
  checkInStatus: CheckInStatus;
  interpreterServiceStatus: InterpreterServiceStatus;
  minutesStatus: MinutesStatus;
  startedAt: string | null;
  endedAt: string | null;
  activeRosterEntryIds: string[]; // 当前有效名册条目；旧条目失效后不再保留在此
  notificationIds: string[];
}

export type VisitorStatus = 'active' | 'void';

export interface VisitorEntry {
  id: string;
  sessionId: string;
  personId: string | null;
  personName: string;
  personRole: 'parent' | 'interpreter' | 'teacher';
  status: VisitorStatus;
  // 每位访客各自的签到状态（门岗名册维度）
  checkIn: CheckInStatus;
  late: boolean;
  early: boolean;
  createdAt: string;
  voidedAt: string | null;
  voidReason: string | null;
}

export interface ResourceBooking {
  id: string;
  resourceType: 'room' | 'interpreter';
  resourceId: string;
  sessionId: string;
  meetingId: string;
  startMin: number;
  endMin: number;
  status: 'held' | 'released';
  releasedAt: string | null;
  releaseReason: string | null;
}

/** 共同议题授权：家长 + 两位学生全部明确同意才成立，可随时撤回 */
export interface ConsentGrant {
  id: string;
  familyId: string;
  scope: 'joint_shared_topic';
  studentIds: string[];
  grantedBy: string; // 家长
  studentApprovals: Record<string, boolean>;
  granted: boolean;
  grantedAt: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
}

export interface AttendanceRecord {
  personId: string;
  name: string;
  role: 'parent' | 'teacher' | 'interpreter' | 'student';
  attended: boolean;
  arrivedLate: boolean; // 迟到回执
  leftEarly: boolean; // 提前离场
  cancelled: boolean; // 取消回执
}

export interface MeetingMinutes {
  id: string;
  sessionId: string;
  meetingId: string;
  hostTeacherId: string;
  attendance: Record<string, AttendanceRecord>;
  /** 本场引用的共同结论（不可变版本 id） */
  sharedConclusionIds: string[];
  /** 本场产生的个别（私有）条目 id */
  privateEntryIds: string[];
  status: 'draft' | 'finalized';
  createdAt: string;
  finalizedAt: string | null;
}

/** 共同结论的两种落地结构（实现者二选一，本工程两种都提供命令路径，不提供数据模型开关） */
export type SharedStorageMode = 'reference' | 'copy';

/** 不可变的共同结论版本；更正 = 新增版本，旧版本原样保留用于历史复现 */
export interface SharedConclusion {
  id: string;
  familyId: string;
  revision: number;
  content: string; // 样例为 80 字
  storageMode: SharedStorageMode;
  supersedesId: string | null;
  /** 记录时的授权范围（两位学生 id）；撤销共享后旧版本仍按此范围保存 */
  authorizedStudentIds: string[];
  consentIdAtCreation: string;
  createdAt: string;
}

/** 个别支持计划中的私有补充（样例每位学生 20 字），任何跨学生读取都应被拒 */
export interface PrivateEntry {
  id: string;
  studentId: string;
  minutesId: string;
  content: string;
  createdAt: string;
}

/** reference 结构：计划只保存指向不可变共同结论的引用，权限检查沿引用执行 */
export interface SharedRef {
  conclusionId: string;
  revision: number;
  pendingReview: boolean; // 更正后两份当前计划置为待核
  detached: boolean; // 一方仅保留自身支持事项后解除引用，但旧纪要与旧版本保留
}

/** copy 结构：经批准内容分别复制进两份计划，并以 pairedCopyId 建立必须共同核对的副本关系 */
export interface SharedCopy {
  id: string;
  studentId: string;
  conclusionId: string; // 来源不可变版本
  revision: number;
  content: string;
  pairedCopyId: string;
  pendingReview: boolean;
  detached: boolean;
}

export interface SupportPlan {
  studentId: string;
  sharedRefs: SharedRef[];
  copies: SharedCopy[];
  privateEntryIds: string[];
  reviewState: 'current' | 'pending_review';
}

export type MeetingNotificationKind =
  | 'invite' // 预约邀请
  | 'change' // 变更
  | 'cancel' // 取消
  | 'reschedule' // 待改期
  | 'roster' // 门岗名册
  | 'consent'; // 授权/拆分告知

export interface MeetingNotification {
  id: string;
  meetingId: string;
  sessionId: string | null;
  recipientId: string;
  recipientRole: Role | 'parent';
  kind: MeetingNotificationKind;
  version: number;
  title: string;
  body: string;
  superseded: boolean;
  createdAt: string;
}

// ---------- 事件 ----------

export type AppEvent =
  | {
      seq: number;
      at: string;
      type: 'incident.created';
      incidentId: string;
      roomIds: string[];
      faultType: FaultType;
      sourceReportId: string;
    }
  | {
      seq: number;
      at: string;
      type: 'report.submitted';
      reportId: string;
      incidentId: string;
      roomId: string;
      faultType: FaultType;
      description: string;
      photoIds: string[];
      teacherId: string;
      duplicate: boolean;
    }
  | {
      seq: number;
      at: string;
      type: 'incident.boundaryConfirmed';
      incidentId: string;
      roomIds: string[];
      sinceMin: number;
      estimatedEndMin: number;
      by: string;
    }
  | {
      seq: number;
      at: string;
      type: 'workorder.created';
      workOrderId: string;
      incidentId: string;
      summary: string;
      assignee: string;
    }
  | {
      seq: number;
      at: string;
      type: 'repair.marked';
      incidentId: string;
      by: string;
    }
  | {
      seq: number;
      at: string;
      type: 'retest.failed';
      incidentId: string;
      by: string;
      note: string;
    }
  | {
      seq: number;
      at: string;
      type: 'retest.passed';
      incidentId: string;
      by: string;
    }
  | {
      seq: number;
      at: string;
      type: 'reassignment.proposed';
      planId: string;
      strategy: 'minimal' | 'swap';
      moves: ReassignmentMove[];
      studentMinutes: number;
      notifiedClassIds: string[];
      affectedRoomIds: string[];
      by: string;
    }
  | {
      seq: number;
      at: string;
      type: 'reassignment.confirmed';
      planId: string;
      courseId: string;
      by: string;
    }
  | {
      seq: number;
      at: string;
      type: 'reassignment.published';
      planId: string;
      notificationIds: string[];
    }
  | {
      seq: number;
      at: string;
      type: 'reassignment.cancelled';
      planId: string;
      reason: string;
    }
  | {
      seq: number;
      at: string;
      type: 'notification.sent';
      notificationId: string;
      version: number;
      courseId: string;
      className: string;
      teacherId: string;
      roomId: string;
      roomName: string;
      startMin: number;
      endMin: number;
      title: string;
      body: string;
      planId: string;
      supersedesId: string | null;
    }
  // ---------- 会谈预约与接待事件 ----------
  | {
      seq: number;
      at: string;
      type: 'meeting.created';
      meetingId: string;
      familyId: string;
      parentId: string;
      mode: MeetingMode;
      sessionIds: string[];
      splitFromMeetingId: string | null;
    }
  | {
      seq: number;
      at: string;
      type: 'session.scheduled';
      sessionId: string;
      meetingId: string;
      familyId: string;
      studentIds: string[];
      joint: boolean;
      title: string;
      startMin: number;
      endMin: number;
      roomId: string;
      interpreterRequired: boolean;
      interpreterId: string | null;
      hostTeacherId: string;
      teacherIds: string[];
      parentId: string;
      rosterEntryIds: string[];
      notificationIds: string[];
    }
  | {
      seq: number;
      at: string;
      type: 'resource.booked';
      bookingId: string;
      resourceType: 'room' | 'interpreter';
      resourceId: string;
      sessionId: string;
      meetingId: string;
      startMin: number;
      endMin: number;
    }
  | {
      seq: number;
      at: string;
      type: 'resource.released';
      bookingId: string;
      reason: string;
    }
  | {
      seq: number;
      at: string;
      type: 'visitor.roster.issued';
      entries: {
        id: string;
        sessionId: string;
        personId: string | null;
        personName: string;
        personRole: 'parent' | 'interpreter' | 'teacher';
      }[];
    }
  | {
      seq: number;
      at: string;
      type: 'visitor.roster.voided';
      entryIds: string[];
      reason: string;
    }
  | {
      seq: number;
      at: string;
      type: 'meeting.notification.sent';
      notificationId: string;
      meetingId: string;
      sessionId: string | null;
      recipientId: string;
      recipientRole: Role | 'parent';
      kind: MeetingNotificationKind;
      version: number;
      title: string;
      body: string;
      supersedesId: string | null;
    }
  | {
      seq: number;
      at: string;
      type: 'consent.granted';
      consentId: string;
      familyId: string;
      studentIds: string[];
      grantedBy: string;
      studentApprovals: Record<string, boolean>;
    }
  | {
      seq: number;
      at: string;
      type: 'consent.revoked';
      consentId: string;
      reason: string;
    }
  | {
      seq: number;
      at: string;
      type: 'meeting.split';
      oldMeetingId: string;
      newMeetingId: string;
      newSessionIds: string[];
      reason: string;
    }
  | {
      seq: number;
      at: string;
      type: 'session.rescheduled';
      sessionId: string;
      oldStartMin: number;
      oldEndMin: number;
      newStartMin: number;
      newEndMin: number;
      roomId: string;
      interpreterId: string | null;
      rosterEntryIds: string[];
      notificationIds: string[];
    }
  | {
      seq: number;
      at: string;
      type: 'session.pending_reschedule';
      sessionId: string;
      reason: string;
    }
  | {
      seq: number;
      at: string;
      type: 'session.cancelled';
      sessionId: string;
      reason: string;
    }
  | {
      seq: number;
      at: string;
      type: 'interpreter.absent';
      sessionId: string;
      interpreterId: string;
    }
  | {
      seq: number;
      at: string;
      type: 'visit.checked_in';
      sessionId: string;
      personId: string;
      late: boolean;
    }
  | {
      seq: number;
      at: string;
      type: 'visit.left';
      sessionId: string;
      personId: string;
      early: boolean;
    }
  | {
      seq: number;
      at: string;
      type: 'visit.cancelled';
      sessionId: string;
      personId: string;
      reason: string;
    }
  | {
      seq: number;
      at: string;
      type: 'session.started';
      sessionId: string;
      hostTeacherId: string;
    }
  | {
      seq: number;
      at: string;
      type: 'session.ended';
      sessionId: string;
      hostTeacherId: string;
    }
  | {
      seq: number;
      at: string;
      type: 'minutes.created';
      minutesId: string;
      sessionId: string;
      meetingId: string;
      hostTeacherId: string;
      attendance: Record<string, AttendanceRecord>;
      sharedConclusionIds: string[];
      privateEntryIds: string[];
    }
  | {
      seq: number;
      at: string;
      type: 'minutes.finalized';
      minutesId: string;
    }
  | {
      seq: number;
      at: string;
      type: 'shared.conclusion.recorded';
      conclusionId: string;
      familyId: string;
      revision: number;
      content: string;
      storageMode: SharedStorageMode;
      supersedesId: string | null;
      authorizedStudentIds: string[];
      consentId: string;
      /** reference：两份计划的引用；copy：两份计划的副本（含 pairedCopyId） */
      refs: { studentId: string; conclusionId: string; revision: number }[];
      copies: {
        id: string;
        studentId: string;
        conclusionId: string;
        revision: number;
        content: string;
        pairedCopyId: string;
      }[];
    }
  | {
      seq: number;
      at: string;
      type: 'private.entry.recorded';
      entryId: string;
      studentId: string;
      minutesId: string;
      content: string;
    }
  | {
      seq: number;
      at: string;
      type: 'plan.review.cleared';
      studentId: string;
      conclusionId: string;
    }
  | {
      seq: number;
      at: string;
      type: 'plan.shared_scope.reduced';
      studentId: string;
      conclusionId: string;
      reason: string;
    };

export interface Snapshot {
  seq: number;
  rooms: Record<string, Room>;
  closures: Record<string, RoomClosure>; // roomId -> closure
  courses: Record<string, Course>;
  incidents: Record<string, Incident>;
  reports: Record<string, Report>;
  workOrders: Record<string, WorkOrder>;
  plans: Record<string, ReassignmentPlan>;
  notifications: Record<string, NotificationDoc>;
  // 会谈预约与接待
  families: Record<string, Family>;
  students: Record<string, Student>;
  interpreters: Record<string, Interpreter>;
  meetingRooms: Record<string, MeetingRoom>;
  teachings: TeacherLink[];
  meetings: Record<string, Meeting>;
  sessions: Record<string, MeetingSession>;
  bookings: Record<string, ResourceBooking>;
  visitorEntries: Record<string, VisitorEntry>;
  consents: Record<string, ConsentGrant>;
  minutes: Record<string, MeetingMinutes>;
  sharedConclusions: Record<string, SharedConclusion>;
  privateEntries: Record<string, PrivateEntry>;
  supportPlans: Record<string, SupportPlan>;
  meetingNotifications: Record<string, MeetingNotification>;
}

export interface Draft {
  id: string;
  teacherId: string;
  roomId: string;
  courseId: string | null;
  faultType: FaultType;
  description: string;
  photoIds: string[];
  status: DraftStatus;
  baseSeq: number; // 保存草稿时的事件版本，用于联网后冲突检测
  conflictReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BlobMeta {
  id: string;
  mime: string;
  size: number;
  createdAt: string;
}
