import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import { BackendApp, DatabaseConnection, EventStatus, EventTarget, MockDefinition, RouteConfig } from '../types';
import * as db from '../db';
import { getEventStore } from '../events/event-store';
import { getReceivedWebhookStore } from '../webhooks/received-store';

const router = Router();

// ============================================================
// Backend Management
// ============================================================

/** List all backends */
router.get('/backends', (_req: Request, res: Response) => {
  const backends = db.getAllBackends();
  res.json({ backends });
});

/** Get a single backend */
router.get('/backends/:id', (req: Request, res: Response) => {
  const backend = db.getBackend(req.params.id);
  if (!backend) {
    res.status(404).json({ error: 'Backend not found' });
    return;
  }
  res.json(backend);
});

/** Create or update a backend */
router.put('/backends/:id', (req: Request, res: Response) => {
  const backend: BackendApp = {
    id: req.params.id || uuidv4(),
    ...req.body,
  };

  if (!backend.name || !backend.baseUrl || !backend.auth) {
    res.status(400).json({ error: 'name, baseUrl, and auth are required' });
    return;
  }

  db.upsertBackend(backend);
  res.json({ message: 'Backend saved', backend });
});

/** Create a new backend (auto-generate ID) */
router.post('/backends', (req: Request, res: Response) => {
  const backend: BackendApp = {
    ...req.body,
    id: req.body.id || uuidv4(),
  };

  if (!backend.name || !backend.baseUrl || !backend.auth) {
    res.status(400).json({ error: 'name, baseUrl, and auth are required' });
    return;
  }

  db.upsertBackend(backend);
  res.status(201).json({ message: 'Backend created', backend });
});

/** Delete a backend */
router.delete('/backends/:id', (req: Request, res: Response) => {
  const deleted = db.deleteBackend(req.params.id);
  if (!deleted) {
    res.status(404).json({ error: 'Backend not found' });
    return;
  }
  res.json({ message: 'Backend deleted' });
});

// ============================================================
// Route Management
// ============================================================

/** List all routes */
router.get('/routes', (_req: Request, res: Response) => {
  const routes = db.getAllRoutes();
  res.json({ routes });
});

/** Get a single route */
router.get('/routes/:id', (req: Request, res: Response) => {
  const route = db.getRoute(req.params.id);
  if (!route) {
    res.status(404).json({ error: 'Route not found' });
    return;
  }
  res.json(route);
});

/** Create or update a route */
router.put('/routes/:id', (req: Request, res: Response) => {
  const route: RouteConfig = {
    id: req.params.id || uuidv4(),
    ...req.body,
  };

  if (!route.name || !route.method || !route.path || !route.steps || !route.responseMapping) {
    res.status(400).json({ error: 'name, method, path, steps, and responseMapping are required' });
    return;
  }

  db.upsertRoute(route);
  res.json({ message: 'Route saved', route });
});

/** Create a new route (auto-generate ID) */
router.post('/routes', (req: Request, res: Response) => {
  const route: RouteConfig = {
    ...req.body,
    id: req.body.id || uuidv4(),
  };

  if (!route.name || !route.method || !route.path || !route.steps || !route.responseMapping) {
    res.status(400).json({ error: 'name, method, path, steps, and responseMapping are required' });
    return;
  }

  db.upsertRoute(route);
  res.status(201).json({ message: 'Route created', route });
});

/** Delete a route */
router.delete('/routes/:id', (req: Request, res: Response) => {
  const deleted = db.deleteRoute(req.params.id);
  if (!deleted) {
    res.status(404).json({ error: 'Route not found' });
    return;
  }
  res.json({ message: 'Route deleted' });
});

// ============================================================
// Export / Import Configuration
// ============================================================

/** Export all configuration (backends, routes, databases, mocks) */
router.get('/export', (_req: Request, res: Response) => {
  const config = {
    exportedAt: new Date().toISOString(),
    backends: db.getAllBackends(),
    routes: db.getAllRoutes(),
    databases: db.getAllDatabases(),
    mocks: db.getAllMocks(),
  };
  res.setHeader('Content-Disposition', 'attachment; filename="orchestrator-config.json"');
  res.json(config);
});

