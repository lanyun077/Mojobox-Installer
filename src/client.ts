import type { Bundle, RuntimeEntry } from './contracts.js';
import type { Plan, TaskRecord } from './manager.js';
import type { CatalogView } from './catalog.js';

declare const require: (id: string) => any;
declare const exports: { apply: typeof apply; inject: string[] };
interface ClientContext {
  remoteAccess: { whenAccess(method: string, effect: () => unknown): void };
  slots: { inject(name: string, effect: () => unknown): unknown; register(options: unknown, component: unknown): unknown };
  effect(effect: () => unknown): void;
}
interface Snapshot { hostVersion: string; busy: boolean; task?: TaskRecord; records: TaskRecord[]; bundles: Bundle[]; runtime: RuntimeEntry[]; catalog?: CatalogView }
const { createElement: h, useEffect, useState, useRef, useMemo } = require('react');
const actionLabels = { install: '新增', reuse: '复用', update: '可更新', 'keep-newer': '保留高版本', unsupported: '无法执行' };
const resultLabels = { running: '执行中', pending: '等待', installed: '已安装', reused: '已复用', skipped: '已跳过', 'dependency-skipped': '依赖未满足', failed: '失败', unconfirmed: '待核对' };
const taskLabels = { running: '正在安装', complete: '安装完成', partial: '部分完成', failed: '安装未完成', interrupted: '安装中断' };

