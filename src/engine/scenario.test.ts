import { describe, expect, it } from 'vitest';
import { initialSnapshot, replay } from './reducer';
import {
  cancelPlan,
  checkDraft,
  confirmBoundary,
  confirmPlan,
  createWorkOrder,
  failRetest,
  markRepaired,
  passRetest,
  proposePlan,
  publishPlan,
  setSeqStart,
  submitReport,
} from './commands';
import {
  buildMinimalPlan,
  buildSwapPlan,
  distanceBetween,
  evaluateRooms,
  validateMoves,
} from './scheduling';
import type { AppEvent, Draft, Snapshot } from '../types';
import { hmToMin } from '../lib/time';

/** 测试助手：依次执行命令，持续回放成快照 */
class World {
  snap: Snapshot = initialSnapshot();

  run(fn: (snap: Snapshot) => { ok: boolean; error?: string; events: AppEvent[] }): AppEvent[] {
    setSeqStart(this.snap.seq);
    const r = fn(this.snap);
    if (!r.ok) throw new Error(r.error ?? '命令失败');
    this.snap = replay(r.events, this.snap);
    return r.events;
  }

  tryRun(fn: (snap: Snapshot) => { ok: boolean; error?: string; events: AppEvent[] }): string {
    setSeqStart(this.snap.seq);
    const r = fn(this.snap);
    if (r.ok) throw new Error('预期失败但命令成功了');
    return r.error!;
  }
}

function leakScenario(): World {
  // 09:40 林老师在 B201 首报冷凝水漏水；09:45 周老师在 B202 续报同一主管
  const w = new World();
  w.run((s) =>
    submitReport(s, {
      roomId: 'r_B201',
      faultType: 'leak',
      description: '冷凝水主管接口滴水',
      photoIds: ['p1'],
      teacherId: 'u_teacher_a',
      atMin: hmToMin('09:40'),
    }),
  );
  w.run((s) =>
    submitReport(s, {
      roomId: 'r_B202',
      faultType: 'leak',
      description: '同一主管渗水到 B202 吊顶',
      photoIds: ['p2'],
      teacherId: 'u_teacher_b',
      atMin: hmToMin('09:45'),
    }),
  );
  return w;
}

describe('报修与事故合并', () => {
  it('同主管同类型的重复报修合并为一项事故，边界包含 B201 与 B202', () => {
    const w = leakScenario();
    const incidents = Object.values(w.snap.incidents);
    expect(incidents).toHaveLength(1);
    const inc = incidents[0];
    expect(inc.roomIds.sort()).toEqual(['r_B201', 'r_B202']);
    expect(inc.reportIds).toHaveLength(2);
    const reports = Object.values(w.snap.reports);
    expect(reports[0].duplicate).toBe(false);
    expect(reports[1].duplicate).toBe(true);
  });

  it('不同故障类型不合并', () => {
    const w = new World();
    w.run((s) =>
      submitReport(s, { roomId: 'r_C101', faultType: 'power', description: '断电', photoIds: [], teacherId: 'u_teacher_a', atMin: 540 }),
    );
    w.run((s) =>
      submitReport(s, { roomId: 'r_C101', faultType: 'equipment', description: '投影坏', photoIds: [], teacherId: 'u_teacher_a', atMin: 541 }),
    );
    expect(Object.keys(w.snap.incidents)).toHaveLength(2);
  });
});

describe('设施核准、封闭与工单门控', () => {
  it('核准边界 10:00-12:00 后两间教室同时封闭，未核准不能开工单', () => {
    const w = leakScenario();
    const inc = Object.values(w.snap.incidents)[0];
    const err = w.tryRun((s) =>
      createWorkOrder(s, { incidentId: inc.id, summary: '维修', assignee: '赵维修', atMin: hmToMin('09:50') }),
    );
    expect(err).toContain('边界尚未核准');

    w.run((s) =>
      confirmBoundary(s, {
        incidentId: inc.id,
        roomIds: ['r_B201', 'r_B202'],
        estimatedEndMin: hmToMin('12:00'),
        atMin: hmToMin('09:50'),
        by: 'u_facility',
      }),
    );
    expect(w.snap.closures.r_B201.closed).toBe(true);
    expect(w.snap.closures.r_B202.closed).toBe(true);
    expect(w.snap.closures.r_B201.estimatedEndMin).toBe(hmToMin('12:00'));

    w.run((s) =>
      createWorkOrder(s, { incidentId: inc.id, summary: '冷凝水主管维修', assignee: '赵维修', atMin: hmToMin('09:55') }),
    );
    expect(Object.values(w.snap.workOrders)).toHaveLength(1);
    expect(w.snap.incidents[inc.id].status).toBe('work_order');
  });
});

