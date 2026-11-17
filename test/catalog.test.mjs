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
  const state = { document, bytes, offline: false, requests: [], contributors: { format: 'mojobox-contributors-v1', repository: 'lanyun077/EAC-mojobox', items: [] }, rankings: { format: 'mojobox-rankings-v1', data_as_of: new Date().toISOString(), items: [] } };
  const file = join(directory, 'catalog.json');
  const transport = async (url, limit) => {
    state.requests.push({ url, limit });
    if (state.offline) throw new Error('offline token=secret');
    const metadata = /generated\/(contributors|rankings)\.json$/.exec(url)?.[1];
    if (metadata) { if (state.metadataGate) await state.metadataGate; if (state.metadataOffline) throw new Error('offline'); return Buffer.from(JSON.stringify(state[metadata])); }
    return url === CATALOG_URL ? Buffer.from(JSON.stringify(state.document)) : state.bytes;
  };
  const catalog = new Catalog(file, transport); await catalog.initialize();
  return { catalog, state, entry, directory, file, transport };
}
const request = (route, body) => new Request(`http://local/api/mojobox/${route}`, { method: 'POST', body: JSON.stringify(body) });
const presentationReady = async catalog => {
  for (let i = 0; i < 100 && catalog.view(host, []).metadataLoading; i++) await new Promise(setImmediate);
  assert.equal(catalog.view(host, []).metadataLoading, false);
};

test('market metadata joins verified submitters and real download counts by exact pack identity', async t => {
  const { catalog, state, entry } = await setup(t);
  entry.source = 'https://github.com/example/original';
  state.contributors.items = [{ kind: 'pack', resource_id: 'remote-test', version: '1.1.0', first_submission: { github_login: 'submitter', github_user_id: 42 } }];
  state.rankings.items = [{ kind: 'pack', resource_id: 'remote-test', version: '1.1.0', downloads_all: 3582500, downloads_7d: 0 }];
  let release;
  state.metadataGate = new Promise(resolve => { release = resolve; });
  await catalog.refresh();
  assert.equal(catalog.view(host, []).stale, false);
  assert.equal(catalog.view(host, []).metadataLoading, true);
  release(); await presentationReady(catalog);
  const result = catalog.view(host, []).entries[0];
  assert.equal(result.source, entry.source);
  assert.deepEqual(result.submitter, { login: 'submitter', userId: 42 });
  assert.equal(result.downloadsAll, 3582500); assert.equal(result.downloads7d, 0);
  assert.equal(result.statisticsAt, state.rankings.data_as_of);
  state.contributors.items[0].version = '1.0.0'; state.rankings.items[0].version = '1.0.0';
  await catalog.refresh(); await presentationReady(catalog);
  assert.equal(catalog.view(host, []).entries[0].submitter, undefined);
  assert.equal(catalog.view(host, []).entries[0].downloadsAll, undefined);
});

test('display metadata rejects unsafe identities, preserves unknown counts and cannot block installation', async t => {
  const { catalog, state, entry } = await setup(t);
  entry.source = 'javascript:alert(1)';
  state.contributors.items = [{ kind: 'pack', resource_id: 'remote-test', version: '1.1.0', first_submission: { github_login: '../evil', github_user_id: 42 } }];
  state.rankings.data_as_of = '2020-01-01T00:00:00Z';
  state.rankings.items = [{ kind: 'pack', resource_id: 'remote-test', version: '1.1.0', downloads_all: -1, downloads_7d: null }];
  await catalog.refresh(); await presentationReady(catalog);
  const result = catalog.view(host, []).entries[0];
  assert.equal(result.source, undefined); assert.equal(result.submitter, undefined);
  assert.equal(result.downloadsAll, null); assert.equal(result.downloads7d, null);
  assert.equal(result.statisticsStale, true);
  state.metadataOffline = true;
  await catalog.refresh(); await presentationReady(catalog);
  assert.equal(catalog.view(host, []).stale, false);
  assert.match(catalog.view(host, []).metadataError, /暂不可用/);
  assert.equal(catalog.view(host, []).entries[0].downloadsAll, undefined);
  assert.ok(await catalog.archive('remote-test', '1.1.0', host, []));
});

test('catalog validates production protocol, consumed fields and official subpath URLs', async t => {
  const { state, entry } = await setup(t);
  assert.equal(parseCatalog(state.document)[0].archiveUrl, 'https://mojobox.cn/generated/downloads/test.dshpack');
  for (const patch of [{ demo: true }, { mode: 'demo' }, { apiVersion: 'next' }, { packs: [entry, entry] }]) assert.throws(() => parseCatalog({ ...state.document, ...patch }));
  for (const patch of [{ archiveUrl: 'https://evil.example/a' }, { archiveUrl: '../downloads/a' }, { archiveUrl: '/downloads/a' }, { archiveUrl: 'generated/downloads/a?token=secret' }, { archiveSize: 2097153 }, { archiveDigest: 'sha256:bad' }, { components: [{ ref: 'a', version: '^1' }] }, { requires: { dsh: '||' } }]) assert.throws(() => parseCatalog({ ...state.document, packs: [{ ...entry, ...patch }] }));
});

