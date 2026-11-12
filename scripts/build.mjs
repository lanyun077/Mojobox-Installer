import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const root = new URL('../', import.meta.url);
const source = name => readFileSync(new URL(`src/${name}.ts`, root), 'utf8');
const strip = text => stripTypeScriptTypes(text, { mode: 'transform' });
mkdirSync(new URL('lib/', root), { recursive: true });
for (const name of ['contracts', 'feature-pack', 'artifacts', 'manager', 'catalog', 'index']) writeFileSync(new URL(`lib/${name}.js`, root), strip(source(name)));
const client = strip(source('client'));
writeFileSync(new URL('lib/client.js', root), `window.__ModuleLoader__.load({id:'dsh-plugin-mojobox',factory:function(require){const exports={};\n${client}\nreturn exports;}});\n`);
console.log('Mojobox host and client built.');
