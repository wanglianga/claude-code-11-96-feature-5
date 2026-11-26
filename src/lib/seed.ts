import type {
  Course,
  Family,
  Interpreter,
  MeetingRoom,
  Room,
  Student,
  TeacherLink,
  User,
} from '../types';
import { hmToMin } from './time';

// ---------- 用户（测试账号） ----------
export const SEED_USERS: User[] = [
  { id: 'u_teacher_a', name: '林老师（A 班·班主任）', role: 'teacher' },
  { id: 'u_teacher_b', name: '周老师（B 班·数学教师）', role: 'teacher' },
  { id: 'u_teacher_s', name: '苏老师（S 研讨·只教王小明）', role: 'teacher' },
  { id: 'u_facility', name: '王设施（设施人员）', role: 'facility' },
  { id: 'u_dispatch', name: '陈调度（调度员）', role: 'dispatcher' },
  { id: 'u_repair', name: '赵维修（维修人员）', role: 'repair' },
  { id: 'u_coordinator', name: '何协调（接待协调员）', role: 'coordinator' },
  { id: 'u_guard', name: '马门岗（门岗值班）', role: 'guard' },
  { id: 'u_interpreter', name: '艾口译（口译员）', role: 'interpreter' },
];

// ---------- 教室资源 ----------
export const SEED_ROOMS: Room[] = [
  {
    id: 'r_B201',
    code: 'B-B201',
    name: 'B201',
    capacity: 30,
    equipment: ['projector'],
    accessible: true,
    safety: true,
  },
  {
    id: 'r_B202',
    code: 'B-B202',
    name: 'B202',
    capacity: 26,
    equipment: ['lab_bench', 'projector'],
    accessible: true,
    safety: true,
  },
  {
    id: 'r_C101',
    code: 'C-C101',
    name: 'C101',
    capacity: 30,
    equipment: ['projector'],
    accessible: true,
    safety: true,
  },
  {
    id: 'r_C102',
    code: 'C-C102',
    name: 'C102',
    capacity: 24,
    equipment: ['lab_bench'],
    accessible: true,
    safety: true,
  },
  {
    id: 'r_D301',
    code: 'D-D301',
    name: 'D301',
    capacity: 20,
    equipment: ['lab_bench'],
    accessible: false,
    safety: true,
  },
];

// ---------- 步行距离矩阵（分钟，对称，0 表示同房间） ----------
// 题目给定：C101 距 B201 = 8；C102 距 B202 = 18；D301 距 B202 = 7；C102 距 D301 = 7
export const DISTANCE: Record<string, Record<string, number>> = {
  r_B201: { r_B201: 0, r_B202: 2, r_C101: 8, r_C102: 14, r_D301: 12 },
  r_B202: { r_B201: 2, r_B202: 0, r_C101: 10, r_C102: 18, r_D301: 7 },
  r_C101: { r_B201: 8, r_B202: 10, r_C101: 0, r_C102: 6, r_D301: 11 },
  r_C102: { r_B201: 14, r_B202: 18, r_C101: 6, r_C102: 0, r_D301: 7 },
  r_D301: { r_B201: 12, r_B202: 7, r_C101: 11, r_C102: 7, r_D301: 0 },
};