describe('候选教室过滤', () => {
  it('A 班：D301 因无障碍被否决，C101 合格且距离 8 分钟', () => {
    const w = leakScenario();
    const inc = Object.values(w.snap.incidents)[0];
    w.run((s) =>
      confirmBoundary(s, { incidentId: inc.id, roomIds: ['r_B201', 'r_B202'], estimatedEndMin: 720, atMin: 590, by: 'u_facility' }),
    );
    const checks = evaluateRooms(w.snap, w.snap.courses.c_A);
    const d301 = checks.find((c) => c.room.id === 'r_D301')!;
    expect(d301.eligible).toBe(false);
    expect(d301.reasons.join('；')).toContain('无障碍');
    const c101 = checks.find((c) => c.room.id === 'r_C101')!;
    expect(c101.eligible).toBe(true);
    expect(distanceBetween('r_B201', 'r_C101')).toBe(8);
  });

  it('B 班：D301 设备容量合格但被弹性 S 占用，C102 全时段空闲', () => {
    const w = leakScenario();
    const inc = Object.values(w.snap.incidents)[0];
    w.run((s) =>
      confirmBoundary(s, { incidentId: inc.id, roomIds: ['r_B201', 'r_B202'], estimatedEndMin: 720, atMin: 590, by: 'u_facility' }),
    );
    const checks = evaluateRooms(w.snap, w.snap.courses.c_B);
    const d301 = checks.find((c) => c.room.id === 'r_D301')!;
    expect(d301.eligible).toBe(false);
    expect(d301.reasons).toContain('课程全时段不空闲');
    const c102 = checks.find((c) => c.room.id === 'r_C102')!;
    expect(c102.eligible).toBe(true);
    expect(c102.room.capacity).toBe(24);
  });

  it('封闭教室不会出现在合格候选中', () => {
    const w = leakScenario();
    const inc = Object.values(w.snap.incidents)[0];
    w.run((s) =>
      confirmBoundary(s, { incidentId: inc.id, roomIds: ['r_B201', 'r_B202'], estimatedEndMin: 720, atMin: 590, by: 'u_facility' }),
    );
    const checks = evaluateRooms(w.snap, w.snap.courses.c_A);
    for (const roomId of ['r_B201', 'r_B202']) {
      expect(checks.find((c) => c.room.id === roomId)!.reasons).toContain('教室已封闭');
    }
  });
});

/** 已核准并封闭 B201/B202（10:00-12:00 场景）的世界 */
function closedWorld(): World {
  const w = leakScenario();
  const inc = Object.values(w.snap.incidents)[0];
  w.run((s) =>
    confirmBoundary(s, { incidentId: inc.id, roomIds: ['r_B201', 'r_B202'], estimatedEndMin: 720, atMin: 590, by: 'u_facility' }),
  );
  return w;
}

describe('两种改排方案的学生分钟', () => {
  it('方案一：只移动 A、B，总量 24×8 + 18×18 = 516', () => {
    const w = closedWorld();
    const plan = buildMinimalPlan(w.snap);
    expect(plan.feasible).toBe(true);
    expect(plan.studentMinutes).toBe(516);
    const a = plan.moves.find((m) => m.courseId === 'c_A')!;
    const b = plan.moves.find((m) => m.courseId === 'c_B')!;
    expect(a.toRoomId).toBe('r_C101');
    expect(a.studentMinutes).toBe(192);
    expect(b.toRoomId).toBe('r_C102');
    expect(b.studentMinutes).toBe(324);
    expect(plan.notifiedClassIds.sort()).toEqual(['c_A', 'c_B']);
  });

  it('方案二：B 与弹性 S 交换，总量 24×8 + 18×7 + 12×7 = 402，少 114', () => {
    const w = closedWorld();
    const plan = buildSwapPlan(w.snap);
    expect(plan.feasible).toBe(true);
    expect(plan.studentMinutes).toBe(402);
    const moves = Object.fromEntries(plan.moves.map((m) => [m.courseId, m]));
    expect(moves.c_A.toRoomId).toBe('r_C101');
    expect(moves.c_B.toRoomId).toBe('r_D301');
    expect(moves.c_B.studentMinutes).toBe(126);
    expect(moves.c_S.toRoomId).toBe('r_C102');
    expect(moves.c_S.studentMinutes).toBe(84);
    // 多移动一个班、多通知一组
    expect(plan.notifiedClassIds.sort()).toEqual(['c_A', 'c_B', 'c_S']);
    expect(plan.notifiedClassIds.length - buildMinimalPlan(w.snap).notifiedClassIds.length).toBe(1);
  });

  it('方案二的全部移动通过重叠/封闭/设备硬校验', () => {
    const w = closedWorld();
    const errors = validateMoves(w.snap, buildSwapPlan(w.snap).moves);
    expect(errors).toEqual([]);
  });

  it('人为制造同房同时段移动会被 validateMoves 拒绝（临时改排不得重叠）', () => {
    const w = closedWorld();
    const bad = [
      { courseId: 'c_A', fromRoomId: 'r_B201', toRoomId: 'r_C102', studentMinutes: 24 * 14 },
      { courseId: 'c_B', fromRoomId: 'r_B202', toRoomId: 'r_C102', studentMinutes: 18 * 18 },
    ];
    const errors = validateMoves(w.snap, bad);
    expect(errors.some((e) => e.includes('课程重叠'))).toBe(true);
  });
});

