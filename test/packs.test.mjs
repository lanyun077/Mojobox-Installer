import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZipFile } from 'yazl';
import { readFeaturePack } from '../lib/feature-pack.js';
import { PackManager, RecordStore, redact, failureReason, safeResult } from '../lib/manager.js';
import { createHandler, apply } from '../lib/index.js';

export const manifest = (plugins = [{ ref: 'dsh-plugin-a', version: '1.0.0' }], patch = {}) => ({ formatVersion: 1, id: 'test-pack', name: 'Test', version: '1.0.0', requires: { dsh: '0.2.2-rc.1' }, plugins, ...patch });
export async function archive(value, entries = []) {
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify(value)), 'pack.json');
  for (const [name, contents, options] of entries) zip.addBuffer(Buffer.from(contents), name, options);
  zip.end();
  const chunks = [];
  for await (const chunk of zip.outputStream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
const bundle = (name, patch = {}) => ({ name, version: '1.0.0', installed: true, availability: 'profile', enabled: true, source: `${name}@1.0.0`, removable: true, ...patch });
async function setup(t, changes = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mojobox-test-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  const calls = [];
  const bundles = [];
  const artifacts = {
    describe: async (name, version) => ({ name, version, registry: 'https://registry.npmjs.org/', url: 'https://registry.npmjs.org/fixture.tgz', sha512: 'a'.repeat(128) }),
    prepare: async target => `/verified/${target.name}@${target.version}.tgz`,
    owns: source => source.startsWith('file:/verified/')
  };
  const manager = {
    listBundles: async () => bundles,
    listPlugins: async () => bundles.map(item => ({ moduleName: item.name, enabled: item.enabled, fiberPhase: 'active' })),
    inspect: async spec => { const at = spec.lastIndexOf('@'); return { status: 'accepted', kind: 'registry', name: spec.slice(0, at), version: spec.slice(at + 1), bundle: true }; },
    installBundle: async (spec, options) => {
      calls.push(spec);
      const registrySpec = spec.startsWith('/verified/') ? spec.slice('/verified/'.length, -4) : spec;
      const at = registrySpec.lastIndexOf('@');
      const name = registrySpec.slice(0, at);
      const previous = bundles.find(item => item.name === name);
      const next = bundle(name, { version: registrySpec.slice(at + 1), source: spec.startsWith('/verified/') ? `file:${spec}` : spec, enabled: options.enabled });
      if (previous) Object.assign(previous, next); else bundles.push(next);
      return { application: 'applied', changed: true };
    },
    ...changes
  };
  const store = new RecordStore(join(directory, 'records.json'));
  const coordinator = new PackManager(manager, '0.2.2-rc.1', store, async () => 'unchanged', artifacts, async () => 'protected');
  await coordinator.initialize();
  t.after(() => coordinator.dispose());
  return { directory, calls, bundles, manager, store, coordinator, artifacts };
}
async function finish(coordinator) {
  for (let i = 0; i < 200; i++) {
    const status = await coordinator.status();
    if (!status.busy) return status.task;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('task did not settle');
}

async function installedPack(env, plugins = ['first', 'last'], patch = {}) {
  const plan = await env.coordinator.preview(await archive(manifest(plugins.map(ref => ({ ref, version: '1.0.0' })), patch)));
  await env.coordinator.start(plan.id, plan.selected);
  return finish(env.coordinator);
}

function enableRemoval(env, calls = []) {
  env.manager.removeBundle = async ref => {
    calls.push(ref);
    env.bundles.splice(env.bundles.findIndex(bundle => bundle.name === ref), 1);
    return { application: 'applied', changed: true };
  };
  return calls;
}

test('component actions use current inventory, preserve pack records and allow an explicit shared deletion', async t => {
  const env = await setup(t);
  const record = await installedPack(env, ['first']);
  const removes = enableRemoval(env);
  env.manager.setBundleEnabled = async (name, enabled) => {
    env.bundles.find(bundle => bundle.name === name).enabled = enabled;
    return { application: 'applied', changed: true };
  };
  let component = (await env.coordinator.status()).components.find(item => item.name === 'first');
  assert.deepEqual(component.packs, ['Test']);
  assert.equal((await env.coordinator.controlComponent('first', 'pause', component.stamp)).status, 'complete');
  component = (await env.coordinator.status()).components.find(item => item.name === 'first');
  assert.equal(component.enabled, false);
  assert.equal((await env.coordinator.controlComponent('first', 'enable', component.stamp)).status, 'complete');
  // A second pack may refer to the same plugin; deletion remains an explicit per-plugin action.
  await installedPack(env, ['first'], { id: 'second-pack', name: 'Other' });
  component = (await env.coordinator.status()).components.find(item => item.name === 'first');
  assert.deepEqual(component.packs.sort(), ['Other', 'Test']);
  assert.equal((await env.coordinator.controlComponent('first', 'delete', component.stamp)).status, 'complete');
  assert.deepEqual(removes, ['first']);
  const status = await env.coordinator.status();
  assert.equal(status.components.length, 0);
  assert.ok(status.records.find(item => item.id === record.id && !item.removedAt));
});

test('component mutations reject stale identity, protected targets and invalid route actions', async t => {
  const env = await setup(t);
  env.bundles.push(bundle('local', { source: 'link:../local' }), bundle('protected', { readOnlyReason: 'management-required' }));
  const calls = enableRemoval(env);
  const components = (await env.coordinator.status()).components;
  const local = components.find(item => item.name === 'local');
  env.bundles[0].version = '2.0.0';
  await assert.rejects(env.coordinator.controlComponent('local', 'delete', local.stamp), /状态已变化/);
  const protectedComponent = components.find(item => item.name === 'protected');
  await assert.rejects(env.coordinator.controlComponent('protected', 'delete', protectedComponent.stamp), /宿主或管理组件/);
  assert.equal(calls.length, 0);
  const handler = createHandler(env.coordinator, 'component');
  const response = await handler(new Request('http://local/api/mojobox/component', { method: 'POST', body: JSON.stringify({ name: 'local', action: 'erase', expected: '' }) }));
  assert.equal(response.status, 400);
  assert.equal((await env.coordinator.status()).busy, false);
});

test('component operation holds the shared lock and reports actual partial failure and restart requirements', async t => {
  const env = await setup(t);
  env.bundles.push(bundle('first'));
  let release;
  env.manager.setBundleEnabled = async (_name, enabled) => { await new Promise(resolve => { release = resolve; }); env.bundles[0].enabled = enabled; return { application: 'restart-required', changed: true }; };
  const component = (await env.coordinator.status()).components[0];
  const pending = env.coordinator.controlComponent('first', 'pause', component.stamp);
  await new Promise(setImmediate);
  assert.equal((await env.coordinator.status()).busy, true);
  await assert.rejects(env.coordinator.controlComponent('first', 'delete', component.stamp), /等待/);
  release(); const paused = await pending;
  assert.equal(paused.status, 'complete'); assert.match(paused.message, /重启/);
  env.manager.removeBundle = async () => { env.bundles.length = 0; return { application: 'failed', changed: true, error: { code: 'pnpm-failed' } }; };
  const current = (await env.coordinator.status()).components[0];
  const result = await env.coordinator.controlComponent('first', 'delete', current.stamp);
  assert.equal(result.status, 'unconfirmed');
  assert.equal((await env.coordinator.status()).components.length, 0);
  assert.equal((await env.coordinator.status()).componentOperation.status, 'unconfirmed');
});

test('pack preview follows official prerelease compatibility semantics', async t => {
  const env = await setup(t);
  const plan = await env.coordinator.preview(await archive(manifest(undefined, { requires: { dsh: '>=0.2.1 <0.3.0' } })));
  assert.equal(plan.blocked, undefined);
  assert.equal(plan.items[0].action, 'install');
});

test('removal is opt-in, uses the host and retains unselected plugins and durable history', async t => {
  const env = await setup(t);
  const record = await installedPack(env);
  const calls = enableRemoval(env);
  const plan = await env.coordinator.previewRemoval(record.id);
  assert.equal(plan.operation, 'remove');
  assert.deepEqual(plan.selected, []);
  assert.deepEqual(plan.items.map(item => item.action), ['remove', 'remove']);
  assert.deepEqual(calls, []);
  await assert.rejects(env.coordinator.start(plan.id, ['unknown']), /Selection/);
  await assert.rejects(env.coordinator.start(plan.id, ['first', 'first']), /Selection/);
  await env.coordinator.start(plan.id, ['first']);
  const task = await finish(env.coordinator);
  assert.deepEqual(calls, ['first']);
  assert.deepEqual(task.items.map(item => item.status), ['removed', 'retained']);
  assert.equal(task.status, 'complete');
  assert.ok(task.removedAt);
  assert.deepEqual(env.bundles.map(item => item.name), ['last']);
  assert.equal((await env.store.read())[0].removedAt, task.removedAt);
  await assert.rejects(env.coordinator.start(plan.id, ['last']), /expired/);
  await assert.rejects(env.coordinator.previewRemoval(task.id), /Active pack/);
  const reinstall = await env.coordinator.replan(task.id, false);
  assert.deepEqual(reinstall.items.map(item => item.action), ['install', 'reuse']);
});

test('record-only removal does not call host or leave a shared-pack claim', async t => {
  const env = await setup(t);
  const first = await installedPack(env, ['shared'], { id: 'first', name: 'First' });
  const second = await installedPack(env, ['shared'], { id: 'second', name: 'Second' });
  const calls = enableRemoval(env);
  const plan = await env.coordinator.previewRemoval(first.id);
  assert.equal(plan.items[0].action, 'keep');
  assert.match(plan.items[0].reason, /Second/);
  await assert.rejects(env.coordinator.start(plan.id, ['shared']), /Selection/);
  await env.coordinator.start(plan.id, []);
  await finish(env.coordinator);
  assert.deepEqual(calls, []);
  assert.equal(env.bundles.length, 1);
  assert.equal((await env.coordinator.previewRemoval(second.id)).items[0].action, 'remove');
});

test('removal protects official, management, read-only and foreign local sources', async t => {
  const env = await setup(t);
  const refs = ['official', 'readonly', 'foreign', 'host-no', 'unknown', 'dsh-plugin-mojobox'];
  const record = await installedPack(env, refs);
  enableRemoval(env);
  Object.assign(env.bundles[0], { official: true });
  Object.assign(env.bundles[1], { readOnlyReason: 'management-required' });
  Object.assign(env.bundles[2], { source: 'link:../foreign' });
  Object.assign(env.bundles[3], { removable: false });
  Object.assign(env.bundles[4], { error: { code: 'broken' } });
  const plan = await env.coordinator.previewRemoval(record.id);
  assert.ok(plan.items.every(item => item.action === 'keep'));
  await assert.rejects(env.coordinator.start(plan.id, ['official']), /Selection/);
});

test('missing removal capability and already absent bundles stay record-only', async t => {
  const env = await setup(t);
  const record = await installedPack(env);
  env.bundles.pop();
  const plan = await env.coordinator.previewRemoval(record.id);
  assert.ok(plan.items.every(item => item.action === 'keep'));
  assert.match(plan.items[0].reason, /未提供卸载接口/);
  assert.match(plan.items[1].reason, /未安装/);
  await env.coordinator.start(plan.id, []);
  assert.equal((await finish(env.coordinator)).status, 'complete');
});

test('removal rechecks version, source, enablement and removability after preview', async t => {
  for (const change of [{ version: '1.1.0' }, { source: 'first@^1.0.0' }, { enabled: false }, { removable: false }]) {
    const env = await setup(t);
    const record = await installedPack(env, ['first']);
    const calls = enableRemoval(env);
    const plan = await env.coordinator.previewRemoval(record.id);
    Object.assign(env.bundles[0], change);
    await env.coordinator.start(plan.id, ['first']);
    const task = await finish(env.coordinator);
    assert.equal(task.items[0].status, 'failed');
    assert.equal(task.removedAt, undefined);
    assert.deepEqual(calls, []);
  }
});

test('ordinary removal failure continues independent items; uncertain outcomes stop writes', async t => {
  for (const outcome of ['failed', 'partial-write', 'false-success', 'throw']) {
    const env = await setup(t);
    const record = await installedPack(env);
    const calls = enableRemoval(env);
    const remove = env.manager.removeBundle;
    env.manager.removeBundle = async ref => {
      if (ref !== 'first') return remove(ref);
      calls.push(ref);
      if (outcome === 'throw') throw new Error('connection token=secret lost');
      if (outcome === 'false-success') return { application: 'applied', changed: true };
      if (outcome === 'partial-write') env.bundles[0].enabled = false;
      return { application: 'failed', changed: outcome === 'partial-write', error: { code: 'operation-error' } };
    };
    const plan = await env.coordinator.previewRemoval(record.id);
    await env.coordinator.start(plan.id, ['first', 'last']);
    const task = await finish(env.coordinator);
    assert.deepEqual(task.items.map(item => item.status), outcome === 'failed' ? ['failed', 'removed'] : ['unconfirmed', 'unconfirmed']);
    assert.deepEqual(calls, outcome === 'failed' ? ['first', 'last'] : ['first']);
    assert.equal(task.removedAt, undefined);
    assert.doesNotMatch(JSON.stringify(task), /secret/);
    const retry = await env.coordinator.previewRemoval(task.id);
    assert.deepEqual(retry.selected, []);
    assert.equal((await env.coordinator.replan(task.id, true)).operation, 'remove');
  }
});

test('removal shares the write lock, persists interruption and reports required restarts', async t => {
  const env = await setup(t);
  const record = await installedPack(env);
  let release;
  env.manager.removeBundle = async () => {
    await new Promise(resolve => { release = resolve; });
    env.bundles.shift();
    return { application: 'restart-required', changed: true };
  };
  const plan = await env.coordinator.previewRemoval(record.id);
  await env.coordinator.start(plan.id, ['first', 'last']);
  for (let i = 0; !release && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(release);
  await assert.rejects(env.coordinator.previewRemoval(record.id), /busy/);
  await assert.rejects(env.coordinator.preview(await archive(manifest())), /busy/);
  const saved = await env.store.read();
  assert.equal(saved[0].operation, 'remove');
  assert.equal(saved[0].status, 'interrupted');
  env.coordinator.dispose(); release();
  const task = await finish(env.coordinator);
  assert.equal(task.items[0].activation, 'restart-required');
  assert.equal(task.items[1].status, 'unconfirmed');
});

test('removal route accepts only a stored record and never trusts a submitted plugin name', async t => {
  const env = await setup(t);
  const record = await installedPack(env, ['first']);
  const calls = enableRemoval(env);
  const handler = createHandler(env.coordinator, 'remove-preview');
  const request = value => new Request('http://local/api/mojobox/remove-preview', { method: 'POST', body: JSON.stringify(value) });
  for (const value of [null, [], { ref: 'first' }, { recordId: 1 }, { recordId: 'missing' }]) assert.equal((await handler(request(value))).status, 400);
  assert.equal((await handler(request({ recordId: record.id }))).status, 200);
  assert.deepEqual(calls, []);
});

test('thin pack accepts exact external versions and prerelease host range', async () => {
  const bytes = await archive(manifest());
  const pack = await readFeaturePack(bytes);
  assert.equal(pack.manifest.id, 'test-pack');
  assert.match(pack.sha256, /^[a-f0-9]{64}$/);
});

test('diagnostic export writes sanitized JSON under the profile and rejects arbitrary destinations', async t => {
  const env = await setup(t);
  const plan = await env.coordinator.preview(await archive(manifest()));
  await env.coordinator.start(plan.id, plan.selected);
  const task = await finish(env.coordinator);
  task.items[0].reason = 'request failed token=secret C:/Users/private/profile';
  const handler = createHandler(env.coordinator, 'save-log');
  const request = value => new Request('http://local/api/mojobox/save-log', { method: 'POST', body: JSON.stringify(value) });
  for (const value of [{ path: '../escape.json' }, { taskId: 'unknown' }, { taskId: 1 }, [], { context: { path: 'escape' } }, { context: { error: 1 } }, { context: { error: 'x'.repeat(4001) } }]) assert.equal((await handler(request(value))).status, 400);
  const result = await handler(request({ taskId: task.id, context: { error: 'preview failed token=secret' } }));
  assert.equal(result.status, 200);
  const { path } = await result.json();
  assert.equal(path.startsWith(join(env.directory, 'logs') + (process.platform === 'win32' ? '\\' : '/')), true);
  const log = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(log.records.length, 1);
  assert.match(log.records[0].items[0].reason, /REDACTED/);
  assert.match(log.context.error, /REDACTED/);
  assert.doesNotMatch(JSON.stringify(log), /secret|private\/profile/);
  assert.equal(log.records[0].pack.version, '1.0.0');
  assert.equal(env.calls.length, 1);
});

test('underscore npm scope installs once and reuses without further network inspection', async t => {
  let inspections = 0;
  const env = await setup(t);
  const inspect = env.manager.inspect;
  env.manager.inspect = async spec => { inspections++; return inspect(spec); };
  const bytes = await archive(manifest([{ ref: '@yolk_vat-y/dsh-project-memory', version: '0.6.12' }]));
  const plan = await env.coordinator.preview(bytes);
  assert.equal(plan.items[0].action, 'install');
  await env.coordinator.start(plan.id, plan.selected);
  assert.equal((await finish(env.coordinator)).status, 'complete');
  const count = inspections;
  env.artifacts.describe = () => assert.fail('reused component requested registry metadata');
  assert.equal((await env.coordinator.preview(bytes)).items[0].action, 'reuse');
  assert.equal(inspections, count);
  for (const ref of ['@scope/../pkg', '@scope/pkg/extra', 'file:pkg', 'https://example.org/pkg', '@scope/pkg;cmd', '@scope/pkg@1.0.0']) {
    await assert.rejects(readFeaturePack(await archive(manifest([{ ref, version: '1.0.0' }]))), /Unsupported plugin reference/);
  }
});

test('preview bounds concurrent checks, preserves order and isolates one failed component', async t => {
  const env = await setup(t);
  const plugins = Array.from({ length: 8 }, (_, index) => ({ ref: `component-${index}`, version: '1.0.0' }));
  env.bundles.push(bundle(plugins.at(-1).ref));
  const waiting = [];
  let active = 0;
  let peak = 0;
  const describe = env.artifacts.describe;
  env.artifacts.describe = async (ref, version) => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => waiting.push(resolve));
    active--;
    if (ref === 'component-2') throw new Error('registry failed token=secret');
    return describe(ref, version);
  };
  const pending = env.coordinator.preview(await archive(manifest(plugins)));
  while (waiting.length < 4) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await env.coordinator.status()).busy, true);
  await assert.rejects(env.coordinator.preview(await archive(manifest())), /busy/);
  waiting.splice(0).reverse().forEach(resolve => resolve());
  while (waiting.length < 3) await new Promise(resolve => setImmediate(resolve));
  waiting.splice(0).reverse().forEach(resolve => resolve());
  const plan = await pending;
  assert.equal(peak, 4);
  assert.deepEqual(plan.items.map(item => item.ref), plugins.map(item => item.ref));
  assert.equal(plan.items[2].action, 'unsupported');
  assert.match(plan.items[2].reason, /REDACTED/);
  assert.equal(plan.items.at(-1).action, 'reuse');
  assert.equal(plan.selected.length, 6);
  assert.equal((await env.coordinator.status()).busy, false);
  assert.deepEqual(env.calls, []);
});
test('archive and manifest boundaries reject before installation', async () => {
  for (const bytes of [
    Buffer.from('not zip'), Buffer.alloc(2 * 1024 * 1024 + 1),
    await archive(manifest(), [['payload.js', 'code']]),
    await archive(manifest(), [['pack.json', '{}']]),
    await archive(manifest(), [['icon.png', 'not png']]),
    await archive(manifest(), [['icon.png', Buffer.alloc(512 * 1024 + 1)]]),
    await archive(manifest([{ ref: 'dsh-plugin-a', version: '^1.0.0' }])),
    await archive(manifest([{ ref: 'dsh-plugin-a', version: '1.0.0' }, { ref: 'dsh-plugin-a', version: '1.0.0' }])),
    await archive(manifest(undefined, { overrides: ['../config'] })),
    await archive(manifest(undefined, { presets: [{ id: 'payload' }] })),
    await archive(manifest(undefined, { 'x-eac': { status: 'draft', intendedPluginIds: [], conflictsPending: false } })),
    await archive(manifest(undefined, { requires: { dsh: '||' } })),
    await archive(manifest(undefined, { unexpected: true }))
  ]) await assert.rejects(readFeaturePack(bytes));
  // Change both ZIP path records to a traversal of the same length; no custom ZIP encoder.
  const traversal = Buffer.from(await archive(manifest()));
  for (let offset = traversal.indexOf('pack.json'); offset !== -1; offset = traversal.indexOf('pack.json', offset + 9)) traversal.write('../x.json', offset);
  await assert.rejects(readFeaturePack(traversal));
});
test('incompatible and unknown kernel and unresolved conflicts never inspect or write', async t => {
  const { coordinator } = await setup(t, { inspect: () => assert.fail('incompatible pack was inspected') });
  for (const patch of [{ requires: { dsh: '0.2.0-rc.2' } }, { requires: {} }, { conflicts: ['bodyAttr:theme'] }]) {
    const plan = await coordinator.preview(await archive(manifest(undefined, patch)));
    assert.ok(plan.blocked);
    await assert.rejects(coordinator.start(plan.id, []));
  }
});

