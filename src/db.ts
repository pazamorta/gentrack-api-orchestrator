import * as fs from 'fs';
import * as path from 'path';
import { BackendApp, DatabaseConnection, MockDefinition, RouteConfig } from './types';

const DB_DIR = path.resolve(process.cwd(), 'data');
const DB_PATH = path.join(DB_DIR, 'store.json');
const LOGS_PATH = path.join(DB_DIR, 'logs.json');

interface Store {
  backends: BackendApp[];
  routes: RouteConfig[];
  databases: DatabaseConnection[];
  mocks: MockDefinition[];
}

interface LogsStore {
  executionLog: ExecutionEntry[];
  auditLog: AuditEntry[];
}

interface AuditEntry {
  id: number;
  entityType: 'backend' | 'route' | 'database' | 'mock';
  entityId: string;
  entityName: string;
  action: 'create' | 'update' | 'delete';
  previousConfig: string | null;
  newConfig: string | null;
  timestamp: string;
}

interface ExecutionEntry {
  id: number;
  route_id: string;
  route_name?: string;
  inbound_method: string;
  inbound_path: string;
  inbound_query?: string;
  inbound_headers?: string;
  inbound_body?: string;
  status_code: number;
  duration_ms: number;
  step_results: string;
  response_body?: string;
  error: string | null;
  created_at: string;
}

let store: Store = {
  backends: [],
  routes: [],
  databases: [],
  mocks: [],
};

let logsStore: LogsStore = {
  executionLog: [],
  auditLog: [],
};

let nextLogId = 1;
let nextAuditId = 1;

/**
 * Initialize the JSON file store.
 */
export async function initDb(): Promise<void> {
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  // Load config store
  if (fs.existsSync(DB_PATH)) {
    try {
      const raw = fs.readFileSync(DB_PATH, 'utf-8');
      store = JSON.parse(raw);
      if (!store.mocks) store.mocks = [];
    } catch {
      store = { backends: [], routes: [], databases: [], mocks: [] };
    }
  }

  // Load logs store (separate file)
  if (fs.existsSync(LOGS_PATH)) {
    try {
      const raw = fs.readFileSync(LOGS_PATH, 'utf-8');
      logsStore = JSON.parse(raw);
      if (!logsStore.executionLog) logsStore.executionLog = [];
      if (!logsStore.auditLog) logsStore.auditLog = [];
      if (logsStore.executionLog.length > 0) {
        nextLogId = Math.max(...logsStore.executionLog.map((e) => e.id)) + 1;
      }
      if (logsStore.auditLog.length > 0) {
        nextAuditId = Math.max(...logsStore.auditLog.map((e) => e.id)) + 1;
      }
    } catch {
      logsStore = { executionLog: [], auditLog: [] };
    }
  }

  persist();
  persistLogs();
}

/** Write the config store to disk */
function persist(): void {
  fs.writeFileSync(DB_PATH, JSON.stringify(store, null, 2), 'utf-8');
}

/** Write the logs store to disk */
function persistLogs(): void {
  fs.writeFileSync(LOGS_PATH, JSON.stringify(logsStore, null, 2), 'utf-8');
}

// ---- Backend CRUD ----

export function getAllBackends(): BackendApp[] {
  return store.backends;
}

export function getBackend(id: string): BackendApp | null {
  return store.backends.find((b) => b.id === id) || null;
}

export function upsertBackend(backend: BackendApp): void {
  const existing = store.backends.find((b) => b.id === backend.id);
  logAudit('backend', backend.id, backend.name, existing ? 'update' : 'create', existing || null, backend);
  const index = store.backends.findIndex((b) => b.id === backend.id);
  if (index >= 0) {
    store.backends[index] = backend;
  } else {
    store.backends.push(backend);
  }
  persist();
}

export function deleteBackend(id: string): boolean {
  const existing = store.backends.find((b) => b.id === id);
  const before = store.backends.length;
  store.backends = store.backends.filter((b) => b.id !== id);
  if (store.backends.length < before) {
    logAudit('backend', id, existing?.name || id, 'delete', existing || null, null);
    persist();
    return true;
  }
  return false;
}

