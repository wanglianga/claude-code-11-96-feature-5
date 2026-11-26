import type {
  FaultType,
  IncidentStatus,
  InterpreterServiceStatus,
  MeetingStatus,
  MinutesStatus,
  PlanStatus,
  SessionStatus,
  CheckInStatus,
} from '../types';

export const FAULT_LABELS: Record<FaultType, string> = {
  leak: '漏水',
  power: '断电',
  equipment: '设备故障',
};

export const INCIDENT_STATUS_LABELS: Record<IncidentStatus, string> = {
  reported: '待核准',
  confirmed: '已核准/封闭中',
  work_order: '维修中',
  repaired: '待复测',
  verified: '复测通过/已解封',
};

export const PLAN_STATUS_LABELS: Record<PlanStatus, string> = {
  proposed: '待教师确认',
  published: '已发布',
  cancelled: '已取消',
};

export const EQUIPMENT_LABELS: Record<string, string> = {
  projector: '投影',
  lab_bench: '实验台',
  accessible: '无障碍入口',
};

export function reqLabel(req: string): string {
  return EQUIPMENT_LABELS[req] ?? req;
}

// ---------- 会谈预约标签 ----------

export const MEETING_STATUS_LABELS: Record<MeetingStatus, string> = {
  scheduled: '已预约',
  in_progress: '进行中',
  completed: '已完成',
  cancelled: '已取消',
  reschedule_pending: '待改期',
};

export const SESSION_STATUS_LABELS: Record<SessionStatus, string> = {
  scheduled: '已排期',
  in_progress: '进行中',
  completed: '已结束',
  cancelled: '已取消',
  reschedule_pending: '待改期',
};

export const CHECKIN_STATUS_LABELS: Record<CheckInStatus, string> = {
  none: '未签到',
  checked_in: '已签到',
  left: '已离场',
  cancelled: '已取消到访',
};

export const INTERPRETER_SERVICE_LABELS: Record<InterpreterServiceStatus, string> = {
  not_required: '无需口译',
  booked: '已预订',
  in_service: '服务中',
  absent: '临时缺席',
  released: '已释放',
};

export const MINUTES_STATUS_LABELS: Record<MinutesStatus, string> = {
  none: '尚无纪要',
  draft: '纪要草稿',
  finalized: '纪要已定稿',
};
