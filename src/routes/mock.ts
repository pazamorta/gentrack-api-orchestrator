import { Router, Request, Response } from 'express';
import * as db from '../db';
import { logExecution } from '../db';

const router = Router();

/**
 * Mock API handler — matches inbound requests against active mocks
 * and returns the configured mock response.
 * 
 * Frontend apps call /mock/* instead of /api/* to get mocked responses.
 */
router.all('*', (req: Request, res: Response) => {
  const startTime = Date.now();
  const mock = findBestMock(req.method, req.path);

  if (!mock) {
    const duration = Date.now() - startTime;
    console.log(`[mock] ⚠️  No mock matched: ${req.method} ${req.path}`);
    logExecution({
      routeId: 'unmatched-mock',
      routeName: '[NO MATCH - MOCK]',
      inboundMethod: req.method,
      inboundPath: req.path,
      inboundQuery: req.query as Record<string, string>,
      inboundHeaders: req.headers as Record<string, string>,
      inboundBody: req.body,
      statusCode: 404,
      durationMs: duration,
      stepResults: {},
      error: `No active mock configured for ${req.method} ${req.path}`,
    });
    res.status(404).json({
      error: 'No active mock configured for this endpoint',
      method: req.method,
      path: req.path,
    });
    return;
  }

  // Set response headers from mock
  if (mock.response.headers) {
    for (const [key, value] of Object.entries(mock.response.headers)) {
      res.setHeader(key, value);
    }
  }

  const duration = Date.now() - startTime;

  // Log the mock execution
  logExecution({
    routeId: mock.routeId,
    routeName: `[MOCK] ${mock.name}`,
    inboundMethod: req.method,
    inboundPath: req.path,
    inboundQuery: req.query as Record<string, string>,
    inboundHeaders: req.headers as Record<string, string>,
    inboundBody: req.body,
    statusCode: mock.response.statusCode,
    durationMs: duration,
    stepResults: {},
    responseBody: mock.response.body,
  });

  res.status(mock.response.statusCode).json(mock.response.body);
});

/**
 * Find the best matching mock — prefers mocks with specific path matches
 * over generic pattern matches.
 */
function findBestMock(method: string, requestPath: string) {
  const allMocks = db.getAllMocks().filter((m) => m.active);
  const routes = db.getAllRoutes();

  // First: try exact path match on mock's request.path
  for (const mock of allMocks) {
    if (mock.request && mock.request.path) {
      const mockPath = mock.request.path.replace(/^\//, '');
      const reqPath = requestPath.replace(/^\//, '');
      if (mock.request.method === method.toUpperCase() && mockPath === reqPath) {
        return mock;
      }
    }
  }

  // Second: try route pattern match (returns first match)
  for (const mock of allMocks) {
    const route = routes.find((r) => r.id === mock.routeId);
    if (!route) continue;
    if (route.method !== method.toUpperCase()) continue;
    if (matchMockPath(route.path, requestPath)) {
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

export default router;