// ---- Route CRUD ----

export function getAllRoutes(): RouteConfig[] {
  return store.routes;
}

export function getRoute(id: string): RouteConfig | null {
  return store.routes.find((r) => r.id === id) || null;
}

export function upsertRoute(route: RouteConfig): void {
  const existing = store.routes.find((r) => r.id === route.id);
  logAudit('route', route.id, route.name, existing ? 'update' : 'create', existing || null, route);
  const index = store.routes.findIndex((r) => r.id === route.id);
  if (index >= 0) {
    store.routes[index] = route;
  } else {
    store.routes.push(route);
  }
  persist();
}

export function deleteRoute(id: string): boolean {
  const existing = store.routes.find((r) => r.id === id);
  const before = store.routes.length;
  store.routes = store.routes.filter((r) => r.id !== id);
  if (store.routes.length < before) {
    logAudit('route', id, existing?.name || id, 'delete', existing || null, null);
    persist();
    return true;
  }
  return false;
}

// ---- Execution Log ----

export function logExecution(entry: {
  routeId: string;
  routeName?: string;
  inboundMethod: string;
  inboundPath: string;
  inboundQuery?: Record<string, string>;
  inboundHeaders?: Record<string, string>;
  inboundBody?: unknown;
  statusCode: number;
  durationMs: number;
  stepResults: Record<string, unknown>;
  responseBody?: unknown;
  error?: string;
}): void {
  logsStore.executionLog.push({
    id: nextLogId++,
    route_id: entry.routeId,
    route_name: entry.routeName,
    inbound_method: entry.inboundMethod,
    inbound_path: entry.inboundPath,
    inbound_query: entry.inboundQuery ? JSON.stringify(entry.inboundQuery) : undefined,
    inbound_headers: entry.inboundHeaders ? JSON.stringify(entry.inboundHeaders) : undefined,
    inbound_body: entry.inboundBody ? JSON.stringify(entry.inboundBody).slice(0, 2000) : undefined,
    status_code: entry.statusCode,
    duration_ms: entry.durationMs,
    step_results: JSON.stringify(entry.stepResults),
    response_body: entry.responseBody ? JSON.stringify(entry.responseBody).slice(0, 2000) : undefined,
    error: entry.error || null,
    created_at: new Date().toISOString(),
  });

  // Keep only the last 500 entries
  if (logsStore.executionLog.length > 500) {
    logsStore.executionLog = logsStore.executionLog.slice(-500);
  }

  persistLogs();
}

export function getExecutionEntry(id: number): ExecutionEntry | null {
  return logsStore.executionLog.find((e) => e.id === id) || null;
}

export function getRecentExecutions(limit = 50): ExecutionEntry[] {
  return logsStore.executionLog.slice(-limit).reverse();
}

export function clearExecutionLog(): void {
  logsStore.executionLog = [];
  persistLogs();
}

// ---- Database Connections CRUD ----

export function getAllDatabases(): DatabaseConnection[] {
  return store.databases || [];
}

export function getDatabase(id: string): DatabaseConnection | null {
  return (store.databases || []).find((d) => d.id === id) || null;
}

export function upsertDatabase(database: DatabaseConnection): void {
  if (!store.databases) store.databases = [];
  const existing = store.databases.find((d) => d.id === database.id);
  logAudit('database', database.id, database.name, existing ? 'update' : 'create', existing || null, database);
  const index = store.databases.findIndex((d) => d.id === database.id);
  if (index >= 0) {
    store.databases[index] = database;
  } else {
    store.databases.push(database);
  }
  persist();
}

export function deleteDatabase(id: string): boolean {
  if (!store.databases) return false;
  const existing = store.databases.find((d) => d.id === id);
  const before = store.databases.length;
  store.databases = store.databases.filter((d) => d.id !== id);
  if (store.databases.length < before) {
    logAudit('database', id, existing?.name || id, 'delete', existing || null, null);
    persist();
    return true;
  }
  return false;
}

// ---- Audit Log ----