/** Import configuration (backends, routes, databases, mocks) */
router.post('/import', (req: Request, res: Response) => {
  const { backends, routes, databases, mocks, mode } = req.body;
  const mergeMode = mode || 'merge'; // 'merge' or 'replace'
  let imported = { backends: 0, routes: 0, databases: 0, mocks: 0 };

  if (mergeMode === 'replace') {
    // Clear existing data first
    for (const b of db.getAllBackends()) db.deleteBackend(b.id);
    for (const r of db.getAllRoutes()) db.deleteRoute(r.id);
    for (const d of db.getAllDatabases()) db.deleteDatabase(d.id);
    for (const m of db.getAllMocks()) db.deleteMock(m.id);
  }

  if (backends && Array.isArray(backends)) {
    for (const backend of backends) {
      db.upsertBackend(backend);
      imported.backends++;
    }
  }

  if (routes && Array.isArray(routes)) {
    for (const route of routes) {
      db.upsertRoute(route);
      imported.routes++;
    }
  }

  if (databases && Array.isArray(databases)) {
    for (const database of databases) {
      db.upsertDatabase(database);
      imported.databases++;
    }
  }

  if (mocks && Array.isArray(mocks)) {
    for (const mock of mocks) {
      db.upsertMock(mock);
      imported.mocks++;
    }
  }

  res.json({
    message: `Import complete (${mergeMode} mode)`,
    imported,
  });
});

// ============================================================
// Execution Log
// ============================================================

/** Get recent execution logs */
router.get('/logs', (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 50;
  const page = parseInt(req.query.page as string) || 1;
  const routeFilter = req.query.route as string | undefined;
  const { logs, total, totalPages } = db.getPaginatedExecutions(page, limit, routeFilter);
  res.json({ logs, pagination: { page, limit, total, totalPages } });
});

/** Clear all execution logs */
router.delete('/logs', (_req: Request, res: Response) => {
  db.clearExecutionLog();
  res.json({ message: 'Execution logs cleared' });
});

/** Get a single execution log entry with full details */
router.get('/logs/:id', (req: Request, res: Response) => {
  const entry = db.getExecutionEntry(parseInt(req.params.id));
  if (!entry) {
    res.status(404).json({ error: 'Log entry not found' });
    return;
  }
  res.json(entry);
});

// ============================================================
// Database Connection Management
// ============================================================

/** List all database connections */
router.get('/databases', (_req: Request, res: Response) => {
  const databases = db.getAllDatabases();
  res.json({ databases });
});

/** Get a single database connection */
router.get('/databases/:id', (req: Request, res: Response) => {
  const database = db.getDatabase(req.params.id);
  if (!database) {
    res.status(404).json({ error: 'Database connection not found' });
    return;
  }
  // Mask password in response
  res.json({ ...database, password: '***' });
});

/** Create a new database connection */
router.post('/databases', (req: Request, res: Response) => {
  const database: DatabaseConnection = {
    ...req.body,
    id: req.body.id || uuidv4(),
  };

  if (!database.name || !database.type || !database.host || !database.database) {
    res.status(400).json({ error: 'name, type, host, and database are required' });
    return;
  }

  db.upsertDatabase(database);
  res.status(201).json({ message: 'Database connection created', database: { ...database, password: '***' } });
});

/** Update a database connection */
router.put('/databases/:id', (req: Request, res: Response) => {
  const database: DatabaseConnection = {
    id: req.params.id,
    ...req.body,
  };

  db.upsertDatabase(database);
  res.json({ message: 'Database connection saved', database: { ...database, password: '***' } });
});

/** Delete a database connection */
router.delete('/databases/:id', (req: Request, res: Response) => {
  const deleted = db.deleteDatabase(req.params.id);
  if (!deleted) {
    res.status(404).json({ error: 'Database connection not found' });
    return;
  }
  res.json({ message: 'Database connection deleted' });
});