test('exact npm conflict references only block installed or planned opponents; unknown kinds stay blocked', async t => {
  const env = await setup(t);
  const bytes = await archive(manifest(undefined, { conflicts: ['other', '@scope/old'] }));
  env.bundles.push(bundle('other', { installed: false, availability: 'missing' }));
  const accepted = await env.coordinator.preview(bytes);
  assert.equal(accepted.blocked, undefined);
  env.bundles.push(bundle('@scope/old', { enabled: false }));
  const blocked = await env.coordinator.preview(bytes);
  assert.match(blocked.blocked, /@scope\/old/);
  await assert.rejects(env.coordinator.start(blocked.id, []), /冲突/);
  assert.equal(env.bundles.at(-1).enabled, false);
  const self = await env.coordinator.preview(await archive(manifest(undefined, { conflicts: ['dsh-plugin-a'] })));
  assert.match(self.blocked, /dsh-plugin-a/);
  assert.deepEqual(env.calls, []);
});

test('a conflict added after preview blocks start and releases the manager lock', async t => {
  const env = await setup(t);
  const bytes = await archive(manifest(undefined, { conflicts: ['other'] }));
  const plan = await env.coordinator.preview(bytes);
  env.bundles.push(bundle('other'));
  await assert.rejects(env.coordinator.start(plan.id, plan.selected), /other/);
  assert.equal((await env.coordinator.status()).busy, false);
  assert.deepEqual(env.calls, []);
  assert.equal((await env.coordinator.status()).records.length, 0);
});

