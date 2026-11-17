import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Parser, type ReadEntry } from 'tar';
import semver from 'semver';
import type { PluginManager } from './contracts.js';
import { hostVersionWarning } from './feature-pack.js';

export interface ArtifactTarget {
  name: string;
  version: string;
  registry: string;
  url: string;
  sha512: string;
  warning?: string;
  requirements?: { ref: string; range: string }[];
}
export interface ArtifactSource {
  describe(name: string, version: string): Promise<ArtifactTarget>;
  prepare(target: ArtifactTarget): Promise<string>;
  owns(source: string, sha512: string): boolean;
}

function requirementsOf(value: any): { ref: string; range: string }[] {
  return [value.dependencies, value.peerDependencies].flatMap((fields, index) => fields && typeof fields === 'object' ? Object.entries(fields).filter(([ref]) => !index || !value.peerDependenciesMeta?.[ref]?.optional).map(([ref, range]) => ({ ref, range: String(range) })) : [])
    .sort((a, b) => a.ref.localeCompare(b.ref) || a.range.localeCompare(b.range));
}

function trustedUrl(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) throw new Error('Artifact source requires HTTPS (HTTP is limited to loopback testing)');
  return url;
}

export async function download(url: string, limit: number, timeoutMs = 60000): Promise<Buffer> {
  let target = trustedUrl(url);
  const release = target.origin === 'https://github.com' && /^\/lanyun077\/EAC-mojobox\/releases\/download\/[^/]+\/[^/]+\.dshpack$/.test(target.pathname) && !target.search;
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response | undefined;
  for (let hop = 0; hop <= 3; hop++) {
    response = await fetch(target, { redirect: release ? 'manual' : 'error', signal });
    if (!release || ![301, 302, 303, 307, 308].includes(response.status)) break;
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (!location) throw new Error('Missing release redirect location');
    const next = trustedUrl(new URL(location, target).href);
    if (next.origin !== 'https://release-assets.githubusercontent.com' || hop === 3) throw new Error('Untrusted or excessive release redirect');
    target = next;
  }
  if (!response) throw new Error('Artifact request did not return a response');
  if (!response.ok) throw new Error(`Artifact request failed: HTTP ${response.status}`);
  const encoding = response.headers.get('content-encoding')?.trim().toLowerCase();
  if ((!encoding || encoding === 'identity') && Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new Error('Artifact response exceeds size limit'); }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > limit) throw new Error('Artifact response exceeds size limit');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function verifyTarball(bytes: Buffer, target: ArtifactTarget): Promise<void> {
  if (createHash('sha512').update(bytes).digest('hex') !== target.sha512) throw new Error('Artifact SHA-512 mismatch');
  // Read only; pnpm remains responsible for installation. Bound decompression before parsing.
  const tar = gunzipSync(bytes, { maxOutputLength: 256 * 1024 * 1024 });
  let manifest: Buffer | undefined;
  await new Promise<void>((done, reject) => {
    const seen = new Set<string>();
    const parser = new Parser({ strict: true });
    parser.on('error', reject);
    parser.on('end', done);
    parser.on('entry', (entry: ReadEntry) => {
      const parts = entry.path.split('/');
      if (parts[0] !== 'package' || parts.some(part => part === '..' || part === '.') || /[\\:\0]/.test(entry.path) || !['File', 'Directory'].includes(entry.type) || seen.has(entry.path)) { parser.abort(new Error('Unsupported package archive entry')); return; }
      seen.add(entry.path);
      if (entry.path === 'package/package.json') {
        if (entry.type !== 'File' || entry.size > 1024 * 1024) { parser.abort(new Error('Invalid package manifest')); return; }
        const chunks: Buffer[] = [];
        entry.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        entry.on('end', () => { manifest = Buffer.concat(chunks); });
      }
      entry.resume();
    });
    parser.end(tar);
  });
  if (!manifest) throw new Error('Missing package/package.json');
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifest));
  if (value.name !== target.name || value.version !== target.version || !value.dsh?.bundle || typeof value.dsh.bundle !== 'object' || Array.isArray(value.dsh.bundle)) throw new Error('Artifact identity, exact version or bundle declaration mismatch');
  if (target.requirements && JSON.stringify(requirementsOf(value)) !== JSON.stringify(target.requirements)) throw new Error('Artifact dependency declarations differ from registry metadata');
}

export class RegistryArtifacts implements ArtifactSource {
  constructor(private manager: PluginManager, private directory: string, private hostVersion: string) {}
  private file(sha512: string) {
    if (!/^[a-f0-9]{128}$/.test(sha512)) throw new Error('Invalid artifact identity');
    return join(this.directory, `${sha512}.tgz`);
  }
  owns(source: string, sha512: string): boolean {
    if (!source.startsWith('file:')) return false;
    return resolve(source.slice(5)).toLowerCase() === resolve(this.file(sha512)).toLowerCase();
  }
  async describe(name: string, version: string): Promise<ArtifactTarget> {
    const registries = await this.manager.registries?.();
    const configured = registries?.registry ?? registries?.resolved;
    if (!configured) throw new Error('Official registry could not be resolved');
    const registry = trustedUrl(configured.endsWith('/') ? configured : `${configured}/`).href;
    // Stay on the official service's configured registry; never fall through a private source.
    const value = JSON.parse((await download(new URL(`${encodeURIComponent(name)}/${encodeURIComponent(version)}`, registry).href, 2 * 1024 * 1024)).toString('utf8'));
    if (value.name !== name || value.version !== version || !value.dsh?.bundle || typeof value.dsh.bundle !== 'object' || Array.isArray(value.dsh.bundle)) throw new Error('Registry identity, exact version or bundle declaration mismatch');
    const range = value.engines?.dsh;
    if (range !== undefined && (typeof range !== 'string' || !semver.validRange(range))) throw new Error('Invalid plugin engines.dsh range');
    const hashes = typeof value.dist?.integrity === 'string' ? value.dist.integrity.split(/\s+/) : [];
    const strong = hashes.find((hash: string) => /^sha512-[A-Za-z0-9+/]{86}==$/.test(hash));
    if (!strong || typeof value.dist.tarball !== 'string') throw new Error('Registry artifact requires SHA-512 integrity and a tarball URL');
    const requirements = requirementsOf(value);
    return { name, version, registry, url: trustedUrl(value.dist.tarball).href, sha512: Buffer.from(strong.slice(7), 'base64').toString('hex'), requirements, warning: hostVersionWarning(this.hostVersion, range) };
  }
  async prepare(target: ArtifactTarget): Promise<string> {
    const file = this.file(target.sha512);
    let bytes: Buffer;
    try { bytes = await readFile(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      bytes = await download(target.url, 64 * 1024 * 1024);
    }
    await verifyTarball(bytes, target);
    await mkdir(this.directory, { recursive: true });
    try { await writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; if (!bytes.equals(await readFile(file))) throw new Error('Artifact cache changed during verification'); }
    // This durable path is saved by pnpm. Do not remove it after an update.
    return file;
  }
}