// ============================================================
// Audit Log
// ============================================================

/** Get audit history — optionally filter by entity type and ID */
router.get('/audit', (req: Request, res: Response) => {
  const entityType = req.query.entityType as string | undefined;
  const entityId = req.query.entityId as string | undefined;
  const limit = parseInt(req.query.limit as string) || 50;
  const entries = db.getAuditLog(entityType, entityId, limit);
  res.json({ audit: entries });
});

/** Clear audit history (retains latest change per entity) */
router.delete('/audit', (_req: Request, res: Response) => {
  db.clearAuditLog();
  res.json({ message: 'Audit history cleared (latest per entity retained)' });
});

/** Get a single audit entry */
router.get('/audit/:id', (req: Request, res: Response) => {
  const entry = db.getAuditEntry(parseInt(req.params.id));
  if (!entry) {
    res.status(404).json({ error: 'Audit entry not found' });
    return;
  }
  res.json(entry);
});

/** Rollback to a previous version */
router.post('/audit/:id/rollback', (req: Request, res: Response) => {
  const auditId = parseInt(req.params.id);
  const entry = db.getAuditEntry(auditId);
  if (!entry) {
    res.status(404).json({ error: 'Audit entry not found' });
    return;
  }
  if (!entry.previousConfig) {
    res.status(400).json({ error: 'No previous config to rollback to (this was a create action)' });
    return;
  }
  const success = db.rollbackEntity(auditId);
  if (success) {
    res.json({ message: `Rolled back ${entry.entityType} "${entry.entityName}" to previous version` });
  } else {
    res.status(500).json({ error: 'Rollback failed' });
  }
});

// ============================================================
// Mocks Management
// ============================================================

/** List all mocks */
router.get('/mocks', (_req: Request, res: Response) => {
  const mocks = db.getAllMocks();
  res.json({ mocks });
});

/** Get a single mock */
router.get('/mocks/:id', (req: Request, res: Response) => {
  const mock = db.getMock(req.params.id);
  if (!mock) {
    res.status(404).json({ error: 'Mock not found' });
    return;
  }
  res.json(mock);
});

/** Create a new mock (with template generation) */
router.post('/mocks', (req: Request, res: Response) => {
  const mock: MockDefinition = {
    ...req.body,
    id: req.body.id || uuidv4(),
    createdAt: new Date().toISOString(),
  };

  if (!mock.routeId || !mock.name) {
    res.status(400).json({ error: 'routeId and name are required' });
    return;
  }

  db.upsertMock(mock);
  res.status(201).json({ message: 'Mock created', mock });
});