test('a conflict appearing during artifact preparation prevents the host write', async t => {
  const env = await setup(t);
  env.bundles.push(bundle('dsh-plugin-a', { version: '0.9.0' }));
  env.artifacts.prepare = async () => { env.bundles.push(bundle('other')); return '/verified/dsh-plugin-a@1.0.0.tgz'; };
  const plan = await env.coordinator.preview(await archive(manifest(undefined, { conflicts: ['other'] })));
  await env.coordinator.start(plan.id, plan.selected);
  const task = await finish(env.coordinator);
  assert.equal(task.items[0].status, 'skipped');
  assert.match(task.items[0].reason, /other/);
  assert.deepEqual(env.calls, []);
  assert.equal(env.bundles[0].version, '0.9.0');
});
test('plan distinguishes reuse, lower version, higher version and local ownership', async t => {
  const { coordinator, bundles, calls } = await setup(t);
  bundles.push(bundle('same', { enabled: false }), bundle('older', { version: '0.9.0' }), bundle('newer', { version: '2.0.0' }), bundle('local', { source: 'file:/work/local.tgz' }));
  const plan = await coordinator.preview(await archive(manifest(['same', 'older', 'newer', 'local', 'builtin:legacy', 'github:owner/repo'].map(ref => ({ ref, version: '1.0.0' })))));
  assert.deepEqual(plan.items.map(item => item.action), ['reuse', 'update', 'keep-newer', 'unsupported', 'unsupported', 'unsupported']);
  await coordinator.start(plan.id, []);
  assert.equal((await finish(coordinator)).status, 'partial');
  assert.equal(bundles[0].enabled, false);
  assert.deepEqual(calls, []);
});
test('only selected new components execute; repeat import does not write', async t => {
  const { coordinator, calls } = await setup(t);
  const bytes = await archive(manifest([{ ref: 'dsh-plugin-a', version: '1.0.0' }, { ref: 'dsh-plugin-b', version: '1.0.0' }]));
  let plan = await coordinator.preview(bytes);
  await coordinator.start(plan.id, ['dsh-plugin-a']);
  assert.equal((await finish(coordinator)).status, 'partial');
  plan = await coordinator.preview(bytes);
  assert.equal(plan.items[0].action, 'reuse');
  await coordinator.start(plan.id, []);
  await finish(coordinator);
  assert.deepEqual(calls, ['dsh-plugin-a@1.0.0']);
});
test('registry aliases and forks are not adopted; different build metadata is not called an upgrade', async t => {
  const env = await setup(t);
  env.bundles.push(bundle('fork', { source: 'fork@npm:other-package@1.0.0' }), bundle('build', { version: '1.0.0+local' }));
  const plan = await env.coordinator.preview(await archive(manifest([{ ref: 'fork', version: '1.0.0' }, { ref: 'build', version: '1.0.0+official' }])));
  assert.deepEqual(plan.items.map(item => item.action), ['unsupported', 'unsupported']);
});
test('per-entry disabled settings remain disabled even when the containing bundle is selected', async t => {
  const env = await setup(t);
  env.bundles.push(bundle('dsh-plugin-a'));
  env.manager.listPlugins = async () => [{ moduleName: 'dsh-plugin-a', enabled: false, fiberPhase: null }];
  const plan = await env.coordinator.preview(await archive(manifest()));
  await env.coordinator.start(plan.id, []);
  const task = await finish(env.coordinator);
  assert.equal(task.status, 'complete');
  assert.equal(task.items[0].activation, 'disabled');
  assert.deepEqual(env.calls, []);
});
test('normal failed item continues to subsequent independent component and keeps earlier success', async t => {
  const env = await setup(t);
  const install = env.manager.installBundle;
  env.manager.installBundle = async (spec, options) => spec.startsWith('broken@') ? { application: 'failed', changed: false, error: { code: 'operation-error', diagnostic: 'download failed' } } : install(spec, options);
  const plan = await env.coordinator.preview(await archive(manifest(['first', 'broken', 'last'].map(ref => ({ ref, version: '1.0.0' })))));
  await env.coordinator.start(plan.id, ['first', 'broken', 'last']);
  const task = await finish(env.coordinator);
  assert.deepEqual(task.items.map(item => item.status), ['installed', 'failed', 'installed']);
  assert.equal(task.status, 'partial');
  assert.equal((await env.store.read())[0].status, 'partial');
  assert.deepEqual(env.calls, ['first@1.0.0', 'last@1.0.0']);
});

