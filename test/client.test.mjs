import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const compiled = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
const entry = { id: 'pack', name: 'Test pack', version: '1.0.0', author: 'Test', description: 'Test', requires: '0.2.2-rc.1', components: [{ ref: 'example', version: '1.0.0' }], archiveSize: 100, newer: false };
const catalog = { stale: false, checkedAt: '2026-11-11T00:00:00Z', entries: [entry] };
const snapshot = () => ({ hostVersion: '0.2.2-rc.1', busy: false, records: [], bundles: [], runtime: [], catalog });
const plan = () => ({ id: 'plan', source: 'catalog', pack: { manifest: { ...entry, plugins: entry.components } }, items: [{ ref: 'example', target: '1.0.0', action: 'install', reason: '新增组件' }], selected: ['example'] });
const task = (patch = {}) => ({ id: 'task', pack: plan().pack, status: 'partial', selected: ['example'], items: [{ ref: 'example', target: '1.0.0', status: 'failed', reason: 'network unavailable' }], ...patch });
const response = (value, status = 200) => ({ ok: status < 400, status, json: async () => value });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function harness(t, handlers = {}) {
  let component, tree, hook = 0, now = 0, renders = 0, updates = 0;
  const hooks = [], effects = [], cleanups = [], intervals = [], requests = [], timeouts = [];
  const document = { visibilityState: 'visible' };
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useState(initial) { const index = hook++; if (!(index in hooks)) hooks[index] = initial; return [hooks[index], value => { hooks[index] = value; updates++; }]; },
    useRef(value) { const index = hook++; return hooks[index] ??= { current: value }; },
    useEffect(effect, deps) { const index = hook++; if (!hooks[index] || deps.some((dep, i) => dep !== hooks[index][i])) { hooks[index] = deps; effects.push(effect); } },
    useMemo(factory, deps) { const index = hook++; if (!hooks[index] || deps.some((dep, i) => dep !== hooks[index].deps[i])) hooks[index] = { deps, value: factory() }; return hooks[index].value; }
  };
  const fakeDate = class extends Date { static now() { return now; } };
  runInNewContext(compiled, {
    window: { __ModuleLoader__: { load(module) { module.factory(() => react).apply({
      effect(fn) { cleanups.push(fn()); },
      remoteAccess: { whenAccess(_method, fn) { fn(); } },
      slots: { inject(_name, fn) { fn(); }, register(_options, value) { component = value; } }
    }); } } },
    fetch: async (url, init) => { const action = url.split('/').at(-1); requests.push({ action, init }); return handlers[action]?.(init) ?? response(action === 'status' ? snapshot() : catalog); },
    AbortController, AbortSignal: { any: signals => AbortSignal.any(signals), timeout(ms) { const controller = new AbortController(); timeouts.push({ ms, controller }); return controller.signal; } },
    document, Date: fakeDate, Blob,
    navigator: { clipboard: { writeText: async value => { handlers.copy?.(value); } } },
    setInterval(fn) { intervals.push(fn); return fn; }, clearInterval() {}
  });
  const render = () => { hook = 0; renders++; tree = component(); while (effects.length) { const cleanup = effects.shift()(); if (cleanup) cleanups.push(cleanup); } return tree; };
  const all = (node = tree) => !node || typeof node !== 'object' ? [] : [node, ...node.children.flatMap(child => all(child ?? null))];
  const text = (node = tree) => !node ? '' : typeof node !== 'object' ? String(node) : node.children.map(child => text(child ?? null)).join('');
  const button = label => { const found = all().find(n => n.type === 'button' && (n.props['aria-label'] === label || text(n) === label)); assert.ok(found, 'Missing button: '+label); return found; };
  const settle = async () => { await new Promise(setImmediate); render(); };
  t.after(() => { for (const cleanup of cleanups.reverse()) cleanup?.(); });
  render();
  return { render, settle, text, button, all, requests, timeouts, document, poll(time) { now = time; for (const fn of intervals) fn(); }, get updates() { return updates; }, get renders() { return renders; } };
}

