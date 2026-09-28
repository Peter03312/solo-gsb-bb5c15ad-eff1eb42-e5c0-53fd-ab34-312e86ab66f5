import type { Project } from '../types';
import { mergeSegments, partUnder, subtractSegments, totalSeconds, type Segment, type UnderSegment } from './coverage';
import { uid } from './id';

/**
 * 临时缺席区间：半开区间 [start, end)，单位秒。
 * 仅存在于当前页面的预演状态中，不写入工程、不随快照冻结、不持久化。
 */
export interface AbsenceInterval extends Segment {
  id: string;
  singerId: string;
  start: number;
  end: number;
}

/** 是否存在任何缺席预演（无缺席时覆盖与原工程完全一致）。 */
export function hasAbsences(absences: AbsenceInterval[]): boolean {
  return absences.length > 0;
}

/**
 * 把缺席预演投影成一个「用于覆盖计算」的派生工程（不改动原工程）：
 * 对每位歌手，先把其缺席区间与既有换气区间放在一起按半开区间合并
 * （重叠 / 相接都并成一段），再交给既有的覆盖扫描。
 * 这样缺席与换气重叠时该歌手只算一次「不在场」，避免重复扣人。
 * 合并后的区间会重新生成 id（仅为满足 BreathInterval 结构，不再参与交互）。
 */
export function applyAbsences(project: Project, absences: AbsenceInterval[]): Project {
  const bySinger = new Map<string, Segment[]>();
  for (const a of absences) {
    const start = Math.min(Math.max(0, a.start), project.duration);
    const end = Math.min(Math.max(0, a.end), project.duration);
    if (end - start <= 1e-6) continue;
    const list = bySinger.get(a.singerId) ?? [];
    list.push({ start, end });
    bySinger.set(a.singerId, list);
  }
  return {
    ...project,
    singers: project.singers.map((s) => {
      const extra = bySinger.get(s.id);
      if (!extra) return s;
      const merged = mergeSegments([...s.breaths, ...extra]).map((seg) => ({ id: uid(), ...seg }));
      return { ...s, breaths: merged };
    }),
  };
}

/**
 * 对比原工程，逐声部求出「由缺席新增的未达标时段」：
 * 预演后的未达标时段减去原工程已有的未达标时段（半开集合作差）。
 */
export function addedUnderByPart(
  baseProject: Project,
  absences: AbsenceInterval[],
): Map<string, UnderSegment[]> {
  const previewProject = applyAbsences(baseProject, absences);
  const m = new Map<string, UnderSegment[]>();
  for (const part of baseProject.parts) {
    const before = partUnder(baseProject, part.id);
    const after = partUnder(previewProject, part.id);
    m.set(part.id, subtractSegments(after, before));
  }
  return m;
}

/** 各声部由缺席新增的未达标秒数合计。 */
export function addedUnderSeconds(added: Map<string, Segment[]>): number {
  return [...added.values()].reduce((acc, segs) => acc + totalSeconds(segs), 0);
}