test('install failure guidance distinguishes approval, compatibility and file access without auto-approving', async t => {
  assert.match(failureReason({ application: 'failed', changed: false, pendingBuilds: ['example@1.0.0'] }), /审核.*审批/);
  assert.match(failureReason({ application: 'failed', changed: false, packageResult: { exitCode: 1, output: 'ERR_PNPM_IGNORED_BUILDS' } }), /构建脚本/);
  assert.match(failureReason({ application: 'failed', changed: false, error: { code: 'incompatible-version' } }), /未添加版本豁免/);
  assert.match(failureReason({ application: 'failed', changed: false, error: { code: 'operation-error', diagnostic: 'EPERM: rename failed' } }), /文件被占用或权限不足/);
  const env = await setup(t, { installBundle: async () => ({ application: 'failed', changed: false, pendingBuilds: ['dsh-plugin-a@1.0.0'] }) });
  const plan = await env.coordinator.preview(await archive(manifest()));
  await env.coordinator.start(plan.id, plan.selected);
  const row = (await finish(env.coordinator)).items[0];
  assert.equal(row.status, 'failed');
  assert.match(row.reason, /不会自动放行/);
  assert.deepEqual(row.result.pendingBuilds, ['dsh-plugin-a@1.0.0']);
  assert.equal(safeResult({ application: 'failed', changed: false, error: { code: 'test', diagnostic: 'token=secret' } }).error.diagnostic, 'token=[REDACTED]');
  const rejected = { application: 'failed', changed: false, error: { code: 'incompatible-version', incompatible: [{ name: 'old-plugin', version: '1.0.0', runtimeVersion: '0.2.2-rc.1', requirements: { '@deepseek-ai/dsh-tools': '^0.1.0' } }] } };
  assert.deepEqual(safeResult(rejected).error.incompatible, rejected.error.incompatible);
});
test('uncertain recovery stops later writes', async t => {
  const env = await setup(t, { installBundle: async () => ({ application: 'failed', changed: true, error: { code: 'operation-error' } }) });
  let count = 0;
  const coordinator = new PackManager(env.manager, '0.2.2-rc.1', env.store, async () => String(count++));
  await coordinator.initialize();
  const plan = await coordinator.preview(await archive(manifest(['broken', 'last'].map(ref => ({ ref, version: '1.0.0' })))));
  await coordinator.start(plan.id, ['broken', 'last']);
  assert.deepEqual((await finish(coordinator)).items.map(item => item.status), ['unconfirmed', 'unconfirmed']);
});
test('unknown transport/lock result pauses instead of assuming normal failure', async t => {
  const env = await setup(t, { installBundle: async () => { throw new Error('transport lost'); } });
  const plan = await env.coordinator.preview(await archive(manifest()));
  await env.coordinator.start(plan.id, ['dsh-plugin-a']);
  assert.equal((await finish(env.coordinator)).status, 'interrupted');
});
test('identity mismatch and read failure isolate preview rows', async t => {
  const env = await setup(t);
  const inspect = env.manager.inspect;
  env.manager.inspect = async spec => spec.startsWith('bad@') ? { status: 'accepted', kind: 'registry', name: 'different', version: '1.0.0', bundle: true } : spec.startsWith('lost@') ? Promise.reject(new Error('network')) : inspect(spec);
  const plan = await env.coordinator.preview(await archive(manifest(['bad', 'lost', 'good'].map(ref => ({ ref, version: '1.0.0' })))));
  assert.deepEqual(plan.items.map(item => item.action), ['unsupported', 'unsupported', 'install']);
});
test('state changes after preview are re-read and do not overwrite a newer install', async t => {
  const env = await setup(t);
  const plan = await env.coordinator.preview(await archive(manifest()));
  env.bundles.push(bundle('dsh-plugin-a', { version: '2.0.0' }));
  await env.coordinator.start(plan.id, ['dsh-plugin-a']);
  assert.equal((await finish(env.coordinator)).items[0].status, 'skipped');
  assert.deepEqual(env.calls, []);
});
test('selection and preview IDs cannot introduce arbitrary specs or replay execution', async t => {
  const env = await setup(t);
  const plan = await env.coordinator.preview(await archive(manifest()));
  await assert.rejects(env.coordinator.start(plan.id, ['file:/tmp/payload']));
  await assert.rejects(env.coordinator.start('missing', []));
  await env.coordinator.start(plan.id, ['dsh-plugin-a']);
  await assert.rejects(env.coordinator.start(plan.id, ['dsh-plugin-a']));
  await finish(env.coordinator);
  await assert.rejects(env.coordinator.start(plan.id, []));
});
test('installed bytes and activation are independent; restart is explicit', async t => {
  for (const [phase, application, expected, activation] of [['failed', 'applied', 'failed', 'failed'], ['pending', 'restart-required', 'installed', 'restart-required']]) {
    const env = await setup(t);
    const install = env.manager.installBundle;
    env.manager.installBundle = async (...args) => ({ ...await install(...args), application });
    env.manager.listPlugins = async () => [{ moduleName: 'dsh-plugin-a', enabled: true, fiberPhase: phase }];
    const plan = await env.coordinator.preview(await archive(manifest()));
    await env.coordinator.start(plan.id, ['dsh-plugin-a']);
    const task = await finish(env.coordinator);
    assert.equal(task.items[0].status, expected); assert.equal(task.items[0].activation, activation);
  }
});
test('restart reads durable records and marks interrupted writes for reconciliation', async t => {
  const env = await setup(t);
  const task = { id: 'interrupted', status: 'running', items: [{ ref: 'first', status: 'installed' }, { ref: 'second', status: 'running' }, { ref: 'third', status: 'pending' }] };
  await env.store.write([task]);
  const [recovered] = await new RecordStore(join(env.directory, 'records.json')).read();
  assert.equal(recovered.status, 'interrupted');
  assert.deepEqual(recovered.items.map(item => item.status), ['installed', 'unconfirmed', 'unconfirmed']);
  await writeFile(join(env.directory, 'records.json'), 'corrupt');
  await assert.rejects(env.store.read());
  assert.equal(await readFile(join(env.directory, 'records.json'), 'utf8'), 'corrupt');
});
test('exact-route handlers enforce size and selection boundary; errors are redacted', async t => {
  const env = await setup(t);
  const handle = createHandler(env.coordinator, 'preview');
  const oversized = await handle(new Request('http://local/api/mojobox/preview', { method: 'POST', headers: { 'content-length': '9999999' }, body: 'tiny' }));
  assert.equal(oversized.status, 413);
  const response = await handle(new Request('http://local/api/mojobox/preview', { method: 'POST', body: await archive(manifest()) }));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.status, 200);
  const rejected = await createHandler(env.coordinator, 'start')(new Request('http://local/api/mojobox/start', { method: 'POST', body: '{}' }));
  assert.equal(rejected.status, 400);
  assert.equal(redact('https://name:secret@example.org token=abc password=xyz\nC:\\Users\\person\\file.log'), 'https://[REDACTED]@example.org token=[REDACTED] password=[REDACTED]\n[LOCAL_PATH]');
});
test('Host registration uses the authenticated owner Connection and disposes all routes', async t => {
  const env = await setup(t);
  await writeFile(join(env.directory, 'package.json'), JSON.stringify({ version: '0.2.2-rc.1' }));
  const routes = []; const cleanups = [];
  await apply({ pluginManager: env.manager, profileContext: { dir: env.directory, installAnchor: join(env.directory, 'package.json') }, connection: { fetch: { register: route => { routes.push(route); return () => routes.splice(routes.indexOf(route), 1); } } }, effect: fn => cleanups.push(fn()), logger: { info() {} } });
  assert.deepEqual(routes.map(route => [route.path, route.methods]), [['/api/mojobox/status', ['GET']], ['/api/mojobox/preview', ['POST']], ['/api/mojobox/start', ['POST']], ['/api/mojobox/replan', ['POST']], ['/api/mojobox/remove-preview', ['POST']], ['/api/mojobox/component', ['POST']], ['/api/mojobox/catalog', ['GET']], ['/api/mojobox/catalog-refresh', ['POST']], ['/api/mojobox/catalog-preview', ['POST']], ['/api/mojobox/save-log', ['POST']]]);
  for (const cleanup of cleanups.reverse()) cleanup();
  assert.equal(routes.length, 0);
});

