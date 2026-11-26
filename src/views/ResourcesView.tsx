import { useMemo } from 'react';
import { useApp } from '../state/store';
import { Badge, Card } from '../components/ui';
import { minToHM } from '../lib/time';
import { reqLabel } from '../lib/labels';
import { DISTANCE } from '../lib/seed';

export function ResourcesView() {
  const { snapshot } = useApp();
  const rooms = Object.values(snapshot.rooms);
  const courses = useMemo(
    () => Object.values(snapshot.courses).sort((a, b) => a.startMin - b.startMin),
    [snapshot.courses],
  );

  return (
    <div>
      <Card title="教室资源与实时封闭状态">
        <table>
          <thead>
            <tr><th>教室</th><th>教室码</th><th>容量</th><th>设备</th><th>无障碍</th><th>安全</th><th>封闭状态</th><th>解封时间</th></tr>
          </thead>
          <tbody>
            {rooms.map((r) => {
              const closure = snapshot.closures[r.id];
              return (
                <tr key={r.id}>
                  <td><b>{r.name}</b></td>
                  <td className="mono">{r.code}</td>
                  <td>{r.capacity}</td>
                  <td>{r.equipment.map(reqLabel).join('、') || '—'}</td>
                  <td>{r.accessible ? <Badge tone="ok">有</Badge> : <Badge tone="warn">无</Badge>}</td>
                  <td>{r.safety ? <Badge tone="ok">达标</Badge> : <Badge tone="bad">不达标</Badge>}</td>
                  <td>
                    {!closure ? <Badge tone="neutral">未封闭</Badge> : closure.closed ? <Badge tone="bad">封闭中（{minToHM(closure.sinceMin)} 起，预计 {closure.estimatedEndMin !== null ? minToHM(closure.estimatedEndMin) : '—'}）</Badge> : <Badge tone="ok">已解封</Badge>}
                  </td>
                  <td>{closure?.reopenedAt ? closure.reopenedAt.slice(11, 16) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      <Card title="当天课表（含改排后的实际房间）">
        <table>
          <thead>
            <tr><th>班级</th><th>时段</th><th>人数</th><th>原教室</th><th>当前教室</th><th>需求</th><th>弹性</th><th>状态</th></tr>
          </thead>
          <tbody>
            {courses.map((c) => (
              <tr key={c.id}>
                <td>{c.className}</td>
                <td className="mono">{minToHM(c.startMin)}-{minToHM(c.endMin)}</td>
                <td>{c.size}</td>
                <td>{snapshot.rooms[c.originalRoomId].name}</td>
                <td>
                  {snapshot.rooms[c.roomId].name}
                  {c.roomId !== c.originalRoomId && <Badge tone="info">已改排</Badge>}
                </td>
                <td>{c.requirements.map(reqLabel).join('、')}</td>
                <td>{c.flexible ? <Badge tone="info">弹性</Badge> : '固定'}</td>
                <td>{c.status === 'normal' ? <Badge tone="neutral">正常</Badge> : <Badge tone="ok">已改排</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title="步行距离矩阵（分钟）">
        <table style={{ maxWidth: 620 }}>
          <thead>
            <tr><th></th>{rooms.map((r) => <th key={r.id}>{r.name}</th>)}</tr>
          </thead>
          <tbody>
            {rooms.map((from) => (
              <tr key={from.id}>
                <td><b>{from.name}</b></td>
                {rooms.map((to) => <td key={to.id} className="mono">{DISTANCE[from.id][to.id]}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