describe('教师确认与发布门控、通知版本', () => {
  it('未取得全部教师确认不能发布；发布后师生通知同版本，再发布生成 v2 并作废旧版', () => {
    const w = closedWorld();
    const proposal = buildSwapPlan(w.snap);
    w.run((s) => proposePlan(s, { proposal, atMin: 600, by: 'u_dispatch' }));
    const plan = Object.values(w.snap.plans)[0];

    const blocked = w.tryRun((s) => publishPlan(s, { planId: plan.id, atMin: 601 }));
    expect(blocked).toContain('教师未确认');

    for (const courseId of ['c_A', 'c_B', 'c_S']) {
      w.run((s) => confirmPlan(s, { planId: plan.id, courseId, atMin: 602, by: s.courses[courseId].teacherId }));
    }
    w.run((s) => publishPlan(s, { planId: plan.id, atMin: 603 }));

    expect(w.snap.plans[plan.id].status).toBe('published');
    const notes = Object.values(w.snap.notifications);
    expect(notes).toHaveLength(3);
    expect(notes.every((n) => n.version === 1)).toBe(true);
    // 课程实际房间已改排
    expect(w.snap.courses.c_B.roomId).toBe('r_D301');
    expect(w.snap.courses.c_S.roomId).toBe('r_C102');

    // 取消已发布方案必须被拒绝
    const cancelErr = w.tryRun((s) => cancelPlan(s, { planId: plan.id, reason: '测试', atMin: 604 }));
    expect(cancelErr).toContain('已发布');

    // 再建一个针对 A 的方案并发布 -> A 收到 v2，v1 被标记 superseded
    const v2 = buildMinimalPlan({
      ...w.snap,
      // 让 A 重新成为受影响课程：把 A 放回已封闭的 B201
      courses: { ...w.snap.courses, c_A: { ...w.snap.courses.c_A, roomId: 'r_B201', status: 'normal', planId: null } },
    });
    // 该构造下 minimal 仍可行（C101 此刻空闲），只取其移动做手工方案
    const moveA = v2.moves.find((m) => m.courseId === 'c_A')!;
    w.run((s) =>
      proposePlan(s, {
        proposal: {
          strategy: 'minimal',
          feasible: true,
          moves: [moveA],
          studentMinutes: moveA.studentMinutes,
          notifiedClassIds: ['c_A'],
          affectedRoomIds: ['r_B201'],
          reasons: [],
        },
        atMin: 605,
        by: 'u_dispatch',
      }),
    );
    const plan2 = Object.values(w.snap.plans).find((p) => p.id !== plan.id)!;
    w.run((s) => confirmPlan(s, { planId: plan2.id, courseId: 'c_A', atMin: 606, by: 'u_teacher_a' }));
    w.run((s) => publishPlan(s, { planId: plan2.id, atMin: 607 }));
    const aNotes = Object.values(w.snap.notifications).filter((n) => n.courseId === 'c_A');
    expect(aNotes.map((n) => n.version).sort()).toEqual([1, 2]);
    expect(aNotes.find((n) => n.version === 1)!.superseded).toBe(true);
    expect(aNotes.find((n) => n.version === 2)!.superseded).toBe(false);
  });
});