test('status omits heavyweight official metadata and preserves version and runtime state', async t => {
  const env = await setup(t);
  env.bundles.push({ ...bundle('example'), meta: { icon: 'x'.repeat(1000000) }, rows: [{ meta: { icon: 'y'.repeat(1000000) } }] });
  env.manager.listPlugins = async () => [{ entryId: 'entry', moduleName: 'example', enabled: true, fiberPhase: 'active', meta: { icon: 'z'.repeat(1000000) } }];
  const value = await (await createHandler(env.coordinator, 'status')(new Request('http://local'))).json();
  assert.ok(JSON.stringify(value).length < 1000);
  assert.deepEqual(value.bundles, [{ name: 'example', version: '1.0.0', installed: true, availability: 'profile', enabled: true }]);
  assert.deepEqual(value.runtime, [{ entryId: 'entry', moduleName: 'example', enabled: true, fiberPhase: 'active' }]);
  assert.equal(env.bundles[0].meta.icon.length, 1000000);
});

test('selective updates preserve disabled state, leave unselected components and survive repeat and restart', async t => {
  const env = await setup(t);
  env.bundles.push(bundle('first', { enabled: false }), bundle('last'));
  const bytes = await archive(manifest(['first', 'last'].map(ref => ({ ref, version: '1.1.0' }))));
  const plan = await env.coordinator.preview(bytes);
  assert.deepEqual(plan.items.map(item => item.action), ['update', 'update']);
  await env.coordinator.start(plan.id, ['first']);
  const task = await finish(env.coordinator);
  assert.deepEqual(task.items.map(item => item.status), ['installed', 'skipped']);
  assert.equal(task.items[0].activation, 'disabled');
  assert.equal(task.items[0].reason, '已安装，保留停用设置');
  assert.equal(env.bundles[0].enabled, false);
  assert.equal(env.bundles[1].version, '1.0.0');
  const restarted = new PackManager(env.manager, '0.2.2-rc.1', env.store, async () => 'same', env.artifacts);
  await restarted.initialize();
  const next = await restarted.preview(bytes);
  assert.deepEqual(next.items.map(item => item.action), ['reuse', 'update']);
  await restarted.start(next.id, []); await finish(restarted);
  assert.deepEqual(env.calls, ['/verified/first@1.1.0.tgz']);
});

