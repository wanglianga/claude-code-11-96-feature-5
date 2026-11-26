// 时间工具：全天用“分钟数”表示时刻，保证 reducer 纯函数可回放

export function minToHM(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function hmToMin(hm: string): number {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
}

/** 两个半开区间 [s1,e1) [s2,e2) 是否重叠 */
export function overlaps(s1: number, e1: number, s2: number, e2: number): boolean {
  return s1 < e2 && s2 < e1;
}

export function todayISO(atMin: number): string {
  // 模拟场景固定在 2026-11-26，时钟只影响业务分钟
  return `2026-11-26T${minToHM(atMin)}:00`;
}
