export interface Bundle {
  name: string;
  version?: string;
  installed: boolean;
  availability: string;
  enabled: boolean;
  source?: string;
  error?: { code: string };
  official?: boolean;
  readOnlyReason?: string;
  removable?: boolean;
  description?: string;
  rows?: { entryId?: string; rowId: string; moduleName: string }[];
}

export interface InstallResult {
  application: string;
  changed: boolean;
  bundle?: string;
  version?: string;
  restartReason?: string;
  stage?: string;
  pendingBuilds?: string[];
  error?: { code: string; message?: string; diagnostic?: string; incompatible?: { name: string; version: string; runtimeVersion: string; requirements: Record<string, string> }[] };
  packageResult?: { exitCode: number | null; timedOut?: boolean; output?: string };
}

export interface PluginManager {
  registries?(): Promise<{ registry: string | null; resolved: string | null; fallbackRegistries: string[] }>;
  listBundles(): Promise<Bundle[]>;
  listPlugins(): Promise<RuntimeEntry[]>;
  inspect?(spec: string): Promise<{ status: string; kind?: string; name?: string; version?: string; bundle?: boolean | null; reason?: string }>;
  installBundle(spec: string, options: { enabled: boolean; saveExact: boolean; requestId: string }): Promise<InstallResult>;
  removeBundle?(name: string): Promise<InstallResult>;
  setBundleEnabled?(name: string, enabled: boolean): Promise<InstallResult>;
}

export type ComponentAction = 'enable' | 'pause' | 'delete';
export interface ManagedComponent extends Bundle {
  stamp: string;
  toggleReason?: string;
  deleteReason?: string;
  packs: string[];
}
export interface ComponentOperation {
  name: string;
  action: ComponentAction;
  status: 'running' | 'complete' | 'failed' | 'unconfirmed';
  message: string;
  result?: InstallResult;
}

export interface RuntimeEntry {
  entryId?: string;
  moduleName: string;
  enabled: boolean;
  fiberPhase: string | null;
}
