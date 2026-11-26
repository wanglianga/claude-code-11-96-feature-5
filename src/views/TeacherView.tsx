import { useMemo, useState } from 'react';
import { useApp } from '../state/store';
import { Badge, Button, Card, Empty, KeyVal } from '../components/ui';
import { PhotoThumb } from '../components/PhotoThumb';
import { FAULT_LABELS, PLAN_STATUS_LABELS } from '../lib/labels';
import { minToHM } from '../lib/time';
import { storePhoto, removePhoto } from '../lib/photos';
import { submitReport, confirmPlan } from '../engine/commands';
import type { Draft, FaultType } from '../types';
import { workerClient } from '../worker/client';

const FAULTS: FaultType[] = ['leak', 'power', 'equipment'];

export function TeacherView() {
  const app = useApp();
  const { snapshot, user, online, nowMin, drafts } = app;

  const [roomId, setRoomId] = useState('r_B201');
  const [faultType, setFaultType] = useState<FaultType>('leak');
  const [description, setDescription] = useState('');
  const [courseId, setCourseId] = useState<string | null>('c_A');
  const [photoIds, setPhotoIds] = useState<string[]>([]);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad' | 'warn'; text: string } | null>(null);

  const myCourses = useMemo(
    () => Object.values(snapshot.courses).filter((c) => c.teacherId === user.id),
    [snapshot.courses, user.id],
  );
  const myNotifications = useMemo(
    () =>
      Object.values(snapshot.notifications)
        .filter((n) => n.teacherId === user.id)
        .sort((a, b) => b.version - a.version || b.startMin - a.startMin),
    [snapshot.notifications, user.id],
  );
  const myDrafts = drafts.filter((d) => d.teacherId === user.id);
  const pendingPlans = Object.values(snapshot.plans).filter(
    (p) => p.status === 'proposed' && p.moves.some((m) => snapshot.courses[m.courseId]?.teacherId === user.id),
  );

  async function onPickFiles(files: FileList | null) {
    if (!files) return;
    const ids: string[] = [];
    for (const f of Array.from(files)) ids.push(await storePhoto(f));
    setPhotoIds((prev) => [...prev, ...ids]);
  }

  function resetForm() {
    setDescription('');
    setPhotoIds([]);
    setMsg(null);
  }

  async function submitOnline() {
    setMsg(null);
    try {
      await app.dispatch((snap) =>
        submitReport(snap, {
          roomId,
          faultType,
          description: description || '（未填写描述）',
          photoIds,
          teacherId: user.id,
          atMin: nowMin,
        }),
      );
      resetForm();
      setMsg({ tone: 'ok', text: '报修已提交，设施人员将核准事故边界。' });
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    }
  }

  async function saveOfflineDraft() {
    setMsg(null);
    const draft = await app.saveDraft({
      teacherId: user.id,
      roomId,
      courseId,
      faultType,
      description,
      photoIds,
    });
    resetForm();
    setMsg({ tone: 'warn', text: `已离线保存草稿 ${draft.id.slice(-6)}，联网后可检查提交；过期或冲突时不能发布。` });
  }

  async function resumeDraft(d: Draft) {
    const verdict = await workerClient.checkDraft(d, nowMin);
    if (verdict.kind === 'ok') {
      try {
        await app.dispatch((snap) =>
          submitReport(snap, {
            roomId: d.roomId,
            faultType: d.faultType,
            description: d.description,
            photoIds: d.photoIds,
            teacherId: d.teacherId,
            atMin: nowMin,
          }),
        );
        await app.updateDraft({ ...d, status: 'submitted', conflictReason: null });
        setMsg({ tone: 'ok', text: '草稿检查通过，已作为报修提交（重复报修将自动合并事故）。' });
      } catch (e) {
        setMsg({ tone: 'bad', text: (e as Error).message });
      }
    } else {
      await app.updateDraft({
        ...d,
        status: verdict.kind === 'expired' ? 'expired' : 'conflict',
        conflictReason: verdict.reason,
      });
      setMsg({ tone: 'bad', text: verdict.reason });
    }
  }

  return (
    <div>
      {!online && (
        <div className="banner banner-warn">
          当前处于<b>离线模式</b>：可查看已下载的版本通知、保存报修草稿；不能发布报修，联网后草稿须通过过期/冲突检查。
        </div>
      )}
      {msg && <div className={`banner banner-${msg.tone}`}>{msg.text}</div>}

      <div className="grid-2">
        <Card title="① 扫描教室码报修">
          <div className="scanner" onClick={() => document.getElementById('room-scan')?.focus()}>
            <span className="qr">▦</span>
            <div>
              <div>模拟扫码：选择教室码</div>
              <select
                id="room-scan"
                value={roomId}
                onChange={(e) => setRoomId(e.target.value)}
                style={{ marginTop: 6, minWidth: 220 }}
              >
                {Object.values(snapshot.rooms).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.code} ｜ {r.name}（容量 {r.capacity}）
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="field" style={{ marginTop: 12 }}>
            <label>故障类型</label>
            <select value={faultType} onChange={(e) => setFaultType(e.target.value as FaultType)}>
              {FAULTS.map((f) => (
                <option key={f} value={f}>
                  {FAULT_LABELS[f]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>关联课程（用于联网后的冲突检测）</label>
            <select value={courseId ?? ''} onChange={(e) => setCourseId(e.target.value || null)}>
              <option value="">不关联</option>
              {myCourses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.className} {minToHM(c.startMin)}-{minToHM(c.endMin)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>问题描述</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="如：冷凝水管接口滴水，地面积水"
            />
          </div>
          <div className="field">
            <label>现场照片（存入 IndexedDB）</label>
            <input type="file" accept="image/*" multiple onChange={(e) => void onPickFiles(e.target.files)} />
            <div className="photo-thumbs">
              {photoIds.map((id) => (
                <span key={id} style={{ position: 'relative' }}>
                  <PhotoThumb id={id} />
                  <button
                    className="btn btn-sm btn-danger"
                    style={{ position: 'absolute', top: 2, right: 2, padding: '0 6px' }}
                    onClick={() => {
                      void removePhoto(id);
                      setPhotoIds((p) => p.filter((x) => x !== id));
                    }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          </div>
          <div className="row-gap">
            <Button tone="primary" disabled={!online} onClick={() => void submitOnline()}>
              提交报修
            </Button>
            <Button onClick={() => void saveOfflineDraft()}>保存草稿{online ? '（本地）' : '（离线可用）'}</Button>
            {!online && <span className="muted">离线时提交按钮禁用</span>}
          </div>
        </Card>

        <div>
          <Card title="② 我的通知（带版本，离线可查看）">
            {myNotifications.length === 0 && <Empty text="暂未收到改排通知" />}
            {myNotifications.map((n) => (
              <div key={n.id} className="card" style={{ marginBottom: 10 }}>
                <div className="card-body">
                  <KeyVal
                    pairs={[
                      ['通知', <span className="notice-version">v{n.version} {n.superseded ? <Badge tone="warn">已被新版取代</Badge> : <Badge tone="ok">当前版本</Badge>}</span>],
                      ['班级', n.className],
                      ['地点', `${n.roomName}（${minToHM(n.startMin)}-${minToHM(n.endMin)}）`],
                      ['内容', n.body],
                      ['发出时间', n.createdAt.replace('T', ' ').slice(0, 16)],
                    ]}
                  />
                </div>
              </div>
            ))}
          </Card>

          <Card title="③ 待我确认的改排方案">
            {pendingPlans.length === 0 && <Empty text="没有待确认方案" />}
            {pendingPlans.map((p) => (
              <div key={p.id} className="plan-card" style={{ marginBottom: 10 }}>
                <h4>
                  方案 {p.strategy === 'minimal' ? '一（仅移动受影响课程）' : '二（弹性换房）'}
                  <Badge tone="info">{PLAN_STATUS_LABELS[p.status]}</Badge>
                </h4>
                {p.moves
                  .filter((m) => snapshot.courses[m.courseId]?.teacherId === user.id)
                  .map((m) => {
                    const c = snapshot.courses[m.courseId];
                    const confirmed = p.confirmedCourseIds.includes(m.courseId);
                    return (
                      <div key={m.courseId} className="row-gap" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
                        <span>
                          {c.className}：{snapshot.rooms[m.fromRoomId].name} → <b>{snapshot.rooms[m.toRoomId].name}</b>
                        </span>
                        {confirmed ? (
                          <Badge tone="ok">已确认</Badge>
                        ) : (
                          <Button
                            tone="primary"
                            onClick={() =>
                              void app
                                .dispatch((snap) => confirmPlan(snap, { planId: p.id, courseId: m.courseId, atMin: app.nowMin, by: user.id }))
                                .catch((e) => setMsg({ tone: 'bad', text: (e as Error).message }))
                            }
                          >
                            确认改排
                          </Button>
                        )}
                      </div>
                    );
                  })}
                <p className="muted" style={{ marginBottom: 0, fontSize: 12.5 }}>
                  全部教师确认后调度员才能发布，发布后师生收到同一版本的地点与时间。
                </p>
              </div>
            ))}
          </Card>
        </div>
      </div>

      <Card title={`④ 报修草稿（${myDrafts.length}）— 离线保存，联网冲突处理`}>
        {myDrafts.length === 0 && <Empty text="暂无草稿" />}
        <table>
          <thead>
            <tr>
              <th>草稿</th><th>教室/故障</th><th>关联课程</th><th>基准版本</th><th>照片</th><th>状态</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            {myDrafts.map((d) => (
              <tr key={d.id}>
                <td className="mono">{d.id.slice(-8)}</td>
                <td>{snapshot.rooms[d.roomId]?.name} / {FAULT_LABELS[d.faultType]}</td>
                <td>{d.courseId ? snapshot.courses[d.courseId]?.className : '—'}</td>
                <td className="mono">seq #{d.baseSeq}</td>
                <td>{d.photoIds.length} 张</td>
                <td>
                  <Badge tone={d.status === 'draft' ? 'neutral' : d.status === 'submitted' ? 'ok' : 'bad'}>
                    {d.status === 'draft' ? '待处理' : d.status === 'submitted' ? '已提交' : d.status === 'expired' ? '已过期' : '冲突'}
                  </Badge>
                  {d.conflictReason && <div className="muted" style={{ maxWidth: 260 }}>{d.conflictReason}</div>}
                </td>
                <td>
                  {d.status === 'draft' ? (
                    <Button tone="primary" disabled={!online} onClick={() => void resumeDraft(d)}>
                      联网检查并提交
                    </Button>
                  ) : (
                    <span className="muted">不可再发布</span>
                  )}
                  <Button className="btn-sm" style={{ marginLeft: 6 }} onClick={() => void app.removeDraft(d.id)}>
                    删除
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
