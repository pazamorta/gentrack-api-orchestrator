import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { BackendApp, DatabaseConnection, MockDefinition, RouteConfig } from '../types';
import * as db from '../db';

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
  const logs = db.getRecentExecutions(limit);
  res.json({ logs });
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

  // Build template from route config
  const params: Record<string, string> = {};
  const pathParts = route.path.split('/');
  for (const part of pathParts) {
    if (part.startsWith(':')) {
      params[part.slice(1)] = 'example-value';
    }
  }

  const template: MockDefinition = {
    id: '',
    routeId: route.id,
    name: `Mock - ${route.name}`,
    request: {
      method: route.method,
      path: route.path.replace(/:([a-zA-Z_]\w*)/g, 'example-value'),
      headers: { 'Content-Type': 'application/json' },
      params,
      query: {},
      body: route.method === 'POST' || route.method === 'PUT' ? {} : undefined,
    },
    response: {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: {},
    },
    active: true,
    createdAt: '',
  };

  res.json(template);
});

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

export default router;
