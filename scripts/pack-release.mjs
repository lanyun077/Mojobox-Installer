import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run npm run pack:release to build the release archive.');
mkdirSync(new URL('../artifacts/', import.meta.url), { recursive: true });
execFileSync(process.execPath, [npm, 'pack', '--ignore-scripts', '--pack-destination', 'artifacts'], { cwd: root, stdio: 'inherit' });
