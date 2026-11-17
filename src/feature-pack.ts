import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { Ajv } from 'ajv';
import yauzl from 'yauzl';
import semver from 'semver';
import schema from '../schema/feature-pack.json' with { type: 'json' };

export interface PackManifest {
  formatVersion: 1;
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  requires?: { dsh?: string };
  plugins: { ref: string; version?: string; enabled?: boolean }[];
  conflicts?: string[];
  overrides?: string[];
  presets?: unknown[];
  skills?: unknown[];
  icon?: string;
  'x-eac'?: { status: string; conflictsPending: boolean };
}

export interface FeaturePack { manifest: PackManifest; sha256: string; size: number }
export const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024;
const validate = new Ajv({ allErrors: true }).compile(schema);
export const NPM_NAME = /^(?:@[a-z0-9_-]+\/)?[a-z0-9][a-z0-9._-]*$/;
export function exactVersion(value: string | undefined): boolean {
  const parsed = semver.parse(value);
  return !!parsed && parsed.version + (parsed.build.length ? `+${parsed.build.join('.')}` : '') === value;
}
export function hostVersionWarning(hostVersion: string, range?: string): string | undefined {
  if (!range) return '未声明内核兼容范围，将逐项交由官版核验';
  if (!semver.satisfies(hostVersion, range, { includePrerelease: true })) return `声明内核范围 ${range}，当前为 ${hostVersion}；版本差异不代表已确认不兼容，将逐项交由官版核验`;
}

// Reads the accepted members in memory; never extracts content into the profile.
export async function readFeaturePack(bytes: Buffer): Promise<FeaturePack> {
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error('Archive exceeds 2 MiB limit');
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true, autoClose: false, strictFileNames: true }, (error, zip) => error ? reject(error) : resolve(zip)));
  const files = new Map<string, yauzl.Entry>();
  try {
    await new Promise<void>((resolve, reject) => {
      zip.once('error', reject);
      zip.once('end', resolve);
      zip.on('entry', (entry: yauzl.Entry) => {
        const name = entry.fileName;
        const kind = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (!['pack.json', 'icon.png'].includes(name)) return reject(new Error(`Unsupported archive path: ${name}`));
        if (files.has(name)) return reject(new Error(`Duplicate archive entry: ${name}`));
        if ((kind && kind !== 0o100000) || entry.generalPurposeBitFlag & 1) return reject(new Error(`Unsupported file type: ${name}`));
        if (entry.uncompressedSize > (name === 'pack.json' ? 1024 * 1024 : 512 * 1024)) return reject(new Error(`Entry too large: ${name}`));
        files.set(name, entry);
        zip.readEntry();
      });
      zip.readEntry();
    });
    if (!files.has('pack.json')) throw new Error('Missing root pack.json');
    const contents = new Map<string, Buffer>();
    for (const [name, entry] of files) {
      const stream = await promisify(zip.openReadStream.bind(zip))(entry);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > entry.uncompressedSize) throw new Error(`Entry size mismatch: ${name}`);
        chunks.push(chunk);
      }
      if (size !== entry.uncompressedSize) throw new Error(`Entry size mismatch: ${name}`);
      contents.set(name, Buffer.concat(chunks));
    }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(contents.get('pack.json')));
    if (!validate(value)) throw new Error(`Invalid Feature Pack: ${JSON.stringify(validate.errors)}`);
    const manifest = value as unknown as PackManifest;
    if (!exactVersion(manifest.version)) throw new Error('Pack version must be exact SemVer');
    if (!manifest.plugins?.length) throw new Error('Function pack must declare at least one plugin');
    if (manifest.overrides?.length || manifest.presets?.length || manifest.skills?.length) throw new Error('Only thin plugin packs are supported; payloads and overrides are not accepted');
    if (manifest['x-eac'] && (manifest['x-eac'].status !== 'publishable' || manifest['x-eac'].conflictsPending)) throw new Error('Draft or unresolved conflicts cannot be installed');
    const refs = new Set<string>();
    for (const { ref, version } of manifest.plugins) {
      if (!NPM_NAME.test(ref) && !/^(?:builtin:[A-Za-z0-9][A-Za-z0-9._-]*|github:[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*)$/.test(ref)) throw new Error(`Unsupported plugin reference: ${ref}`);
      if (refs.has(ref)) throw new Error(`Duplicate plugin reference: ${ref}`);
      refs.add(ref);
      if ((!ref.startsWith('builtin:') || version !== undefined) && !exactVersion(version)) throw new Error(`Plugin must declare an exact SemVer version: ${ref}`);
    }
    const range = manifest.requires?.dsh;
    if (range !== undefined && (!range.trim() || range.split('||').some(group => !group.trim()) || !semver.validRange(range))) throw new Error('Invalid requires.dsh SemVer range');
    if (manifest.icon && manifest.icon !== 'icon.png') throw new Error('Icon must be root icon.png');
    if (Boolean(manifest.icon) !== files.has('icon.png')) throw new Error('Icon declaration and archive differ');
    if (contents.has('icon.png') && !contents.get('icon.png')!.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Invalid PNG signature');
    return { manifest, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
  } finally {
    zip.close();
  }
}