test('artifact download failure continues independent updates; retry preselects only failed rows', async t => {
  const env = await setup(t);
  env.bundles.push(bundle('first'), bundle('broken'), bundle('last'));
  const prepare = env.artifacts.prepare;
  env.artifacts.prepare = target => target.name === 'broken' ? Promise.reject(new Error('SHA mismatch')) : prepare(target);
  const plan = await env.coordinator.preview(await archive(manifest(['first', 'broken', 'last'].map(ref => ({ ref, version: '1.1.0' })))));
  await env.coordinator.start(plan.id, plan.selected);
  const task = await finish(env.coordinator);
  assert.deepEqual(task.items.map(item => item.status), ['installed', 'failed', 'installed']);
  const retry = await env.coordinator.replan(task.id, true);
  assert.deepEqual(retry.selected, ['broken']);
  assert.deepEqual(retry.items.map(item => item.action), ['reuse', 'update', 'reuse']);
  assert.equal(env.calls.length, 2);
  env.bundles.find(item => item.name === 'broken').version = '1.1.0';
  assert.deepEqual((await env.coordinator.replan(task.id, true)).selected, []);
});

test('a failed host update continues only when both configuration and actual old version recovered', async t => {
  for (const restored of [true, false]) {
    const env = await setup(t);
    env.bundles.push(bundle('broken'), bundle('last'));
    const install = env.manager.installBundle;
    env.manager.installBundle = async (spec, options) => {
      if (spec.includes('broken@')) {
        if (!restored) env.bundles[0].version = '1.1.0';
        return { application: 'failed', changed: false, error: { code: 'operation-error' } };
      }
      return install(spec, options);
    };
    const plan = await env.coordinator.preview(await archive(manifest(['broken', 'last'].map(ref => ({ ref, version: '1.1.0' })))));
    await env.coordinator.start(plan.id, plan.selected);
    assert.deepEqual((await finish(env.coordinator)).items.map(item => item.status), restored ? ['failed', 'installed'] : ['unconfirmed', 'unconfirmed']);
  }
});

