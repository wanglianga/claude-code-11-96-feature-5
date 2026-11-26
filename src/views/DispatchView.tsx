import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../state/store';
import { Badge, Button, Card, Empty } from '../components/ui';
import { minToHM } from '../lib/time';
import { affectedCourses, distanceBetween, type PlanProposal, type RoomCheck } from '../engine/scheduling';
import { evaluatePlans, proposePlan, publishPlan } from '../engine/commands';
import { workerClient } from '../worker/client';
import { reqLabel } from '../lib/labels';

export function DispatchView() {
  const app = useApp();
  const { snapshot, user, nowMin } = app;
  const [plans, setPlans] = useState<{ minimal: PlanProposal; swap: PlanProposal } | null>(null);
  const [checks, setChecks] = useState<Record<string, RoomCheck[]>>({});
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  const closedRoomIds = useMemo(
    () => Object.entries(snapshot.closures).filter(([, c]) => c.closed).map(([id]) => id),
    [snapshot.closures],
  );
  const affected = useMemo(() => affectedCourses(snapshot), [snapshot]);

  useEffect(() => {
    if (!affected.length) {
      setPlans(null);
      setChecks({});
      return;
    }
    let alive = true;
    void workerClient.computePlans().then((p) => {
      if (alive) setPlans(p);
    });
    Promise.all(affected.map((c) => workerClient.evaluateRooms(c.id))).then((list) => {
      if (!alive) return;
      const map: Record<string, RoomCheck[]> = {};
      affected.forEach((c, i) => (map[c.id] = list[i]));
      setChecks(map);
    });
    return () => {
      alive = false;
    };
  }, [snapshot.seq, affected.map((c) => c.id).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  async function propose(proposal: PlanProposal) {
    setMsg(null);
    try {
      await app.dispatch((snap) => proposePlan(snap, { proposal, atMin: nowMin, by: user.id }));
      setMsg({ tone: 'ok', text: '方案已生成，等待涉及课程的教师逐一确认。' });
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    }
  }

  async function publish(planId: string) {
    setMsg(null);
    try {
      await app.dispatch((snap) => publishPlan(snap, { planId, atMin: nowMin }));
      setMsg({ tone: 'ok', text: '已发布：教师与学生收到同一版本的地点与时间通知。' });
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    }
  }

  const proposedOrPublished = Object.values(snapshot.plans)
    .filter((p) => p.status !== 'cancelled')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <div>
      {msg && <div className={`banner banner-${msg.tone}`}>{msg.text}</div>}
      <div className="banner banner-info">
        调度硬约束：目标教室须在课程<b>全时段空闲</b>、容量足够、设备齐全、具备无障碍通道与安全条件、未被封闭；临时改排不得造成课程重叠；发布前必须取得每位涉及教师确认。
      </div>

      {!closedRoomIds.length && <Empty text="当前没有封闭房间，无需改排" />}

      {affected.length > 0 && (
        <Card title="① 受封闭影响的课程与候选教室核查（距离/容量/设备/无障碍/安全/时段）">
          {affected.map((c) => (
            <div key={c.id} style={{ marginBottom: 16 }}>
              <h4 style={{ margin: '4px 0 6px' }}>
                {c.className}（{c.size} 人，{minToHM(c.startMin)}-{minToHM(c.endMin)}，原 {snapshot.rooms[c.roomId].name}）
                需求：{c.requirements.map(reqLabel).join('、')}
              </h4>
              <table>
                <thead>
                  <tr><th>教室</th><th>距离（分钟）</th><th>容量</th><th>设备/无障碍/安全</th><th>全时段空闲</th><th>判定</th></tr>
                </thead>
                <tbody>
                  {(checks[c.id] ?? []).map((chk) => (
                    <tr key={chk.room.id}>
                      <td>{chk.room.name}</td>
                      <td className="mono">{distanceBetween(c.originalRoomId, chk.room.id)}</td>
                      <td>{chk.room.capacity}{chk.room.capacity >= c.size ? ' ✓' : ''}</td>
                      <td>
                        {chk.room.equipment.map(reqLabel).join('、') || '—'}
                        {chk.room.accessible ? '；无障碍✓' : '；无无障碍'}
                        {chk.room.safety ? '；安全✓' : '；安全✕'}
                      </td>
                      <td>{chk.reasons.includes('课程全时段不空闲') ? <Badge tone="bad">占用</Badge> : <Badge tone="ok">空闲</Badge>}</td>
                      <td>
                        {chk.eligible ? (
                          <Badge tone="ok">可选用</Badge>
                        ) : (
                          <div className="cross-line" style={{ color: 'var(--bad)' }}>{chk.reasons.join('；')}</div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </Card>
      )}

      {plans && (
        <Card title="② 两种改排方案（学生分钟 = 人数 × 步行分钟）">
          <div className="grid-2">
            <PlanPanel
              title="方案一：仅移动受影响课程"
              subtitle="通知面最小，学生可能多走路"
              proposal={plans.minimal}
              onPropose={() => void propose(plans.minimal)}
              recommended={false}
            />
            <PlanPanel
              title="方案二：弹性课程交换房间"
              subtitle="步行更少，但要额外通知原本未受影响的班级"
              proposal={plans.swap}
              onPropose={() => void propose(plans.swap)}
              recommended
            />
          </div>
          {plans.swap.feasible && (
            <div className="banner banner-ok" style={{ marginTop: 12 }}>
              方案二比方案一少 <b>{plans.minimal.studentMinutes - plans.swap.studentMinutes}</b> 学生分钟
              （{plans.minimal.studentMinutes} → {plans.swap.studentMinutes}），
              但多移动 {plans.swap.moves.length - plans.minimal.moves.length} 个班、多发出一组通知，由调度员权衡。
            </div>
          )}
        </Card>
      )}

      <Card title="③ 方案确认与发布（教师全部确认后才能发布）">
        {proposedOrPublished.length === 0 && <Empty text="暂无方案" />}
        {proposedOrPublished.map((p) => {
          const allCourseIds = p.moves.map((m) => m.courseId);
          const confirmed = allCourseIds.filter((id) => p.confirmedCourseIds.includes(id));
          const allConfirmed = confirmed.length === allCourseIds.length;
          return (
            <div key={p.id} className="plan-card" style={{ marginBottom: 12 }}>
              <h4>
                {p.strategy === 'minimal' ? '方案一 · 仅移动受影响课程' : '方案二 · 弹性换房'}
                <Badge tone={p.status === 'published' ? 'ok' : 'warn'}>
                  {p.status === 'published' ? '已发布' : '待教师确认'}
                </Badge>
                <span className="muted" style={{ fontWeight: 400, fontSize: 12.5 }}>
                  合计 {p.studentMinutes} 学生分钟 ｜ 通知 {p.notifiedClassIds.length} 个班
                </span>
              </h4>
              <table>
                <thead><tr><th>班级</th><th>移动</th><th>学生分钟</th><th>教师确认</th></tr></thead>
                <tbody>
                  {p.moves.map((m) => {
                    const c = snapshot.courses[m.courseId];
                    const ok = p.confirmedCourseIds.includes(m.courseId);
                    return (
                      <tr key={m.courseId}>
                        <td>{c.className}{c.flexible && <Badge tone="info">弹性</Badge>}</td>
                        <td>{snapshot.rooms[m.fromRoomId].name} → <b>{snapshot.rooms[m.toRoomId].name}</b></td>
                        <td className="mono">{m.studentMinutes}</td>
                        <td>{ok ? <Badge tone="ok">已确认</Badge> : <Badge tone="warn">待确认</Badge>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {p.status === 'proposed' && (
                <div className="row-gap" style={{ marginTop: 10 }}>
                  <Button tone="primary" disabled={!allConfirmed} onClick={() => void publish(p.id)}>
                    {allConfirmed ? '发布改排并发出版本通知' : `等待确认（${confirmed.length}/${allCourseIds.length}）`}
                  </Button>
                  {!allConfirmed && <span className="muted">请相关教师在“教师工作台”确认</span>}
                </div>
              )}
            </div>
          );
        })}
      </Card>
    </div>
  );
}

function PlanPanel({
  title,
  subtitle,
  proposal,
  onPropose,
  recommended,
}: {
  title: string;
  subtitle: string;
  proposal: PlanProposal;
  onPropose: () => void;
  recommended: boolean;
}) {
  const app = useApp();
  return (
    <div className={`plan-card ${recommended ? 'recommended' : ''}`}>
      <h4>
        {title}
        {recommended && <Badge tone="info">步行更优</Badge>}
      </h4>
      <p className="muted" style={{ marginTop: 0 }}>{subtitle}</p>
      {proposal.feasible ? (
        <>
          <table>
            <thead><tr><th>班级</th><th>安排</th><th>计算</th></tr></thead>
            <tbody>
              {proposal.moves.map((m) => {
                const c = app.snapshot.courses[m.courseId];
                return (
                  <tr key={m.courseId}>
                    <td>{c.className}{c.flexible && <Badge tone="info">弹性</Badge>}</td>
                    <td>{app.snapshot.rooms[m.fromRoomId].name} → {app.snapshot.rooms[m.toRoomId].name}</td>
                    <td className="mono">
                      {c.size} × {distanceBetween(m.fromRoomId, m.toRoomId)} = {m.studentMinutes}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="metrics" style={{ margin: '10px 0' }}>
            <div className="metric"><div className="num">{proposal.studentMinutes}</div><div className="lbl">总学生分钟</div></div>
            <div className="metric"><div className="num">{proposal.moves.length}</div><div className="lbl">移动班级数</div></div>
            <div className="metric"><div className="num">{proposal.notifiedClassIds.length}</div><div className="lbl">通知对象数</div></div>
          </div>
          <Button tone="primary" onClick={onPropose}>采用此方案（进入教师确认）</Button>
        </>
      ) : (
        <ul className="reason-list">
          {proposal.reasons.map((r, i) => <li key={i}>{r}</li>)}
        </ul>
      )}
    </div>
  );
}