test('remote preview and install give immediate feedback and ignore double clicks', async t => {
  const preview = deferred(), start = deferred();
  const ui = harness(t, { 'catalog-preview': () => preview.promise, start: () => start.promise });
  await ui.settle();
  ui.button('发现').props.onClick(); ui.render();
  ui.button('Test pack').props.onClick(); ui.render();
  const pending = ui.button('预览 Test pack').props.onClick();
  ui.render(); assert.match(ui.text(), /正在下载整合包并核对组件/);
  assert.equal(ui.button('预览 Test pack').props.disabled, true);
  await ui.button('预览 Test pack').props.onClick();
  assert.equal(ui.requests.filter(r => r.action === 'catalog-preview').length, 1);
  preview.resolve(response(plan())); await pending; await ui.settle();
  const submitted = ui.button('↓ 执行所选（1）').props.onClick();
  ui.render(); assert.match(ui.text(), /正在提交安装任务/);
  await ui.button('正在处理…').props.onClick();
  assert.equal(ui.requests.filter(r => r.action === 'start').length, 1);
  assert.deepEqual(JSON.parse(ui.requests.find(r => r.action === 'start').init.body), { planId: 'plan', selected: ['example'] });
  start.resolve(response({ taskId: 'task' }, 202)); await submitted; await ui.settle();
  assert.doesNotMatch(ui.text(), /正在提交安装任务/);
});

test('unchanged status does not publish, polling backs off while idle and stops while hidden', async t => {
  const ui = harness(t); await ui.settle();
  const before = ui.updates;
  ui.poll(10000); await ui.settle();
  assert.equal(ui.updates, before);
  const count = ui.requests.filter(r => r.action === 'status').length;
  ui.poll(11500); await ui.settle();
  assert.equal(ui.requests.filter(r => r.action === 'status').length, count);
  ui.document.visibilityState = 'hidden'; ui.poll(30000); await ui.settle();
  assert.equal(ui.requests.filter(r => r.action === 'status').length, count);
});

test('manual refresh coalesces pending status and displays completion', async t => {
  const pending = deferred(); const ui = harness(t, { status: () => pending.promise });
  const clicked = ui.button('刷新状态').props.onClick();
  ui.render(); assert.equal(ui.button('刷新状态').props.disabled, true);
  assert.equal(ui.requests.filter(r => r.action === 'status').length, 1);
  pending.resolve(response(snapshot())); await clicked; await ui.settle();
  assert.match(ui.text(), /状态已刷新/);
});

test('a timed out submission clears stale plan, reads records and never auto-replays', async t => {
  const ui = harness(t, {
    'catalog-preview': () => response(plan()),
    start: init => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }))
  });
  await ui.settle(); ui.button('发现').props.onClick(); ui.render(); ui.button('Test pack').props.onClick(); ui.render();
  await ui.button('预览 Test pack').props.onClick(); await ui.settle();
  const submitting = ui.button('↓ 执行所选（1）').props.onClick();
  ui.timeouts.at(-1).controller.abort(new Error('timeout'));
  await submitting; await ui.settle();
  assert.match(ui.text(), /请求超时/); assert.match(ui.text(), /核对任务记录/);
  assert.equal(ui.requests.filter(r => r.action === 'start').length, 1);
  assert.ok(!ui.all().some(n => n.type === 'button' && ui.text(n).includes('执行所选')));
});

test('preview failures and catalog refresh failures are visible and controls recover', async t => {
  const ui = harness(t, { 'catalog-preview': () => response({ error: 'checksum mismatch' }, 400), 'catalog-refresh': () => response({ ...catalog, stale: true, error: 'offline' }) });
  await ui.settle(); assert.match(ui.text(), /目录检查失败.*offline/);
  ui.button('发现').props.onClick(); ui.render(); ui.button('Test pack').props.onClick(); ui.render();
  await ui.button('预览 Test pack').props.onClick(); await ui.settle();
  assert.match(ui.text(), /远端包预览失败.*checksum mismatch/);
  assert.equal(ui.button('预览 Test pack').props.disabled, false);
});

