import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZipFile } from 'yazl';
import { Catalog, CATALOG_URL, parseCatalog } from '../lib/catalog.js';
import { PackManager, RecordStore } from '../lib/manager.js';
import { createHandler } from '../lib/index.js';

const host = '0.2.2-rc.1';
const manifest = (patch = {}) => ({ formatVersion: 1, id: 'remote-test', version: '1.1.0', name: 'Remote test', requires: { dsh: host }, plugins: [{ ref: 'dsh-plugin-a', version: '1.0.0' }], ...patch });
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
async function archive(m) {
  const zip = new ZipFile(); zip.addBuffer(Buffer.from(JSON.stringify(m)), 'pack.json'); zip.end();
  const chunks = []; for await (const chunk of zip.outputStream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
async function setup(t, m = manifest()) {
  const directory = await mkdtemp(join(tmpdir(), 'mojobox-catalog-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  const bytes = await archive(m);
  const entry = { format: 'eac-feature-pack-v1', metadata: { id: m.id, version: m.version, name: m.name, description: 'Description' }, author: 'Author', requires: m.requires, components: m.plugins, archiveUrl: 'generated/downloads/test.dshpack', archiveSize: bytes.length, archiveDigest: digest(bytes) };
  const document = { apiVersion: 'catalog.mojobox.dev/v1alpha1', mode: 'intake', demo: false, packs: [entry] };
  const state = { document, bytes, offline: false, requests: [] };
  const file = join(directory, 'catalog.json');
  const transport = async (url, limit) => {
    state.requests.push({ url, limit });
    if (state.offline) throw new Error('offline token=secret');
    return url === CATALOG_URL ? Buffer.from(JSON.stringify(state.document)) : state.bytes;
  };
  const catalog = new Catalog(file, transport); await catalog.initialize();
  return { catalog, state, entry, directory, file, transport };
}
const request = (route, body) => new Request(`http://local/api/mojobox/${route}`, { method: 'POST', body: JSON.stringify(body) });

test('catalog validates production protocol, consumed fields and official subpath URLs', async t => {
  const { state, entry } = await setup(t);
  assert.equal(parseCatalog(state.document)[0].archiveUrl, 'https://lanyun077.github.io/EAC-mojobox/generated/downloads/test.dshpack');
  for (const patch of [{ demo: true }, { mode: 'demo' }, { apiVersion: 'next' }, { packs: [entry, entry] }]) assert.throws(() => parseCatalog({ ...state.document, ...patch }));
  for (const patch of [{ archiveUrl: 'https://evil.example/a' }, { archiveUrl: '../downloads/a' }, { archiveUrl: '/generated/downloads/a' }, { archiveUrl: 'generated/downloads/a?token=secret' }, { archiveSize: 2097153 }, { archiveDigest: 'sha256:bad' }, { components: [{ ref: 'a', version: '^1' }] }, { requires: { dsh: '||' } }]) assert.throws(() => parseCatalog({ ...state.document, packs: [{ ...entry, ...patch }] }));
});

test('catalog accepts underscore npm scopes while rejecting executable and path references', async t => {
  const { state, entry } = await setup(t, manifest({ plugins: [{ ref: '@yolk_vat-y/dsh-project-memory', version: '0.6.12' }] }));
  assert.equal(parseCatalog(state.document)[0].components[0].ref, '@yolk_vat-y/dsh-project-memory');
  for (const ref of ['@scope/pkg/extra', '@scope/../pkg', 'file:pkg', 'https://example.org/pkg', '@scope/pkg;cmd']) {
    assert.throws(() => parseCatalog({ ...state.document, packs: [{ ...entry, components: [{ ref, version: '1.0.0' }] }] }));
  }
});
test('valid cache survives offline restart but cannot install until a successful refresh', async t => {
  const { catalog, state, file, transport } = await setup(t);
  await catalog.refresh(); const first = catalog.view(host, []); assert.equal(first.stale, false);
  const restarted = new Catalog(file, transport); await restarted.initialize();
  assert.equal(restarted.view(host, []).entries.length, 1); assert.equal(restarted.view(host, []).stale, true);
  state.offline = true; await restarted.refresh();
  assert.equal(restarted.view(host, []).checkedAt, first.checkedAt); assert.match(restarted.view(host, []).error, /REDACTED/);
  await assert.rejects(restarted.archive('remote-test', '1.1.0', host, []), /Refresh/);
  state.offline = false; await restarted.refresh(); assert.ok(await restarted.archive('remote-test', '1.1.0', host, []));
});
test('same-version digest changes are rejected across refresh, removal and restart', async t => {
  const { catalog, state, entry, file, transport } = await setup(t);
  await catalog.refresh(); state.document.packs = []; await catalog.refresh();
  const restarted = new Catalog(file, transport); await restarted.initialize();
  state.document.packs = [{ ...entry, archiveDigest: `sha256:${'f'.repeat(64)}` }];
  await restarted.refresh(); assert.equal(restarted.view(host, []).stale, true); assert.match(restarted.view(host, []).error, /version bump/);
  assert.equal(restarted.view(host, []).entries.length, 0);
});
test('newer detection preserves local targets; metadata and disappearance do not imply updates', async t => {
  const { catalog, state, entry } = await setup(t);
  const records = [{ source: 'local', pack: { manifest: manifest({ version: '1.0.0' }), sha256: 'a'.repeat(64) } }];
  await catalog.refresh(); assert.equal(catalog.view(host, records).entries[0].newer, true);
  assert.equal(catalog.view('0.2.0-rc.2', records).entries[0].newer, false);
  assert.match(catalog.view('0.2.0-rc.2', records).entries[0].blocked, /内核/);
  records[0].pack.manifest.version = entry.metadata.version; records[0].pack.sha256 = entry.archiveDigest.slice(7);
  entry.metadata.description = 'Changed copy'; await catalog.refresh(); assert.equal(catalog.view(host, records).entries[0].newer, false);
  records[0].pack.sha256 = 'b'.repeat(64); assert.match(catalog.view(host, records).entries[0].blocked, /摘要/);
  state.document.packs = []; await catalog.refresh(); assert.equal(catalog.view(host, records).entries.length, 0); assert.equal(records.length, 1);
});
test('download enforces exact size, digest, archive identity and declarations before preview', async t => {
  for (const mutation of ['size', 'digest', 'id', 'version', 'requires', 'components']) {
    const { catalog, state, entry } = await setup(t);
    if (mutation === 'size') entry.archiveSize++;
    else if (mutation === 'digest') entry.archiveDigest = `sha256:${'a'.repeat(64)}`;
    else {
      state.bytes = await archive(manifest({ [mutation]: mutation === 'id' ? 'other' : mutation === 'version' ? '9.0.0' : mutation === 'requires' ? { dsh: '*' } : undefined, ...(mutation === 'components' ? { plugins: [{ ref: 'other', version: '1.0.0' }] } : {}) }));
      entry.archiveSize = state.bytes.length; entry.archiveDigest = digest(state.bytes);
    }
    await catalog.refresh(); await assert.rejects(catalog.archive('remote-test', '1.1.0', host, []));
  }
});
test('incompatible catalog entries never download, status polling never accesses the network', async t => {
  const { catalog, state } = await setup(t, manifest({ requires: { dsh: '0.2.0-rc.2' } })); await catalog.refresh();
  await assert.rejects(catalog.archive('remote-test', '1.1.0', host, []), /内核/);
  const manager = { status: async () => ({ hostVersion: host, records: [] }) };
  for (let i = 0; i < 3; i++) await createHandler(manager, 'status', catalog)(new Request('http://local'));
  assert.equal(state.requests.length, 1);
});
test('legacy packs without a kernel range remain visible and blocked alongside compatible entries', async t => {
  const { catalog, state, entry } = await setup(t);
  state.document.packs.push({ ...entry, metadata: { ...entry.metadata, id: 'legacy' }, requires: {} });
  await catalog.refresh(); const view = catalog.view(host, []);
  assert.equal(view.stale, false); assert.equal(view.entries.length, 2); assert.equal(view.entries[0].blocked, undefined);
  assert.match(view.entries[1].blocked, /未声明/);
  await assert.rejects(catalog.archive('legacy', '1.1.0', host, []), /未声明/);
  assert.equal(state.requests.length, 1);
});
test('remote and local previews share selective executor; records retain source across retry', async t => {
  const { catalog, state, directory } = await setup(t); await catalog.refresh();
  const calls = []; const bundles = [];
  const hostManager = {
    listBundles: async () => bundles, listPlugins: async () => bundles.map(item => ({ moduleName: item.name, enabled: true, fiberPhase: 'active' })),
    inspect: async () => ({ status: 'accepted', kind: 'registry', name: 'dsh-plugin-a', version: '1.0.0', bundle: true }),
    installBundle: async spec => { calls.push(spec); bundles.push({ name: 'dsh-plugin-a', version: '1.0.0', installed: true, enabled: true, availability: 'profile', source: spec }); return { application: 'applied', changed: true }; }
  };
  const coordinator = new PackManager(hostManager, host, new RecordStore(join(directory, 'records.json')), async () => 'same'); await coordinator.initialize();
  t.after(() => coordinator.dispose());
  const response = await createHandler(coordinator, 'catalog-preview', catalog)(request('catalog-preview', { id: 'remote-test', version: '1.1.0', url: 'https://evil.example/' }));
  assert.equal(response.status, 200); const plan = await response.json(); assert.equal(plan.source, 'catalog');
  await coordinator.start(plan.id, plan.selected);
  for (let i = 0; i < 100 && (await coordinator.status()).busy; i++) await new Promise(resolve => setTimeout(resolve, 5));
  const status = await coordinator.status(); assert.equal(status.task.status, 'complete'); assert.equal(status.task.source, 'catalog'); assert.deepEqual(calls, ['dsh-plugin-a@1.0.0']);
  const retry = await coordinator.replan(status.task.id, true); assert.equal(retry.source, 'catalog'); assert.deepEqual(retry.selected, []);
  const local = await coordinator.preview(state.bytes); assert.equal(local.source, 'local'); assert.equal(local.items[0].action, 'reuse');
  assert.ok(state.requests.every(item => item.url.startsWith('https://lanyun077.github.io/EAC-mojobox/')));
  assert.equal(JSON.parse(await readFile(join(directory, 'records.json'), 'utf8'))[0].source, 'catalog');
  state.offline = true; await catalog.refresh();
  const offlineLocal = await coordinator.preview(state.bytes); assert.equal(offlineLocal.items[0].action, 'reuse');
  assert.equal((await coordinator.status()).records.length, 1);
});
test('a catalog change while an archive is downloading expires the selection', async t => {
  const { file, state, transport } = await setup(t);
  let release; let entered;
  const downloading = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const catalog = new Catalog(file, async (url, limit) => {
    if (url !== CATALOG_URL) { entered(); await gate; }
    return transport(url, limit);
  });
  await catalog.initialize(); await catalog.refresh();
  const pending = catalog.archive('remote-test', '1.1.0', host, []);
  await downloading; state.document.packs = []; await catalog.refresh(); release();
  await assert.rejects(pending, /changed during download/);
});