/** Generate a mock template for a route */
router.get('/mocks/template/:routeId', (req: Request, res: Response) => {
  const route = db.getRoute(req.params.routeId);
  if (!route) {
    res.status(404).json({ error: 'Route not found' });
    return;
  }

  // Build path params from route pattern
  const params: Record<string, string> = {};
  const pathParts = route.path.split('/');
  for (const part of pathParts) {
    if (part.startsWith(':')) {
      params[part.slice(1)] = 'example-value';
    }
  }

  // Build example request body from first step's bodyMapping/bodyTemplate
  let requestBody: unknown = undefined;
  if (route.method === 'POST' || route.method === 'PUT' || route.method === 'PATCH') {
    const firstStep = route.steps[0];
    if (firstStep && firstStep.calls && firstStep.calls[0]) {
      const call = firstStep.calls[0];
      if (call.bodyTemplate) {
        // Show the bodyTemplate structure as expected input
        if (typeof call.bodyTemplate === 'string') {
          requestBody = { _note: 'Pass-through: send any JSON body' };
        } else if (Array.isArray(call.bodyTemplate)) {
          requestBody = call.bodyTemplate.map((item) =>
            item !== null && typeof item === 'object'
              ? buildExampleFromTemplate(item as Record<string, unknown>)
              : item
          );
        } else {
          requestBody = buildExampleFromTemplate(call.bodyTemplate);
        }
      } else if (call.bodyMapping && Object.keys(call.bodyMapping).length > 0) {
        // Show expected fields from bodyMapping
        const body: Record<string, string> = {};
        for (const [key, expr] of Object.entries(call.bodyMapping)) {
          if (typeof expr === 'string' && expr.includes('inboundRequest.body')) {
            const fieldPath = expr.replace(/.*inboundRequest\.body\.?/, '');
            body[fieldPath || key] = 'example-value';
          } else {
            body[key] = String(expr);
          }
        }
        requestBody = body;
      } else {
        requestBody = {};
      }
    } else {
      requestBody = {};
    }
  }

  // Build example response from responseMapping
  let responseBody: unknown;
  if (route.responseMapping.rawPassthrough) {
    responseBody = { _note: 'This route returns raw binary data (e.g., PDF). Mock with a base64 string or text.' };
  } else if (route.responseMapping.arrayBody) {
    responseBody = [{ exampleField: 'example-value' }];
  } else {
    responseBody = buildExampleResponse(route.responseMapping.body);
  }

  // Build example query params from first step's queryMapping
  const query: Record<string, string> = {};
  const firstStep = route.steps[0];
  if (firstStep && firstStep.calls && firstStep.calls[0] && firstStep.calls[0].queryMapping) {
    for (const [key, expr] of Object.entries(firstStep.calls[0].queryMapping)) {
      if (typeof expr === 'string' && expr.includes('inboundRequest.query')) {
        query[key] = 'example-value';
      }
    }
  }

  const template: MockDefinition = {
    id: '',
    routeId: route.id,
    name: `Mock - ${route.name}`,
    request: {
      method: route.method,
      path: route.path.replace(/:([a-zA-Z_]\w*)/g, 'example-value'),
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer example-token' },
      params,
      query: Object.keys(query).length > 0 ? query : undefined,
      body: requestBody,
    },
    response: {
      statusCode: typeof route.responseMapping.statusCode === 'number' ? route.responseMapping.statusCode : 200,
      headers: { 'Content-Type': 'application/json' },
      body: responseBody,
    },
    active: true,
    createdAt: '',
  };

  res.json(template);
});

function buildExampleFromTemplate(template: Record<string, unknown>): unknown {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(template)) {
    if (key.startsWith('$')) continue; // Skip directives
    if (typeof value === 'boolean' || typeof value === 'number') {
      result[key] = value;
    } else if (typeof value === 'string') {
      result[key] = 'example-value';
    } else if (typeof value === 'object' && value !== null) {
      if ('$source' in (value as Record<string, unknown>)) {
        result[key] = [{ exampleField: 'example-value' }];
      } else {
        result[key] = buildExampleFromTemplate(value as Record<string, unknown>);
      }
    }
  }
  return result;
}

function buildExampleResponse(body: Record<string, unknown>): unknown {
  if (!body || typeof body !== 'object') return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'string') {
      if (value.startsWith('$steps.') || value.startsWith('$.')) {
        result[key] = 'example-value';
      } else {
        result[key] = value; // Literal
      }
    } else if (typeof value === 'boolean' || typeof value === 'number') {
      result[key] = value;
    } else if (value !== null && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if ('$source' in obj && '$pick' in obj) {
        // Array with $source/$pick — show example array
        const pick = obj['$pick'] as Record<string, unknown>;
        const exampleItem: Record<string, unknown> = {};
        for (const [pKey, pVal] of Object.entries(pick)) {
          if (typeof pVal === 'string' && (pVal.startsWith('$.') || pVal.startsWith('$steps.'))) {
            exampleItem[pKey] = 'example-value';
          } else if (typeof pVal === 'string') {
            exampleItem[pKey] = pVal;
          } else if (typeof pVal === 'boolean' || typeof pVal === 'number') {
            exampleItem[pKey] = pVal;
          } else {
            exampleItem[pKey] = 'example-value';
          }
        }
        result[key] = [exampleItem];
      } else if ('$switch' in obj) {
        result[key] = 'example-value';
      } else if ('$concat' in obj) {
        result[key] = 'example concatenated value';
      } else if ('$filter' in obj) {
        result[key] = [{ exampleField: 'example-value' }];
      } else if ('$calc' in obj) {
        result[key] = 0;
      } else if ('$dateAdd' in obj) {
        result[key] = '2026-01-01';
      } else if ('$derive' in obj) {
        result[key] = 'example-derived-value';
      } else {
        // Nested object — recurse
        result[key] = buildExampleResponse(obj);
      }
    }
  }
  return result;
}