describe('维修、复测与不自动回滚', () => {
  it('11:30 复测失败维持封闭且已发布安排不回滚，14:00 复测通过才解封', () => {
    const w = closedWorld();
    const inc = Object.values(w.snap.incidents)[0];

    // 发布方案二
    w.run((s) => proposePlan(s, { proposal: buildSwapPlan(s), atMin: 600, by: 'u_dispatch' }));
    const plan = Object.values(w.snap.plans)[0];
    for (const courseId of ['c_A', 'c_B', 'c_S']) {
      w.run((x) => confirmPlan(x, { planId: plan.id, courseId, atMin: 602, by: x.courses[courseId].teacherId }));
    }
    w.run((s) => publishPlan(s, { planId: plan.id, atMin: 603 }));
    const roomsAfterPublish = {
      c_A: w.snap.courses.c_A.roomId,
      c_B: w.snap.courses.c_B.roomId,
      c_S: w.snap.courses.c_S.roomId,
    };

    // 维修中 -> 标记已修复
    w.run((s) => createWorkOrder(s, { incidentId: inc.id, summary: '主管维修', assignee: '赵维修', atMin: 610 }));
    w.run((s) => markRepaired(s, { incidentId: inc.id, atMin: hmToMin('11:00'), by: 'u_repair' }));
    // 关键：标记已修复后封闭依旧
    expect(w.snap.closures.r_B201.closed).toBe(true);
    expect(w.snap.closures.r_B202.closed).toBe(true);
    expect(w.snap.incidents[inc.id].status).toBe('repaired');

    // 11:30 复测失败
    w.run((s) =>
      failRetest(s, { incidentId: inc.id, atMin: hmToMin('11:30'), by: 'u_facility', note: '仍有滴水' }),
    );
    expect(w.snap.closures.r_B201.closed).toBe(true);
    expect(w.snap.closures.r_B202.closed).toBe(true);
    expect(w.snap.incidents[inc.id].retestFailures).toHaveLength(1);

    // 超过预计修复时间 12:00 也不会自动解封/回滚
    expect(w.snap.closures.r_B201.estimatedEndMin).toBe(720);
    // 已发布安排保持不变
    expect(w.snap.courses.c_A.roomId).toBe(roomsAfterPublish.c_A);
    expect(w.snap.courses.c_B.roomId).toBe(roomsAfterPublish.c_B);
    expect(w.snap.courses.c_S.roomId).toBe(roomsAfterPublish.c_S);
    expect(w.snap.plans[plan.id].status).toBe('published');

    // 非 repaired 状态不能复测（失败后仍允许继续复测，因为状态保持 repaired）
    // 14:00 复测通过 -> 解封
    w.run((s) => passRetest(s, { incidentId: inc.id, atMin: hmToMin('14:00'), by: 'u_facility' }));
    expect(w.snap.closures.r_B201.closed).toBe(false);
    expect(w.snap.closures.r_B202.closed).toBe(false);
    expect(w.snap.closures.r_B201.reopenedAt).toContain('14:00');
    expect(w.snap.incidents[inc.id].status).toBe('verified');
    // 解封不等于回滚改排：已发布安排仍然保留
    expect(w.snap.courses.c_B.roomId).toBe(roomsAfterPublish.c_B);
  });
});

describe('离线草稿：过期与冲突', () => {
  function draft(over: Partial<Draft>): Draft {
    return {
      id: 'd1',
      teacherId: 'u_teacher_a',
      roomId: 'r_B201',
      courseId: 'c_A',
      faultType: 'leak',
      description: '离线草稿',
      photoIds: [],
      status: 'draft',
      baseSeq: 0,
      conflictReason: null,
      createdAt: '',
      updatedAt: '',
      ...over,
    };
  }

  it('课程时段结束后草稿判为过期，不能发布过期教室报修', () => {
    const w = closedWorld();
    const verdict = checkDraft(w.snap, draft({ baseSeq: w.snap.seq }), hmToMin('11:30'));
    expect(verdict.kind).toBe('expired');
  });

  it('联网后课程已被改排，旧草稿进入冲突处理，不能覆盖新安排', () => {
    const w = closedWorld();
    const baseBeforePublish = w.snap.seq;
    w.run((s) => proposePlan(s, { proposal: buildSwapPlan(s), atMin: 600, by: 'u_dispatch' }));
    const plan = Object.values(w.snap.plans)[0];
    for (const courseId of ['c_A', 'c_B', 'c_S']) {
      w.run((x) => confirmPlan(x, { planId: plan.id, courseId, atMin: 602, by: x.courses[courseId].teacherId }));
    }
    w.run((s) => publishPlan(s, { planId: plan.id, atMin: 603 }));

    const verdict = checkDraft(w.snap, draft({ baseSeq: baseBeforePublish }), hmToMin('09:55'));
    expect(verdict.kind).toBe('conflict');
    if (verdict.kind === 'conflict') expect(verdict.reason).toContain('已被改排');
  });

  it('未过期且未改排的草稿检查通过', () => {
    const w = closedWorld();
    const verdict = checkDraft(w.snap, draft({ baseSeq: w.snap.seq }), hmToMin('09:55'));
    expect(verdict.kind).toBe('ok');
  });
});