test('disabled install explains why and diagnostics are rendered only after opening', async t => {
  const blocked = { ...plan(), blocked: '检测到冲突：other', items: [], selected: [] };
  const ui = harness(t, { 'catalog-preview': () => response(blocked) });
  await ui.settle(); ui.button('发现').props.onClick(); ui.render(); ui.button('Test pack').props.onClick(); ui.render();
  await ui.button('预览 Test pack').props.onClick(); await ui.settle();
  const execute = ui.button('核对已安装组件'); assert.equal(execute.props.disabled, true); assert.match(execute.props.title, /检测到冲突/);
  assert.equal(ui.all().filter(n => n.type === 'pre').length, 0);
  ui.all().find(n => n.type === 'details' && n.props.onToggle).props.onToggle({ currentTarget: { open: true } }); ui.render();
  assert.equal(ui.all().filter(n => n.type === 'pre').length, 1);
  await ui.button('复制诊断').props.onClick(); await ui.settle(); assert.match(ui.text(), /诊断已复制/);
});

test('retry gives local pending feedback, suppresses repeat clicks and opens confirmation without auto-installing', async t => {
  const pending = deferred();
  const ui = harness(t, { status: () => response({ ...snapshot(), records: [task()] }), replan: () => pending.promise });
  await ui.settle(); ui.button('已安装').props.onClick(); ui.render();
  assert.doesNotMatch(ui.text(), /network unavailable/);
  const clicked = ui.button('重试失败项').props.onClick(); ui.render();
  assert.match(ui.text(), /正在核对失败项/);
  assert.equal(ui.button('正在准备重试…').props.disabled, true);
  await ui.button('正在准备重试…').props.onClick();
  assert.equal(ui.requests.filter(r => r.action === 'replan').length, 1);
  assert.deepEqual(JSON.parse(ui.requests.find(r => r.action === 'replan').init.body), { recordId: 'task', failedOnly: true });
  pending.resolve(response(plan())); await clicked; await ui.settle();
  assert.match(ui.text(), /失败项已核对，请确认后重试/);
  assert.equal(ui.button('↓ 执行所选（1）').props.disabled, false);
  assert.equal(ui.requests.filter(r => r.action === 'start').length, 0);
});

test('check updates refreshes remote catalog and previews a new pack instead of the historical target', async t => {
  let checks = 0;
  const pending = deferred();
  const ui = harness(t, { status: () => response({ ...snapshot(), records: [task()] }),
    'catalog-refresh': () => ++checks === 1 ? response(catalog) : pending.promise,
    'catalog-preview': () => response({ ...plan(), pack: { manifest: { ...plan().pack.manifest, version: '1.1.0' } } }) });
  await ui.settle(); ui.button('已安装').props.onClick(); ui.render();
  const clicked = ui.button('核对 Test pack 更新').props.onClick(); ui.render();
  assert.equal(ui.button('核对 Test pack 更新').props.disabled, true);
  assert.match(ui.text(), /正在检查整合包更新/);
  pending.resolve(response({ ...catalog, entries: [{ ...entry, version: '1.1.0', newer: true }] }));
  await clicked; await ui.settle();
  assert.match(ui.text(), /发现新版 1.1.0/);
  assert.deepEqual(JSON.parse(ui.requests.find(r => r.action === 'catalog-preview').init.body), { id: 'pack', version: '1.1.0' });
  assert.equal(ui.requests.filter(r => r.action === 'replan' || r.action === 'start').length, 0);
});

