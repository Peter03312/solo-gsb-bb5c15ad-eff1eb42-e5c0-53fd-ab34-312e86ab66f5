import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Project, RehearsalSnapshot, Selection } from './types';
import { createSampleProject } from './lib/sample';
import { loadProject, sanitizeProject, saveProject, uid } from './lib/storage';
import {
  createSnapshot,
  loadSnapshots,
  restoreProjectSnapshot,
  saveSnapshots,
} from './lib/snapshot';
import { normalizeBeatMap } from './lib/tempo';
import { partUnder, totalSeconds, type Segment } from './lib/coverage';
import { addedUnderByPart, addedUnderSeconds, applyAbsences, hasAbsences, type AbsenceInterval } from './lib/absence';
import { projectFatigue } from './lib/fatigue';
import { applyMove, findBestMove, type OptimizeResult } from './lib/optimize';
import { applyRelay, planRelay, type RelayRequest, type RelayResult, type RelaySuccess } from './lib/relay';
import { MIN_DURATION, clamp } from './lib/constraints';
import { fmtClock, fmtOffset } from './lib/format';
import Sidebar from './components/Sidebar';
import Timeline, { type Ghost } from './components/Timeline';
import OptimizerPanel from './components/OptimizerPanel';
import RelayPanel from './components/RelayPanel';
import AbsencePanel from './components/AbsencePanel';

