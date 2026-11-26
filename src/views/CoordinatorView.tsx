import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../state/store';
import { Badge, Button, Card, Empty, KeyVal } from '../components/ui';
import {
  CHECKIN_STATUS_LABELS,
  INTERPRETER_SERVICE_LABELS,
  MEETING_STATUS_LABELS,
  MINUTES_STATUS_LABELS,
  SESSION_STATUS_LABELS,
} from '../lib/labels';
import { minToHM } from '../lib/time';
import { workerClient } from '../worker/client';
import type { MeetingOption } from '../engine/meeting';
import {
  bookMeeting,
  cancelSession,
  changeSession,
  grantConsent,
  markInterpreterAbsent,
  reduceSharedScope,
  revokeConsentAndSplit,
} from '../engine/meetingCommands';

const FAMILY = 'fam_wang';

export function CoordinatorView() {
  const app = useApp();
  const { snapshot, nowMin } = app;
  const [options, setOptions] = useState<{ joint: MeetingOption; separate: MeetingOption } | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad' | 'warn'; text: string } | null>(null);
  const [approveMing, setApproveMing] = useState(true);
  const [approveHua, setApproveHua] = useState(true);

  useEffect(() => {
    let alive = true;
    void workerClient.meetingOptions(FAMILY).then((o) => {
      if (alive) setOptions(o);
    });
    return () => {
      alive = false;
    };
  }, [snapshot.seq]);

  const family = snapshot.families[FAMILY];
  const consent = useMemo(
    () => Object.values(snapshot.consents).find((c) => c.familyId === FAMILY && c.granted) ?? null,
    [snapshot.consents],
  );
  const meetings = useMemo(
    () => Object.values(snapshot.meetings).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [snapshot.meetings],
  );

  async function run(fn: Parameters<typeof app.dispatch>[0], ok: string) {
    setMsg(null);
    try {
      await app.dispatch(fn);
      setMsg({ tone: 'ok', text: ok });
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    }
  }

  return (
    <div>
      {msg && <div className={`banner banner-${msg.tone}`}>{msg.text}</div>}
      <div className="banner banner-info">
        共同议题与个别记录<b>分别建模</b>：联合会谈只有在家长与两位学生都明确同意共享议题后才可行；
        联合或分场都是家长可选功能。任何会议变更都会同步释放口译员、接待室并作废旧门岗名册。
      </div>

      <Card title="① 共同议题共享授权（联合场前置条件，可随时撤回）">
        <KeyVal
          pairs={[
            ['当前授权', consent ? <Badge tone="ok">生效中（家长 + 两位学生均同意）</Badge> : <Badge tone="warn">未授权</Badge>],
            ['王小明同意', <input type="checkbox" checked={approveMing} onChange={(e) => setApproveMing(e.target.checked)} />],
            ['王小华同意', <input type="checkbox" checked={approveHua} onChange={(e) => setApproveHua(e.target.checked)} />],
          ]}
        />
        <div className="row-gap" style={{ marginTop: 10 }}>
          <Button
            tone="primary"
            disabled={Boolean(consent)}
            onClick={() =>
              void run(
                (snap) =>
                  grantConsent(snap, {
                    familyId: FAMILY,
                    grantedBy: family.parentId,
                    studentApprovals: { stu_ming: approveMing, stu_hua: approveHua },
                    atMin: nowMin,
                  }),
                '已记录家长与两位学生的共享同意，联合场已可预约',
              )
            }
          >
            记录共享同意
          </Button>
          <Button
            tone="danger"
            disabled={!consent}
            onClick={() =>
              void run(
                (snap) => revokeConsentAndSplit(snap, { familyId: FAMILY, reason: '家长撤回共同议题同意', atMin: nowMin }),
                '已撤回同意：后续会谈立即拆分为个别场，旧纪要按原授权范围保存',
              )
            }
          >
            撤回同意并立即拆分后续会谈
          </Button>
        </div>
        <p className="muted" style={{ fontSize: 12.5, marginBottom: 0 }}>
          撤回后原联合场取消、资源释放、旧名册失效；系统自动新建两场 20 分钟个别会谈，旧纪要与私有补充不删除。
        </p>
      </Card>

      {options && (
        <Card title="② 联合 vs 分开：可行性、参会人与通知差别">
          <div className="grid-2">
            <OptionPanel
              title="联合一场（15:30-16:10，40 分钟）"
              subtitle="少一次往返；须共享同意，只讨论授权共同事项"
              option={options.joint}
              disabled={!consent}
              onBook={() =>
                void run(
                  (snap) => bookMeeting(snap, { familyId: FAMILY, mode: 'joint', atMin: nowMin, by: 'u_coordinator' }),
                  '联合会谈已预约：接待室/口译已占用，门岗名册与通知已发出',
                )
              }
            />
            <OptionPanel
              title="分开两场（15:30-15:50 / 15:50-16:10）"
              subtitle="信息边界清楚；教师分别确认、家长切换议题"
              option={options.separate}
              disabled={false}
              onBook={() =>
                void run(
                  (snap) => bookMeeting(snap, { familyId: FAMILY, mode: 'separate', atMin: nowMin, by: 'u_coordinator' }),
                  '两场个别会谈已预约：分别占用资源、各自签发名册与通知',
                )
              }
            />
          </div>
        </Card>
      )}

      <Card title="③ 会谈与场次（访客签到 / 口译服务 / 纪要 三状态独立）">
        {meetings.length === 0 && <Empty text="暂无预约" />}
        {meetings.map((m) => (
          <div key={m.id} className="plan-card" style={{ marginBottom: 14 }}>
            <h4>
              会谈 {m.id.slice(-6)}（{m.mode === 'joint' ? '联合' : '分开'}）
              <Badge tone={m.status === 'completed' ? 'ok' : m.status === 'reschedule_pending' ? 'bad' : 'warn'}>
                {MEETING_STATUS_LABELS[m.status]}
              </Badge>
              {m.splitFromMeetingId && <Badge tone="info">由会谈 {m.splitFromMeetingId.slice(-6)} 拆分</Badge>}
            </h4>
            <table>
              <thead>
                <tr><th>场次</th><th>时间</th><th>学生/教师</th><th>访客签到</th><th>口译服务</th><th>纪要</th><th>协调操作</th></tr>
              </thead>
              <tbody>
                {m.sessionIds.map((sid) => {
                  const s = snapshot.sessions[sid];
                  if (!s) return null;
                  return (
                    <tr key={sid}>
                      <td>
                        {s.title}
                        <div className="muted">{s.joint ? '联合场' : '个别场'}</div>
                      </td>
                      <td className="mono">{minToHM(s.startMin)}-{minToHM(s.endMin)}</td>
                      <td>
                        学生：{s.studentIds.map((x) => snapshot.students[x]?.name ?? x).join('、')}
                        <div className="muted">教师 {s.teacherIds.length} 位 ｜ 主持人 {s.hostTeacherId.slice(-4)}</div>
                      </td>
                      <td><Badge tone="neutral">{CHECKIN_STATUS_LABELS[s.checkInStatus]}</Badge></td>
                      <td>
                        <Badge tone={s.interpreterServiceStatus === 'absent' ? 'bad' : s.interpreterServiceStatus === 'in_service' ? 'ok' : 'info'}>
                          {INTERPRETER_SERVICE_LABELS[s.interpreterServiceStatus]}
                        </Badge>
                      </td>
                      <td><Badge tone={s.minutesStatus === 'finalized' ? 'ok' : 'neutral'}>{MINUTES_STATUS_LABELS[s.minutesStatus]}</Badge></td>
                      <td>
                        <div className="row-gap">
                          <RescheduleControl
                            disabled={s.status === 'completed' || s.status === 'cancelled'}
                            onApply={(startMin, endMin) =>
                              void run(
                                (snap) =>
                                  changeSession(snap, {
                                    sessionId: sid,
                                    newStartMin: startMin,
                                    newEndMin: endMin,
                                    atMin: nowMin,
                                    reason: '协调员改期',
                                  }),
                                '场次已改期：旧资源释放、旧名册失效、新名册与通知已重建',
                              )
                            }
                          />
                          <Button
                            tone="danger"
                            className="btn-sm"
                            disabled={s.status === 'completed' || s.status === 'cancelled'}
                            onClick={() =>
                              void run(
                                (snap) => cancelSession(snap, { sessionId: sid, reason: '协调员取消', atMin: nowMin }),
                                '场次已取消，资源释放、名册失效',
                              )
                            }
                          >
                            取消
                          </Button>
                          <Button
                            tone="danger"
                            className="btn-sm"
                            disabled={!s.interpreterRequired || s.status === 'completed' || s.status === 'reschedule_pending'}
                            onClick={() =>
                              void run(
                                (snap) =>
                                  markInterpreterAbsent(snap, {
                                    meetingId: m.id,
                                    atMin: nowMin,
                                    reason: '口译员临时缺席，转为待改期',
                                  }),
                                '口译员缺席：相关场次转待改期，资源释放、旧名册立即失效',
                              )
                            }
                          >
                            口译缺席
                          </Button>
                        </div>
                        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{SESSION_STATUS_LABELS[s.status]}</div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
      </Card>

      <SupportPlanGovernance />
    </div>
  );
}

function minToMin(hm: string): number {
  const [h, mm] = hm.split(':').map(Number);
  return h * 60 + mm;
}

function RescheduleControl({
  disabled,
  onApply,
}: {
  disabled: boolean;
  onApply: (startMin: number, endMin: number) => void;
}) {
  // 默认改到教师 15:30-16:10 窗口内的 20 分钟空档；超出窗口/口译窗口时引擎会拒绝
  const [start, setStart] = useState('15:30');
  const [end, setEnd] = useState('15:50');
  return (
    <span className="row-gap">
      <input
        type="time"
        value={start}
        disabled={disabled}
        onChange={(e) => setStart(e.target.value)}
        style={{ width: 92 }}
        aria-label="改期开始时间"
      />
      <span className="muted">至</span>
      <input
        type="time"
        value={end}
        disabled={disabled}
        onChange={(e) => setEnd(e.target.value)}
        style={{ width: 92 }}
        aria-label="改期结束时间"
      />
      <Button
        className="btn-sm"
        disabled={disabled}
        onClick={() => onApply(minToMin(start), minToMin(end))}
      >
        改期
      </Button>
    </span>
  );
}

function OptionPanel({
  title,
  subtitle,
  option,
  disabled,
  onBook,
}: {
  title: string;
  subtitle: string;
  option: MeetingOption;
  disabled: boolean;
  onBook: () => void;
}) {
  return (
    <div className={`plan-card ${option.feasible ? 'recommended' : ''}`}>
      <h4>{title}{option.feasible ? <Badge tone="ok">可行</Badge> : <Badge tone="bad">不可行</Badge>}</h4>
      <p className="muted" style={{ marginTop: 0 }}>{subtitle}</p>
      {!option.feasible && (
        <ul className="reason-list">
          {option.reasons.map((r, i) => <li key={i}>{r}</li>)}
        </ul>
      )}
      <table>
        <tbody>
          <tr><td>场次数</td><td>{option.sessions.length}（{option.sessions.map((s) => `${minToHM(s.startMin)}-${minToHM(s.endMin)}`).join('，')}）</td></tr>
          <tr><td>参会教师（去重）</td><td>{option.attendees.teachers.length} 位</td></tr>
          <tr><td>教师确认次数</td><td className="mono">{option.notifications.teacherConfirmCount}</td></tr>
          <tr><td>家长通知 / 名册批次</td><td className="mono">{option.notifications.parentNoticeCount} / {option.notifications.rosterCount}</td></tr>
          <tr><td>家长往返/议题切换</td><td className="mono">{option.trips}</td></tr>
        </tbody>
      </table>
      <Button tone="primary" disabled={disabled || !option.feasible} onClick={onBook}>
        {disabled ? '需先取得共享同意' : '按此方案预约'}
      </Button>
    </div>
  );
}

function SupportPlanGovernance() {
  const app = useApp();
  const { snapshot, nowMin } = app;
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  const conclusions = Object.values(snapshot.sharedConclusions).sort((a, b) => b.revision - a.revision);

  async function run(fn: Parameters<typeof app.dispatch>[0], ok: string) {
    setMsg(null);
    try {
      await app.dispatch(fn);
      setMsg({ tone: 'ok', text: ok });
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    }
  }

  return (
    <Card title="④ 学生支持计划与共同结论治理（逐学生隔离）">
      {msg && <div className={`banner banner-${msg.tone}`}>{msg.text}</div>}
      {Object.keys(snapshot.supportPlans).length === 0 && <Empty text="尚无支持计划（会议结束并记录结论后生成）" />}
      <table>
        <thead><tr><th>学生</th><th>计划核对状态</th><th>共同引用</th><th>共同副本</th><th>私有补充</th><th>授权收窄</th></tr></thead>
        <tbody>
          {Object.values(snapshot.supportPlans).map((plan) => {
            const student = snapshot.students[plan.studentId];
            const activeRef = plan.sharedRefs.find((r) => !r.detached);
            const activeCopy = plan.copies.find((c) => !c.detached);
            const conclusionId = activeRef?.conclusionId ?? activeCopy?.conclusionId ?? null;
            return (
              <tr key={plan.studentId}>
                <td>{student?.name ?? plan.studentId}</td>
                <td>
                  <Badge tone={plan.reviewState === 'pending_review' ? 'warn' : 'ok'}>
                    {plan.reviewState === 'pending_review' ? '待核（结论已更正）' : '当前'}
                  </Badge>
                </td>
                <td className="mono">{plan.sharedRefs.filter((r) => !r.detached).length}</td>
                <td className="mono">{plan.copies.filter((c) => !c.detached).length}</td>
                <td className="mono">{plan.privateEntryIds.length}（其他学生不可见）</td>
                <td>
                  <Button
                    tone="danger"
                    className="btn-sm"
                    disabled={!conclusionId}
                    onClick={() =>
                      void run(
                        (snap) =>
                          reduceSharedScope(snap, {
                            studentId: plan.studentId,
                            conclusionId: conclusionId!,
                            reason: '该生仅保留自身支持事项，解除共同结论关联',
                            atMin: nowMin,
                          }),
                        `${student?.name} 已仅保留自身支持事项；不可变共同结论与另一方计划保留`,
                      )
                    }
                  >
                    仅保留自身事项
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {conclusions.length > 0 && (
        <div className="sticky-note" style={{ marginTop: 10 }}>
          不可变共同结论修订历史：
          {conclusions
            .slice()
            .reverse()
            .map((c) => (
              <span key={c.id} className="mono" style={{ marginRight: 10 }}>
                rev{c.revision}（{c.storageMode === 'reference' ? '引用·1 份' : '复制·2 份'}，{c.content.length} 字）
              </span>
            ))}
        </div>
      )}
    </Card>
  );
}
