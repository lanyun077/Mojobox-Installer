import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const origin = 'http://127.0.0.1:19487';
const packages = new Map();
for (const part of ['first', 'broken', 'last']) {
  const name = `dsh-plugin-mojobox-p1-${part}`;
  const bytes = await readFile(new URL(`../artifacts/${name}-1.0.0.tgz`, import.meta.url));
  const manifest = JSON.parse(await readFile(new URL(`../fixtures/p1/${part}/package.json`, import.meta.url)));
  // Deliberate normal install failure: registry advertises a bundle but the middle tarball has no bundle.
  const metadata = { ...manifest, dsh: { bundle: { patch: './cordis.patch.yml' } }, dist: { tarball: `${origin}/${name}/-/${name}-1.0.0.tgz`, shasum: createHash('sha1').update(bytes).digest('hex'), integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` } };
  packages.set(name, { bytes, metadata });
}
const server = createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url, origin).pathname);
  const name = path.split('/')[1];
  const entry = packages.get(name);
  if (!entry || request.method !== 'GET') { response.writeHead(404); response.end('{}'); return; }
  if (path.includes('/-/')) { response.writeHead(200, { 'content-type': 'application/octet-stream' }); response.end(entry.bytes); return; }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(path.endsWith('/1.0.0') ? entry.metadata : { name, 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': entry.metadata } }));
});
server.listen(19487, '127.0.0.1', () => console.log(`Local fixture registry listening on ${origin}`));
