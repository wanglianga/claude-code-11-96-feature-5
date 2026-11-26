// 全局应用状态：worker 快照、角色、在线状态、模拟时钟、草稿

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { AppEvent, Draft, Snapshot, User } from '../types';
import { workerClient } from '../worker/client';
import { initialSnapshot } from '../engine/reducer';
import { setSeqStart } from '../engine/commands';
import { getAllDrafts, putDraft, deleteDraft, resetDatabase } from '../db/idb';
import { SEED_USERS } from '../lib/seed';
import { uid } from '../lib/id';

interface AppState {
  ready: boolean;
  snapshot: Snapshot;
  user: User;
  online: boolean;
  nowMin: number;
  drafts: Draft[];
  replaySeq: number | null; // 非 null 时处于历史回放视图
}

interface AppContextValue extends AppState {
  users: User[];
  switchUser: (u: User) => void;
  setOnline: (v: boolean) => void;
  setNowMin: (m: number) => void;
  /** 执行命令：命令函数基于当前快照生成事件，再交给 worker 持久化+回放 */
  dispatch: (fn: (snap: Snapshot) => { ok: boolean; error?: string; events: AppEvent[] }) => Promise<void>;
  refreshDrafts: () => Promise<void>;
  saveDraft: (d: Omit<Draft, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'baseSeq' | 'conflictReason'>) => Promise<Draft>;
  updateDraft: (d: Draft) => Promise<void>;
  removeDraft: (id: string) => Promise<void>;
  replayAt: (seq: number | null) => Promise<void>;
  resetAll: () => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<Snapshot>(initialSnapshot());
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<User>(SEED_USERS[0]);
  const [online, setOnline] = useState(
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  const [nowMin, setNowMin] = useState(9 * 60); // 模拟时钟默认 09:00
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [replaySeq, setReplaySeq] = useState<number | null>(null);
  const liveRef = useRef<Snapshot>(snapshot);
  liveRef.current = snapshot;

  useEffect(() => {
    void workerClient.boot().then((s) => {
      setSnapshot(s);
      setReady(true);
    });
  }, []);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  const refreshDrafts = useCallback(async () => {
    setDrafts(await getAllDrafts());
  }, []);

  useEffect(() => {
    void refreshDrafts();
  }, [refreshDrafts, snapshot.seq]);

  const dispatch = useCallback<AppContextValue['dispatch']>(async (fn) => {
    // 历史回放中禁止基于旧快照写事件：先回到最新状态，避免 seq 冲突覆盖
    if (replaySeq !== null) {
      const latest = await workerClient.boot();
      setSnapshot(latest);
      setReplaySeq(null);
      liveRef.current = latest;
    }
    const base = liveRef.current;
    setSeqStart(base.seq);
    const result = fn(base);
    if (!result.ok) throw new Error(result.error ?? '命令执行失败');
    const next = await workerClient.append(result.events);
    setSnapshot(next);
    setReplaySeq(null);
  }, [replaySeq]);

  const saveDraft = useCallback<AppContextValue['saveDraft']>(
    async (input) => {
      const draft: Draft = {
        ...input,
        id: uid('draft'),
        status: 'draft',
        baseSeq: liveRef.current.seq,
        conflictReason: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await putDraft(draft);
      await refreshDrafts();
      return draft;
    },
    [refreshDrafts],
  );

  const updateDraft = useCallback(
    async (d: Draft) => {
      await putDraft({ ...d, updatedAt: new Date().toISOString() });
      await refreshDrafts();
    },
    [refreshDrafts],
  );

  const removeDraft = useCallback(
    async (id: string) => {
      await deleteDraft(id);
      await refreshDrafts();
    },
    [refreshDrafts],
  );

  const replayAt = useCallback(async (seq: number | null) => {
    if (seq === null) {
      setReplaySeq(null);
      const s = await workerClient.boot();
      setSnapshot(s);
      return;
    }
    setReplaySeq(seq);
    const s = await workerClient.replay(seq);
    setSnapshot(s);
  }, []);

  const resetAll = useCallback(async () => {
    const s = await resetDatabase().then(() => workerClient.reset());
    setSnapshot(s);
    setReplaySeq(null);
    await refreshDrafts();
  }, [refreshDrafts]);

  const value = useMemo<AppContextValue>(
    () => ({
      ready,
      snapshot,
      user,
      online,
      nowMin,
      drafts,
      replaySeq,
      users: SEED_USERS,
      switchUser: setUser,
      setOnline,
      setNowMin,
      dispatch,
      refreshDrafts,
      saveDraft,
      updateDraft,
      removeDraft,
      replayAt,
      resetAll,
    }),
    [ready, snapshot, user, online, nowMin, drafts, replaySeq, dispatch, refreshDrafts, saveDraft, updateDraft, removeDraft, replayAt, resetAll],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp 必须在 AppProvider 内使用');
  return ctx;
}