/** Update a mock */
router.put('/mocks/:id', (req: Request, res: Response) => {
  const mock: MockDefinition = {
    ...req.body,
    id: req.params.id,
  };
  db.upsertMock(mock);
  res.json({ message: 'Mock updated', mock });
});

/** Delete a mock */
router.delete('/mocks/:id', (req: Request, res: Response) => {
  const deleted = db.deleteMock(req.params.id);
  if (!deleted) {
    res.status(404).json({ error: 'Mock not found' });
    return;
  }
  res.json({ message: 'Mock deleted' });
});

// ============================================================
// Performance Stats
// ============================================================

/** Get performance statistics per route */
router.get('/performance', (req: Request, res: Response) => {
  let logs = db.getRecentExecutions(parseInt(process.env.LOG_RETENTION || '5000', 10));

  // Apply time range filter
  const from = req.query.from ? new Date(req.query.from as string).getTime() : null;
  const to = req.query.to ? new Date(req.query.to as string).getTime() : null;
  if (from || to) {
    logs = logs.filter(entry => {
      const t = new Date(entry.created_at).getTime();
      if (from && t < from) return false;
      if (to && t > to) return false;
      return true;
    });
  }
  const statsMap = new Map<string, {
    routeId: string;
    routeName: string;
    successDurations: number[];
    failureDurations: number[];
    allDurations: number[];
    backendWallTimes: number[];
    stepDurations: Map<string, { success: number[]; failure: number[] }>;
  }>();

  for (const entry of logs) {
    const key = entry.route_id;
    if (key === 'unmatched' || key === 'unmatched-mock') continue;

    if (!statsMap.has(key)) {
      statsMap.set(key, {
        routeId: key,
        routeName: entry.route_name || key,
        successDurations: [],
        failureDurations: [],
        allDurations: [],
        backendWallTimes: [],
        stepDurations: new Map(),
      });
    }

    const stat = statsMap.get(key)!;
    const isSuccess = entry.status_code >= 200 && entry.status_code < 400;
    stat.allDurations.push(entry.duration_ms);
    if (isSuccess) {
      stat.successDurations.push(entry.duration_ms);
    } else {
      stat.failureDurations.push(entry.duration_ms);
    }

    if (entry.step_results) {
      try {
        const steps = JSON.parse(entry.step_results);
        // Track backend wall time for accurate overhead
        if (steps._backendWallTime !== undefined) {
          stat.backendWallTimes.push(steps._backendWallTime);
        } else {
          stat.backendWallTimes.push(entry.duration_ms); // fallback: no overhead calculable
        }
        for (const [stepId, stepData] of Object.entries(steps)) {
          if (stepId === '_backendWallTime') continue;
          const sd = stepData as { duration?: number; statusCode?: number };
          if (sd && typeof sd.duration === 'number') {
            if (!stat.stepDurations.has(stepId)) {
              stat.stepDurations.set(stepId, { success: [], failure: [] });
            }
            const stepEntry = stat.stepDurations.get(stepId)!;
            const stepSuccess = sd.statusCode !== undefined ? (sd.statusCode >= 200 && sd.statusCode < 400) : isSuccess;
            if (stepSuccess) { stepEntry.success.push(sd.duration); }
            else { stepEntry.failure.push(sd.duration); }
          }
        }
      } catch { /* ignore */ }
    } else {
      stat.backendWallTimes.push(entry.duration_ms);
    }
  }

  const calcStats = (arr: number[]) => {
    if (arr.length === 0) return { count: 0, mean: 0, stdDev: 0, min: 0, max: 0 };
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const variance = arr.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / arr.length;
    return { count: arr.length, mean: Math.round(mean), stdDev: Math.round(Math.sqrt(variance)), min: Math.round(Math.min(...arr)), max: Math.round(Math.max(...arr)) };
  };

  const results = Array.from(statsMap.values()).map((stat) => {
    const stepStats: Record<string, { all: ReturnType<typeof calcStats>; success: ReturnType<typeof calcStats>; failure: ReturnType<typeof calcStats> }> = {};
    for (const [stepId, durations] of stat.stepDurations) {
      stepStats[stepId] = {
        all: calcStats([...durations.success, ...durations.failure]),
        success: calcStats(durations.success),
        failure: calcStats(durations.failure),
      };
    }
    return {
      routeId: stat.routeId,
      routeName: stat.routeName,
      callCount: stat.allDurations.length,
      successCount: stat.successDurations.length,
      failureCount: stat.failureDurations.length,
      all: calcStats(stat.allDurations),
      success: calcStats(stat.successDurations),
      failure: calcStats(stat.failureDurations),
      overhead: calcStats(stat.allDurations.map((t, i) => Math.max(0, t - (stat.backendWallTimes[i] || 0)))),
      steps: stepStats,
    };
  });

  results.sort((a, b) => b.callCount - a.callCount);
  res.json({ performance: results });
});