function logAudit(
  entityType: 'backend' | 'route' | 'database' | 'mock',
  entityId: string,
  entityName: string,
  action: 'create' | 'update' | 'delete',
  previous: unknown,
  current: unknown
): void {
  if (!logsStore.auditLog) logsStore.auditLog = [];
  logsStore.auditLog.push({
    id: nextAuditId++,
    entityType,
    entityId,
    entityName,
    action,
    previousConfig: previous ? JSON.stringify(previous) : null,
    newConfig: current ? JSON.stringify(current) : null,
    timestamp: new Date().toISOString(),
  });

  // Keep only the last 1000 audit entries
  if (logsStore.auditLog.length > 1000) {
    logsStore.auditLog = logsStore.auditLog.slice(-1000);
  }
  persistLogs();
}

export function clearAuditLog(): void {
  // Keep only the latest entry per unique entity
  const latestByEntity = new Map<string, AuditEntry>();
  for (const entry of logsStore.auditLog) {
    const key = `${entry.entityType}:${entry.entityId}`;
    const existing = latestByEntity.get(key);
    if (!existing || entry.id > existing.id) {
      latestByEntity.set(key, entry);
    }
  }
  logsStore.auditLog = Array.from(latestByEntity.values());
  persistLogs();
}

export function getAuditLog(entityType?: string, entityId?: string, limit = 50): AuditEntry[] {
  let entries = logsStore.auditLog || [];
  if (entityType) {
    entries = entries.filter((e) => e.entityType === entityType);
  }
  if (entityId) {
    entries = entries.filter((e) => e.entityId === entityId);
  }
  return entries.slice(-limit).reverse();
}

export function getAuditEntry(id: number): AuditEntry | null {
  return (logsStore.auditLog || []).find((e) => e.id === id) || null;
}

export function rollbackEntity(auditId: number): boolean {
  const entry = getAuditEntry(auditId);
  if (!entry || !entry.previousConfig) return false;

  const previousData = JSON.parse(entry.previousConfig);

  switch (entry.entityType) {
    case 'backend':
      upsertBackend(previousData);
      return true;
    case 'route':
      upsertRoute(previousData);
      return true;
    case 'database':
      upsertDatabase(previousData);
      return true;
    default:
      return false;
  }
}

// ---- Mock CRUD ----

export function getAllMocks(): MockDefinition[] {
  return store.mocks || [];
}

export function getMock(id: string): MockDefinition | null {
  return (store.mocks || []).find((m) => m.id === id) || null;
}

export function getMocksForRoute(routeId: string): MockDefinition[] {
  return (store.mocks || []).filter((m) => m.routeId === routeId);
}

export function getActiveMockForRoute(method: string, path: string): MockDefinition | null {
  const routes = getAllRoutes();
  for (const mock of (store.mocks || [])) {
    if (!mock.active) continue;
    const route = routes.find((r) => r.id === mock.routeId);
    if (!route) continue;
    if (route.method === method.toUpperCase() && matchMockPath(route.path, path)) {
      return mock;
    }
  }
  return null;
}

function matchMockPath(pattern: string, requestPath: string): boolean {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = requestPath.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return false;
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) continue;
    if (patternParts[i] !== pathParts[i]) return false;
  }
  return true;
}

export function upsertMock(mock: MockDefinition): void {
  if (!store.mocks) store.mocks = [];
  const existing = store.mocks.find((m) => m.id === mock.id);
  logAudit('mock', mock.id, mock.name, existing ? 'update' : 'create', existing || null, mock);
  const index = store.mocks.findIndex((m) => m.id === mock.id);
  if (index >= 0) {
    store.mocks[index] = mock;
  } else {
    store.mocks.push(mock);
  }
  persist();
}

export function deleteMock(id: string): boolean {
  if (!store.mocks) return false;
  const existing = store.mocks.find((m) => m.id === id);
  const before = store.mocks.length;
  store.mocks = store.mocks.filter((m) => m.id !== id);
  if (store.mocks.length < before) {
    logAudit('mock', id, existing?.name || id, 'delete', existing || null, null);
    persist();
    return true;
  }
  return false;
}
