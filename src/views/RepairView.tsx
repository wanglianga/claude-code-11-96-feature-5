import { useMemo } from 'react';
import { useApp } from '../state/store';
import { Badge, Button, Card, Empty, KeyVal } from '../components/ui';
import { FAULT_LABELS, INCIDENT_STATUS_LABELS } from '../lib/labels';
import { markRepaired } from '../engine/commands';

export function RepairView() {
  const app = useApp();
  const { snapshot, user, nowMin } = app;
  const workOrders = useMemo(() => Object.values(snapshot.workOrders), [snapshot.workOrders]);

  return (
    <div>
      <div className="banner banner-info">
        维修人员只能标记“已修复”，封闭状态不会改变；必须由设施人员复测通过后才解除封闭。
      </div>
      {workOrders.length === 0 && <Empty text="暂无工单" />}
      {workOrders.map((wo) => {
        const inc = snapshot.incidents[wo.incidentId];
        return (
          <Card
            key={wo.id}
            title={`工单 ${wo.id.slice(-6)} · ${wo.summary}`}
            extra={
              wo.completedAt ? <Badge tone="warn">已修复·待设施复测</Badge> : <Badge tone="bad">维修中</Badge>
            }
          >
            <KeyVal
              pairs={[
                ['事故状态', inc ? INCIDENT_STATUS_LABELS[inc.status] : '—'],
                ['故障类型', inc ? FAULT_LABELS[inc.faultType] : '—'],
                ['受影响房间', inc ? inc.roomIds.map((r) => snapshot.rooms[r]?.name).join('、') : '—'],
                ['负责人', wo.assignee],
                ['创建时间', wo.createdAt.replace('T', ' ').slice(0, 16)],
                ['完成时间', wo.completedAt ? wo.completedAt.replace('T', ' ').slice(0, 16) : '—'],
              ]}
            />
            <div style={{ marginTop: 10 }}>
              {!wo.completedAt ? (
                <Button
                  tone="primary"
                  onClick={() =>
                    app
                      .dispatch((snap) => markRepaired(snap, { incidentId: wo.incidentId, atMin: nowMin, by: user.id }))
                      .catch((e) => alert((e as Error).message))
                  }
                >
                  标记“已修复”（提交设施复测）
                </Button>
              ) : (
                <span className="muted">已提交复测，房间保持封闭直到设施复测通过</span>
              )}
            </div>
          </Card>
        );
      })}
    </div>
  );
}
