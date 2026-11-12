import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { c } from 'tar';
import { ZipFile } from 'yazl';

const root = new URL('../', import.meta.url);
const origin = 'http://127.0.0.1:19487';
const packages = new Map();
for (const [part, versions] of [['first', ['1.1.0', '1.2.0']], ['last', ['1.1.0']]]) {
  const name = `dsh-plugin-mojobox-p1-${part}`;
  const entries = new Map();
  const previous = await readFile(new URL(`artifacts/${name}-1.0.0.tgz`, root));
  const previousManifest = JSON.parse(await readFile(new URL(`fixtures/p1/${part}/package.json`, root)));
  entries.set('1.0.0', { bytes: previous, metadata: { ...previousManifest, dist: { tarball: `${origin}/${name}/-/${name}-1.0.0.tgz`, integrity: `sha512-${createHash('sha512').update(previous).digest('base64')}`, shasum: createHash('sha1').update(previous).digest('hex') } } });
  for (const version of versions) {
    const dir = new URL(`fixtures/p2/${part}-${version}/package/`, root);
    await mkdir(dir, { recursive: true });
    const manifest = { name, version, private: true, type: 'module', main: 'index.js', exports: { '.': './index.js', './package.json': './package.json' }, engines: { dsh: '0.2.2-rc.1' }, dsh: { bundle: { patch: './cordis.patch.yml' } } };
    // Ordinary package-manager failure before activation, with no user data writes.
    if (version === '1.2.0') manifest.dependencies = { 'dsh-plugin-mojobox-missing-test-dependency': '1.0.0' };
    await writeFile(new URL('package.json', dir), JSON.stringify(manifest, null, 2));
    await writeFile(new URL('index.js', dir), `export const name = 'mojobox-p1-${part}';\nexport function apply(ctx) { ctx.provide('mojoboxP1${part[0].toUpperCase()+part.slice(1)}', { version: '${version}' }); }\n`);
    await writeFile(new URL('cordis.patch.yml', dir), `- insert:\n    - id: mojobox-p1-${part}\n      name: ${name}\n`);
    const chunks = []; for await (const chunk of c({ cwd: fileURLToPath(new URL('../', dir)), gzip: true }, ['package'])) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const tarball = `${name}-${version}.tgz`;
    await writeFile(new URL(`artifacts/${tarball}`, root), bytes);
    const metadata = { ...manifest, dist: { tarball: `${origin}/${name}/-/${tarball}`, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`, shasum: createHash('sha1').update(bytes).digest('hex') } };
    entries.set(version, { bytes, metadata });
  }
  packages.set(name, entries);
}
for (const [label, firstVersion] of [['selective', '1.1.0'], ['failure', '1.2.0']]) {
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify({ formatVersion: 1, id: `mojobox-update-${label}`, name: `Mojobox 更新验收 ${label}`, version: firstVersion, requires: { dsh: '0.2.2-rc.1' }, plugins: [{ ref: 'dsh-plugin-mojobox-p1-first', version: firstVersion }, { ref: 'dsh-plugin-mojobox-p1-last', version: '1.1.0' }] })), 'pack.json');
  zip.end(); const chunks = []; for await (const chunk of zip.outputStream) chunks.push(chunk);
  await writeFile(new URL(`artifacts/mojobox-update-${label}.dshpack`, root), Buffer.concat(chunks));
}
const server = createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url, origin).pathname);
  const [, name, segment, tarName] = path.split('/');
  const versions = packages.get(name);
  if (!versions || request.method !== 'GET') { response.writeHead(404); response.end('{}'); return; }
  if (segment === '-') {
    const entry = [...versions.values()].find(row => row.metadata.dist.tarball.endsWith('/' + tarName));
    if (!entry) { response.writeHead(404); response.end('{}'); return; }
    response.end(entry.bytes); return;
  }
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(versions.has(segment) ? versions.get(segment).metadata : { name, 'dist-tags': { latest: [...versions.keys()].at(-1) }, versions: Object.fromEntries([...versions].map(([version, row]) => [version, row.metadata])) }));
});
server.listen(19487, '127.0.0.1', () => console.log(`Update fixtures ready on ${origin}`));