export default function App() {
  const [project, setProject] = useState<Project>(() => loadProject() ?? createSampleProject());
  const [selection, setSelection] = useState<Selection | null>(null);
  const [range, setRange] = useState(10);
  const [result, setResult] = useState<OptimizeResult | null>(null);
  const [previewOffset, setPreviewOffset] = useState<number | null>(null);
  const [relay, setRelay] = useState<RelaySuccess | null>(null);
  /**
   * 临时缺席预演：纯页面状态（不写入工程、不持久化、不进快照）。
   * 切换 / 编辑工程（含节拍图）或进入寻优 / 接力预览时清空。
   */
  const [absences, setAbsences] = useState<AbsenceInterval[]>([]);
  const [pxPerSec, setPxPerSec] = useState(10);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [snapshots, setSnapshots] = useState<RehearsalSnapshot[]>(() => loadSnapshots());
  const fileRef = useRef<HTMLInputElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  // 本地自动保存（刷新后自动恢复）
  useEffect(() => {
    saveProject(project);
    setSavedAt(new Date());
  }, [project]);

  // 排练快照单独持久化（快照不随当前工程自动保存而改变）
  useEffect(() => {
    saveSnapshots(snapshots);
  }, [snapshots]);

  const clearOptimization = useCallback(() => {
    setResult(null);
    setPreviewOffset(null);
  }, []);

  const clearRelay = useCallback(() => setRelay(null), []);

  /** 退出临时缺席预演：清空缺席区间后覆盖立即恢复为原工程计算结果。 */
  const clearAbsences = useCallback(() => setAbsences([]), []);

  /**
   * 所有工程修改的统一入口：修改后寻优 / 接力预览均失效
   * （预览基于修改前的工程，继续展示会与时间轴不符）；
   * 缺席预演基于旧工程，切换或编辑工程时一并清空。
   */
  const mutate = useCallback(
    (fn: (p: Project) => Project) => {
      clearOptimization();
      clearRelay();
      clearAbsences();
      setProject(fn);
    },
    [clearOptimization, clearRelay, clearAbsences],
  );

  /**
   * 仅修改节拍图：换气段的实际秒位置保持不变（仅重新显示对应拍位），
   * 因此不影响寻优结果（寻优基于秒），无需清空寻优预览；
   * 但接力排程的候选是在旧拍域上枚举的，节拍图一变即失效，需退出接力预览。
   * 缺席区间按秒定义、本不受节拍图影响，但按「编辑工程即清空预演」的约定一并清空。
   */
  const mutateBeatMap = useCallback(
    (fn: (b: Project['beatMap']) => Project['beatMap']) => {
      clearRelay();
      clearAbsences();
      setProject((p) => ({ ...p, beatMap: normalizeBeatMap(fn(p.beatMap)) }));
    },
    [clearRelay, clearAbsences],
  );

  // 选中的换气段被删除后，清空选择
  useEffect(() => {
    if (!selection) return;
    const s = project.singers.find((x) => x.id === selection.singerId);
    if (!s || !s.breaths.some((b) => b.id === selection.intervalId)) {
      setSelection(null);
      clearOptimization();
    }
  }, [project, selection, clearOptimization]);

  const previewing = result !== null && previewOffset !== null;

  /**
   * 时间轴实际展示与覆盖计算所基于的工程：
   * 接力整组预览优先（预览期不允许同时做单段寻优）；其次为单段寻优预览。
   */
  const effectiveProject = useMemo(() => {
    if (relay) return applyRelay(project, relay);
    if (previewing && result) return applyMove(project, result.singerId, result.intervalId, previewOffset);
    return project;
  }, [project, relay, previewing, result, previewOffset]);

  /**
   * 覆盖计算专用工程：在 effectiveProject 之上叠加临时缺席预演
   * （缺席与同歌手既有换气先按半开区间合并，避免重叠重复扣人）。
   * 缺席预演与寻优 / 接力预览互斥，因此二者不会同时叠加。
   */
  const coverageProject = useMemo(
    () => (hasAbsences(absences) ? applyAbsences(effectiveProject, absences) : effectiveProject),
    [effectiveProject, absences],
  );

  const absenceActive = hasAbsences(absences);

  const coverage = useMemo(() => {
    const m = new Map<string, ReturnType<typeof partUnder>>();
    for (const p of coverageProject.parts) m.set(p.id, partUnder(coverageProject, p.id));
    return m;
  }, [coverageProject]);

  /** 对比原工程，各声部「由缺席新增」的未达标时段（非预演时为 null）。 */
  const addedCoverage = useMemo(() => {
    if (!absenceActive) return null;
    return addedUnderByPart(effectiveProject, absences);
  }, [absenceActive, effectiveProject, absences]);

  const addedUnderTotal = useMemo(
    () => (addedCoverage ? addedUnderSeconds(addedCoverage) : 0),
    [addedCoverage],
  );

  const totalUnder = useMemo(
    () => [...coverage.values()].reduce((acc, segs) => acc + totalSeconds(segs), 0),
    [coverage],
  );
  const underCount = useMemo(() => [...coverage.values()].reduce((acc, segs) => acc + segs.length, 0), [coverage]);

  /**
   * 持续发声疲劳警示：与覆盖计算一样基于 effectiveProject，
   * 因此拖拽、缩放、寻优 / 接力预览期间实时重算，取消预览即还原。
   */
  const fatigue = useMemo(() => projectFatigue(effectiveProject), [effectiveProject]);
  const fatigueCount = useMemo(
    () => [...fatigue.values()].reduce((acc, segs) => acc + segs.length, 0),
    [fatigue],
  );

  /** 侧栏疲劳汇总跳转：把时间轴滚动到对应歌手的对应时刻。 */
  const jumpToTime = useCallback(
    (singerId: string, t: number) => {
      const tl = timelineRef.current;
      if (!tl) return;
      const row = tl.querySelector(`[data-singer-row="${CSS.escape(singerId)}"]`);
      if (row) {
        const tlRect = tl.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        if (rowRect.top < tlRect.top || rowRect.bottom > tlRect.bottom) {
          tl.scrollTop += rowRect.top - tlRect.top - 34;
        }
      }
      tl.scrollTo({ left: Math.max(0, t * pxPerSec - 100), behavior: 'smooth' });
    },
    [pxPerSec],
  );

  const ghost: Ghost | null = useMemo(() => {
    if (relay || !previewing || !result) return null;
    const s = project.singers.find((x) => x.id === result.singerId);
    const b = s?.breaths.find((x) => x.id === result.intervalId);
    if (!s || !b) return null;
    return { singerId: s.id, start: b.start + previewOffset, end: b.end + previewOffset };
  }, [relay, previewing, result, project, previewOffset]);

  /** 接力排程整组预览：幽灵块 + 拍域窗口 */
  const relayPreview = useMemo(() => {
    if (!relay) return null;
    return {
      partId: relay.partId,
      windowStart: relay.windowStart,
      windowEnd: relay.windowEnd,
      ghosts: relay.assignments.map((a) => ({ singerId: a.singerId, start: a.start, end: a.end })),
    };
  }, [relay]);

  // ---------- 换气段操作 ----------
  const updateInterval = useCallback(
    (singerId: string, intervalId: string, start: number, end: number) => {
      mutate((p) => ({
        ...p,
        singers: p.singers.map((s) =>
          s.id !== singerId
            ? s
            : { ...s, breaths: s.breaths.map((b) => (b.id !== intervalId ? b : { ...b, start, end })) },
        ),
      }));
    },
    [mutate],
  );

  const addInterval = useCallback(
    (singerId: string, seg: Segment) => {
      if (seg.end - seg.start < MIN_DURATION) return;
      mutate((p) => ({
        ...p,
        singers: p.singers.map((s) =>
          s.id !== singerId ? s : { ...s, breaths: [...s.breaths, { id: uid(), ...seg }] },
        ),
      }));
    },
    [mutate],
  );

  const deleteInterval = useCallback(
    (singerId: string, intervalId: string) => {
      mutate((p) => ({
        ...p,
        singers: p.singers.map((s) =>
          s.id !== singerId ? s : { ...s, breaths: s.breaths.filter((b) => b.id !== intervalId) },
        ),
      }));
    },
    [mutate],
  );

  // Delete / Backspace 删除选中换气段
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (selection) deleteInterval(selection.singerId, selection.intervalId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection, deleteInterval]);

  // ---------- 临时缺席预演 ----------
  /** 添加一段缺席（半开 [start, end) 秒）；进入预演时退出寻优 / 接力预览（三种预览互斥）。 */
  const addAbsence = useCallback(
    (singerId: string, start: number, end: number) => {
      if (!(end > start)) return;
      clearOptimization();
      clearRelay();
      setAbsences((list) => [...list, { id: uid(), singerId, start, end }]);
    },
    [clearOptimization, clearRelay],
  );

  const removeAbsence = useCallback((id: string) => {
    setAbsences((list) => list.filter((a) => a.id !== id));
  }, []);

  // ---------- 寻优 ----------
  const runOptimize = () => {
    if (!selection) return;
    clearRelay();
    clearAbsences();
    const r = findBestMove(project, selection.singerId, selection.intervalId, Math.max(0, Math.round(range)));
    if (!r) return;
    setResult(r);
    setPreviewOffset(r.best.offset);
  };

  const applyPreview = () => {
    if (!result || previewOffset === null) return;
    setProject((p) => applyMove(p, result.singerId, result.intervalId, previewOffset));
    clearOptimization();
  };

  // ---------- 声部接力排程 ----------
  const runRelay = (req: RelayRequest): RelayResult => {
    clearOptimization();
    clearAbsences();
    const r = planRelay(project, req);
    // 仅在成功时进入整组幽灵块预览；失败原因（区分两类）交给面板展示
    setRelay(r.ok ? r : null);
    return r;
  };

  /** 确认：整组一次写入；取消：不改工程（effectProject 立即回到原工程）。 */
  const applyRelayPreview = () => {
    if (!relay) return;
    setProject((p) => applyRelay(p, relay));
    setRelay(null);
  };

  // ---------- 导入 / 导出 ----------
  const exportJson = () => {
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${project.name || 'breath-relay'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importJson = (file: File) => {
    file
      .text()
      .then((txt) => {
        const p = sanitizeProject(JSON.parse(txt));
        if (!p) throw new Error('invalid');
        clearOptimization();
        clearRelay();
        clearAbsences();
        setSelection(null);
        setProject(p);
      })
      .catch(() => alert('无法导入：文件不是有效的工程 JSON'));
  };

  const loadSample = () => {
    clearOptimization();
    clearRelay();
    clearAbsences();
    setSelection(null);
    setProject(createSampleProject());
  };

  // ---------- 排练快照 ----------
  /** 保存当前工程快照：冻结声部、歌手与换气区间（寻优 / 接力预览不影响快照内容）。 */
  const handleCreateSnapshot = (name: string) => {
    setSnapshots((list) => [createSnapshot(project, name), ...list]);
  };

  const handleDeleteSnapshot = (snapshotId: string) => {
    setSnapshots((list) => list.filter((s) => s.id !== snapshotId));
  };

  /**
   * 恢复快照：用快照中的声部 / 歌手 / 换气区间整体替换当前工程；
   * 节拍图、曲名与全曲时长保持现状。恢复后清除当前选中段与接力 / 寻优预览。
   */
  const handleRestoreSnapshot = (snapshot: RehearsalSnapshot) => {
    clearOptimization();
    clearRelay();
    clearAbsences();
    setSelection(null);
    setProject((p) => restoreProjectSnapshot(p, snapshot));
  };

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          🎵 换气接力 <span>合唱排练换气规划</span>
        </div>
        <div className="header-actions">
          <button onClick={loadSample}>载入示例数据</button>
          <button onClick={exportJson}>导出 JSON</button>
          <button onClick={() => fileRef.current?.click()}>导入 JSON</button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importJson(f);
              e.target.value = '';
            }}
          />
          {savedAt && <span className="saved">已自动保存到本地 {fmtClock(savedAt)}</span>}
        </div>
      </header>

      <div className="layout">
        <Sidebar
          project={project}
          coverage={coverage}
          fatigue={fatigue}
          mutate={mutate}
          mutateBeatMap={mutateBeatMap}
          snapshots={snapshots}
          onCreateSnapshot={handleCreateSnapshot}
          onRestoreSnapshot={handleRestoreSnapshot}
          onDeleteSnapshot={handleDeleteSnapshot}
          onJumpToTime={jumpToTime}
        />

        <main className="main">
          <div className="toolbar">
            <div className="stat">
              全曲未达标：
              <b className={totalUnder > 0 ? 'bad' : 'ok'}>{totalUnder.toFixed(1)}s</b>
              <span className="muted">
                （{underCount} 处{previewing ? ' · 寻优预览中' : ''}
                {relay ? ' · 接力预览中' : ''}
                {absenceActive ? ' · 临时缺席预演中' : ''}）
              </span>
              {absenceActive && (
                <em className={`absence-delta-badge ${addedUnderTotal > 0 ? 'absence-added' : 'ok'}`}>
                  {addedUnderTotal > 0 ? `缺席新增 +${addedUnderTotal.toFixed(1)}s` : '缺席未新增未达标'}
                </em>
              )}
            </div>
            <div className="stat">
              疲劳警示：
              <b className={fatigueCount > 0 ? 'warn' : 'ok'}>{fatigueCount} 处</b>
            </div>
            <div className="zoom">
              <span className="muted">缩放</span>
              <button onClick={() => setPxPerSec((v) => clamp(v / 1.25, 3, 40))}>−</button>
              <button onClick={() => setPxPerSec((v) => clamp(v * 1.25, 3, 40))}>＋</button>
            </div>
          </div>

          {previewing && result && (
            <div className="preview-banner">
              预览中：选中换气段位移 <b>{fmtOffset(previewOffset)}</b>
              ，红色为修复后仍不足的时段；虚线框为新位置，半透明块为原位置。
              <button className="primary" onClick={applyPreview}>
                应用
              </button>
              <button onClick={clearOptimization}>取消</button>
            </div>
          )}

          {relay && (
            <div className="preview-banner relay-banner">
              🔗 声部接力排程预览中：已为声部每位歌手安排一段新换气（虚线幽灵块），琥珀色为所选拍域窗口；
              红色覆盖行按整组写入后实时计算。
              <button className="primary" onClick={applyRelayPreview}>
                确认整组写入
              </button>
              <button onClick={clearRelay}>取消（不改工程）</button>
            </div>
          )}

          {absenceActive && (
            <div className="preview-banner absence-banner">
              🕳 临时缺席预演中：缺席区间已与各歌手既有换气按半开区间合并后重算声部覆盖，紫色为
              <b>由缺席新增</b>的未达标时段（原工程已有的红色条纹保留）；工程与换气段均未被修改。
              <button className="primary" onClick={clearAbsences}>
                退出预演（恢复原覆盖）
              </button>
            </div>
          )}

          <Timeline
            project={project}
            coverage={coverage}
            addedCoverage={addedCoverage}
            absences={absences}
            fatigue={fatigue}
            selection={selection}
            ghost={ghost}
            relayPreview={relayPreview}
            pxPerSec={pxPerSec}
            scrollRef={timelineRef}
            onSelect={(sel) => {
              clearOptimization();
              clearRelay();
              setSelection(sel);
            }}
            onUpdateInterval={updateInterval}
            onAddInterval={addInterval}
          />

          <RelayPanel
            project={project}
            result={relay}
            onPlan={runRelay}
            onApply={applyRelayPreview}
            onCancel={clearRelay}
          />

          <AbsencePanel
            project={project}
            absences={absences}
            addedCoverage={addedCoverage ?? new Map()}
            onAdd={addAbsence}
            onRemove={removeAbsence}
            onClear={clearAbsences}
          />

          <OptimizerPanel
            project={project}
            selection={selection}
            range={range}
            onRangeChange={setRange}
            result={result}
            previewOffset={previewOffset}
            onRun={runOptimize}
            onPreview={setPreviewOffset}
            onApply={applyPreview}
            onCancel={clearOptimization}
            onDelete={() => selection && deleteInterval(selection.singerId, selection.intervalId)}
          />
        </main>
      </div>
    </div>
  );
}
