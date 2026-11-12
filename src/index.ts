import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_ARCHIVE_BYTES } from './feature-pack.js';
import { PackManager, RecordStore, redact } from './manager.js';
import type { PluginManager } from './contracts.js';
import { RegistryArtifacts } from './artifacts.js';
import { Catalog } from './catalog.js';

interface HostContext {
  pluginManager: PluginManager;
  profileContext: { name: string; dir: string; installAnchor: string };
  connection: { fetch: { register(route: { path: string; methods: string[]; requestBody: string; fetch(request: Request): Promise<Response> }): () => void } };
  effect(effect: () => unknown, label?: string): void;
  logger: { info(message: string): void };
}

export const name = 'mojobox-manager';
export const inject = ['pluginManager', 'profileContext', 'connection'];
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });

export function createHandler(manager: PackManager, action: 'status' | 'preview' | 'start' | 'replan' | 'catalog' | 'catalog-refresh' | 'catalog-preview' | 'save-log', catalog?: Catalog) {
  return async (request: Request): Promise<Response> => {
    try {
      if (action === 'status') {
        const status = await manager.status();
        return json({ ...status, catalog: catalog?.view(status.hostVersion, status.records) });
      }
      if (action === 'catalog' || action === 'catalog-refresh') {
        if (!catalog) throw new Error('Catalog is unavailable');
        if (action === 'catalog-refresh') await catalog.refresh();
        const status = await manager.status();
        return json(catalog.view(status.hostVersion, status.records));
      }
      const limit = action === 'preview' ? MAX_ARCHIVE_BYTES : 32 * 1024;
      if (Number(request.headers.get('content-length')) > limit) return json({ error: 'Request body too large' }, 413);
      const bytes = Buffer.from(await request.arrayBuffer());
      if (bytes.length > limit) return json({ error: 'Request body too large' }, 413);
      if (action === 'preview') return json(await manager.preview(bytes));
      const selection = JSON.parse(bytes.toString('utf8'));
      if (action === 'save-log') {
        if (!selection || typeof selection !== 'object' || Array.isArray(selection) || Object.keys(selection).some(key => !['taskId', 'context'].includes(key)) || (selection.taskId !== undefined && typeof selection.taskId !== 'string')) return json({ error: 'Invalid log selection' }, 400);
        if (selection.context !== undefined && (!selection.context || typeof selection.context !== 'object' || Array.isArray(selection.context) || Object.entries(selection.context).some(([key, value]) => !['error', 'connectionError', 'pending'].includes(key) || typeof value !== 'string' || value.length > 4000))) return json({ error: 'Invalid log context' }, 400);
        return json(await manager.saveLog(selection.taskId, selection.context));
      }
      if (action === 'catalog-preview') {
        if (!catalog || !selection || typeof selection.id !== 'string' || typeof selection.version !== 'string') return json({ error: 'Invalid catalog selection' }, 400);
        const status = await manager.status();
        const archive = await catalog.archive(selection.id, selection.version, status.hostVersion, status.records);
        return json(await manager.preview(archive, 'catalog'));
      }
      if (action === 'replan') {
        if (!selection || typeof selection.recordId !== 'string' || typeof selection.failedOnly !== 'boolean') return json({ error: 'Invalid record selection' }, 400);
        return json(await manager.replan(selection.recordId, selection.failedOnly));
      }
      if (!selection || typeof selection.planId !== 'string' || !Array.isArray(selection.selected)) return json({ error: 'Invalid selection' }, 400);
      return json(await manager.start(selection.planId, selection.selected), 202);
    } catch (error) { return json({ error: redact(String(error)) }, 400); }
  };
}

export async function apply(ctx: HostContext) {
  const profile = ctx.profileContext;
  const installation = JSON.parse(await readFile(profile.installAnchor, 'utf8'));
  const manager = new PackManager(ctx.pluginManager, installation.version,
    new RecordStore(join(profile.dir, '.mojobox-manager', 'records.json')),
    async () => {
      const digest = createHash('sha256');
      for (const file of ['package.json', 'pnpm-lock.yaml', 'cordis.yml', 'cordis.patch.yml']) {
        digest.update(file);
        try { digest.update(await readFile(join(profile.dir, file))); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; digest.update('missing'); }
      }
      return digest.digest('hex');
    }, new RegistryArtifacts(ctx.pluginManager, join(profile.dir, '.mojobox-manager', 'artifacts'), installation.version),
    async () => {
      const digest = createHash('sha256');
      for (const file of ['cordis.yml', 'cordis.patch.yml', 'pnpm-workspace.yaml']) {
        digest.update(file);
        try { digest.update(await readFile(join(profile.dir, file))); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; digest.update('missing'); }
      }
      return digest.digest('hex');
    });
  await manager.initialize();
  const catalog = new Catalog(join(profile.dir, '.mojobox-manager', 'catalog.json'));
  await catalog.initialize();
  ctx.effect(() => () => manager.dispose());
  for (const action of ['status', 'preview', 'start', 'replan', 'catalog', 'catalog-refresh', 'catalog-preview', 'save-log'] as const) {
    ctx.effect(() => ctx.connection.fetch.register({
      path: `/api/mojobox/${action}`, methods: [['status', 'catalog'].includes(action) ? 'GET' : 'POST'],
      requestBody: 'buffered', fetch: createHandler(manager, action, catalog)
    }), `mojobox: ${action}`);
  }
  ctx.logger.info(`Mojobox installer available; host ${installation.version}`);
}