test('changed protected configuration or entry selection pauses subsequent writes after update', async t => {
  const env = await setup(t);
  env.bundles.push(bundle('first'), bundle('last'));
  let fingerprint = 0;
  const coordinator = new PackManager(env.manager, '0.2.2-rc.1', env.store, async () => 'same', env.artifacts, async () => String(fingerprint++));
  await coordinator.initialize();
  const plan = await coordinator.preview(await archive(manifest(['first', 'last'].map(ref => ({ ref, version: '1.1.0' })))));
  await coordinator.start(plan.id, plan.selected);
  assert.deepEqual((await finish(coordinator)).items.map(item => item.status), ['unconfirmed', 'unconfirmed']);
  assert.equal(env.calls.length, 1);
});

test('shared targets remain visible and higher installed versions are never downgraded', async t => {
  const env = await setup(t);
  env.bundles.push(bundle('shared'));
  const first = await env.coordinator.preview(await archive(manifest([{ ref: 'shared', version: '1.0.0' }], { id: 'one' })));
  await env.coordinator.start(first.id, []); await finish(env.coordinator);
  const second = await env.coordinator.preview(await archive(manifest([{ ref: 'shared', version: '1.1.0' }], { id: 'two' })));
  assert.deepEqual(second.items[0].sharedTargets, [{ id: 'one', name: 'Test', version: '1.0.0' }]);
  await env.coordinator.start(second.id, ['shared']); await finish(env.coordinator);
  const firstRecord = (await env.coordinator.status()).records.find(item => item.pack.manifest.id === 'one');
  const recheck = await env.coordinator.replan(firstRecord.id, false);
  assert.equal(recheck.items[0].action, 'keep-newer');
  assert.deepEqual(recheck.selected, []);
});