function apply(ctx: ClientContext) {
  let state = { snapshot: null as Snapshot | null, plan: null as Plan | null, selected: [] as string[], working: false, pending: '', operationRecord: '', retrying: false, submittedTaskId: '', savingLog: false, savedLogPath: '', catalogWorking: false, refreshing: false, notice: '', error: '', connectionError: '', view: 'import' };
  let disposed = false;
  const lifetime = new AbortController();
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<typeof state>) => {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const api = async (action: string, init?: RequestInit) => {
    const timeout = AbortSignal.timeout(action === 'status' ? 15000 : 120000);
    try {
      const response = await fetch(`api/mojobox/${action}`, { ...init, signal: AbortSignal.any([lifetime.signal, timeout]) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
      return value;
    } catch (error) {
      if (timeout.aborted) throw new Error('请求超时，请检查连接并核对当前任务状态');
      throw error;
    }
  };
  let snapshotKey = '';
  let refreshing: Promise<void> | undefined;
  const refresh = (): Promise<void> => {
    return refreshing ??= (async () => {
      try {
        const snapshot: Snapshot = await api('status');
        const key = JSON.stringify(snapshot);
        if (key !== snapshotKey) { snapshotKey = key; publish({ snapshot, connectionError: '', ...(snapshot.records.some(task => task.id === state.submittedTaskId) ? { submittedTaskId: '' } : {}) }); }
        else if (state.connectionError) publish({ connectionError: '' });
      } catch (error) { if (!disposed && state.connectionError !== String(error)) publish({ connectionError: String(error) }); }
    })().finally(() => { refreshing = undefined; });
  };
  const refreshManually = async () => {
    if (state.refreshing) return;
    publish({ refreshing: true, notice: '' });
    try { await refresh(); if (!state.connectionError) publish({ notice: '状态已刷新' }); }
    finally { publish({ refreshing: false }); }
  };
  const refreshCatalog = async () => {
    if (state.catalogWorking) return;
    publish({ catalogWorking: true, notice: '', error: '' });
    try {
      const catalog: CatalogView = await api('catalog-refresh', { method: 'POST' });
      if (catalog.error || catalog.stale) throw new Error(catalog.error ?? '目录未核验');
    }
    catch (error) { publish({ error: `目录检查失败：${String(error)}` }); }
    finally { await refresh(); publish({ catalogWorking: false }); }
  };
  const previewRemote = async (id: string, version: string) => {
    if (state.working || state.snapshot?.busy) return;
    publish({ working: true, pending: '正在下载整合包并核对组件…', error: '', notice: '', plan: null });
    try {
      const plan: Plan = await api('catalog-preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, version }) });
      publish({ plan, selected: plan.selected, view: 'import' });
    } catch (error) { publish({ error: `远端包预览失败：${String(error)}` }); }
    finally { await refresh(); publish({ working: false, pending: '' }); }
  };
  const importFile = async (file?: File) => {
    if (!file || state.working || state.snapshot?.busy) return;
    publish({ working: true, pending: '正在读取整合包并核对组件…', plan: null, error: '', notice: '' });
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('整合包超过 2 MiB 限制');
      const plan: Plan = await api('preview', { method: 'POST', body: file });
      publish({ plan, selected: plan.selected, view: 'import' });
    } catch (error) { publish({ error: `无法导入：${String(error)}` }); }
    finally { await refresh(); publish({ working: false, pending: '' }); }
  };
  const replan = async (recordId: string, failedOnly: boolean) => {
    if (state.working || state.snapshot?.busy) return;
    publish({ working: true, operationRecord: recordId, retrying: failedOnly, pending: failedOnly ? '正在核对失败项，准备重试…' : '正在检查整合包更新…', error: '', notice: '', plan: null });
    try {
      let newer;
      if (!failedOnly) {
        const catalog: CatalogView = await api('catalog-refresh', { method: 'POST' });
        if (catalog.error || catalog.stale) throw new Error(catalog.error ?? '目录尚未核验');
        const record = state.snapshot?.records.find(task => task.id === recordId);
        newer = catalog.entries.find(entry => entry.id === record?.pack.manifest.id && entry.newer);
      }
      const plan: Plan = newer
        ? await api('catalog-preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: newer.id, version: newer.version }) })
        : await api('replan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ recordId, failedOnly }) });
      publish({ plan, selected: plan.selected, view: 'import', notice: failedOnly ? '失败项已核对，请确认后重试' : newer ? `发现新版 ${newer.version}，请确认更新项` : '未发现新版整合包，已重新核对当前目标' });
    } catch (error) { publish({ error: `${failedOnly ? '准备重试失败' : '核对更新失败'}：${String(error)}` }); }
    finally { await refresh(); publish({ working: false, pending: '', operationRecord: '' }); }
  };
  const start = async () => {
    if (!state.plan || state.working || state.snapshot?.busy) return;
    publish({ working: true, pending: '正在提交安装任务…', error: '', notice: '' });
    try {
      const result = await api('start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ planId: state.plan.id, selected: state.selected }) });
      publish({ plan: null, view: 'installed', notice: '', submittedTaskId: result.taskId }); await refresh();
    } catch (error) {
      publish({ plan: null, view: 'installed', error: `安装提交未完成确认：${String(error)}。请核对任务记录；需要重试时重新预览，避免重复提交。` });
      await refresh();
    }
    finally { publish({ working: false, pending: '' }); }
  };
  ctx.effect(() => {
    let polling = false;
    let lastPoll = 0;
    const timer = setInterval(() => {
      if (!listeners.size || polling || document.visibilityState === 'hidden' || Date.now() - lastPoll < (state.snapshot?.busy || state.working ? 1500 : 10000)) return;
      lastPoll = Date.now();
      polling = true; void refresh().finally(() => { polling = false; });
    }, 1500);
    return () => { disposed = true; clearInterval(timer); lifetime.abort(); listeners.clear(); };
  });

  function Section() {
    const [view, setView] = useState(state) as [typeof state, (value: typeof state) => void];
    const [detailId, setDetailId] = useState('') as [string, (id: string) => void];
    const [diagnosticsOpen, setDiagnosticsOpen] = useState(false) as [boolean, (open: boolean) => void];
    const [expandedTasks, setExpandedTasks] = useState([]) as [string[], (ids: string[]) => void];
    const planTitle = useRef(null) as { current: HTMLHeadingElement | null };
    const statusPanel = useRef(null) as { current: HTMLDivElement | null };
    const detailTitle = useRef(null) as { current: HTMLHeadingElement | null };
    const packGrid = useRef(null) as { current: HTMLDivElement | null };
    const lastOpened = useRef('') as { current: string };
    useEffect(() => {
      if (detailId) detailTitle.current?.focus();
      else if (lastOpened.current) Array.from(packGrid.current?.querySelectorAll('button') ?? []).find(button => button.dataset.packId === lastOpened.current)?.focus();
    }, [detailId]);
    useEffect(() => {
      const target = view.view === 'import' && view.plan ? planTitle.current : view.view === 'installed' ? statusPanel.current : null;
      target?.scrollIntoView({ block: 'start' });
      target?.focus({ preventScroll: true });
    }, [view.plan?.id, view.view]);
    useEffect(() => {
      const listener = () => setView(state);
      listeners.add(listener); setView(state); void refresh(); void refreshCatalog();
      return () => listeners.delete(listener);
    }, []);
    const busy = view.working || view.snapshot?.busy || !!view.submittedTaskId;
    const card = { border: '1px solid #8883', borderRadius: 16, padding: 20, marginTop: 16 };
    const button = { border: '1px solid #8885', borderRadius: 8, padding: '8px 16px', minHeight: 36, font: 'inherit', background: 'transparent', color: 'inherit', cursor: 'pointer' };
    const catalog = view.snapshot?.catalog;
    const detail = catalog?.entries.find(entry => entry.id === detailId);
    const inventory = useMemo(() => {
      const bundles = new Map<string, Bundle>();
      const runtime = new Map<string, RuntimeEntry[]>();
      for (const bundle of view.snapshot?.bundles ?? []) if (bundle.installed || bundle.availability !== 'missing') bundles.set(bundle.name, bundle);
      for (const entry of view.snapshot?.runtime ?? []) { const rows = runtime.get(entry.moduleName) ?? []; rows.push(entry); runtime.set(entry.moduleName, rows); }
      return { bundles, runtime };
    }, [view.snapshot?.bundles, view.snapshot?.runtime]) as { bundles: Map<string, Bundle>; runtime: Map<string, RuntimeEntry[]> };
    const report = () => JSON.stringify({ version: '0.0.1-p3.0', hostVersion: view.snapshot?.hostVersion, task: view.snapshot?.task, records: view.snapshot?.records, catalog, pending: view.pending, error: view.error, connectionError: view.connectionError }, null, 2);
    const saveLog = async (task?: TaskRecord) => {
      if (state.savingLog) return;
      publish({ savingLog: true, savedLogPath: '', notice: '正在保存日志…' });
      try {
        const context = { error: view.error.slice(0, 4000), connectionError: view.connectionError.slice(0, 4000), pending: view.pending.slice(0, 4000) };
        const result = await api('save-log', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...(task ? { taskId: task.id } : {}), context }) });
        publish({ notice: '日志已保存', savedLogPath: result.path });
      } catch (error) { publish({ notice: '', error: `保存日志失败，可展开诊断记录复制：${String(error)}` }); }
      finally { publish({ savingLog: false }); }
    };
    const startBlocked = view.plan?.blocked || (busy ? '请等待当前操作完成' : !view.selected.length && !view.plan?.items.some(item => item.action === 'reuse') ? '请选择至少一个可安装或更新的组件' : '');
    const previewBlocked = busy ? '请等待当前操作完成' : view.catalogWorking ? '正在检查远端目录' : detail?.blocked || (catalog?.stale ? '请先刷新远端目录' : '');
    const chooseAll = (checked: boolean) => publish({ selected: checked ? (view.plan?.items.filter(item => ['install', 'update'].includes(item.action)).map(item => item.ref) ?? []) : [] });
    return h('section', { 'aria-label': 'Mojobox 整合包管理', 'aria-busy': !!busy, style: { maxWidth: 960, padding: '20px 24px', color: 'inherit', lineHeight: 1.6, fontSize: 14 } },
      h('style', null, '[aria-label="Mojobox 整合包管理"] button:hover:not(:disabled){background:light-dark(#f3f3f5,#29292b)}[aria-label="Mojobox 整合包管理"] :is(button,summary):focus-visible{outline:2px solid light-dark(#0066cc,#80baff);outline-offset:3px}[aria-label="Mojobox 整合包管理"] button:disabled{opacity:.45;cursor:default}[aria-label="Mojobox 整合包管理"] button[aria-pressed="true"]{background:light-dark(#ededf0,#303034)}'),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 12 } },
        h('h2', { style: { margin: 0, fontSize: 24, fontWeight: 600, flex: 1 } }, 'Mojobox'),
        h('button', { style: button, title: '刷新状态', 'aria-label': '刷新状态', disabled: view.refreshing, onClick: refreshManually }, view.refreshing ? '刷新中…' : '↻')),
      h('p', { style: { opacity: .6 } }, `整合包管理 · 官版 ${view.snapshot?.hostVersion ?? '连接中'}`),
      h('nav', { 'aria-label': '整合包视图', style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
        ...[['import', '导入'], ['catalog', '发现'], ['installed', '已安装']].map(([id, label]) => h('button', { key: id, style: { ...button, whiteSpace: 'nowrap' }, 'aria-pressed': view.view === id, onClick: () => { setDetailId(''); publish({ view: id }); } }, label))),
      (view.error || view.connectionError || view.pending || view.notice) && h('div', { style: { position: 'sticky', top: 0, zIndex: 1, padding: '12px 0', background: 'light-dark(#fff,#202022)', borderBottom: '1px solid #8883', overflowWrap: 'anywhere' } },
        view.error && h('p', { role: 'alert', style: { margin: 0 } }, view.error),
        view.connectionError && h('p', { role: 'alert', style: { margin: 0 } }, `无法读取宿主状态：${view.connectionError}`),
        (view.pending || view.notice) && h('p', { role: 'status', 'aria-live': 'polite', style: { margin: 0 } }, view.pending || view.notice),
        view.savedLogPath && view.notice === '日志已保存' && h('details', { style: { marginTop: 4, fontSize: 12, opacity: .65 } }, h('summary', { style: { cursor: 'pointer' } }, '查看保存位置'), h('div', { style: { userSelect: 'text' } }, view.savedLogPath)),
        !!view.error && h('button', { style: { ...button, marginTop: 8 }, disabled: view.savingLog, onClick: () => saveLog() }, view.savingLog ? '正在保存…' : '保存日志')),
      view.view === 'catalog' && h('div', null,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 } },
          h('h3', { style: { flex: 1, margin: 0 } }, 'Mojobox 目录'),
          h('button', { style: button, disabled: view.catalogWorking || busy, title: '检查远端目录和新版', 'aria-label': '检查远端目录和新版', onClick: refreshCatalog }, view.catalogWorking ? '检查中…' : '↻')),
        h('p', { role: 'status', style: { opacity: .65, fontSize: 12 } }, `${catalog?.stale ? '缓存快照，需刷新后安装' : catalog ? '已核对远端目录' : '尚无目录'} · 上次成功检查 ${catalog?.checkedAt ? new Date(catalog.checkedAt).toLocaleString() : '暂无'}`),
        catalog?.error && h('p', { role: 'alert', style: { overflowWrap: 'anywhere' } }, `目录不可用：${catalog.error}`),
        !catalog?.entries.length && h('p', null, '暂无可展示的整合包；仍可从文件导入'),
        detail ? h('div', null,
          h('button', { style: button, onClick: () => setDetailId('') }, '返回目录'),
          h('article', { style: card },
            h('h3', { ref: detailTitle, tabIndex: -1, style: { marginTop: 0, overflowWrap: 'anywhere' } }, `${detail.name} · ${detail.version}${detail.newer ? ' · 有新版' : ''}`),
            h('p', null, detail.description),
            h('p', { style: { opacity: .65, fontSize: 12 } }, `${detail.author} · 内核 ${detail.requires ?? '未声明'} · ${detail.components.length} 个组件 · ${detail.archiveSize.toLocaleString()} B`),
            detail.installedVersion && h('p', { style: { fontSize: 12 } }, `本地记录目标 ${detail.installedVersion}`),
            detail.blocked && h('p', null, detail.blocked),
            h('details', null, h('summary', { style: { cursor: 'pointer' } }, '包含组件'), ...detail.components.map(plugin => h('div', { key: plugin.ref, style: { fontSize: 12, overflowWrap: 'anywhere', padding: '4px 0' } }, `${plugin.ref} · ${plugin.version ?? '内置版本'}`))),
            h('button', { style: { ...button, marginTop: 12 }, disabled: !!previewBlocked, title: previewBlocked || '下载校验并选择组件', 'aria-label': `预览 ${detail.name}`, onClick: () => previewRemote(detail.id, detail.version) }, view.working ? '正在准备安装…' : '↓ 预览安装'),
            previewBlocked && h('p', { style: { fontSize: 12 } }, previewBlocked)))
          : h('div', { ref: packGrid, 'aria-label': '整合包目录', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 144px), 1fr))', gap: 12 } },
            ...(catalog?.entries ?? []).map(entry => h('button', { key: entry.id, type: 'button', 'data-pack-id': entry.id, title: entry.name,
              style: { ...button, borderRadius: 12, padding: 16, minHeight: 80, minWidth: 0, textAlign: 'left', fontFamily: 'inherit', fontSize: 14, fontWeight: 500, lineHeight: 1.5, overflowWrap: 'anywhere' },
              onClick: () => { lastOpened.current = entry.id; setDetailId(entry.id); }
            }, entry.name)))),
      view.view === 'import' && h('div', null,
        h('div', { style: { ...card, borderStyle: 'dashed', textAlign: 'center' },
          onDragOver: (event: DragEvent) => event.preventDefault(),
          onDrop: (event: DragEvent) => { event.preventDefault(); if (event.dataTransfer?.files.length !== 1) publish({ error: '请每次导入一个整合包' }); else void importFile(event.dataTransfer.files[0]); }
        }, h('p', null, '将 Mojobox 整合包拖到这里'),
        h('label', null, '或选择文件 ', h('input', { type: 'file', accept: '.dshpack,.zip', disabled: busy, 'aria-label': '选择 Mojobox 整合包', onChange: (event: { target: HTMLInputElement }) => { const file = event.target.files?.[0]; event.target.value = ''; void importFile(file); } }))),
        view.plan && h('div', { style: card },
          h('h3', { ref: planTitle, tabIndex: -1, style: { marginTop: 0, scrollMarginTop: 88 } }, `${view.plan.pack.manifest.name} · ${view.plan.pack.manifest.version}`),
          h('p', null, view.plan.pack.manifest.description ?? '本地导入'),
          h('p', { style: { opacity: .65 } }, `${view.plan.source === 'catalog' ? 'Mojobox 远端目录' : '本地导入'} · ${view.plan.pack.manifest.author ?? '作者未声明'} · 内核 ${view.plan.pack.manifest.requires?.dsh ?? '未知'}`),
          view.plan.blocked && h('p', { role: 'alert' }, view.plan.blocked),
          view.plan.items.some(item => item.action === 'update') && h('p', { role: 'status' }, '检测到插件版本过低，是否更新？请勾选要更新的插件，或跳过。'),
          h('div', { style: { display: 'flex', gap: 8 } }, h('button', { style: button, disabled: busy, onClick: () => chooseAll(true) }, '全选安装 / 更新项'), h('button', { style: button, disabled: busy, onClick: () => chooseAll(false) }, '跳过全部')),
          ...view.plan.items.map(item => h('div', { key: item.ref, style: { borderBottom: '1px solid #8882', padding: '12px 0', overflowWrap: 'anywhere' } },
            h('label', null, h('input', { type: 'checkbox', 'aria-label': `选择 ${item.ref}`, checked: view.selected.includes(item.ref), disabled: busy || !['install', 'update'].includes(item.action), onChange: (event: { target: HTMLInputElement }) => publish({ selected: event.target.checked ? [...view.selected, item.ref] : view.selected.filter(ref => ref !== item.ref) }) }), ` ${item.ref}`),
            h('div', null, `${item.current ?? '未安装'} → ${item.target ?? '未声明'} · ${actionLabels[item.action]}`), h('small', { style: { opacity: .65 } }, item.reason),
            !!item.sharedTargets?.length && h('p', { style: { fontSize: 12 } }, `共享组件：${item.sharedTargets.map(other => `${other.name} 的目标为 ${other.version}`).join('；')}。变更后这些整合包可能与目标不同。`))),
          h('button', { style: { ...button, marginTop: 16 }, disabled: !!startBlocked, onClick: start, title: startBlocked || '执行所选组件' }, view.working ? '正在处理…' : view.selected.length ? `↓ 执行所选（${view.selected.length}）` : '核对已安装组件'),
          startBlocked && h('p', { style: { fontSize: 12 } }, startBlocked))),
      view.view === 'installed' && h('div', { ref: statusPanel, tabIndex: -1, style: { scrollMarginTop: 88 } },
        view.submittedTaskId && h('p', { role: 'status' }, '安装任务已提交，正在读取进度…'),
        !view.submittedTaskId && !view.snapshot?.records.length && h('p', null, '尚无通过 Mojobox 管理的整合包'),
        ...(view.snapshot?.records ?? []).map(task => {
          const running = task.status === 'running';
          const processed = task.items.filter(item => !['pending', 'running'].includes(item.status)).length;
          const percent = task.items.length ? Math.min(running ? 99 : 100, Math.floor(processed / task.items.length * 100)) : 0;
          const installed = task.items.filter(item => item.status === 'installed').length;
          const reused = task.items.filter(item => item.status === 'reused').length;
          const failed = task.items.filter(item => ['failed', 'unconfirmed', 'dependency-skipped'].includes(item.status)).length;
          const skipped = task.items.filter(item => item.status === 'skipped').length;
          const matched = task.pack.manifest.plugins.filter(item => { const actual = inventory.bundles.get(item.ref); return actual && actual.version === item.version && !actual.error; }).length;
          const restarts = task.items.filter(item => item.activation === 'restart-required').length;
          return h('article', { key: task.id, style: card },
            h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 16, justifyContent: 'space-between', flexWrap: 'wrap' } },
              h('h3', { style: { margin: 0, fontSize: 16, fontWeight: 500, overflowWrap: 'anywhere' } }, task.pack.manifest.name),
              h('span', { style: { fontSize: 12, opacity: .65 } }, `目标 ${task.pack.manifest.version}`)),
            h('p', { role: 'status', 'aria-live': 'polite', style: { margin: '12px 0 8px' } }, running ? `正在安装 · ${percent}%` : taskLabels[task.status]),
            running && h('div', { role: 'progressbar', 'aria-label': `${task.pack.manifest.name} 安装进度`, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': percent, 'aria-valuetext': `已处理 ${processed}/${task.items.length} 项，按组件计数`, style: { height: 8, background: '#8882', borderRadius: 4, overflow: 'hidden' } },
              h('div', { style: { height: '100%', background: 'light-dark(#0066cc,#80baff)', transform: `scaleX(${percent / 100})`, transformOrigin: 'left' } })),
            h('p', { style: { margin: '8px 0 16px', opacity: .65, fontSize: 12, fontVariantNumeric: 'tabular-nums' } }, running
              ? `已处理 ${processed}/${task.items.length} 项 · 按组件计数，下载速度可能影响等待时间`
              : `安装 ${installed} · 复用 ${reused} · 跳过 ${skipped} · 异常 ${failed} · 当前符合目标 ${matched}/${task.pack.manifest.plugins.length}`),
            !!restarts && !running && h('p', { role: 'status' }, `${restarts} 个组件需要重启客户端后生效`),
            !running && h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              catalog?.entries.filter(entry => entry.id === task.pack.manifest.id && entry.newer).map(entry => h('button', { key: entry.id, style: button, disabled: busy || view.catalogWorking, onClick: () => previewRemote(entry.id, entry.version) }, `新版 ${entry.version}`)),
              h('button', { style: button, disabled: busy, title: busy ? '请等待当前操作完成' : '检查远端整合包更新并核对组件', 'aria-label': `核对 ${task.pack.manifest.name} 更新`, onClick: () => replan(task.id, false) }, view.operationRecord === task.id && !view.retrying ? '正在核对…' : '核对更新'),
              !!failed && h('button', { style: button, disabled: busy, title: busy ? '请等待当前操作完成' : '重新核对失败项，确认后执行', onClick: () => replan(task.id, true) }, view.operationRecord === task.id && view.retrying ? '正在准备重试…' : '重试失败项'),
              (failed > 0 || task.status !== 'complete') && h('button', { style: button, disabled: view.savingLog, onClick: () => saveLog(task) }, view.savingLog ? '正在保存…' : '保存日志')),
            h('details', { style: { marginTop: 16 }, onToggle: (event: { currentTarget: HTMLDetailsElement }) => setExpandedTasks(event.currentTarget.open ? [...expandedTasks.filter(id => id !== task.id), task.id] : expandedTasks.filter(id => id !== task.id)) },
              h('summary', { style: { cursor: 'pointer', fontSize: 12, opacity: .65 } }, '组件详情'),
              expandedTasks.includes(task.id) && h('div', null, ...task.items.map(item => {
                const actual = inventory.bundles.get(item.ref);
                const runtime = inventory.runtime.get(item.ref) ?? [];
                const activation = runtime.length && runtime.every(entry => !entry.enabled) ? '已停用' : runtime.length && runtime.every(entry => !entry.enabled || entry.fiberPhase === 'active') ? '已加载' : '运行状态待核对';
                return h('div', { key: item.ref, style: { padding: '12px 0', borderBottom: '1px solid #8882', overflowWrap: 'anywhere' } },
                  h('div', null, `${item.ref} · ${resultLabels[item.status]}`),
                  h('small', null, `实际 ${actual?.version ?? '未确认'} / 目标 ${item.target ?? '未知'} · ${activation}${actual?.version !== item.target ? ' · 与目标不同' : ''}`),
                  h('div', { style: { opacity: .65, fontSize: 12 } }, item.reason));
              })), h('p', { style: { fontSize: 12, opacity: .65 } }, '安装结果为历史记录，当前版本来自宿主')));
        })),
      h('details', { style: { marginTop: 20 }, onToggle: (event: { currentTarget: HTMLDetailsElement }) => setDiagnosticsOpen(event.currentTarget.open) }, h('summary', { style: { cursor: 'pointer' } }, '诊断记录'),
        diagnosticsOpen && h('button', { style: button, onClick: async () => { try { await navigator.clipboard.writeText(report()); publish({ notice: '诊断已复制' }); } catch (error) { publish({ error: `复制失败，可手动选择下方报告：${String(error)}` }); } } }, '复制诊断'),
        diagnosticsOpen && h('button', { style: { ...button, marginLeft: 8 }, disabled: view.savingLog, onClick: () => saveLog() }, view.savingLog ? '正在保存…' : '保存日志'),
        diagnosticsOpen && h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12, maxHeight: 360, overflow: 'auto' } }, report()))
    );
  }
  ctx.remoteAccess.whenAccess('pluginManager/installBundle', () => ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'mojobox-manager', order: 80, label: () => 'Mojobox' }, Section)));
}
exports.apply = apply;
exports.inject = ['slots', 'remoteAccess'];
