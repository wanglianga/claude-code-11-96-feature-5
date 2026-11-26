// 会谈记录访问控制（纯函数，worker 与测试共用）
// 核心规则：
// 1. 教师只可读自己所教学生的记录；不教即整份计划拒绝。
// 2. 未授权的兄弟姐妹内容不得因同一家庭预约而互相可见：
//    私有条目严格按学生隔离；共同内容必须沿引用/副本核对授权学生范围。
// 3. 一方仅保留自身支持事项（detached）后，其计划不再暴露该共同结论；
//    不可变旧结论与旧纪要仍保留，但读取当前计划时不可见。

import type {
  PrivateEntry,
  SharedConclusion,
  SharedCopy,
  SharedRef,
  Snapshot,
  SupportPlan,
} from '../types';

/** 教师任教的学生 id 集合 */
export function studentsTaughtBy(snap: Snapshot, teacherId: string): Set<string> {
  return new Set(snap.teachings.filter((t) => t.teacherId === teacherId).map((t) => t.studentId));
}

/** 教某学生的全部教师 */
export function teachersOfStudent(snap: Snapshot, studentId: string): string[] {
  return snap.teachings.filter((t) => t.studentId === studentId).map((t) => t.teacherId);
}

export function canTeacherReadStudent(snap: Snapshot, teacherId: string, studentId: string): boolean {
  return studentsTaughtBy(snap, teacherId).has(studentId);
}

function assertTeaches(snap: Snapshot, teacherId: string, studentId: string): void {
  if (!canTeacherReadStudent(snap, teacherId, studentId)) {
    const student = snap.students[studentId];
    throw new Error(
      `访问被拒：教师 ${teacherId} 不任教${student ? `学生 ${student.name}` : `学生 ${studentId}`}，无权读取其记录`,
    );
  }
}

/** 共同结论是否在该学生的当前授权范围内（沿引用执行权限检查） */
export function conclusionVisibleToStudent(
  snap: Snapshot,
  conclusion: SharedConclusion,
  studentId: string,
): boolean {
  return conclusion.authorizedStudentIds.includes(studentId);
}

function activeRefs(plan: SupportPlan): SharedRef[] {
  return plan.sharedRefs.filter((r) => !r.detached);
}

function activeCopies(plan: SupportPlan): SharedCopy[] {
  return plan.copies.filter((c) => !c.detached);
}

/** 教师视角下某学生当前计划的可读视图；不任教直接拒绝 */
export interface ReadablePlanView {
  studentId: string;
  reviewState: SupportPlan['reviewState'];
  sharedRefs: SharedRef[];
  copies: SharedCopy[];
  sharedConclusions: SharedConclusion[];
  privateEntries: PrivateEntry[];
}

export function readStudentPlan(
  snap: Snapshot,
  studentId: string,
  teacherId: string,
): ReadablePlanView {
  assertTeaches(snap, teacherId, studentId);
  const plan = snap.supportPlans[studentId];
  if (!plan) {
    return {
      studentId,
      reviewState: 'current',
      sharedRefs: [],
      copies: [],
      sharedConclusions: [],
      privateEntries: [],
    };
  }

  const refs = activeRefs(plan);
  const copies = activeCopies(plan);

  // 沿引用执行权限检查：只暴露授权范围包含该学生、且当前仍有效的结论
  const sharedConclusions: SharedConclusion[] = [];
  for (const ref of refs) {
    const c = snap.sharedConclusions[ref.conclusionId];
    if (c && conclusionVisibleToStudent(snap, c, studentId)) sharedConclusions.push(c);
  }
  for (const copy of copies) {
    const c = snap.sharedConclusions[copy.conclusionId];
    if (c && conclusionVisibleToStudent(snap, c, studentId) && !sharedConclusions.includes(c)) {
      sharedConclusions.push(c);
    }
  }

  // 私有条目只可能是该学生本人的；计划里绝不混入兄弟姐妹的私有条目
  const privateEntries = plan.privateEntryIds
    .map((id) => snap.privateEntries[id])
    .filter((e): e is PrivateEntry => Boolean(e) && e.studentId === studentId);

  return {
    studentId,
    reviewState: plan.reviewState,
    sharedRefs: refs,
    copies,
    sharedConclusions,
    privateEntries,
  };
}

/** 读取单条私有补充：任何不任教该学生的教师都被拒（含同家庭兄弟姐妹的教师） */
export function readPrivateEntry(
  snap: Snapshot,
  entryId: string,
  teacherId: string,
): PrivateEntry {
  const entry = snap.privateEntries[entryId];
  if (!entry) throw new Error(`私有记录不存在：${entryId}`);
  assertTeaches(snap, teacherId, entry.studentId);
  return entry;
}

/**
 * 跨学生越权探测：教师试图读取另一学生计划时必须失败。
 * 返回拒绝原因，供 UI/测试断言；允许时返回 null。
 */
export function denyReasonForStudent(
  snap: Snapshot,
  teacherId: string,
  studentId: string,
): string | null {
  return canTeacherReadStudent(snap, teacherId, studentId)
    ? null
    : `教师 ${teacherId} 与学生 ${studentId} 无任教关系，记录不可见`;
}
