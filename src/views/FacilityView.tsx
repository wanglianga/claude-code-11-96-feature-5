import { useMemo, useState } from 'react';
import { useApp } from '../state/store';
import { Badge, Button, Card, Empty, KeyVal } from '../components/ui';
import { PhotoThumb } from '../components/PhotoThumb';
import { FAULT_LABELS, INCIDENT_STATUS_LABELS } from '../lib/labels';
import { minToHM } from '../lib/time';
import { confirmBoundary, createWorkOrder, failRetest, passRetest } from '../engine/commands';
import type { Incident } from '../types';

/**
 * 设施人员视图：
 * 1. 核准事故边界（勾选受影响房间）与预计修复时间 -> 封闭 + 可开工单
 * 2. 维修人员“已修复”后执行复测；失败保持封闭，通过才解封
 * 3. 已发布安排不随预计修复时间自动回滚（仅在复测通过时解封房间）
 */
export function FacilityView() {
  const app = useApp();
  const { snapshot, user, nowMin } = app;
  const [estEnd, setEstEnd] = useState(12 * 60);
  const [retestNote, setRetestNote] = useState('11:30 复测：吊顶内仍有滴水，冷凝水主管接口未密封');
  const [msg, setMsg] = useState<string | null>(null);

  const incidents = useMemo(
    () => Object.values(snapshot.incidents).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [snapshot.incidents],
  );

  async function run(fn: Parameters<typeof app.dispatch>[0], ok: string) {
    setMsg(null);
    try {
      await app.dispatch(fn);
      setMsg(ok);
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  return (
    <div>
      {msg && <div className="banner banner-info">{msg}</div>}
      <div className="banner banner-warn">
        规则：封闭只能由“核准边界”建立、由“复测通过”解除；维修人员标记已修复不会自动解封，预计修复时间仅作参考，不会自动回滚已发布安排。
      </div>

      {incidents.length === 0 && <Empty text="暂无事故，等待教师报修" />}

      {incidents.map((inc) => {
        const closureRooms = inc.roomIds.map((id) => snapshot.rooms[id]?.name).join('、');
        return (
          <Card
            key={inc.id}
            title={`事故 ${inc.id.slice(-6)} · ${FAULT_LABELS[inc.faultType]} · 影响 ${closureRooms}`}
            extra={<Badge tone={inc.status === 'verified' ? 'ok' : inc.status === 'repaired' ? 'warn' : 'bad'}>{INCIDENT_STATUS_LABELS[inc.status]}</Badge>}
          >
            <KeyVal
              pairs={[
                ['报修数量', `${inc.reportIds.length} 条（重复报修已合并为同一事故）`],
                ['事故边界', inc.roomIds.map((r) => snapshot.rooms[r]?.name).join('、')],
                ['预计修复', inc.estimatedEndMin !== null ? minToHM(inc.estimatedEndMin) : '未设定（参考值，不触发自动解封）'],
                ['封闭状态', inc.roomIds.map((r) => `${snapshot.rooms[r]?.name}:${snapshot.closures[r]?.closed ? '封闭' : '已解封'}`).join('；')],
                ['复测失败', inc.retestFailures.length ? inc.retestFailures.map((f) => `${f.at.slice(11, 16)} ${f.note}`).join(' / ') : '无'],
                ['复测通过', inc.verifiedAt ?? '未通过'],
              ]}
            />

            <div style={{ marginTop: 10 }}>
              <b>关联报修与照片：</b>
              <table>
                <thead><tr><th>报修</th><th>教室</th><th>描述</th><th>照片</th><th>性质</th></tr></thead>
                <tbody>
                  {inc.reportIds.map((rid) => {
                    const r = snapshot.reports[rid];
                    if (!r) return null;
                    return (
                      <tr key={rid}>
                        <td className="mono">{rid.slice(-6)}</td>
                        <td>{snapshot.rooms[r.roomId]?.name}</td>
                        <td style={{ maxWidth: 320 }}>{r.description}</td>
                        <td>
                          <div className="photo-thumbs">{r.photoIds.map((p) => <PhotoThumb key={p} id={p} />)}</div>
                        </td>
                        <td>{r.duplicate ? <Badge tone="warn">重复报修·已合并</Badge> : <Badge tone="info">首报</Badge>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="row-gap" style={{ marginTop: 12 }}>
              {inc.status === 'reported' && (
                <BoundaryForm
                  inc={inc}
                  estEnd={estEnd}
                  onEstEnd={setEstEnd}
                  onConfirm={(roomIds) =>
                    run(
                      (snap) => confirmBoundary(snap, { incidentId: inc.id, roomIds, estimatedEndMin: estEnd, atMin: nowMin, by: user.id }),
                      `已核准边界并封闭 ${roomIds.map((r) => snapshot.rooms[r]?.name).join('、')}，预计 ${minToHM(estEnd)} 修复`,
                    )
                  }
                />
              )}
              {inc.status === 'confirmed' && (
                <Button tone="primary" onClick={() => void run(
                  (snap) => createWorkOrder(snap, { incidentId: inc.id, summary: `${FAULT_LABELS[inc.faultType]}维修：${inc.roomIds.map((r) => snapshot.rooms[r]?.name).join('/')}`, assignee: '赵维修', atMin: nowMin }),
                  '工单已生成并派发维修',
                )}>
                  生成维修工单
                </Button>
              )}
              {inc.status === 'work_order' && <span className="muted">等待维修人员标记“已修复”</span>}
              {inc.status === 'repaired' && (
                <>
                  <input
                    style={{ flex: '1 1 280px' }}
                    value={retestNote}
                    onChange={(e) => setRetestNote(e.target.value)}
                    placeholder="复测记录"
                  />
                  <Button tone="danger" onClick={() => void run(
                    (snap) => failRetest(snap, { incidentId: inc.id, atMin: nowMin, by: user.id, note: retestNote }),
                    '复测失败：维持封闭，退回返修，已发布安排不回滚',
                  )}>
                    复测失败（保持封闭）
                  </Button>
                  <Button tone="primary" onClick={() => void run(
                    (snap) => passRetest(snap, { incidentId: inc.id, atMin: nowMin, by: user.id }),
                    '复测通过：正式解除全部受影响房间封闭',
                  )}>
                    复测通过并解除封闭
                  </Button>
                </>
              )}
              {inc.status === 'verified' && <Badge tone="ok">房间已恢复使用</Badge>}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

/** 事故边界核准表单：勾选受影响房间 + 设定预计修复时间 */
function BoundaryForm({
  inc,
  estEnd,
  onEstEnd,
  onConfirm,
}: {
  inc: Incident;
  estEnd: number;
  onEstEnd: (m: number) => void;
  onConfirm: (roomIds: string[]) => void;
}) {
  const { snapshot } = useApp();
  const [picked, setPicked] = useState<string[]>([...inc.roomIds]);
  const toggle = (id: string) =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <div style={{ background: '#f8fafc', border: '1px solid var(--line)', borderRadius: 10, padding: 12 }}>
      <div className="field">
        <label>核准事故边界（勾选实际受同一主管影响的房间）</label>
        {Object.values(snapshot.rooms).map((r) => (
          <label key={r.id} className="row-gap" style={{ padding: '3px 0', fontWeight: 400 }}>
            <input type="checkbox" checked={picked.includes(r.id)} onChange={() => toggle(r.id)} />
            {r.name}
            {inc.roomIds.includes(r.id) && <span className="muted">（报修涉及）</span>}
          </label>
        ))}
      </div>
      <div className="row-gap">
        <label className="row-gap">
          预计修复时间
          <input
            type="time"
            value={minToHM(estEnd)}
            onChange={(e) => {
              const [h, m] = e.target.value.split(':').map(Number);
              onEstEnd(h * 60 + m);
            }}
          />
        </label>
        <Button tone="primary" disabled={picked.length === 0} onClick={() => onConfirm(picked)}>
          核准边界并封闭房间
        </Button>
      </div>
    </div>
  );
}
