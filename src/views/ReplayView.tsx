import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../state/store';
import { Badge, Button, Card } from '../components/ui';
import type { AppEvent } from '../types';
import { workerClient } from '../worker/client';
import { minToHM } from '../lib/time';

const EVENT_TEXT: Record<AppEvent['type'], (e: AppEvent) => string> = {
  'incident.created': (e) => e.type === 'incident.created' ? `新建事故，故障类型 ${e.faultType}，首报房间 ${e.roomIds.join(',')}` : '',
  'report.submitted': (e) => e.type === 'report.submitted' ? `收到报修（${e.duplicate ? '重复·合并' : '首报'}）：房间 ${e.roomId}，照片 ${e.photoIds.length} 张` : '',
  'incident.boundaryConfirmed': (e) => e.type === 'incident.boundaryConfirmed' ? `设施核准边界 [${e.roomIds.join('、')}]，预计 ${minToHM(e.estimatedEndMin)} 修复，房间封闭` : '',
  'workorder.created': (e) => e.type === 'workorder.created' ? `生成工单 ${e.workOrderId.slice(-6)}，负责人 ${e.assignee}` : '',
  'repair.marked': () => '维修人员标记“已修复”，等待设施复测（封闭未解除）',
  'retest.failed': (e) => e.type === 'retest.failed' ? `复测失败：${e.note}（维持封闭，安排不回滚）` : '',
  'retest.passed': () => '设施复测通过，解除封闭，房间恢复使用',
  'reassignment.proposed': (e) => e.type === 'reassignment.proposed' ? `调度生成${e.strategy === 'minimal' ? '方案一（仅移动受影响课程）' : '方案二（弹性换房）'}，${e.studentMinutes} 学生分钟，涉及 ${e.moves.length} 个班` : '',
  'reassignment.confirmed': (e) => e.type === 'reassignment.confirmed' ? `教师确认改排：课程 ${e.courseId}` : '',
  'reassignment.published': (e) => e.type === 'reassignment.published' ? `方案 ${e.planId.slice(-6)} 发布，发出 ${e.notificationIds.length} 条同版本通知` : '',
  'reassignment.cancelled': (e) => e.type === 'reassignment.cancelled' ? `方案取消：${e.reason}` : '',
  'notification.sent': (e) => e.type === 'notification.sent' ? `通知 v${e.version} 发给 ${e.className}：改至 ${e.roomName}（${e.supersedesId ? '旧版本已作废' : '首版'}）` : '',
  'meeting.created': (e) => e.type === 'meeting.created' ? `创建${e.mode === 'joint' ? '联合' : '分开'}会谈 ${e.meetingId.slice(-6)}，含 ${e.sessionIds.length} 场${e.splitFromMeetingId ? '（由撤回同意拆分而来）' : ''}` : '',
  'session.scheduled': (e) => e.type === 'session.scheduled' ? `排定${e.joint ? '联合' : '个别'}场次「${e.title}」${minToHM(e.startMin)}-${minToHM(e.endMin)}，房间/口译已占用、名册 ${e.rosterEntryIds.length} 人` : '',
  'resource.booked': (e) => e.type === 'resource.booked' ? `占用${e.resourceType === 'room' ? '接待室' : '口译员'} ${e.resourceId}（${minToHM(e.startMin)}-${minToHM(e.endMin)}）` : '',
  'resource.released': (e) => e.type === 'resource.released' ? `释放资源 ${e.bookingId.slice(-6)}：${e.reason}` : '',
  'visitor.roster.issued': (e) => e.type === 'visitor.roster.issued' ? `签发门岗名册 ${e.entries.length} 条（${e.entries.map((x) => x.personName).join('、')}）` : '',
  'visitor.roster.voided': (e) => e.type === 'visitor.roster.voided' ? `旧访客名册 ${e.entryIds.length} 条立即失效：${e.reason}` : '',
  'meeting.notification.sent': (e) => e.type === 'meeting.notification.sent' ? `会谈通知 v${e.version} 致 ${e.recipientId}（${e.kind}）${e.supersedesId ? '，旧版作废' : ''}` : '',
  'consent.granted': (e) => e.type === 'consent.granted' ? `家长与两位学生授予共同议题共享同意 ${e.consentId.slice(-6)}` : '',
  'consent.revoked': (e) => e.type === 'consent.revoked' ? `撤回共同议题同意：${e.reason}；后续会谈立即拆分，旧纪要按原授权保留` : '',
  'meeting.split': (e) => e.type === 'meeting.split' ? `会谈拆分：${e.oldMeetingId.slice(-6)} → 新会谈 ${e.newMeetingId.slice(-6)}，新个别场 ${e.newSessionIds.length} 场` : '',
  'session.rescheduled': (e) => e.type === 'session.rescheduled' ? `场次改期 ${minToHM(e.oldStartMin)} → ${minToHM(e.newStartMin)}，重新占用资源并签发新名册` : '',
  'session.pending_reschedule': (e) => e.type === 'session.pending_reschedule' ? `场次转为待改期：${e.reason}（资源已释放、旧名册失效）` : '',
  'session.cancelled': (e) => e.type === 'session.cancelled' ? `场次取消：${e.reason}` : '',
  'interpreter.absent': (e) => e.type === 'interpreter.absent' ? `口译员 ${e.interpreterId} 临时缺席` : '',
  'visit.checked_in': (e) => e.type === 'visit.checked_in' ? `访客签到 ${e.personId}${e.late ? '（迟到回执，不等于会议完成）' : ''}` : '',
  'visit.left': (e) => e.type === 'visit.left' ? `访客离场 ${e.personId}${e.early ? '（提前离场，不自动关闭另一场）' : ''}` : '',
  'visit.cancelled': (e) => e.type === 'visit.cancelled' ? `取消到访 ${e.personId}：${e.reason}（回执不等于会议完成）` : '',
  'session.started': (e) => e.type === 'session.started' ? `主持人 ${e.hostTeacherId} 开始场次` : '',
  'session.ended': (e) => e.type === 'session.ended' ? `主持人 ${e.hostTeacherId} 记录结束，场次关闭` : '',
  'minutes.created': (e) => e.type === 'minutes.created' ? `创建纪要 ${e.minutesId.slice(-6)}：参加 ${Object.keys(e.attendance).length} 人，共同结论 ${e.sharedConclusionIds.length} 条、个别记录 ${e.privateEntryIds.length} 条` : '',
  'minutes.finalized': (e) => e.type === 'minutes.finalized' ? `纪要 ${e.minutesId.slice(-6)} 定稿` : '',
  'shared.conclusion.recorded': (e) => e.type === 'shared.conclusion.recorded' ? `记录共同结论 rev${e.revision}（${e.storageMode === 'reference' ? '引用结构·1 份' : '复制结构·2 份'}，${e.content.length} 字）${e.supersedesId ? '，两份当前计划置待核' : ''}` : '',
  'private.entry.recorded': (e) => e.type === 'private.entry.recorded' ? `写入学生 ${e.studentId} 的私有补充（${e.content.length} 字），跨学生不可见` : '',
  'plan.review.cleared': (e) => e.type === 'plan.review.cleared' ? `学生 ${e.studentId} 的计划核对完成，清除待核（结论 ${e.conclusionId.slice(-6)}）` : '',
  'plan.shared_scope.reduced': (e) => e.type === 'plan.shared_scope.reduced' ? `学生 ${e.studentId} 仅保留自身支持事项，解除共同结论 ${e.conclusionId.slice(-6)} 的引用/副本：${e.reason}` : '',
};