// ---------- 当天课程 ----------
// A 班 10:00-11:00，24 人，需投影+无障碍入口，原 B201
// B 班 10:15-11:15，18 人，需实验台，原 B202
// S 弹性研讨 10:15-11:15，12 人，需实验台，原 D301，可换房
export const SEED_COURSES: Course[] = [
  {
    id: 'c_A',
    className: 'A 班',
    teacherId: 'u_teacher_a',
    roomId: 'r_B201',
    originalRoomId: 'r_B201',
    startMin: hmToMin('10:00'),
    endMin: hmToMin('11:00'),
    size: 24,
    requirements: ['projector', 'accessible'],
    flexible: false,
    status: 'normal',
    planId: null,
  },
  {
    id: 'c_B',
    className: 'B 班',
    teacherId: 'u_teacher_b',
    roomId: 'r_B202',
    originalRoomId: 'r_B202',
    startMin: hmToMin('10:15'),
    endMin: hmToMin('11:15'),
    size: 18,
    requirements: ['lab_bench'],
    flexible: false,
    status: 'normal',
    planId: null,
  },
  {
    id: 'c_S',
    className: 'S 研讨课',
    teacherId: 'u_teacher_s',
    roomId: 'r_D301',
    originalRoomId: 'r_D301',
    startMin: hmToMin('10:15'),
    endMin: hmToMin('11:15'),
    size: 12,
    requirements: ['lab_bench'],
    flexible: true,
    status: 'normal',
    planId: null,
  },
  // 一节午后课，用于验证 14:00 复测通过后房间恢复
  {
    id: 'c_P',
    className: 'P 班午后课',
    teacherId: 'u_teacher_a',
    roomId: 'r_B201',
    originalRoomId: 'r_B201',
    startMin: hmToMin('14:00'),
    endMin: hmToMin('15:00'),
    size: 20,
    requirements: ['projector'],
    flexible: false,
    status: 'normal',
    planId: null,
  },
];

export function roomById(id: string, rooms: Room[]): Room {
  const r = rooms.find((x) => x.id === id);
  if (!r) throw new Error(`未知教室: ${id}`);
  return r;
}

// ==================================================================
// 家长会谈预约种子（feature-5）
// 题目窗口：家长 15:00-16:30；口译员 15:30-16:30；
// 班主任与数学教师 15:30-16:10；接待室整段可用；每位学生 20 分钟
// ==================================================================

export const SEED_FAMILIES: Family[] = [
  {
    id: 'fam_wang',
    name: '王姓家庭',
    parentId: 'p_wang',
    parentName: '王家长',
    studentIds: ['stu_ming', 'stu_hua'],
    needsInterpreter: true,
    availableStartMin: hmToMin('15:00'),
    availableEndMin: hmToMin('16:30'),
  },
];

export const SEED_STUDENTS: Student[] = [
  { id: 'stu_ming', name: '王小明', familyId: 'fam_wang', homeroomTeacherId: 'u_teacher_a' },
  { id: 'stu_hua', name: '王小华', familyId: 'fam_wang', homeroomTeacherId: 'u_teacher_a' },
];

/** 任教关系：教师只可读自己所教学生的记录（苏老师只教王小明，用于验证越权拒绝） */
export const SEED_TEACHINGS: TeacherLink[] = [
  { teacherId: 'u_teacher_a', studentId: 'stu_ming', subject: 'homeroom' },
  { teacherId: 'u_teacher_a', studentId: 'stu_hua', subject: 'homeroom' },
  { teacherId: 'u_teacher_b', studentId: 'stu_ming', subject: 'math' },
  { teacherId: 'u_teacher_b', studentId: 'stu_hua', subject: 'math' },
  { teacherId: 'u_teacher_s', studentId: 'stu_ming', subject: 'seminar' },
];

export const SEED_INTERPRETERS: Interpreter[] = [
  { id: 'int_ai', name: '艾口译', startMin: hmToMin('15:30'), endMin: hmToMin('16:30') },
];

export const SEED_MEETING_ROOMS: MeetingRoom[] = [
  {
    id: 'mr_reception',
    name: '行政楼一层接待室',
    startMin: hmToMin('15:00'),
    endMin: hmToMin('16:30'),
  },
];

/** 题目给定的会谈时间常量（分钟），供可行性引擎与 UI 共用 */
export const MEETING_WINDOW = {
  parentStart: hmToMin('15:00'),
  parentEnd: hmToMin('16:30'),
  interpreterStart: hmToMin('15:30'),
  interpreterEnd: hmToMin('16:30'),
  teacherStart: hmToMin('15:30'),
  teacherEnd: hmToMin('16:10'),
  perStudentMin: 20,
  jointStart: hmToMin('15:30'),
  jointEnd: hmToMin('16:10'),
  splitAStart: hmToMin('15:30'),
  splitAEnd: hmToMin('15:50'),
  splitBStart: hmToMin('15:50'),
  splitBEnd: hmToMin('16:10'),
};