test('check without a newer pack explicitly reports the result; retry failures restore controls', async t => {
  const ui = harness(t, { status: () => response({ ...snapshot(), records: [task()] }), replan: init => JSON.parse(init.body).failedOnly ? response({ error: 'inspection failed' }, 400) : response(plan()) });
  await ui.settle(); ui.button('已安装').props.onClick(); ui.render();
  await ui.button('核对 Test pack 更新').props.onClick(); await ui.settle();
  assert.match(ui.text(), /未发现新版整合包/);
  ui.button('已安装').props.onClick(); ui.render();
  await ui.button('重试失败项').props.onClick(); await ui.settle();
  assert.match(ui.text(), /准备重试失败.*inspection failed/);
  assert.equal(ui.button('重试失败项').props.disabled, false);
  assert.equal(ui.requests.filter(r => r.action === 'start').length, 0);
});

test('running task shows overall progress, completion summarizes results and details stay collapsed', async t => {
  let current = task({ status: 'running', items: [
    { ref: 'installed-component', status: 'installed' }, { ref: 'failed-component', status: 'failed', reason: 'failure detail' },
    { ref: 'running-component', status: 'running' }, { ref: 'pending-component', status: 'pending' }
  ] });
  const ui = harness(t, { status: () => response({ ...snapshot(), busy: current.status === 'running', records: [current] }) });
  await ui.settle(); ui.button('已安装').props.onClick(); ui.render();
  assert.equal(ui.all().find(n => n.props.role === 'progressbar').props['aria-valuenow'], 50);
  assert.doesNotMatch(ui.text(), /running-component|failure detail/);
  assert.ok(!ui.all().some(n => n.type === 'button' && ui.text(n) === '重试失败项'));
  current = { ...current, status: 'partial', items: current.items.map(item => item.status === 'pending' || item.status === 'running' ? { ...item, status: 'skipped' } : item) };
  ui.poll(10000); await ui.settle();
  assert.match(ui.text(), /部分完成/); assert.match(ui.text(), /安装 1 · 复用 0 · 跳过 2 · 异常 1/);
  assert.ok(!ui.all().some(n => n.props.role === 'progressbar'));
  const details = ui.all().find(n => n.type === 'details' && ui.text(n).includes('组件详情'));
  details.props.onToggle({ currentTarget: { open: true } }); ui.render();
  assert.match(ui.text(), /failure detail/);
});

test('failure log saves the chosen task through the owner route and shows the returned path', async t => {
  const pending = deferred();
  const ui = harness(t, { status: () => response({ ...snapshot(), records: [task()] }), 'save-log': () => pending.promise });
  await ui.settle(); ui.button('已安装').props.onClick(); ui.render();
  const clicked = ui.button('保存日志').props.onClick(); ui.render();
  assert.equal(ui.button('正在保存…').props.disabled, true);
  await ui.button('正在保存…').props.onClick();
  assert.equal(ui.requests.filter(r => r.action === 'save-log').length, 1);
  assert.deepEqual(JSON.parse(ui.requests.find(r => r.action === 'save-log').init.body), { taskId: 'task', context: { error: '', connectionError: '', pending: '' } });
  pending.resolve(response({ path: '/isolated/.mojobox-manager/logs/example.json' }));
  await clicked; await ui.settle();
  assert.match(ui.text(), /日志已保存/); assert.match(ui.text(), /\/isolated/);
});

test('failed log saves do not claim success and release the save control', async t => {
  const ui = harness(t, { status: () => response({ ...snapshot(), records: [task()] }), 'save-log': () => response({ error: 'permission denied' }, 400) });
  await ui.settle(); ui.button('已安装').props.onClick(); ui.render();
  await ui.button('保存日志').props.onClick(); await ui.settle();
  assert.doesNotMatch(ui.text(), /日志已保存|正在保存日志/);
  assert.match(ui.text(), /保存日志失败.*permission denied/);
  assert.ok(ui.all().filter(n => n.type === 'button' && ui.text(n) === '保存日志').every(n => !n.props.disabled));
});
