import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import semver from 'semver';
import { NPM_NAME, readFeaturePack } from './feature-pack.js';
import type { FeaturePack } from './feature-pack.js';
import type { Bundle, InstallResult, PluginManager, RuntimeEntry, ManagedComponent, ComponentAction, ComponentOperation } from './contracts.js';
import type { ArtifactSource, ArtifactTarget } from './artifacts.js';

export interface PlanItem {
  ref: string;
  target?: string;
  current?: string;
  enabled?: boolean;
  action: 'install' | 'reuse' | 'update' | 'keep-newer' | 'unsupported' | 'remove' | 'keep';
  source?: string;
  reason: string;
  sharedTargets?: { id: string; name: string; version: string }[];
  requirements?: { ref: string; range: string }[];
}
export interface Plan {
  id: string;
  operation?: 'remove';
  recordId?: string;
  source?: 'local' | 'catalog';
  pack: FeaturePack;
  hostVersion: string;
  blocked?: string;
  items: PlanItem[];
  selected: string[];
}
export interface ComponentResult {
  ref: string;
  status: 'pending' | 'running' | 'installed' | 'reused' | 'skipped' | 'dependency-skipped' | 'failed' | 'unconfirmed' | 'removed' | 'retained';
  reason: string;
  target?: string;
  observed?: string;
  activation?: 'active' | 'disabled' | 'restart-required' | 'failed' | 'unknown';
  result?: InstallResult;
}
export interface TaskRecord {
  id: string;
  operation?: 'remove';
  removedAt?: string;
  pack: FeaturePack;
  hostVersion: string;
  source: 'local' | 'catalog';
  selected: string[];
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'complete' | 'partial' | 'failed' | 'interrupted';
  items: ComponentResult[];
  artifacts?: Record<string, { version: string; sha512: string }>;
}

