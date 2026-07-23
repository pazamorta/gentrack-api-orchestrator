import express from 'express';
import * as path from 'path';
import { initDb } from './db';
import { loadConfig } from './config-loader';
import * as db from './db';
import adminRouter from './routes/admin';
import proxyRouter from './routes/proxy';
import mockRouter from './routes/mock';
import { rateLimitMiddleware } from './rate-limiter';

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting — configurable via env vars
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '100', 10);
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);

// Apply rate limiting to the proxy API
app.use('/api', rateLimitMiddleware({
  maxRequests: RATE_LIMIT_MAX,
  windowMs: RATE_LIMIT_WINDOW_MS,
  message: 'Rate limit exceeded. Please try again later.',
  headers: true,
}));

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Web UI (serves static files)
app.use('/ui', express.static(path.resolve(__dirname, '../public')));
app.get('/', (_req, res) => res.redirect('/ui'));

// Admin API for managing backends and routes
app.use('/admin', adminRouter);

// Mock API — serves mocked responses for testing
app.use('/mock', mockRouter);

// Proxy/orchestration handler — catches all other requests
app.use('/api', proxyRouter);

// Catch-all for unmatched requests at root level (no /api or /mock prefix)
app.use((req, res) => {
  const { logExecution } = require('./db');
  console.log(`[app] ⚠️  Unmatched request: ${req.method} ${req.path}`);
  logExecution({
    routeId: 'unmatched',
    routeName: '[NO MATCH]',
    inboundMethod: req.method,
    inboundPath: req.path,
    inboundHeaders: req.headers as Record<string, string>,
    inboundBody: req.body,
    statusCode: 404,
    durationMs: 0,
    stepResults: {},
    error: `No route configured for ${req.method} ${req.path}`,
  });
  res.status(404).json({
    error: 'Not found',
    method: req.method,
    path: req.path,
  });
});

// Start server
async function start(): Promise<void> {
  // Initialize database
  await initDb();
  console.log('[orchestrator] Database initialized');

  // Try to seed from YAML config if DB is empty
  try {
    const existingBackends = db.getAllBackends();
    const existingRoutes = db.getAllRoutes();

    if (existingBackends.length === 0 && existingRoutes.length === 0) {
      const config = loadConfig();
      if (config.backends.length > 0 || config.routes.length > 0) {
        console.log('[orchestrator] Seeding database from YAML config...');
        for (const backend of config.backends) {
          db.upsertBackend(backend);
        }
        for (const route of config.routes) {
          db.upsertRoute(route);
        }
        console.log(`[orchestrator] Seeded ${config.backends.length} backends, ${config.routes.length} routes`);
      }
    }
  } catch (err) {
    console.log('[orchestrator] No YAML config found or error loading it — starting with empty config');
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[orchestrator] API Orchestrator running on port ${PORT}`);
    console.log(`[orchestrator] Web UI:    http://localhost:${PORT}/ui`);
    console.log(`[orchestrator] Admin API: http://localhost:${PORT}/admin`);
    console.log(`[orchestrator] Proxy API: http://localhost:${PORT}/api`);
    console.log(`[orchestrator] Mock API:  http://localhost:${PORT}/mock`);
    console.log(`[orchestrator] Rate limit: ${RATE_LIMIT_MAX} requests per ${RATE_LIMIT_WINDOW_MS / 1000}s`);
  });
}

start().catch((err) => {
  console.error('[orchestrator] Failed to start:', err);
  process.exit(1);
});

export default app;
