import type { Project } from '../types';

export interface Segment {
  start: number;
  end: number;
}

const EPS = 1e-6;

/** 合并重叠或首尾相接的半开区间。 */
export function mergeSegments(segments: Segment[]): Segment[] {
  const sorted = segments
    .filter((s) => s.end - s.start > EPS)
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Segment[] = [];
  for (const seg of sorted) {
    const last = out[out.length - 1];
    if (last && seg.start <= last.end + EPS) {
      last.end = Math.max(last.end, seg.end);
    } else {
      out.push({ ...seg });
    }
  }
  return out;
}

export function totalSeconds(segments: Segment[]): number {
  return segments.reduce((acc, s) => acc + (s.end - s.start), 0);
}

/**
 * 半开区间集合作差：返回 a − b（先各自合并重叠 / 相接区间）。
 * 结果片段继承 a 片段的附加字段（如未达标时段的缺口统计）。
 * 用于从预演后的未达标时段中剔除原工程已有的部分，只保留「新增」时段。
 */
export function subtractSegments<T extends Segment>(a: T[], b: Segment[]): T[] {
  const am = mergeSegments(a) as T[];
  const bm = mergeSegments(b);
  const out: T[] = [];
  let j = 0;
  for (const seg of am) {
    let cursor = seg.start;
    const push = (s: number, e: number) => {
      if (e - s > EPS) out.push({ ...seg, start: s, end: e });
    };
    while (j < bm.length) {
      const cut = bm[j];
      if (cut.end <= seg.start + EPS) {
        j++; // 切口完全在本段之前，永久跳过
        continue;
      }
      if (cut.start >= seg.end - EPS) break; // 切口完全在本段之后，可能与后续 a 段相交，保留 j
      const cs = Math.max(cut.start, cursor);
      const ce = Math.min(cut.end, seg.end);
      if (cs > cursor + EPS) push(cursor, cs);
      cursor = Math.max(cursor, ce);
      if (cut.end >= seg.end - EPS) break; // 切口延伸出本段，需保留给下一段 a
      j++;
    }
    push(cursor, seg.end);
  }
  return out;
}

export interface UnderSegment extends Segment {
  /** 该时段内最少发声人数 */
  minSinging: number;
  /** 相对最低要求的最大缺口人数 */
  deficit: number;
}

/**
 * 扫描线计算某声部「人数不足」的时段（半开区间语义）。
 * 歌手在换气区间 [start, end) 内不发声；end 时刻即恢复发声。
 * 返回的相邻时段已合并，并附带该时段内最差人数统计。
 */
export function underCoveredSegments(
  breaths: Segment[],
  totalSingers: number,
  minSingers: number,
  duration: number,
): UnderSegment[] {
  if (duration <= 0 || minSingers <= 0) return [];
  if (totalSingers < minSingers) {
    const singing = Math.max(0, totalSingers);
    return [{ start: 0, end: duration, minSinging: singing, deficit: minSingers - singing }];
  }
  const threshold = totalSingers - minSingers; // 允许同时换气的最大人数
  const events: { t: number; d: number }[] = [];
  for (const b of breaths) {
    const s = Math.max(0, Math.min(duration, b.start));
    const e = Math.max(0, Math.min(duration, b.end));
    if (e - s <= EPS) continue;
    events.push({ t: s, d: 1 }, { t: e, d: -1 });
  }
  events.sort((a, b) => a.t - b.t);

  const raw: UnderSegment[] = [];
  let breathing = 0;
  let maxBreathing = 0;
  let segStart: number | null = null;
  let i = 0;
  while (i < events.length) {
    const t = events[i].t;
    if (segStart !== null && t - segStart > EPS) {
      raw.push(makeSeg(segStart, t, totalSingers, minSingers, maxBreathing));
      segStart = null;
    }
    // 同一时刻的所有事件先全部生效，再评估其后的区间（半开语义）
    while (i < events.length && Math.abs(events[i].t - t) < EPS) {
      breathing += events[i].d;
      i++;
    }
    if (breathing > threshold) {
      if (segStart === null) {
        segStart = t;
        maxBreathing = breathing;
      } else {
        maxBreathing = Math.max(maxBreathing, breathing);
      }
    }
  }
  if (segStart !== null && duration - segStart > EPS) {
    raw.push(makeSeg(segStart, duration, totalSingers, minSingers, maxBreathing));
  }

  // 合并相接时段，并汇总最差人数
  const merged: UnderSegment[] = [];
  for (const seg of raw) {
    const last = merged[merged.length - 1];
    if (last && seg.start <= last.end + EPS) {
      last.end = Math.max(last.end, seg.end);
      last.minSinging = Math.min(last.minSinging, seg.minSinging);
      last.deficit = Math.max(last.deficit, seg.deficit);
    } else {
      merged.push({ ...seg });
    }
  }
  return merged;
}

function makeSeg(start: number, end: number, total: number, min: number, maxBreathing: number): UnderSegment {
  const minSinging = total - maxBreathing;
  return { start, end, minSinging, deficit: Math.max(0, min - minSinging) };
}

/** 某声部当前的未达标时段。 */
export function partUnder(project: Project, partId: string): UnderSegment[] {
  const part = project.parts.find((p) => p.id === partId);
  if (!part) return [];
  const singers = project.singers.filter((s) => s.partId === partId);
  const breaths = singers.flatMap((s) => s.breaths);
  return underCoveredSegments(breaths, singers.length, part.minSingers, project.duration);
}

/** 全曲未达标总秒数（所有声部合并计算）。 */
export function projectUnderSeconds(project: Project): number {
  return project.parts.reduce((acc, p) => acc + totalSeconds(partUnder(project, p.id)), 0);
}