test('declared dependencies in a pack execute before their consumers; failures skip only related rows', async t => {
  for (const fail of [false, true]) {
    const env = await setup(t);
    const describe = env.artifacts.describe;
    env.artifacts.describe = async (name, version) => ({ ...await describe(name, version), requirements: name === 'consumer' ? [{ ref: 'base', range: '^1.0.0' }] : [] });
    const install = env.manager.installBundle;
    const execution = [];
    env.manager.installBundle = async (spec, options) => {
      execution.push(spec);
      if (spec === 'base@1.0.0' && fail) return { application: 'failed', changed: false, error: { code: 'operation-error' } };
      return install(spec, options);
    };
    const plan = await env.coordinator.preview(await archive(manifest(['consumer', 'base', 'independent'].map(ref => ({ ref, version: '1.0.0' })))));
    await env.coordinator.start(plan.id, plan.selected);
    const task = await finish(env.coordinator);
    assert.deepEqual(task.items.map(item => item.status), fail ? ['dependency-skipped', 'failed', 'installed'] : ['installed', 'installed', 'installed']);
    assert.deepEqual(execution, fail ? ['base@1.0.0', 'independent@1.0.0'] : ['base@1.0.0', 'consumer@1.0.0', 'independent@1.0.0']);
  }
});

test('unselected missing dependencies and cycles never expand the user selection', async t => {
  const env = await setup(t);
  const describe = env.artifacts.describe;
  env.artifacts.describe = async (name, version) => ({ ...await describe(name, version), requirements: name === 'one' ? [{ ref: 'two', range: '^1.0.0' }] : name === 'two' ? [{ ref: 'one', range: '^1.0.0' }] : [] });
  const bytes = await archive(manifest(['one', 'two', 'independent'].map(ref => ({ ref, version: '1.0.0' }))));
  let plan = await env.coordinator.preview(bytes);
  await env.coordinator.start(plan.id, ['one']);
  assert.deepEqual((await finish(env.coordinator)).items.map(item => item.status), ['dependency-skipped', 'skipped', 'skipped']);
  assert.deepEqual(env.calls, []);
  plan = await env.coordinator.preview(bytes);
  await env.coordinator.start(plan.id, plan.selected);
  assert.deepEqual((await finish(env.coordinator)).items.map(item => item.status), ['dependency-skipped', 'dependency-skipped', 'installed']);
  assert.deepEqual(env.calls, ['independent@1.0.0']);
});
