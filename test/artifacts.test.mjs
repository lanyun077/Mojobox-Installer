import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { c } from 'tar';
import { RegistryArtifacts, download, verifyTarball } from '../lib/artifacts.js';

async function fixture(t, patch = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mojobox-artifact-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  await mkdir(join(directory, 'package'));
  const value = { name: 'fixture', version: '1.1.0', dsh: { bundle: {} }, ...patch };
  await writeFile(join(directory, 'package', 'package.json'), JSON.stringify(value));
  const stream = c({ gzip: true, cwd: directory }, ['package']);
  const chunks = []; for await (const chunk of stream) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  const sha512 = createHash('sha512').update(bytes).digest('hex');
  return { directory, bytes, target: { name: 'fixture', version: '1.1.0', sha512 } };
}

test('tarball verification binds actual package identity, version, bundle and SHA-512', async t => {
  const good = await fixture(t);
  await verifyTarball(good.bytes, good.target);
  await assert.rejects(verifyTarball(Buffer.from('corrupt'), good.target), /SHA-512/);
  for (const patch of [{ name: 'other' }, { version: '1.2.0' }, { dsh: {} }]) {
    const bad = await fixture(t, patch);
    await assert.rejects(verifyTarball(bad.bytes, bad.target), /mismatch/);
  }
});

test('official registry resolution pins SHA-512; durable cache is rechecked before reuse', async t => {
  const env = await fixture(t);
  let metadata = { name: 'fixture', version: '1.1.0', dsh: { bundle: {} } };
  let requests = 0;
  const server = createServer((request, response) => {
    if (request.url.endsWith('.tgz')) { requests++; response.end(env.bytes); }
    else response.end(JSON.stringify(metadata));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}/`;
  metadata.dist = { tarball: `${origin}package.tgz`, integrity: `sha512-${Buffer.from(env.target.sha512, 'hex').toString('base64')}` };
  const source = new RegistryArtifacts({ registries: async () => ({ registry: null, resolved: origin, fallbackRegistries: [] }) }, join(env.directory, 'cache'), '0.2.2-rc.1');
  const target = await source.describe('fixture', '1.1.0');
  assert.equal(target.sha512, env.target.sha512);
  const file = await source.prepare(target);
  assert.equal(source.owns(`file:${file}`, target.sha512), true);
  assert.equal(source.owns(`file:${join(env.directory, 'unrelated.tgz')}`, target.sha512), false);
  assert.deepEqual(await readFile(file), env.bytes);
  await source.prepare(target);
  assert.equal(requests, 1);
  await writeFile(file, 'corrupt');
  await assert.rejects(source.prepare(target), /SHA-512/);
  metadata.name = 'alias';
  await assert.rejects(source.describe('fixture', '1.1.0'), /mismatch/);
  metadata.name = 'fixture'; metadata.dist.integrity = 'sha1-unsafe';
  await assert.rejects(source.describe('fixture', '1.1.0'), /SHA-512/);
});

test('downloads refuse insecure remote sources, redirects and oversized responses', async t => {
  await assert.rejects(download('http://example.org/plugin.tgz', 100), /HTTPS/);
  await assert.rejects(download('https://name:secret@example.org/plugin.tgz', 100), /HTTPS/);
  const server = createServer((request, response) => {
    if (request.url === '/redirect') { response.writeHead(302, { location: '/body' }); response.end(); }
    else if (request.url === '/length') { response.writeHead(200, { 'content-length': '1024' }); response.end('large'); }
    else response.end('too large');
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const path of ['/redirect', '/length', '/body']) await assert.rejects(download(origin + path, 4));
});

test('HTTP compression uses decoded artifact size and still rejects oversized decoded bytes', async t => {
  const bytes = Buffer.from('small zip');
  const encoded = gzipSync(bytes);
  assert.ok(encoded.length > bytes.length);
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-encoding': 'gzip', 'content-length': String(encoded.length) });
    response.end(encoded);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/archive`;
  assert.deepEqual(await download(url, bytes.length), bytes);
  await assert.rejects(download(url, bytes.length - 1), /size limit/);
});

test('official release redirects are bounded to GitHub asset CDN while ordinary redirects remain rejected', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const url = 'https://github.com/lanyun077/EAC-mojobox/releases/download/pack-test-v1.0.0/test-1.0.0.dshpack';
  const calls = [];
  globalThis.fetch = async (target, options) => {
    calls.push({ target: String(target), options });
    return calls.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/asset?sig=signed' } }) : new Response('pack');
  };
  assert.deepEqual(await download(url, 4), Buffer.from('pack'));
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => !call.options.headers));
  for (const location of ['https://evil.example/asset', 'http://127.0.0.1/asset', 'https://name:secret@release-assets.githubusercontent.com/asset', 'https://release-assets.githubusercontent.com.evil.example/asset']) {
    globalThis.fetch = async () => new Response(null, { status: 302, headers: { location } });
    await assert.rejects(download(url, 100), /HTTPS|Untrusted/);
  }
  globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/loop' } });
  await assert.rejects(download(url, 100), /excessive/);
  globalThis.fetch = async () => new Response('too large');
  await assert.rejects(download(url, 1), /size limit/);
});

test('plugin engines accept prerelease hosts using official includePrerelease semantics', async t => {
  const env = await fixture(t);
  let range = '>=0.1.0';
  const server = createServer((_request, response) => response.end(JSON.stringify({
    name: 'fixture', version: '1.1.0', dsh: { bundle: {} }, engines: { dsh: range },
    dist: { tarball: 'https://example.org/fixture.tgz', integrity: `sha512-${Buffer.from(env.target.sha512, 'hex').toString('base64')}` }
  })));
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const registry = `http://127.0.0.1:${server.address().port}/`;
  const source = new RegistryArtifacts({ registries: async () => ({ resolved: registry }) }, join(env.directory, 'cache'), '0.2.2-rc.1');
  assert.equal((await source.describe('fixture', '1.1.0')).version, '1.1.0');
  range = '>=0.2.2';
  await assert.rejects(source.describe('fixture', '1.1.0'), /current host/);
});
