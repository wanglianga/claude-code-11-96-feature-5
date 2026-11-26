import { useState } from 'react';
import { AppProvider, useApp } from './state/store';
import { TeacherView } from './views/TeacherView';
import { FacilityView } from './views/FacilityView';
import { DispatchView } from './views/DispatchView';
import { RepairView } from './views/RepairView';
import { ResourcesView } from './views/ResourcesView';
import { ReplayView } from './views/ReplayView';
import { CoordinatorView } from './views/CoordinatorView';
import { GuardView } from './views/GuardView';
import { InterpreterView } from './views/InterpreterView';
import { MeetingTeacherView } from './views/MeetingTeacherView';
import { minToHM } from './lib/time';
import type { Role } from './types';

const NAV: { key: string; label: string; role: Role | null }[] = [
  { key: 'teacher', label: '教师工作台', role: 'teacher' },
  { key: 'meeting-teacher', label: '教师·家长会谈', role: 'teacher' },
  { key: 'facility', label: '设施工作台', role: 'facility' },
  { key: 'dispatch', label: '调度工作台', role: 'dispatcher' },
  { key: 'repair', label: '维修工作台', role: 'repair' },
  { key: 'coordinator', label: '接待预约工作台', role: 'coordinator' },
  { key: 'guard', label: '门岗工作台', role: 'guard' },
  { key: 'interpreter', label: '口译排班', role: 'interpreter' },
  { key: 'resources', label: '资源与课表', role: null },
  { key: 'replay', label: '事件回放', role: null },
];

const ROLE_LABELS: Record<Role, string> = {
  teacher: '教师',
  facility: '设施人员',
  dispatcher: '调度员',
  repair: '维修人员',
  coordinator: '接待协调员',
  guard: '门岗',
  interpreter: '口译员',
};

function Shell() {
  const app = useApp();
  const [tab, setTab] = useState('teacher');

  if (!app.ready) {
    return <div style={{ padding: 40 }}>正在从 IndexedDB 回放事件…</div>;
  }

  return (
    <>
      <header className="app-header">
        <div>
          <h1>校园后勤与家长会谈接待工作台</h1>
          <div className="sub">React + TypeScript + IndexedDB + WebWorker ｜ 事件溯源 · 本地可回放 · 共同/个别记录分别建模</div>
        </div>
        <div className="header-controls">
          <label>
            当前身份
            <select value={app.user.id} onChange={(e) => app.switchUser(app.users.find((u) => u.id === e.target.value)!)}>
              {app.users.map((u) => (
                <option key={u.id} value={u.id}>
                  {ROLE_LABELS[u.role]}｜{u.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            网络
            <select value={app.online ? '1' : '0'} onChange={(e) => app.setOnline(e.target.value === '1')}>
              <option value="1">在线</option>
              <option value="0">离线</option>
            </select>
          </label>
          <label>
            模拟时钟
            <input
              type="time"
              value={minToHM(app.nowMin)}
              onChange={(e) => {
                const [h, m] = e.target.value.split(':').map(Number);
                app.setNowMin(h * 60 + m);
              }}
            />
          </label>
        </div>
      </header>
      <div className="layout">
        <nav className="sidebar">
          {NAV.map((n) => (
            <button key={n.key} className={tab === n.key ? 'active' : ''} onClick={() => setTab(n.key)}>
              {n.label}
              {n.role && <span className="sub" style={{ opacity: 0.65, fontSize: 11, marginLeft: 6 }}>
                {ROLE_LABELS[n.role]}
              </span>}
            </button>
          ))}
          <div className="role-note">
            演示提示：可随时切换身份体验各角色操作；离线开关与模拟时钟用于复现离线草稿、过期与冲突场景。
          </div>
        </nav>
        <main>
          {tab === 'teacher' && <TeacherView />}
          {tab === 'meeting-teacher' && <MeetingTeacherView />}
          {tab === 'facility' && <FacilityView />}
          {tab === 'dispatch' && <DispatchView />}
          {tab === 'repair' && <RepairView />}
          {tab === 'coordinator' && <CoordinatorView />}
          {tab === 'guard' && <GuardView />}
          {tab === 'interpreter' && <InterpreterView />}
          {tab === 'resources' && <ResourcesView />}
          {tab === 'replay' && <ReplayView />}
        </main>
      </div>
    </>
  );
}

export function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}
