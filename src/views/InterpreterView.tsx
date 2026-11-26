import { useMemo } from 'react';
import { useApp } from '../state/store';
import { Badge, Card, Empty, KeyVal } from '../components/ui';
import { INTERPRETER_SERVICE_LABELS } from '../lib/labels';
import { minToHM } from '../lib/time';

/**
 * 口译员视图：只看与自己相关的场次与口译服务状态。
 * 预订（booked）不等于服务完成；临时缺席由协调员登记后，相关场次转待改期并释放本资源。
 */
export function InterpreterView() {
  const app = useApp();
  const { snapshot } = app;

  // 本演示只有一位口译员（int_ai）；所有需要口译的场次都分配给 ta
  const mySessions = useMemo(
    () =>
      Object.values(snapshot.sessions)
        .filter((s) => s.interpreterRequired)
        .sort((a, b) => a.startMin - b.startMin),
    [snapshot.sessions],
  );

  const windowInfo = Object.values(snapshot.interpreters)[0];

  return (
    <div>
      <div className="banner banner-info">
        你的可服务窗口为 {windowInfo ? `${minToHM(windowInfo.startMin)}-${minToHM(windowInfo.endMin)}` : '—'}；
        早于 15:30 的场次不会被排入口译。预订、服务中、缺席、释放是独立状态。
      </div>

      <Card title="我的口译排班">
        {mySessions.length === 0 && <Empty text="暂无口译排班" />}
        {mySessions.map((s) => (
          <div key={s.id} className="plan-card" style={{ marginBottom: 12 }}>
            <h4>
              {s.title}
              <Badge
                tone={
                  s.interpreterServiceStatus === 'absent'
                    ? 'bad'
                    : s.interpreterServiceStatus === 'in_service'
                      ? 'ok'
                      : s.interpreterServiceStatus === 'released'
                        ? 'neutral'
                        : 'info'
                }
              >
                {INTERPRETER_SERVICE_LABELS[s.interpreterServiceStatus]}
              </Badge>
            </h4>
            <KeyVal
              pairs={[
                ['时段', `${minToHM(s.startMin)}-${minToHM(s.endMin)}`],
                ['地点', snapshot.meetingRooms[s.roomId]?.name ?? s.roomId],
                ['学生', s.studentIds.map((id) => snapshot.students[id]?.name ?? id).join('、')],
                ['场次状态', s.status],
              ]}
            />
            {s.interpreterServiceStatus === 'absent' && (
              <p className="muted" style={{ marginBottom: 0 }}>
                你已被登记临时缺席：该场次转为待改期，你的时段占用与门岗名册均已释放/失效，等待重新排期后的新通知。
              </p>
            )}
          </div>
        ))}
      </Card>
    </div>
  );
}
