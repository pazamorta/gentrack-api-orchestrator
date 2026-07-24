import express, { Request, Response, NextFunction } from 'express';
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

// Admin credentials (configurable via env vars)
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'welcome';

// Basic auth middleware for UI and admin routes
function basicAuth(req: Request, res: Response, next: NextFunction): void {
  // Allow login page and its assets without auth
  if (req.path === '/login.html' || req.path === '/assets/style.css' || req.path === '/assets/mainLogo.png' || req.path === '/favicon.png') {
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  if (authHeader) {
    const encoded = authHeader.split(' ')[1];
    if (encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
      const [user, pass] = decoded.split(':');
      if (user === ADMIN_USER && pass === ADMIN_PASS) {
        next();
        return;
      }
    }
  }

  // Check session cookie
  const cookie = req.headers.cookie;
  if (cookie && cookie.includes('orch_auth=valid')) {
    next();
    return;
  }

  // Redirect to login page for browser requests, 401 for API requests
  if (req.headers.accept && req.headers.accept.includes('text/html')) {
    res.redirect('/ui/login.html');
  } else {
    res.status(401).json({ error: 'Authentication required' });
  }
}

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

// Favicon
app.get('/favicon.ico', (_req, res) => {
  res.redirect('/ui/favicon.png');
});

// Login endpoint
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    res.setHeader('Set-Cookie', 'orch_auth=valid; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400');
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

// Logout endpoint
app.post('/logout', (_req, res) => {
  res.setHeader('Set-Cookie', 'orch_auth=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  res.json({ success: true });
});

// Web UI (serves static files — requires auth)
app.use('/ui', basicAuth, express.static(path.resolve(__dirname, '../public')));
app.get('/', (_req, res) => res.redirect('/ui'));

// Admin API for managing backends and routes — requires auth
app.use('/admin', basicAuth, adminRouter);

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
    inboundQuery: req.query as Record<string, string>,
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