export function redact(text: string): string {
  return text.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/((?:authorization|cookie|password|token|api[_-]?key)\s*[=:]\s*)(?:Bearer\s+)?[^\s,;"}]+/gi, '$1[REDACTED]')
    .replace(/\b[A-Za-z]:[\\/][^\r\n"<>|]*/g, '[LOCAL_PATH]')
    .replace(/\/(?:Users|home)\/[^\s/]+/g, '[HOME]')
    .slice(-16000);
}
export function safeResult(result: InstallResult): InstallResult {
  return {
    application: result.application, changed: result.changed,
    bundle: result.bundle, version: result.version, stage: result.stage, restartReason: result.restartReason,
    pendingBuilds: result.pendingBuilds?.map(item => redact(item)),
    error: result.error ? { code: result.error.code, diagnostic: redact(result.error.diagnostic ?? result.error.message ?? ''),
      incompatible: result.error.incompatible?.map(item => ({ name: redact(item.name), version: redact(item.version), runtimeVersion: redact(item.runtimeVersion), requirements: Object.fromEntries(Object.entries(item.requirements).map(([name, range]) => [redact(name), redact(range)])) })) } : undefined,
    packageResult: result.packageResult ? { exitCode: result.packageResult.exitCode, timedOut: result.packageResult.timedOut, output: redact(result.packageResult.output ?? '') } : undefined
  };
}

export function failureReason(result: InstallResult): string {
  const code = result.error?.code ?? result.application;
  const detail = `${result.error?.diagnostic ?? result.error?.message ?? ''}\n${result.packageResult?.output ?? ''}`;
  if (result.pendingBuilds?.length || /ERR_PNPM_IGNORED_BUILDS/.test(detail)) return '官版需要批准此插件的构建脚本。请先审核并在官版完成审批，再重试失败项；安装器不会自动放行';
  if (code === 'incompatible-version') return '插件声明的内核版本不兼容，请等待插件适配；未添加版本豁免';
  if (/\b(?:EPERM|EBUSY)\b/.test(detail)) return '文件被占用或权限不足，请检查占用／权限，核对任务状态后重试失败项';
  return `${code}；请展开诊断记录查看详细错误，核对后可重试失败项`;
}

function activationOf(bundle: Bundle, runtime: RuntimeEntry[]): ComponentResult['activation'] {
  const entries = runtime.filter(item => item.moduleName === bundle.name);
  if (!bundle.enabled || (entries.length && entries.every(item => !item.enabled))) return 'disabled';
  const enabled = entries.filter(item => item.enabled);
  return enabled.length && enabled.every(item => item.fiberPhase === 'active') ? 'active' : enabled.some(item => item.fiberPhase === 'failed') ? 'failed' : 'unknown';
}

export class RecordStore {
  constructor(private file: string) {}
  async saveLog(value: unknown): Promise<string> {
    const directory = join(dirname(this.file), 'logs');
    await mkdir(directory, { recursive: true });
    const file = join(directory, `mojobox-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`);
    await writeFile(file, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
    return file;
  }
  async read(): Promise<TaskRecord[]> {
    try {
      const value: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      if (!Array.isArray(value) || value.some(item => !item || typeof item.id !== 'string' || !Array.isArray(item.items))) throw new Error('Invalid Mojobox task records; preserve the file for diagnosis');
      return value.map((task: TaskRecord) => task.status === 'running' ? {
        ...task, status: 'interrupted',
        items: task.items.map(item => ['running', 'pending'].includes(item.status) ? { ...item, status: 'unconfirmed', reason: '任务中断，需核对当前状态后重新预览' } : item)
      } : task);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
  async write(records: TaskRecord[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(records, null, 2), { mode: 0o600 });
    await rename(temporary, this.file);
  }
}

export class PackManager {
  private plan?: Plan;
  private busy = false;
  private disposed = false;
  private records: TaskRecord[] = [];
  private task?: TaskRecord;
  private targets = new Map<string, ArtifactTarget>();
  private componentOperation?: ComponentOperation;
  constructor(
    private manager: PluginManager,
    private hostVersion: string,
    private store: RecordStore,
    // Used only to detect uncertain official recovery; never restores profile files itself.
    private fingerprint: () => Promise<string>,
    private artifacts?: ArtifactSource,
    private protectedFingerprint?: () => Promise<string>
  ) {}

  async initialize() { this.records = await this.store.read(); }
  async saveLog(taskId?: string, context: Record<string, string> = {}): Promise<{ path: string }> {
    const records = taskId === undefined ? this.records : this.records.filter(task => task.id === taskId);
    if (taskId !== undefined && !records.length) throw new Error('Task record not found');
    const status = await this.status();
    const tasks = records.map(task => ({
      id: task.id, pack: { id: task.pack.manifest.id, name: task.pack.manifest.name, version: task.pack.manifest.version, sha256: task.pack.sha256 },
      status: task.status, operation: task.operation, removedAt: task.removedAt, hostVersion: task.hostVersion, startedAt: task.startedAt, finishedAt: task.finishedAt,
      items: task.items.map(item => ({ ...item, reason: redact(item.reason), result: item.result ? safeResult(item.result) : undefined }))
    }));
    return { path: await this.store.saveLog({ createdAt: new Date().toISOString(), installerVersion: '0.0.1-p3.0', hostVersion: this.hostVersion, busy: this.busy, componentOperation: this.componentOperation, context: Object.fromEntries(Object.entries(context).map(([key, value]) => [key, redact(value)])), records: tasks, bundles: status.bundles, runtime: status.runtime }) };
  }
  dispose() { this.disposed = true; }
  private conflictReason(pack: FeaturePack, bundles: Bundle[]): string | undefined {
    const conflicts = pack.manifest.conflicts ?? [];
    const unknown = conflicts.filter(ref => !NPM_NAME.test(ref));
    if (unknown.length) return `无法核验冲突声明：${unknown.join('、')}，请维护者提供精确 npm 包名`;
    const present = conflicts.filter(ref => pack.manifest.plugins.some(plugin => plugin.ref === ref) || bundles.some(bundle => bundle.name === ref && (bundle.installed || bundle.availability !== 'missing')));
    if (present.length) return `检测到冲突组件：${present.join('、')}。请先核对已有插件；安装器不会自动禁用或删除`;
  }
  async status() {
    const [bundles, runtime] = await Promise.all([this.manager.listBundles(), this.manager.listPlugins()]);
    return { hostVersion: this.hostVersion, busy: this.busy, task: this.task, records: this.records, componentOperation: this.componentOperation,
      components: bundles.filter(bundle => bundle.installed || bundle.enabled).map(bundle => this.componentInfo(bundle)),
      bundles: bundles.map(({ name, version, installed, availability, enabled, error }) => ({ name, version, installed, availability, enabled, error: error ? { code: error.code } : undefined })),
      runtime: runtime.map(({ entryId, moduleName, enabled, fiberPhase }) => ({ entryId, moduleName, enabled, fiberPhase })) };
  }
  private componentInfo(bundle: Bundle): ManagedComponent {
    const protectedReason = bundle.readOnlyReason || bundle.official || bundle.availability === 'installation' || bundle.name === 'dsh-plugin-mojobox'
      ? '宿主或管理组件，请在官方插件页管理' : !NPM_NAME.test(bundle.name) ? '无法确认组件包名' : undefined;
    const { name, version, installed, availability, enabled, source, official, readOnlyReason, removable } = bundle;
    return { name, version, installed, availability, enabled, source, official, readOnlyReason, removable,
      description: bundle.description?.slice(0, 1000), rows: bundle.rows?.map(({ entryId, rowId, moduleName }) => ({ entryId, rowId, moduleName })),
      error: bundle.error ? { code: bundle.error.code } : undefined,
      stamp: JSON.stringify([bundle.name, bundle.version, bundle.source, bundle.enabled, bundle.installed, bundle.availability, bundle.removable, bundle.readOnlyReason, bundle.error?.code]),
      toggleReason: protectedReason || (!this.manager.setBundleEnabled ? '当前宿主不支持启用或暂停' : !bundle.installed ? '组件未安装' : !bundle.enabled && bundle.error ? `请先处理组件异常：${bundle.error.code}` : undefined),
      deleteReason: protectedReason || (!this.manager.removeBundle ? '当前宿主不支持删除' : bundle.removable !== true || !bundle.installed || bundle.availability !== 'profile' ? '宿主未允许删除此组件' : undefined),
      packs: [...new Set(this.records.filter(record => !record.removedAt && record.operation !== 'remove' && record.pack.manifest.plugins.some(plugin => plugin.ref === bundle.name)).map(record => record.pack.manifest.name))]
    };
  }
  async controlComponent(name: string, action: ComponentAction, expected: string): Promise<ComponentOperation> {
    if (this.busy || this.disposed) throw new Error('请等待当前操作完成');
    this.busy = true;
    try {
      const bundle = (await this.manager.listBundles()).find(item => item.name === name);
      if (!bundle) throw new Error('组件已不在当前库存，请刷新后重试');
      const current = this.componentInfo(bundle);
      if (current.stamp !== expected) throw new Error('组件状态已变化，请刷新后重新确认');
      const refusal = action === 'delete' ? current.deleteReason : current.toggleReason;
      if (refusal) throw new Error(refusal);
      const operation: ComponentOperation = { name, action, status: 'running', message: '宿主正在处理此组件…' };
      this.componentOperation = operation;
      // A component change invalidates any earlier install/removal preview.
      this.plan = undefined;
      try {
        const result = safeResult(action === 'delete' ? await this.manager.removeBundle!(name) : await this.manager.setBundleEnabled!(name, action === 'enable'));
        operation.result = result;
        const observed = (await this.manager.listBundles()).find(item => item.name === name);
        const confirmed = action === 'delete' ? !observed?.installed && !observed?.enabled : observed?.enabled === (action === 'enable');
        const accepted = ['applied', 'restart-required', 'overridden'].includes(result.application) && !result.error;
        operation.status = accepted && confirmed ? 'complete' : accepted || result.changed ? 'unconfirmed' : 'failed';
        const label = action === 'delete' ? '删除' : action === 'enable' ? '启用' : '暂停';
        operation.message = operation.status === 'complete' ? `已${label}${result.application === 'restart-required' ? '，请重启客户端后生效' : ''}`
          : result.application === 'overridden' ? '设置被其他配置覆盖，请在官方插件页核对'
          : result.error?.code === 'bundle-in-use' ? '组件仍在运行，无法删除。请先暂停并核对状态后重试'
          : result.error?.code === 'stop-profile' ? '宿主要求停止运行后再操作，请退出客户端后使用官方管理方式处理'
          : operation.status === 'unconfirmed' ? '操作结果待核对，请刷新查看当前状态，不要重复提交'
          : `${label}未完成：${result.error?.code ?? result.application}，请核对当前状态后重试`;
      } catch (error) {
        operation.status = 'unconfirmed';
        operation.message = `操作结果未确认：${redact(String(error))}。请刷新核对当前状态`;
      }
      return operation;
    } finally { this.busy = false; }
  }
  private async classify(ref: string, target: string | undefined, bundles: Bundle[]): Promise<PlanItem> {
    const item: PlanItem = { ref, target, action: 'unsupported', reason: '' };
    if (!NPM_NAME.test(ref)) return { ...item, reason: ref.startsWith('builtin:') ? '官版无法确认此内置组件的真实身份' : 'GitHub 引用尚未绑定可核验的精确发行产物' };
    const installed = bundles.find(bundle => bundle.name === ref && (bundle.installed || bundle.availability !== 'missing'));
    if (installed) {
      Object.assign(item, { current: installed.version, enabled: installed.enabled });
      if (installed.error || !semver.valid(installed.version)) return { ...item, reason: '现有组件状态或版本无法确认，保持原样' };
      const ownedArtifact = this.records.some(record => {
        const artifact = record.artifacts?.[ref];
        return !!artifact && artifact.version === installed.version && !!installed.source && this.artifacts?.owns(installed.source, artifact.sha512);
      });
      if (!ownedArtifact && installed.source && installed.source !== ref && (!installed.source.startsWith(`${ref}@`) || !semver.validRange(installed.source.slice(ref.length + 1)))) return { ...item, reason: '现有组件为本地链接或其他来源，不自动接管' };
      if (installed.version === target) return { ...item, action: 'reuse', reason: '已安装相同版本，保留启停与配置' };
      if (semver.gt(installed.version!, target!)) return { ...item, action: 'keep-newer', reason: '已装版本更高，保留且不降级' };
      if (semver.eq(installed.version!, target!)) return { ...item, reason: '版本构建标识与精确目标不同，保持原样' };
      if (installed.official || installed.readOnlyReason || !installed.source || installed.availability !== 'profile' || !this.artifacts) return { ...item, reason: '此组件不属于可原位更新的第三方 Profile 依赖' };
      return { ...item, action: 'update', reason: '检测到插件版本过低，是否更新？可逐项选择，保留配置与启停设置' };
    }
    const inspection = await this.manager.inspect?.(`${ref}@${target}`);
    if (inspection?.status !== 'accepted' || inspection.kind !== 'registry' || inspection.name !== ref || inspection.version !== target || !inspection.bundle) return { ...item, reason: inspection?.reason ? redact(inspection.reason) : '官方服务未确认目标包身份、精确版本或 bundle 声明' };
    return { ...item, action: 'install', reason: '新增组件' };
  }
  async preview(bytes: Buffer, source: TaskRecord['source'] = 'local'): Promise<Plan> { return this.buildPlan(() => readFeaturePack(bytes), undefined, source); }
  private removalItem(ref: string, bundles: Bundle[], packId: string): PlanItem {
    const bundle = bundles.find(item => item.name === ref && (item.installed || item.availability !== 'missing'));
    const item: PlanItem = { ref, current: bundle?.version, enabled: bundle?.enabled, source: bundle?.source, action: 'keep', reason: '' };
    if (!bundle) return { ...item, reason: '未安装，无需卸载' };
    const shared = this.records.filter(record => !record.removedAt && record.pack.manifest.id !== packId && record.pack.manifest.plugins.some(plugin => plugin.ref === ref));
    if (shared.length) return { ...item, reason: `其他整合包仍引用：${shared.map(record => record.pack.manifest.name).join('、')}，保留组件` };
    if (!this.manager.removeBundle) return { ...item, reason: '当前宿主未提供卸载接口' };
    if (!NPM_NAME.test(ref) || ref === 'dsh-plugin-mojobox' || !bundle.installed || bundle.availability !== 'profile' || bundle.official || bundle.readOnlyReason || bundle.removable !== true || bundle.error || !semver.valid(bundle.version)) return { ...item, reason: '宿主组件、管理组件或状态不明的组件，保持原样' };
    const ownedArtifact = this.records.some(record => {
      const artifact = record.artifacts?.[ref];
      return !!artifact && artifact.version === bundle.version && !!bundle.source && this.artifacts?.owns(bundle.source, artifact.sha512);
    });
    if (!ownedArtifact && (!bundle.source || (bundle.source !== ref && (!bundle.source.startsWith(`${ref}@`) || !semver.validRange(bundle.source.slice(ref.length + 1)))))) return { ...item, reason: '本地链接或其他来源，不自动接管' };
    return { ...item, action: 'remove', reason: '默认保留；勾选后通过官方接口卸载，不清理插件私有数据' };
  }
  async previewRemoval(recordId: string): Promise<Plan> {
    if (this.busy || this.disposed) throw new Error('Mojobox is busy or disposed');
    this.busy = true;
    this.plan = undefined;
    try {
      const record = this.records.find(item => item.id === recordId && !item.removedAt);
      if (!record) throw new Error('Active pack record not found');
      const bundles = await this.manager.listBundles();
      return this.plan = { id: randomUUID(), operation: 'remove', recordId, pack: record.pack, source: record.source, hostVersion: this.hostVersion,
        items: record.pack.manifest.plugins.map(plugin => this.removalItem(plugin.ref, bundles, record.pack.manifest.id)), selected: [] };
    } finally { this.busy = false; }
  }
  async replan(recordId: string, failedOnly: boolean): Promise<Plan> {
    const record = this.records.find(item => item.id === recordId);
    if (!record) throw new Error('Task record not found');
    if (record.operation === 'remove' && !record.removedAt) return this.previewRemoval(recordId);
    return this.buildPlan(async () => record.pack, failedOnly ? record.items.filter(item => ['failed', 'unconfirmed', 'dependency-skipped'].includes(item.status)).map(item => item.ref) : undefined, record.source);
  }
  private async buildPlan(load: () => Promise<FeaturePack>, selectedRefs?: string[], source: TaskRecord['source'] = 'local'): Promise<Plan> {
    if (this.busy || this.disposed) throw new Error('Mojobox is busy or disposed');
    this.busy = true;
    this.plan = undefined;
    this.targets.clear();
    try {
      const pack = await load();
      const bundles = await this.manager.listBundles();
      const range = pack.manifest.requires?.dsh;
      const blocked = !range ? '整包未声明内核兼容范围，无法安装' : !semver.satisfies(this.hostVersion, range, { includePrerelease: true }) ? `整包要求内核 ${range}，当前为 ${this.hostVersion}` :
        this.conflictReason(pack, bundles);
      const items: PlanItem[] = new Array(pack.manifest.plugins.length);
      let next = 0;
      const inspectNext = async () => {
        while (next < pack.manifest.plugins.length) {
          const index = next++;
          const plugin = pack.manifest.plugins[index];
          if (blocked) { items[index] = { ref: plugin.ref, target: plugin.version, action: 'unsupported', reason: blocked }; continue; }
          try {
            const item = await this.classify(plugin.ref, plugin.version, bundles);
            if (['install', 'update'].includes(item.action) && this.artifacts) {
              const target = await this.artifacts.describe(item.ref, item.target!);
              this.targets.set(item.ref, target);
              item.requirements = target.requirements?.filter(requirement => pack.manifest.plugins.some(plugin => plugin.ref === requirement.ref));
            }
            item.sharedTargets = this.records.filter(record => !record.removedAt && record.pack.manifest.id !== pack.manifest.id)
              .flatMap(record => record.pack.manifest.plugins.filter(other => other.ref === item.ref && other.version !== item.target).map(other => ({ id: record.pack.manifest.id, name: record.pack.manifest.name, version: other.version! })));
            items[index] = item;
          }
          catch (error) { items[index] = { ref: plugin.ref, target: plugin.version, action: 'unsupported', reason: redact(String(error)) }; }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, items.length) }, inspectNext));
      return this.plan = { id: randomUUID(), source, pack, hostVersion: this.hostVersion, blocked, items,
        selected: items.filter(item => ['install', 'update'].includes(item.action) && (!selectedRefs || selectedRefs.includes(item.ref))).map(item => item.ref) };
    } finally { this.busy = false; }
  }
  async start(planId: string, selected: string[]): Promise<{ taskId: string }> {
    if (this.busy || this.disposed) throw new Error('Mojobox is busy or disposed');
    const plan = this.plan;
    if (!plan || plan.id !== planId) throw new Error('Preview expired; import the pack again');
    if (plan.operation === 'remove') return this.startRemoval(plan, selected);
    if (plan.blocked) throw new Error(plan.blocked);
    if (!Array.isArray(selected) || selected.some(ref => typeof ref !== 'string' || !plan.items.some(item => item.ref === ref && ['install', 'update'].includes(item.action))) || new Set(selected).size !== selected.length) throw new Error('Selection is not part of the executable preview');
    this.busy = true;
    try {
      const conflict = this.conflictReason(plan.pack, await this.manager.listBundles());
      if (conflict) throw new Error(conflict);
    } catch (error) { this.busy = false; throw error; }
    this.plan = undefined;
    const task: TaskRecord = {
      id: randomUUID(), pack: plan.pack, hostVersion: this.hostVersion, source: plan.source ?? 'local', selected,
      startedAt: new Date().toISOString(), status: 'running',
      items: plan.items.map(item => ({ ref: item.ref, target: item.target, status: 'pending', reason: '' })),
      artifacts: Object.assign({}, ...this.records.toReversed().map(record => record.artifacts ?? {}))
    };
    this.task = task;
    // Keep only the latest target per pack. Actual state is always read from the host.
    this.records = [task, ...this.records.filter(record => record.pack.manifest.id !== task.pack.manifest.id)];
    try { await this.store.write(this.records); }
    catch (error) {
      this.busy = false; task.status = 'interrupted';
      throw error;
    }
    void this.execute(plan, task).catch(error => {
      task.status = 'interrupted';
      task.items.filter(item => ['pending', 'running'].includes(item.status)).forEach(item => { item.status = 'unconfirmed'; item.reason = redact(String(error)); });
    }).finally(() => { this.busy = false; });
    return { taskId: task.id };
  }
  private async startRemoval(plan: Plan, selected: string[]): Promise<{ taskId: string }> {
    if (!Array.isArray(selected) || selected.some(ref => typeof ref !== 'string' || !plan.items.some(item => item.ref === ref && item.action === 'remove')) || new Set(selected).size !== selected.length) throw new Error('Selection is not part of the removal preview');
    const previous = this.records.find(record => record.id === plan.recordId && !record.removedAt);
    if (!previous) throw new Error('Active pack record not found');
    this.busy = true;
    this.plan = undefined;
    const task: TaskRecord = { ...previous, id: randomUUID(), operation: 'remove', selected: [...selected], startedAt: new Date().toISOString(), finishedAt: undefined, status: 'running',
      items: plan.items.map(item => ({ ref: item.ref, target: item.current, status: 'pending', reason: '' })) };
    this.task = task;
    this.records = [task, ...this.records.filter(record => record !== previous)];
    try { await this.store.write(this.records); }
    catch (error) { this.records = this.records.map(record => record === task ? previous : record); this.task = undefined; this.busy = false; throw error; }
    void this.executeRemoval(plan, task).catch(error => {
      task.status = 'interrupted';
      task.items.filter(item => ['pending', 'running'].includes(item.status)).forEach(item => { item.status = 'unconfirmed'; item.reason = redact(String(error)); });
    }).finally(() => { this.busy = false; });
    return { taskId: task.id };
  }
  private async executeRemoval(plan: Plan, task: TaskRecord) {
    let stop = false;
    for (const entry of plan.items) {
      const row = task.items.find(item => item.ref === entry.ref)!;
      if (!task.selected.includes(entry.ref)) {
        row.status = 'retained'; row.reason = entry.reason || '用户保留组件';
      } else if (stop || this.disposed) {
        row.status = 'unconfirmed'; row.reason = '宿主状态待核对，已暂停后续卸载';
      } else {
        row.status = 'running'; row.reason = '正在通过官方接口卸载';
        await this.store.write(this.records);
        try {
          const bundles = await this.manager.listBundles();
          const current = this.removalItem(entry.ref, bundles, plan.pack.manifest.id);
          if (current.action !== 'remove' || current.current !== entry.current || current.source !== entry.source || current.enabled !== entry.enabled) {
            row.status = 'failed'; row.reason = '当前状态已变化，请重新预览；' + current.reason;
          } else {
            const before = await this.fingerprint();
            const result = await this.manager.removeBundle!(entry.ref);
            row.result = safeResult(result);
            const after = await this.manager.listBundles();
            const remaining = after.find(item => item.name === entry.ref && (item.installed || item.availability !== 'missing'));
            if (result.error || !['applied', 'restart-required'].includes(result.application)) {
              const restored = !!remaining && remaining.version === current.current && remaining.source === current.source && remaining.enabled === current.enabled && !remaining.error && await this.fingerprint() === before;
              row.status = restored ? 'failed' : 'unconfirmed'; row.reason = '卸载未完成：' + failureReason(result); stop = !restored;
            } else if (remaining) {
              row.status = 'unconfirmed'; row.reason = '卸载返回成功，但组件仍在库存中，需核对'; stop = true;
            } else {
              row.status = 'removed'; row.reason = '已通过官方接口卸载；插件私有数据保留';
              if (result.application === 'restart-required') row.activation = 'restart-required';
              if (task.artifacts) delete task.artifacts[entry.ref];
            }
          }
        } catch (error) { row.status = 'unconfirmed'; row.reason = redact(String(error)); stop = true; }
      }
      await this.store.write(this.records);
    }
    task.finishedAt = new Date().toISOString();
    task.status = task.items.some(item => item.status === 'unconfirmed') ? 'interrupted' : task.items.some(item => item.status === 'failed') ? 'partial' : 'complete';
    if (task.status === 'complete') task.removedAt = task.finishedAt;
    await this.store.write(this.records);
  }
  private async execute(plan: Plan, task: TaskRecord) {
    let stop = false;
    const remaining = [...plan.items];
    while (remaining.length) {
      // Only order declared relationships inside this pack; pnpm resolves external dependencies.
      let next = remaining.findIndex(item => !task.selected.includes(item.ref) || !item.requirements?.some(requirement => task.selected.includes(requirement.ref) && remaining.some(other => other.ref === requirement.ref)));
      if (next < 0) {
        for (const entry of remaining) {
          const row = task.items.find(item => item.ref === entry.ref)!;
          row.status = stop || this.disposed ? 'unconfirmed' : 'dependency-skipped';
          row.reason = stop || this.disposed ? '宿主状态待核对，已暂停后续写入' : '包内依赖形成循环，未扩大安装范围，请调整整合包';
        }
        break;
      }
      const [entry] = remaining.splice(next, 1);
      const row = task.items.find(item => item.ref === entry.ref)!;
      if (stop || this.disposed) {
        row.status = 'unconfirmed'; row.reason = '宿主状态待核对，已暂停后续写入';
      } else if (!task.selected.includes(entry.ref) && entry.action !== 'reuse') {
        row.status = 'skipped'; row.reason = ['install', 'update'].includes(entry.action) ? '用户跳过' : entry.reason;
      } else {
        row.status = 'running';
        await this.store.write(this.records);
        let before: string | undefined;
        try {
          // Re-check immediately before each write; never execute a stale preview.
          const inventory = await this.manager.listBundles();
          const current = await this.classify(entry.ref, entry.target, inventory);
          if (current.action === 'reuse') {
            row.status = 'reused'; row.reason = current.reason; row.observed = current.current;
            const bundle = { name: current.ref, enabled: current.enabled ?? false } as Bundle;
            row.activation = activationOf(bundle, await this.manager.listPlugins());
            if (row.activation === 'failed' || row.activation === 'unknown') {
              row.status = 'failed'; row.reason = '版本已存在且未重复安装；运行状态未通过核验';
            }
          }
          else if (!['install', 'update'].includes(current.action) || current.action !== entry.action || !task.selected.includes(entry.ref) || (current.action === 'update' && current.current !== entry.current)) { row.status = 'skipped'; row.reason = '当前状态已变化，请重新预览；' + current.reason; }
          else {
            const missing = entry.requirements?.filter(requirement => {
              const required = inventory.find(item => item.name === requirement.ref && item.installed && !item.error);
              const previous = task.items.find(item => item.ref === requirement.ref);
              return !semver.validRange(requirement.range) || !required?.version || !semver.satisfies(required.version, requirement.range) || ['failed', 'dependency-skipped', 'unconfirmed'].includes(previous?.status ?? '');
            });
            if (missing?.length) {
              row.status = 'dependency-skipped'; row.reason = '依赖未满足：' + missing.map(item => `${item.ref} ${item.range}`).join('、');
              await this.store.write(this.records);
              continue;
            }
            let spec = `${entry.ref}@${entry.target}`;
            const target = current.action === 'update' ? this.targets.get(entry.ref) : undefined;
            if (current.action === 'update') {
              // Downloads do not mutate the host; one artifact failure must not stop independent items.
              try {
                if (!target) throw new Error('Update artifact is not bound to this preview');
                row.reason = '正在下载并核验目标发行包';
                await this.store.write(this.records);
                spec = await this.artifacts!.prepare(target);
              } catch (error) {
                row.status = 'failed'; row.reason = '更新产物核验失败：' + redact(String(error));
                await this.store.write(this.records);
                continue;
              }
              const latest = await this.classify(entry.ref, entry.target, await this.manager.listBundles());
              if (latest.action !== 'update' || latest.current !== current.current || latest.enabled !== current.enabled) {
                row.status = 'skipped'; row.reason = '下载期间组件状态变化，请重新预览';
                await this.store.write(this.records);
                continue;
              }
            }
            if (this.disposed) throw new Error('Mojobox disposed before host write');
            const conflict = this.conflictReason(plan.pack, await this.manager.listBundles());
            if (conflict) {
              row.status = 'skipped'; row.reason = conflict;
              await this.store.write(this.records);
              continue;
            }
            row.reason = current.action === 'update' ? '正在通过官方接口原位更新' : '正在通过官方接口安装';
            const protectedBefore = await this.protectedFingerprint?.();
            const runtimeBefore = current.action === 'update' ? await this.manager.listPlugins() : [];
            before = await this.fingerprint();
            const result = await this.manager.installBundle(spec, { enabled: current.action === 'update' ? current.enabled ?? false : true, saveExact: true, requestId: `${task.id}:${entry.ref}` });
            row.result = safeResult(result);
            if (result.application === 'failed' || result.application === 'cancelled' || result.error) {
              row.status = 'failed'; row.reason = failureReason(result);
              stop = await this.fingerprint() !== before;
              if (current.action === 'update') {
                const restored = (await this.manager.listBundles()).find(item => item.name === entry.ref);
                const runtimeAfter = await this.manager.listPlugins();
                stop ||= !restored || restored.version !== current.current || restored.enabled !== current.enabled || restored.source !== inventory.find(item => item.name === entry.ref)?.source || !!restored.error ||
                  !runtimeBefore.filter(item => item.moduleName === entry.ref).every(item => runtimeAfter.some(after => after.moduleName === item.moduleName && after.entryId === item.entryId && after.enabled === item.enabled));
                stop ||= protectedBefore !== undefined && await this.protectedFingerprint!() !== protectedBefore;
              }
              if (stop) { row.status = 'unconfirmed'; row.reason += '；安装失败后配置发生变化，暂停后续写入以核对恢复状态'; }
            } else {
              const observed = (await this.manager.listBundles()).find(item => item.name === entry.ref);
              row.observed = observed?.version;
              if (!observed || observed.version !== entry.target || observed.error || !(observed.installed || observed.availability !== 'missing')) {
                row.status = 'unconfirmed'; row.reason = '安装返回成功，但实际目标版本未得到确认'; stop = true;
              } else {
                if (target) task.artifacts![entry.ref] = { version: target.version, sha512: target.sha512 };
                row.activation = result.application === 'restart-required' ? 'restart-required' : activationOf(observed, await this.manager.listPlugins());
                row.status = row.activation === 'active' || row.activation === 'disabled' || row.activation === 'restart-required' ? 'installed' : 'failed';
                row.reason = row.activation === 'restart-required' ? '已安装，官版要求重启' : row.activation === 'active' ? '已安装并加载' : row.activation === 'disabled' ? '已安装，保留停用设置' : '已安装，加载状态未通过核验';
                if (current.action === 'update') {
                  const runtimeAfter = await this.manager.listPlugins();
                  const preserved = runtimeBefore.filter(item => item.moduleName === entry.ref).every(item => runtimeAfter.some(after => after.moduleName === item.moduleName && after.entryId === item.entryId && after.enabled === item.enabled));
                  if (observed.enabled !== current.enabled || !preserved || (protectedBefore !== undefined && await this.protectedFingerprint!() !== protectedBefore)) {
                    row.status = 'unconfirmed'; row.reason = '更新后配置或启停状态发生变化，暂停后续写入以核对'; stop = true;
                  }
                }
              }
            }
          }
        } catch (error) {
          // A rejected transport/lock call has no trustworthy settled result.
          row.status = 'unconfirmed'; row.reason = redact(String(error)); stop = true;
        }
      }
      await this.store.write(this.records);
    }
    task.finishedAt = new Date().toISOString();
    const satisfied = task.items.filter(item => ['installed', 'reused'].includes(item.status)).length;
    task.status = task.items.some(item => item.status === 'unconfirmed') ? 'interrupted' : satisfied === task.items.length ? 'complete' : satisfied ? 'partial' : 'failed';
    await this.store.write(this.records);
  }
}
