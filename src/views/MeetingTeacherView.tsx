import { useMemo, useState } from 'react';
import { useApp } from '../state/store';
import { Badge, Button, Card, Empty, KeyVal } from '../components/ui';
import {
  CHECKIN_STATUS_LABELS,
  INTERPRETER_SERVICE_LABELS,
  MINUTES_STATUS_LABELS,
  SESSION_STATUS_LABELS,
} from '../lib/labels';
import { minToHM } from '../lib/time';
import {
  clearPlanReview,
  endSession,
  finalizeMinutes,
  recordSessionOutcome,
  startSession,
} from '../engine/meetingCommands';
import { readStudentPlan } from '../engine/access';

const SHARED_SAMPLE = '共'.repeat(80);
const PRIV_SAMPLE = '个别'.repeat(10); // 20 字

/**
 * 教师会谈工作台：
 * - 只列出与当前教师有关（主持或参会）且其任教学生在场的场次
 * - 主持人可开始/记录结束/写纪要；纪要只记参加情况与各自授权范围内结论
 * - 支持计划按任教关系过滤读取，不任教学生的计划明确不可见
 */
export function MeetingTeacherView() {
  const app = useApp();
  const { snapshot, user, nowMin } = app;
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  const mySessions = useMemo(
    () =>
      Object.values(snapshot.sessions)
        .filter((s) => s.teacherIds.includes(user.id) || s.hostTeacherId === user.id)
        .sort((a, b) => a.startMin - b.startMin),
    [snapshot.sessions, user.id],
  );

  const myStudents = useMemo(
    () =>
      Object.values(snapshot.students).filter((st) =>
        snapshot.teachings.some((t) => t.teacherId === user.id && t.studentId === st.id),
      ),
    [snapshot.students, snapshot.teachings, user.id],
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
        你只能看到自己所教学生相关的场次与记录。迟到、取消、提前离场都不是会议完成；
        只有主持人在会议结束后于本页“记录结束”，预约才会关闭，随后才能写纪要。
      </div>

      <Card title={`我的会谈场次（${mySessions.length}）`}>
        {mySessions.length === 0 && <Empty text="当前没有与你相关的会谈" />}
        {mySessions.map((s) => (
          <SessionCard key={s.id} session={s} nowMin={nowMin} onRun={run} />
        ))}
      </Card>

      <Card title="学生支持计划（按任教关系过滤；兄弟姐妹私有内容互不可见）">
        {myStudents.length === 0 && <Empty text="你名下没有任教学生" />}
        {myStudents.map((st) => {
          const view = readStudentPlan(snapshot, st.id, user.id);
          return (
            <div key={st.id} className="plan-card" style={{ marginBottom: 12 }}>
              <h4>
                {st.name}
                <Badge tone={view.reviewState === 'pending_review' ? 'warn' : 'ok'}>
                  {view.reviewState === 'pending_review' ? '待核对更正' : '当前版本'}
                </Badge>
              </h4>
              <KeyVal
                pairs={[
                  ['共同结论（沿引用授权可见）', view.sharedConclusions.length ? view.sharedConclusions.map((c) => `rev${c.revision}·${c.content.length}字`).join('；') : '无'],
                  ['共同副本', view.copies.length ? view.copies.map((c) => `rev${c.revision}（配对 ${c.pairedCopyId.slice(-4)}）`).join('；') : '无'],
                  ['私有补充', view.privateEntries.length ? view.privateEntries.map((e) => e.content).join('；') : '无'],
                ]}
              />
              {view.reviewState === 'pending_review' && (
                <div className="row-gap" style={{ marginTop: 8 }}>
                  {view.sharedRefs.filter((r) => r.pendingReview).map((r) => (
                    <Button
                      key={r.conclusionId}
                      tone="primary"
                      className="btn-sm"
                      onClick={() =>
                        void run(
                          (snap) =>
                            clearPlanReview(snap, {
                              studentId: st.id,
                              conclusionId: r.conclusionId,
                              teacherId: user.id,
                              atMin: nowMin,
                            }),
                          `${st.name} 的计划已核对，待核标记清除`,
                        )
                      }
                    >
                      核对结论 {r.conclusionId.slice(-4)}
                    </Button>
                  ))}
                  {view.copies.filter((c) => c.pendingReview).map((c) => (
                    <Button
                      key={c.id}
                      tone="primary"
                      className="btn-sm"
                      onClick={() =>
                        void run(
                          (snap) =>
                            clearPlanReview(snap, {
                              studentId: st.id,
                              conclusionId: c.conclusionId,
                              teacherId: user.id,
                              atMin: nowMin,
                            }),
                          `${st.name} 的副本已核对，待核标记清除`,
                        )
                      }
                    >
                      核对副本 {c.id.slice(-4)}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        <div className="sticky-note" style={{ marginTop: 10 }}>
          任教关系之外的学生（如苏老师视角下的王小华）不会出现计划入口；任何强行读取其私有 20 字补充的请求都会被引擎拒绝。
        </div>
      </Card>
    </div>
  );
}

function SessionCard({
  session,
  nowMin,
  onRun,
}: {
  session: import('../types').MeetingSession;
  nowMin: number;
  onRun: (fn: Parameters<ReturnType<typeof useApp>['dispatch']>[0], ok: string) => Promise<void>;
}) {
  const app = useApp();
  const { snapshot, user } = app;
  const isHost = session.hostTeacherId === user.id;
  const [sharedMode, setSharedMode] = useState<'reference' | 'copy'>('reference');
  const [sharedText, setSharedText] = useState(SHARED_SAMPLE);
  const [privMing, setPrivMing] = useState(PRIV_SAMPLE);
  const [privHua, setPrivHua] = useState(PRIV_SAMPLE);

  const minutes = Object.values(snapshot.minutes).find((m) => m.sessionId === session.id);
  const consent = Object.values(snapshot.consents).find((c) => c.familyId === session.familyId && c.granted);

  async function writeMinutes() {
    await onRun(
      (snap) =>
        recordSessionOutcome(snap, {
          sessionId: session.id,
          hostTeacherId: user.id,
          attendance: {
            [session.parentId]: {
              personId: session.parentId,
              name: snapshot.families[session.familyId].parentName,
              role: 'parent',
              attended: true,
              arrivedLate: false,
              leftEarly: false,
              cancelled: false,
            },
          },
          // 无生效授权时不传 shared，引擎只记录个别内容
          shared:
            sharedText.trim() && consent
              ? { content: sharedText.trim(), storageMode: sharedMode, consentId: consent.id }
              : null,
          privateContents: session.studentIds.map((sid) => ({
            studentId: sid,
            content: sid === 'stu_ming' ? privMing : privHua,
          })),
          atMin: nowMin,
        }),
      '纪要已创建：仅记录参加情况与授权范围内结论，个别补充已分别写入对应学生记录',
    );
  }

  return (
    <div className="plan-card" style={{ marginBottom: 14 }}>
      <h4>
        {session.title}
        <Badge tone={session.status === 'completed' ? 'ok' : session.status === 'in_progress' ? 'warn' : 'neutral'}>
          {SESSION_STATUS_LABELS[session.status]}
        </Badge>
        {isHost && <Badge tone="info">你是主持人</Badge>}
      </h4>
      <KeyVal
        pairs={[
          ['时间', `${minToHM(session.startMin)}-${minToHM(session.endMin)}（${session.endMin - session.startMin} 分钟）`],
          ['学生', session.studentIds.map((id) => snapshot.students[id]?.name ?? id).join('、')],
          ['地点', snapshot.meetingRooms[session.roomId]?.name ?? session.roomId],
          ['访客签到', CHECKIN_STATUS_LABELS[session.checkInStatus]],
          ['口译服务', INTERPRETER_SERVICE_LABELS[session.interpreterServiceStatus]],
          ['纪要状态', MINUTES_STATUS_LABELS[session.minutesStatus]],
        ]}
      />

      {isHost && (
        <div className="row-gap" style={{ marginTop: 10 }}>
          <Button
            tone="primary"
            className="btn-sm"
            disabled={session.status !== 'scheduled'}
            onClick={() =>
              void onRun(
                (snap) => startSession(snap, { sessionId: session.id, hostTeacherId: user.id, atMin: nowMin }),
                '会议已开始（口译到场则进入服务中）',
              )
            }
          >
            开始会议
          </Button>
          <Button
            tone="primary"
            className="btn-sm"
            disabled={session.status !== 'in_progress'}
            onClick={() =>
              void onRun(
                (snap) => endSession(snap, { sessionId: session.id, hostTeacherId: user.id, atMin: nowMin }),
                '已记录结束，场次关闭；全部场次结束后会谈自动完成',
              )
            }
          >
            记录结束
          </Button>
        </div>
      )}

      {isHost && session.status === 'completed' && !minutes && (
        <div style={{ marginTop: 12, borderTop: '1px dashed var(--line)', paddingTop: 10 }}>
          <div className="field">
            <label>共同结论内容（须仍有共享授权；留空则不记录共同结论）</label>
            <textarea value={sharedText} onChange={(e) => setSharedText(e.target.value)} />
          </div>
          <div className="field">
            <label>落地结构（引用：共同内容 1 份；复制：两份计划各 1 份并配对）</label>
            <select value={sharedMode} onChange={(e) => setSharedMode(e.target.value as 'reference' | 'copy')}>
              <option value="reference">引用结构（少重复、更正一次定位，权限沿引用执行）</option>
              <option value="copy">复制结构（单份计划可独立读取，副本强制共同核对）</option>
            </select>
          </div>
          {session.studentIds.map((sid) => (
            <div className="field" key={sid}>
              <label>{snapshot.students[sid]?.name} 的个别（私有）补充 · 20 字</label>
              <input
                value={sid === 'stu_ming' ? privMing : privHua}
                onChange={(e) => (sid === 'stu_ming' ? setPrivMing(e.target.value) : setPrivHua(e.target.value))}
              />
            </div>
          ))}
          <Button tone="primary" onClick={() => void writeMinutes()}>
            记录纪要并分别写入学生计划
          </Button>
          {!consent && <p className="muted" style={{ marginBottom: 0 }}>当前无生效共享授权，共同结论将被引擎拒绝，只能记录个别内容。</p>}
        </div>
      )}

      {minutes && (
        <div style={{ marginTop: 10 }}>
          <KeyVal
            pairs={[
              ['纪要状态', minutes.status === 'finalized' ? '已定稿' : '草稿'],
              ['参加情况', Object.values(minutes.attendance).map((a) => `${a.name}:${a.attended ? '出席' : '缺席'}`).join('；')],
              ['共同结论条目', minutes.sharedConclusionIds.length],
              ['个别记录条目', minutes.privateEntryIds.length],
            ]}
          />
          {isHost && minutes.status === 'draft' && (
            <Button
              tone="primary"
              className="btn-sm"
              style={{ marginTop: 8 }}
              onClick={() =>
                void onRun(
                  (snap) => finalizeMinutes(snap, { minutesId: minutes.id, hostTeacherId: user.id, atMin: nowMin }),
                  '纪要已定稿',
                )
              }
            >
              定稿纪要
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
