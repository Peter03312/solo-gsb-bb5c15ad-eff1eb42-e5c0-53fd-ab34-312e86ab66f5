import { useState } from 'react';
import type { Project } from '../types';
import type { AbsenceInterval } from '../lib/absence';
import { snap } from '../lib/constraints';
import { fmtSec } from '../lib/format';

interface Props {
  project: Project;
  /** 当前页面的临时缺席区间（不写入工程）；null/空数组 = 未在预演 */
  absences: AbsenceInterval[];
  /** 各声部由缺席新增的未达标时段（用于显示新增秒数） */
  addedCoverage: Map<string, { start: number; end: number }[]>;
  onAdd: (singerId: string, start: number, end: number) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
}

const EPS = 1e-6;

export default function AbsencePanel(props: Props) {
  const { project, absences } = props;
  const [singerId, setSingerId] = useState(project.singers[0]?.id ?? '');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');

  const effectiveSingerId = project.singers.some((s) => s.id === singerId)
    ? singerId
    : project.singers[0]?.id ?? '';
  const singer = project.singers.find((s) => s.id === effectiveSingerId) ?? null;

  const s0 = Number(start);
  const s1 = Number(end);
  const formError = (() => {
    if (!singer) return '工程中还没有歌手';
    if (start.trim() === '' || end.trim() === '') return null; // 留空不报错，等待输入
    if (!Number.isFinite(s0) || !Number.isFinite(s1)) return '起点和终点必须是数字';
    if (s0 < 0 || s1 < 0) return '时间不能为负';
    if (s1 - s0 < EPS) return '终点必须晚于起点（半开区间 [起, 止)）';
    if (s1 > project.duration + EPS) return `终点（${fmtSec(s1)}）超出全曲时长 ${fmtSec(project.duration)}`;
    return null;
  })();

  const submit = () => {
    if (!singer || formError) return;
    props.onAdd(singer.id, snap(Math.max(0, s0)), snap(Math.min(project.duration, s1)));
    setStart('');
    setEnd('');
  };

  const bySinger = new Map<string, AbsenceInterval[]>();
  for (const a of absences) {
    const list = bySinger.get(a.singerId) ?? [];
    list.push(a);
    bySinger.set(a.singerId, list);
  }

  const totalAdded = [...props.addedCoverage.values()].reduce(
    (acc, segs) => acc + segs.reduce((n, seg) => n + (seg.end - seg.start), 0),
    0,
  );

  return (
    <section className="optimizer absence-panel">
      <h3>
        🕳 临时缺席预演
        {absences.length > 0 && <span className="absence-live badge">预演中（仅当前页面）</span>}
      </h3>
      <p className="hint">
        为歌手临时添加 / 移除以秒计的缺席区间（半开 [起, 止)），覆盖按「缺席与该歌手既有换气先合并、再按声部重算」。
        预演只影响本页显示，<b>不改工程、不写换气段、不持久化</b>；切换或编辑工程时自动清空，退出后恢复原覆盖。
      </p>

      <div className="absence-form">
        <label className="relay-field">
          <span>歌手</span>
          <select value={effectiveSingerId} onChange={(e) => setSingerId(e.target.value)}>
            {project.parts.flatMap((part) => {
              const singers = project.singers.filter((s) => s.partId === part.id);
              if (singers.length === 0) return [];
              return [
                <optgroup key={part.id} label={part.name}>
                  {singers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </optgroup>,
              ];
            })}
          </select>
        </label>
        <label className="relay-field">
          <span>起</span>
          <input
            type="number"
            min={0}
            step={0.1}
            placeholder="秒"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </label>
        <label className="relay-field">
          <span>止（不含）</span>
          <input
            type="number"
            min={0}
            step={0.1}
            placeholder="秒"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </label>
        <button className="primary" onClick={submit} disabled={!!formError || start.trim() === '' || end.trim() === ''}>
          添加缺席
        </button>
      </div>
      {formError && <p className="relay-error bad">⚠ {formError}</p>}

      {absences.length === 0 ? (
        <p className="hint">尚无缺席区间。添加后时间轴覆盖行将用紫色标出「由缺席新增」的未达标时段。</p>
      ) : (
        <>
          <div className="absence-summary">
            <span>
              共 <b>{absences.length}</b> 段缺席；由缺席新增的未达标合计{' '}
              <b className={totalAdded > 0 ? 'absence-added' : 'ok'}>{totalAdded.toFixed(1)}s</b>
            </span>
            <button className="danger" onClick={props.onClear}>
              全部移除并退出预演
            </button>
          </div>
          <div className="absence-groups">
            {project.parts.map((part) => {
              const singers = project.singers.filter((s) => s.partId === part.id);
              const rows = singers
                .map((s) => ({ s, list: (bySinger.get(s.id) ?? []).slice().sort((a, b) => a.start - b.start) }))
                .filter((r) => r.list.length > 0);
              if (rows.length === 0) return null;
              const added = props.addedCoverage.get(part.id) ?? [];
              const addedSec = added.reduce((n, seg) => n + (seg.end - seg.start), 0);
              return (
                <div className="absence-group" key={part.id}>
                  <div className="absence-group-head">
                    <span className="dot" style={{ background: part.color }} />
                    <b>{part.name}</b>
                    <em className={addedSec > 0 ? 'absence-added' : 'muted'}>
                      {addedSec > 0 ? `新增未达标 +${addedSec.toFixed(1)}s` : '无新增未达标'}
                    </em>
                  </div>
                  {rows.map(({ s, list }) => (
                    <div className="absence-singer" key={s.id}>
                      <span className="absence-singer-name">{s.name}</span>
                      {list.map((a) => (
                        <span className="absence-chip" key={a.id} title={`临时缺席 ${fmtSec(a.start)} – ${fmtSec(a.end)}（点击移除）`}>
                          {fmtSec(a.start)} – {fmtSec(a.end)}
                          <button className="absence-chip-x" title="移除该缺席区间" onClick={() => props.onRemove(a.id)}>
                            ✕
                          </button>
                        </span>
                      ))}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