export function ReplayView() {
  const app = useApp();
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [seq, setSeq] = useState<number>(0);

  useEffect(() => {
    let alive = true;
    void workerClient.listEvents().then((list) => {
      if (!alive) return;
      setEvents(list);
      const max = list.length ? list[list.length - 1].seq : 0;
      // 处于历史回放时保留滑块位置；回到最新视图时同步到最大 seq
      setSeq((prev) => (app.replaySeq === null ? max : Math.min(prev, max)));
    });
    return () => {
      alive = false;
    };
  }, [app.snapshot.seq, app.replaySeq]);

  const maxSeq = events.length ? events[events.length - 1].seq : 0;
  const visible = useMemo(() => events.filter((e) => e.seq <= seq), [events, seq]);

  return (
    <div>
      <Card title="事件日志与本地回放（IndexedDB 只追加事件流）">
        <div className="row-gap" style={{ marginBottom: 10 }}>
          <input
            type="range"
            min={0}
            max={maxSeq}
            value={seq}
            onChange={(e) => {
              const v = Number(e.target.value);
              setSeq(v);
              void app.replayAt(v === maxSeq ? null : v);
            }}
            style={{ flex: 1 }}
          />
          <span className="mono">回放至 seq #{seq} / {maxSeq}</span>
          <Button onClick={() => { setSeq(maxSeq); void app.replayAt(null); }}>回到最新</Button>
          <Button tone="danger" onClick={() => { if (confirm('确认清空全部事件、草稿与照片并重置演示？')) void app.resetAll(); }}>
            重置演示数据
          </Button>
        </div>
        {app.replaySeq !== null && (
          <div className="banner banner-warn">
            正在浏览历史快照（seq #{app.replaySeq}），各工作台显示的是当时状态；点击“回到最新”恢复实时视图。
          </div>
        )}
        {events.length === 0 && <p className="empty">暂无事件</p>}
        <ol className="timeline">
          {visible.map((e) => (
            <li key={e.seq}>
              <span className="seq">#{e.seq}</span>
              <Badge tone="neutral">{e.type}</Badge>
              <span className="at">{e.at.replace('T', ' ').slice(0, 16)}</span>
              <div className="desc">{EVENT_TEXT[e.type](e)}</div>
            </li>
          ))}
        </ol>
      </Card>

      <Card title="当前快照核查（随回放位置变化）">
        <ul>
          <li>事件总数（当前视图）：{visible.length} ／ 全量 {events.length}</li>
          <li>封闭房间：{Object.entries(app.snapshot.closures).filter(([, c]) => c.closed).map(([r]) => app.snapshot.rooms[r]?.name).join('、') || '无'}</li>
          <li>事故数：{Object.keys(app.snapshot.incidents).length}；工单数：{Object.keys(app.snapshot.workOrders).length}</li>
          <li>已发布方案：{Object.values(app.snapshot.plans).filter((p) => p.status === 'published').length}；通知数：{Object.keys(app.snapshot.notifications).length}</li>
        </ul>
      </Card>
    </div>
  );
}