/** Get time-series performance data for charting */
router.get('/performance/timeseries', (req: Request, res: Response) => {
  let logs = db.getRecentExecutions(parseInt(process.env.LOG_RETENTION || '5000', 10));
  const bucketSize = 1000; // 1-second buckets
  const routeFilter = req.query.routes ? (req.query.routes as string).split(',') : null;

  // Apply time range filter
  const from = req.query.from ? new Date(req.query.from as string).getTime() : null;
  const to = req.query.to ? new Date(req.query.to as string).getTime() : null;
  if (from || to) {
    logs = logs.filter(entry => {
      const t = new Date(entry.created_at).getTime();
      if (from && t < from) return false;
      if (to && t > to) return false;
      return true;
    });
  }

  // Group by time bucket
  const buckets = new Map<number, { count: number; totalDuration: number; totalStepDuration: number }>();
  const routeMap = new Map<string, string>();

  for (const entry of logs) {
    if (entry.route_id === 'unmatched' || entry.route_id === 'unmatched-mock') continue;
    routeMap.set(entry.route_id, entry.route_name || entry.route_id);

    // Apply route filter if specified
    if (routeFilter && !routeFilter.includes(entry.route_id)) continue;

    const timestamp = new Date(entry.created_at).getTime();
    const bucket = Math.floor(timestamp / bucketSize) * bucketSize;

    if (!buckets.has(bucket)) {
      buckets.set(bucket, { count: 0, totalDuration: 0, totalStepDuration: 0 });
    }
    const b = buckets.get(bucket)!;
    b.count++;
    b.totalDuration += entry.duration_ms;

    // Calculate step duration sum for overhead
    if (entry.step_results) {
      try {
        const steps = JSON.parse(entry.step_results);
        // Use _backendWallTime if available (accurate for parallel steps)
        if (steps._backendWallTime !== undefined) {
          b.totalStepDuration += steps._backendWallTime;
        } else {
          let stepSum = 0;
          for (const [key, stepData] of Object.entries(steps)) {
            if (key === '_backendWallTime') continue;
            const sd = stepData as { duration?: number };
            if (sd && typeof sd.duration === 'number') stepSum += sd.duration;
          }
          b.totalStepDuration += stepSum;
        }
      } catch { /* ignore */ }
    }
  }

  // Convert to sorted arrays
  const sorted = Array.from(buckets.entries()).sort((a, b) => a[0] - b[0]);

  // Calculate concurrency per bucket (requests in-flight)
  // A request is in-flight from (endTime - duration) to endTime
  const concurrencyBuckets = new Map<number, number>();
  for (const entry of logs) {
    if (entry.route_id === 'unmatched' || entry.route_id === 'unmatched-mock') continue;
    if (routeFilter && !routeFilter.includes(entry.route_id)) continue;

    const endTime = new Date(entry.created_at).getTime();
    const startTime = endTime - entry.duration_ms;

    // Mark all buckets this request was active in
    const firstBucket = Math.floor(startTime / bucketSize) * bucketSize;
    const lastBucket = Math.floor(endTime / bucketSize) * bucketSize;
    for (let b = firstBucket; b <= lastBucket; b += bucketSize) {
      concurrencyBuckets.set(b, (concurrencyBuckets.get(b) || 0) + 1);
    }
  }

  const timeseries = sorted.map(([timestamp, data]) => ({
    time: new Date(timestamp).toISOString(),
    callsPerSecond: Math.round((data.count / (bucketSize / 1000)) * 100) / 100,
    meanResponseTime: data.count > 0 ? Math.round(data.totalDuration / data.count) : 0,
    meanOverhead: data.count > 0 ? Math.round((data.totalDuration - data.totalStepDuration) / data.count) : 0,
    concurrency: concurrencyBuckets.get(timestamp) || 0,
  }));

  // Also return available routes for filter UI
  const routes = Array.from(routeMap.entries()).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  res.json({ timeseries, routes });
});

