import { mkdir, writeFile } from 'node:fs/promises';
import { ZipFile } from 'yazl';
const root = new URL('../', import.meta.url);
await mkdir(new URL('artifacts/', root), { recursive: true });
for (const part of ['first', 'broken', 'last']) {
  const dir = new URL(`fixtures/p1/${part}/`, root);
  await mkdir(dir, { recursive: true });
  const name = `dsh-plugin-mojobox-p1-${part}`;
  const manifest = { name, version: '1.0.0', private: true, type: 'module', main: 'index.js', exports: { '.': './index.js', './package.json': './package.json' }, engines: { dsh: '0.2.2-rc.1' }, files: ['index.js', 'cordis.patch.yml'] };
  if (part !== 'broken') manifest.dsh = { bundle: { patch: './cordis.patch.yml' } };
  await writeFile(new URL('package.json', dir), JSON.stringify(manifest, null, 2));
  await writeFile(new URL('index.js', dir), `export const name = 'mojobox-p1-${part}';\nexport function apply(ctx) { ctx.provide('mojoboxP1${part[0].toUpperCase() + part.slice(1)}', { ready: true }); }\n`);
  await writeFile(new URL('cordis.patch.yml', dir), `- insert:\n    - id: mojobox-p1-${part}\n      name: ${name}\n`);
}
const zip = new ZipFile();
const manifest = { formatVersion: 1, id: 'mojobox-local-acceptance', name: 'Mojobox 本地验收包', version: '1.0.0', author: 'Mojobox development', description: '受控测试：首项成功，中项失败，末项继续；无网络业务与用户数据写入。', requires: { dsh: '0.2.2-rc.1' }, plugins: ['first', 'broken', 'last'].map(part => ({ ref: `dsh-plugin-mojobox-p1-${part}`, version: '1.0.0' })) };
zip.addBuffer(Buffer.from(JSON.stringify(manifest)), 'pack.json');
zip.end();
const chunks = [];
for await (const chunk of zip.outputStream) chunks.push(chunk);
await writeFile(new URL('artifacts/mojobox-local-acceptance.dshpack', root), Buffer.concat(chunks));
console.log('Prepared local-only fixtures. Pack each fixtures/p1 directory before starting the fixture registry.');
