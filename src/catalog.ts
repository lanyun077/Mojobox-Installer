import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import semver from 'semver';
import { download } from './artifacts.js';
import { exactVersion, hostVersionWarning, MAX_ARCHIVE_BYTES, NPM_NAME, readFeaturePack } from './feature-pack.js';
import type { PackManifest } from './feature-pack.js';
import type { TaskRecord } from './manager.js';
import { redact } from './manager.js';

export const CATALOG_URL = 'https://mojobox.cn/generated/catalog.json';
const SITE_ROOT = new URL('../', CATALOG_URL);
const LEGACY_ROOT = new URL('https://lanyun077.github.io/EAC-mojobox/');
export interface CatalogEntry {
  id: string; version: string; name: string; description: string; author: string;
  category?: 'function' | 'appearance' | 'workflow';
  source?: string;
  submitter?: { login: string; userId: number };
  downloadsAll?: number | null; downloads7d?: number | null; statisticsAt?: string; statisticsStale?: boolean;
  requires?: string; components: PackManifest['plugins']; archiveUrl: string; archiveSize: number; archiveDigest: string;
}
interface Cache { document: unknown; checkedAt: string; identities: Record<string, string> }
export interface CatalogView {
  checkedAt?: string; stale: boolean; error?: string;
  metadataLoading?: boolean; metadataError?: string;
  entries: (CatalogEntry & { blocked?: string; warning?: string; installedVersion?: string; newer: boolean })[];
}
function sourceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
  } catch { /* Optional display metadata must not block installation. */ }
}
function archiveUrl(value: unknown, id: string, version: string): string {
  if (typeof value !== 'string') throw new Error('Catalog archive URL is missing');
  const url = new URL(value, SITE_ROOT);
  const release = `https://github.com/lanyun077/EAC-mojobox/releases/download/${encodeURIComponent(`pack-${id}-v${version}`)}/${encodeURIComponent(`${id}-${version}.dshpack`)}`;
  const local = [SITE_ROOT, LEGACY_ROOT].some(root => url.origin === root.origin && url.pathname.startsWith(`${root.pathname}generated/downloads/`));
  if ((!local && url.href !== release) || url.username || url.password || url.search || url.hash || /%2f|%5c/i.test(url.pathname)) throw new Error('Catalog archive URL is outside the official download directory or pack release');
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
    const category = ['function', 'appearance', 'workflow'].includes(m.category) ? m.category : undefined;
    return { id: m.id, version: m.version, name: m.name, description: m.description, author: item.author, category, source: sourceUrl(item.source), requires: range, components, archiveUrl: archiveUrl(item.archiveUrl, m.id, m.version), archiveSize: item.archiveSize, archiveDigest: item.archiveDigest };
  });
}

export class Catalog {
  private cache?: Cache;
  private entries: CatalogEntry[] = [];
  private stale = true;
  private error?: string;
  private refreshing?: Promise<void>;
  private metadataLoading = false;
  private metadataError?: string;
  private presentation = new Map<string, Partial<CatalogEntry>>();
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
    return { checkedAt: this.cache?.checkedAt, stale: this.stale, error: this.error, metadataLoading: this.metadataLoading, metadataError: this.metadataError, entries: this.entries.map(entry => {
      const record = records.find(record => record.pack.manifest.id === entry.id);
      const installedVersion = record?.removedAt ? undefined : record?.pack.manifest.version;
      const blocked = record?.pack.manifest.version === entry.version && `sha256:${record.pack.sha256}` !== entry.archiveDigest ? '同版本归档摘要与本地记录不同，已停止远端安装' : undefined;
      return { ...entry, ...this.presentation.get(`${entry.id}@${entry.version}`), installedVersion, blocked, warning: hostVersionWarning(hostVersion, entry.requires), newer: !this.stale && !blocked && !!semver.valid(installedVersion) && semver.gt(entry.version, installedVersion!) };
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
      void this.fetchPresentation(cache);
    } catch (error) { this.stale = true; this.error = redact(String(error)); }
  }
  private async fetchPresentation(cache: Cache) {
    this.metadataLoading = true; this.metadataError = undefined;
    const results = await Promise.allSettled(['contributors', 'rankings'].map(async name => {
      const bytes = await this.transport(new URL(`generated/${name}.json`, SITE_ROOT).href, 2 * 1024 * 1024, 12000);
      if (bytes.length > 2 * 1024 * 1024) throw new Error('Display metadata exceeds size limit');
      const data = JSON.parse(bytes.toString('utf8'));
      if (data?.format !== `mojobox-${name}-v1` || !Array.isArray(data.items) || data.items.length > 10000) throw new Error(`Invalid ${name} metadata`);
      if (name === 'contributors' && data.repository !== 'lanyun077/EAC-mojobox') throw new Error('Invalid contributor repository');
      if (name === 'rankings' && data.data_as_of !== null && !Number.isFinite(Date.parse(data.data_as_of))) throw new Error('Invalid statistics timestamp');
      return data;
    }));
    if (this.cache !== cache) return;
    const contributors = results[0].status === 'fulfilled' ? results[0].value : null;
    const rankings = results[1].status === 'fulfilled' ? results[1].value : null;
    this.presentation.clear();
    for (const entry of this.entries) {
      const matches = (item: any) => item?.kind === 'pack' && item.resource_id === entry.id && item.version === entry.version;
      const submission = contributors?.items.find(matches)?.first_submission;
      const stats = rankings?.items.find(matches);
      const metadata: Partial<CatalogEntry> = {};
      if (Number.isSafeInteger(submission?.github_user_id) && submission.github_user_id > 0 && typeof submission.github_login === 'string' && /^[a-z0-9][a-z0-9-]{0,38}$/i.test(submission.github_login)) {
        metadata.submitter = { login: submission.github_login, userId: submission.github_user_id };
      }
      const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
      if (stats) {
        metadata.downloadsAll = count(stats.downloads_all); metadata.downloads7d = count(stats.downloads_7d);
        metadata.statisticsAt = rankings.data_as_of ?? undefined;
        metadata.statisticsStale = rankings.stale === true || !metadata.statisticsAt || Date.now() - Date.parse(metadata.statisticsAt) > 2 * 86400000;
      }
      this.presentation.set(`${entry.id}@${entry.version}`, metadata);
    }
    this.metadataError = results.some(result => result.status === 'rejected') ? '部分投稿或下载统计暂不可用' : undefined;
    this.metadataLoading = false;
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