// ============================================================
// Documentation
// ============================================================

/** Search documentation files */
router.get('/docs/search', (req: Request, res: Response) => {
  const query = (req.query.q as string || '').toLowerCase().trim();
  const docsDir = path.resolve(__dirname, '../../docs');

  if (!fs.existsSync(docsDir)) {
    res.json({ results: [] });
    return;
  }

  const files = fs.readdirSync(docsDir).filter(f => f.endsWith('.md'));
  const results: { file: string; title: string; matches: { line: number; text: string }[] }[] = [];

  for (const file of files) {
    const content = fs.readFileSync(path.join(docsDir, file), 'utf-8');
    const lines = content.split('\n');
    const title = lines.find(l => l.startsWith('# '))?.replace('# ', '') || file;
    const matches: { line: number; text: string }[] = [];

    if (!query) {
      // No query — return all content
      results.push({ file, title, matches: [{ line: 0, text: content }] });
    } else {
      // Search for matching lines with context
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(query)) {
          const start = Math.max(0, i - 1);
          const end = Math.min(lines.length - 1, i + 3);
          const contextLines = lines.slice(start, end + 1).join('\n');
          matches.push({ line: i + 1, text: contextLines });
        }
      }
      if (matches.length > 0) {
        results.push({ file, title, matches });
      }
    }
  }

  res.json({ results });
});

/** Get a single documentation file */
router.get('/docs/:filename', (req: Request, res: Response) => {
  const docsDir = path.resolve(__dirname, '../../docs');
  const filePath = path.join(docsDir, req.params.filename);

  if (!fs.existsSync(filePath) || !req.params.filename.endsWith('.md')) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  res.json({ filename: req.params.filename, content });
});

// ============================================================
// Event Targets Management
// ============================================================

/** List all event targets */
router.get('/event-targets', (_req: Request, res: Response) => {
  res.json({ eventTargets: db.getAllEventTargets() });
});

/** Get a single event target */
router.get('/event-targets/:id', (req: Request, res: Response) => {
  const target = db.getEventTarget(req.params.id);
  if (!target) {
    res.status(404).json({ error: 'Event target not found' });
    return;
  }
  res.json(target);
});

/** Create a new event target (auto-generate ID) */
router.post('/event-targets', (req: Request, res: Response) => {
  const target: EventTarget = {
    ...req.body,
    id: req.body.id || uuidv4(),
    config: req.body.config || {},
  };
  if (!target.name || !target.type) {
    res.status(400).json({ error: 'name and type are required' });
    return;
  }
  db.upsertEventTarget(target);
  res.status(201).json({ message: 'Event target created', eventTarget: target });
});

