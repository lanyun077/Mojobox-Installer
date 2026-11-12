import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import semver from 'semver';
import { download } from './artifacts.js';
import { exactVersion, MAX_ARCHIVE_BYTES, NPM_NAME, readFeaturePack } from './feature-pack.js';
import type { PackManifest } from './feature-pack.js';
import type { TaskRecord } from './manager.js';
import { redact } from './manager.js';

export const CATALOG_URL = 'https://lanyun077.github.io/EAC-mojobox/generated/catalog.json';
const SITE_ROOT = new URL('../', CATALOG_URL);
export interface CatalogEntry {
  id: string; version: string; name: string; description: string; author: string;
  requires?: string; components: PackManifest['plugins']; archiveUrl: string; archiveSize: number; archiveDigest: string;
}
interface Cache { document: unknown; checkedAt: string; identities: Record<string, string> }
export interface CatalogView {
  checkedAt?: string; stale: boolean; error?: string;
  entries: (CatalogEntry & { blocked?: string; installedVersion?: string; newer: boolean })[];
}
function archiveUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Catalog archive URL is missing');
  const url = new URL(value, SITE_ROOT);
  if (url.origin !== SITE_ROOT.origin || !url.pathname.startsWith(`${SITE_ROOT.pathname}generated/downloads/`) || url.username || url.password || url.search || url.hash || /%2f|%5c/i.test(url.pathname)) throw new Error('Catalog archive URL is outside the official download directory');
  return url.href;
}
export function parseCatalog(value: any): CatalogEntry[] {
  if (value?.apiVersion !== 'catalog.mojobox.dev/v1alpha1' || value.mode !== 'intake' || value.demo !== false || !Array.isArray(value.packs) || value.packs.length > 1000) throw new Error('Unsupported or non-production Mojobox catalog');
  const seen = new Set<string>();
  return value.packs.map((item: any) => {
    const m = item?.metadata;
    const range = item?.requires?.dsh;
    if (item?.format !== 'eac-feature-pack-v1' || !m || typeof m.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(m.id) || seen.has(m.id) || !exactVersion(m.version) || typeof m.name !== 'string' || !m.name.trim() || typeof m.description !== 'string' || typeof item.author !== 'string' || !Array.isArray(item.components) || (range !== undefined && (typeof range !== 'string' || !range.trim() || !semver.validRange(range) || range.split('||').some((part: string) => !part.trim()))) || !Number.isSafeInteger(item.archiveSize) || item.archiveSize <= 0 || item.archiveSize > MAX_ARCHIVE_BYTES || typeof item.archiveDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(item.archiveDigest)) throw new Error('Invalid or duplicate catalog pack entry');
    seen.add(m.id);
    const refs = new Set<string>();
    const components = item.components.map((plugin: any) => {
      if (!plugin || typeof plugin.ref !== 'string' || (!NPM_NAME.test(plugin.ref) && !/^(?:builtin:[A-Za-z0-9][A-Za-z0-9._-]*|github:[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*)$/.test(plugin.ref)) || refs.has(plugin.ref) || ((!plugin.ref.startsWith('builtin:') || plugin.version !== undefined) && !exactVersion(plugin.version)) || (plugin.enabled !== undefined && typeof plugin.enabled !== 'boolean')) throw new Error('Invalid catalog component declaration');
      refs.add(plugin.ref);
      return { ref: plugin.ref, version: plugin.version, enabled: plugin.enabled };
    });
    if (!components.length) throw new Error('Catalog function pack has no components');
    return { id: m.id, version: m.version, name: m.name, description: m.description, author: item.author, requires: range, components, archiveUrl: archiveUrl(item.archiveUrl), archiveSize: item.archiveSize, archiveDigest: item.archiveDigest };
  });
}

export class Catalog {
  private cache?: Cache;
  private entries: CatalogEntry[] = [];
  private stale = true;
  private error?: string;
  private refreshing?: Promise<void>;
  // Transport injection is only for tests; product routes always use the fixed official URL.
  constructor(private file: string, private transport = download) {}
  async initialize() {
    try {
      const cache: Cache = JSON.parse(await readFile(this.file, 'utf8'));
      const entries = parseCatalog(cache.document);
      if (!cache.identities || typeof cache.identities !== 'object' || !Number.isFinite(Date.parse(cache.checkedAt)) || Object.values(cache.identities).some(digest => !/^sha256:[a-f0-9]{64}$/.test(digest))) throw new Error('Invalid catalog cache');
      for (const entry of entries) if (cache.identities[`${entry.id}@${entry.version}`] !== entry.archiveDigest) throw new Error('Catalog cache identity mismatch');
      this.cache = cache; this.entries = entries;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.error = redact(String(error)); }
  }
  view(hostVersion: string, records: TaskRecord[]): CatalogView {
    return { checkedAt: this.cache?.checkedAt, stale: this.stale, error: this.error, entries: this.entries.map(entry => {
      const record = records.find(record => record.pack.manifest.id === entry.id);
      const installedVersion = record?.pack.manifest.version;
      const blocked = !entry.requires ? '整包未声明内核兼容范围，无法安装' : !semver.satisfies(hostVersion, entry.requires) ? `整包要求内核 ${entry.requires}，当前为 ${hostVersion}` :
        record?.pack.manifest.version === entry.version && `sha256:${record.pack.sha256}` !== entry.archiveDigest ? '同版本归档摘要与本地记录不同，已停止远端安装' : undefined;
      return { ...entry, installedVersion, blocked, newer: !this.stale && !blocked && !!semver.valid(installedVersion) && semver.gt(entry.version, installedVersion!) };
    }) };
  }
  refresh(): Promise<void> {
    return this.refreshing ??= this.fetchCatalog().finally(() => { this.refreshing = undefined; });
  }
  private async fetchCatalog() {
    try {
      const bytes = await this.transport(CATALOG_URL, 2 * 1024 * 1024);
      if (bytes.length > 2 * 1024 * 1024) throw new Error('Catalog exceeds size limit');
      const document = JSON.parse(bytes.toString('utf8'));
      const entries = parseCatalog(document);
      const identities = { ...this.cache?.identities };
      for (const entry of entries) {
        const key = `${entry.id}@${entry.version}`;
        if (identities[key] && identities[key] !== entry.archiveDigest) throw new Error(`Catalog archive changed without a version bump: ${key}`);
        identities[key] = entry.archiveDigest;
      }
      const cache = { document, identities, checkedAt: new Date().toISOString() };
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(cache), { mode: 0o600 });
      await rename(temporary, this.file);
      this.cache = cache; this.entries = entries; this.stale = false; this.error = undefined;
    } catch (error) { this.stale = true; this.error = redact(String(error)); }
  }
  async archive(id: string, version: string, hostVersion: string, records: TaskRecord[]): Promise<Buffer> {
    if (this.stale || this.refreshing) throw new Error('Refresh the official catalog before installing');
    const entry = this.view(hostVersion, records).entries.find(entry => entry.id === id && entry.version === version);
    if (!entry) throw new Error('Catalog selection expired');
    if (entry.blocked) throw new Error(entry.blocked);
    const bytes = await this.transport(entry.archiveUrl, entry.archiveSize);
    if (bytes.length !== entry.archiveSize || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== entry.archiveDigest) throw new Error('Catalog archive size or SHA-256 mismatch');
    const pack = await readFeaturePack(bytes);
    const components = pack.manifest.plugins.map(plugin => ({ ref: plugin.ref, version: plugin.version, enabled: plugin.enabled }));
    if (pack.manifest.id !== id || pack.manifest.version !== version || pack.manifest.requires?.dsh !== entry.requires || JSON.stringify(components) !== JSON.stringify(entry.components)) throw new Error('Catalog and archive identity or requirements differ');
    if (this.stale || this.refreshing || !this.entries.some(current => current.id === id && current.version === version && current.archiveDigest === entry.archiveDigest)) throw new Error('Catalog changed during download; preview again');
    return bytes;
  }
}