test('catalog accepts underscore npm scopes while rejecting executable and path references', async t => {
  const { state, entry } = await setup(t, manifest({ plugins: [{ ref: '@yolk_vat-y/dsh-project-memory', version: '0.6.12' }] }));
  assert.equal(parseCatalog(state.document)[0].components[0].ref, '@yolk_vat-y/dsh-project-memory');
  for (const ref of ['@scope/pkg/extra', '@scope/../pkg', 'file:pkg', 'https://example.org/pkg', '@scope/pkg;cmd']) {
    assert.throws(() => parseCatalog({ ...state.document, packs: [{ ...entry, components: [{ ref, version: '1.0.0' }] }] }));
  }
});

test('catalog binds Releases to the selected pack identity and preserves old Pages download links', async t => {
  const { state, entry } = await setup(t);
  const url = 'https://github.com/lanyun077/EAC-mojobox/releases/download/pack-remote-test-v1.1.0/remote-test-1.1.0.dshpack';
  entry.archiveUrl = url;
  assert.equal(parseCatalog(state.document)[0].archiveUrl, url);
  for (const invalid of [url.replace('lanyun077/', 'other/'), url.replace('pack-remote-test', 'pack-other'), url.replace('/remote-test-1.1.0.dshpack', '/other.dshpack'), `${url}?token=secret`, url.replace('https:', 'http:')]) {
    entry.archiveUrl = invalid;
    assert.throws(() => parseCatalog(state.document), /outside/);
  }
  entry.archiveUrl = 'https://lanyun077.github.io/EAC-mojobox/generated/downloads/test.dshpack';
  assert.equal(parseCatalog(state.document)[0].archiveUrl, entry.archiveUrl);
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
  assert.equal(catalog.view('0.2.0-rc.2', records).entries[0].newer, true);
  assert.equal(catalog.view('0.2.0-rc.2', records).entries[0].blocked, undefined);
  assert.match(catalog.view('0.2.0-rc.2', records).entries[0].warning, /逐项交由官版核验/);
  records[0].pack.manifest.version = entry.metadata.version; records[0].pack.sha256 = entry.archiveDigest.slice(7);
  entry.metadata.description = 'Changed copy'; await catalog.refresh(); assert.equal(catalog.view(host, records).entries[0].newer, false);
  records[0].pack.sha256 = 'b'.repeat(64); assert.match(catalog.view(host, records).entries[0].blocked, /摘要/);
  state.document.packs = []; await catalog.refresh(); assert.equal(catalog.view(host, records).entries.length, 0); assert.equal(records.length, 1);
});

test('catalog uses prerelease host ranges and removed records keep identity without update badges', async t => {
  const { catalog, entry } = await setup(t, manifest({ requires: { dsh: '>=0.2.1 <0.3.0' } }));
  await catalog.refresh();
  const records = [{ removedAt: '2026-11-12T00:00:00Z', pack: { manifest: manifest({ version: '1.0.0' }), sha256: 'a'.repeat(64) } }];
  const view = catalog.view(host, records).entries[0];
  assert.equal(view.blocked, undefined);
  assert.equal(view.installedVersion, undefined);
  assert.equal(view.newer, false);
  records[0].pack.manifest.version = entry.metadata.version;
  assert.match(catalog.view(host, records).entries[0].blocked, /摘要/);
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
test('kernel declaration differences allow remote preview, status polling never accesses the network', async t => {
  const { catalog, state } = await setup(t, manifest({ requires: { dsh: '0.2.0-rc.2' } })); await catalog.refresh();
  assert.ok(await catalog.archive('remote-test', '1.1.0', host, []));
  assert.match(catalog.view(host, []).entries[0].warning, /逐项交由官版核验/);
  const before = state.requests.length;
  const manager = { status: async () => ({ hostVersion: host, records: [] }) };
  for (let i = 0; i < 3; i++) await createHandler(manager, 'status', catalog)(new Request('http://local'));
  assert.equal(state.requests.length, before);
});
test('packs without a kernel range remain available with an explicit warning', async t => {
  const { catalog, state, entry } = await setup(t);
  state.document.packs.push({ ...entry, metadata: { ...entry.metadata, id: 'legacy' }, requires: {} });
  await catalog.refresh(); const view = catalog.view(host, []);
  assert.equal(view.stale, false); assert.equal(view.entries.length, 2); assert.equal(view.entries[0].blocked, undefined);
  assert.equal(view.entries[1].blocked, undefined);
  assert.match(view.entries[1].warning, /未声明/);
  assert.equal(state.requests.filter(request => request.url === CATALOG_URL).length, 1);
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
  assert.ok(state.requests.every(item => item.url.startsWith('https://mojobox.cn/')));
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