/** Create or update an event target */
router.put('/event-targets/:id', (req: Request, res: Response) => {
  const target: EventTarget = {
    ...req.body,
    id: req.params.id,
    config: req.body.config || {},
  };
  if (!target.name || !target.type) {
    res.status(400).json({ error: 'name and type are required' });
    return;
  }
  db.upsertEventTarget(target);
  res.json({ message: 'Event target saved', eventTarget: target });
});

/** Delete an event target */
router.delete('/event-targets/:id', (req: Request, res: Response) => {
  const deleted = db.deleteEventTarget(req.params.id);
  if (!deleted) {
    res.status(404).json({ error: 'Event target not found' });
    return;
  }
  res.json({ message: 'Event target deleted' });
});

// ============================================================
// Events
// ============================================================

/** List events, optionally filtered by status and/or routeId */
router.get('/events', (req: Request, res: Response) => {
  const status = req.query.status as EventStatus | undefined;
  const routeId = req.query.routeId as string | undefined;
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;
  const events = getEventStore().list({ status, routeId, limit });
  res.json({ events });
});

/** Get a single event with full detail (poll history, payload) */
router.get('/events/:id', (req: Request, res: Response) => {
  const event = getEventStore().get(parseInt(req.params.id, 10));
  if (!event) {
    res.status(404).json({ error: 'Event not found' });
    return;
  }
  res.json(event);
});

/** Restart a timed-out event — reset to pending-readiness and resume polling (Req 7) */
router.post('/events/:id/restart', (req: Request, res: Response) => {
  const store = getEventStore();
  const event = store.get(parseInt(req.params.id, 10));
  if (!event) {
    res.status(404).json({ error: 'Event not found' });
    return;
  }
  if (event.status !== 'TIMED_OUT') {
    res.status(400).json({ error: `Only timed-out events can be restarted (current status: ${event.status})` });
    return;
  }
  const nowIso = new Date().toISOString();
  const updated = store.update(event.id, {
    status: 'PENDING_READINESS',
    lastError: null,
    // Reset the readiness elapsed-time accounting so the timeout window starts again
    readiness: event.eventConfig.readiness
      ? { startedAt: nowIso, pollCount: 0, lastPollAt: null, pollHistory: [] }
      : undefined,
  });
  res.json({ message: 'Event restarted', event: updated });
});

/** Re-publish an event — re-queue for delivery using the stored payload and target (Req 9) */
router.post('/events/:id/republish', (req: Request, res: Response) => {
  const store = getEventStore();
  const event = store.get(parseInt(req.params.id, 10));
  if (!event) {
    res.status(404).json({ error: 'Event not found' });
    return;
  }
  if (event.status !== 'DELIVERY_FAILED' && event.status !== 'DELIVERED') {
    res.status(400).json({ error: `Only failed or delivered events can be re-published (current status: ${event.status})` });
    return;
  }
  const updated = store.update(event.id, {
    status: 'READY',
    readyAt: new Date().toISOString(),
    lastError: null,
  });
  res.json({ message: 'Event queued for re-publish', event: updated });
});

// ============================================================
// Received Webhooks (inbound)
// ============================================================

/** List received webhooks (newest first, optional limit) */
router.get('/received-webhooks', (req: Request, res: Response) => {
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 200;
  res.json({ webhooks: getReceivedWebhookStore().list(limit) });
});

/** Get a single received webhook */
router.get('/received-webhooks/:id', (req: Request, res: Response) => {
  const wh = getReceivedWebhookStore().get(parseInt(req.params.id, 10));
  if (!wh) {
    res.status(404).json({ error: 'Received webhook not found' });
    return;
  }
  res.json(wh);
});

/** Clear all received webhooks */
router.delete('/received-webhooks', (_req: Request, res: Response) => {
  getReceivedWebhookStore().clear();
  res.json({ message: 'Received webhooks cleared' });
});

export default router;
