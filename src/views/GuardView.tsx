import { useMemo, useState } from 'react';
import { useApp } from '../state/store';
import { Badge, Button, Card, Empty, KeyVal } from '../components/ui';
import { CHECKIN_STATUS_LABELS } from '../lib/labels';
import { minToHM } from '../lib/time';
import { cancelVisit, checkInVisitor, visitorLeave } from '../engine/meetingCommands';

/**
 * 门岗工作台：
 * - 只依据“有效名册”放行；旧名册一旦失效（变更/取消/口译缺席）立即不再出现
 * - 访客签到、提前离场、取消到访各自独立，均不等于会议完成
 */
export function GuardView() {
  const app = useApp();
  const { snapshot, nowMin } = app;
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  const activeEntries = useMemo(
    () =>
      Object.values(snapshot.visitorEntries)
        .filter((e) => e.status === 'active')
        .sort((a, b) => {
          const sa = snapshot.sessions[a.sessionId]?.startMin ?? 0;
          const sb = snapshot.sessions[b.sessionId]?.startMin ?? 0;
          return sa - sb;
        }),
    [snapshot.visitorEntries, snapshot.sessions],
  );

  const voidedCount = useMemo(
    () => Object.values(snapshot.visitorEntries).filter((e) => e.status === 'void').length,
    [snapshot.visitorEntries],
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
        门岗仅以系统内<b>有效名册</b>为准：预约变更、取消或口译员缺席时旧名单立即失效，失效条目不会出现在下方。
        签到、离场、取消到访是三种相互独立的访客状态，<b>都不会关闭会议</b>——会议只能由主持人记录结束。
      </div>

      <Card title={`有效访客名册（${activeEntries.length}）`} extra={<Badge tone="neutral">已失效历史条目 {voidedCount}</Badge>}>
        {activeEntries.length === 0 && <Empty text="当前没有有效访客记录（可能尚未预约或旧名单已失效）" />}
        <table>
          <thead>
            <tr><th>访客</th><th>身份</th><th>场次/时间</th><th>签到状态</th><th>门岗操作</th></tr>
          </thead>
          <tbody>
            {activeEntries.map((e) => {
              const session = snapshot.sessions[e.sessionId];
              const late = nowMin > (session?.startMin ?? nowMin);
              return (
                <tr key={e.id}>
                  <td>{e.personName}</td>
                  <td>{e.personRole === 'parent' ? '家长' : e.personRole === 'interpreter' ? '口译员' : '教师'}</td>
                  <td>
                    {session?.title}
                    <div className="muted mono">{session ? `${minToHM(session.startMin)}-${minToHM(session.endMin)}` : '—'}</div>
                  </td>
                  <td>
                    <Badge tone={e.checkIn === 'checked_in' ? 'ok' : e.checkIn === 'left' ? 'warn' : e.checkIn === 'cancelled' ? 'bad' : 'neutral'}>
                      {CHECKIN_STATUS_LABELS[e.checkIn]}
                    </Badge>
                    {e.late && <div className="muted">迟到回执</div>}
                    {e.early && <div className="muted">提前离场</div>}
                  </td>
                  <td>
                    <div className="row-gap">
                      <Button
                        tone="primary"
                        className="btn-sm"
                        disabled={e.checkIn === 'checked_in' || e.checkIn === 'left' || e.checkIn === 'cancelled'}
                        onClick={() =>
                          void run(
                            (snap) => checkInVisitor(snap, { sessionId: e.sessionId, personId: e.personId!, atMin: nowMin }),
                            late ? `${e.personName} 已登记迟到签到（回执不等于会议完成）` : `${e.personName} 签到成功`,
                          )
                        }
                      >
                        签到{late ? '（迟到）' : ''}
                      </Button>
                      <Button
                        className="btn-sm"
                        disabled={e.checkIn !== 'checked_in'}
                        onClick={() =>
                          void run(
                            (snap) => visitorLeave(snap, { sessionId: e.sessionId, personId: e.personId!, atMin: nowMin }),
                            `${e.personName} 已登记离场（不自动关闭场次）`,
                          )
                        }
                      >
                        离场
                      </Button>
                      <Button
                        tone="danger"
                        className="btn-sm"
                        disabled={e.checkIn === 'cancelled' || e.checkIn === 'left'}
                        onClick={() =>
                          void run(
                            (snap) =>
                              cancelVisit(snap, {
                                sessionId: e.sessionId,
                                personId: e.personId!,
                                reason: '门岗登记取消到访',
                                atMin: nowMin,
                              }),
                            `${e.personName} 已登记取消到访（会议不因此关闭）`,
                          )
                        }
                      >
                        取消到访
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      <Card title="今日接待资源（实时占用/释放）">
        <table>
          <thead><tr><th>资源</th><th>类型</th><th>场次时段</th><th>占用状态</th></tr></thead>
          <tbody>
            {Object.values(snapshot.bookings).map((b) => (
              <tr key={b.id}>
                <td>{b.resourceType === 'room' ? snapshot.meetingRooms[b.resourceId]?.name ?? b.resourceId : snapshot.interpreters[b.resourceId]?.name ?? b.resourceId}</td>
                <td>{b.resourceType === 'room' ? '接待室' : '口译员'}</td>
                <td className="mono">{minToHM(b.startMin)}-{minToHM(b.endMin)}</td>
                <td>
                  <Badge tone={b.status === 'held' ? 'ok' : 'neutral'}>
                    {b.status === 'held' ? '占用中' : `已释放（${b.releaseReason ?? ''}）`}
                  </Badge>
                </td>
              </tr>
            ))}
            {Object.keys(snapshot.bookings).length === 0 && (
              <tr><td colSpan={4}><Empty text="暂无资源占用" /></td></tr>
            )}
          </tbody>
        </table>
      </Card>

      <Card title="门岗规则要点">
        <KeyVal
          pairs={[
            ['名册依据', '仅有效条目可放行；失效条目保留在事件流中供回放，但不在本表出现'],
            ['迟到/取消', '属于到访回执，不改变会议状态，不能据此关闭预约'],
            ['提前离场', '只标记该访客，不自动结束本场，更不影响同会谈的另一场'],
            ['关闭权限', '只有主持人（班主任）在系统内记录结束，场次才会关闭'],
          ]}
        />
      </Card>
    </div>
  );
}
