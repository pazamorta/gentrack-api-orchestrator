import { Router, Request, Response } from 'express';
import { BackendApp, DatabaseConnection, OrchestrationContext, RouteConfig } from '../types';
import { executeOrchestration } from '../orchestrator';
import * as db from '../db';
import { logExecution } from '../db';

const router = Router();

/**
 * Dynamic proxy handler — matches inbound requests against configured routes
 * and executes the orchestration flow.
 */
router.all('*', async (req: Request, res: Response) => {
  const startTime = Date.now();

  // Find matching route
  const routes = db.getAllRoutes();
  const matchedRoute = findMatchingRoute(routes, req.method, req.path);

  if (!matchedRoute) {
    const duration = Date.now() - startTime;
    console.log(`[proxy] ⚠️  No route matched: ${req.method} ${req.path}`);
    logExecution({
      routeId: 'unmatched',
      routeName: '[NO MATCH]',
      inboundMethod: req.method,
      inboundPath: req.path,
      inboundHeaders: req.headers as Record<string, string>,
      inboundBody: req.body,
      statusCode: 404,
      durationMs: duration,
      stepResults: {},
      error: `No orchestration route configured for ${req.method} ${req.path}`,
    });
    res.status(404).json({
      error: 'No orchestration route configured for this endpoint',
      method: req.method,
      path: req.path,
    });
    return;
  }

  const logLevel = matchedRoute.logLevel || 'error';

  // Build context
  const params = extractParams(matchedRoute.path, req.path);
  const context: OrchestrationContext = {
    inboundRequest: {
      method: req.method,
      path: req.path,
      headers: req.headers as Record<string, string>,
      query: req.query as Record<string, string>,
      params,
      body: req.body,
    },
    stepResults: {},
    logLevel,
  };

  // Log inbound request
  if (logLevel === 'info' || logLevel === 'debug') {
    console.log(`[proxy] ➡️  ${req.method} ${req.path} → "${matchedRoute.name}"`);
  }
  if (logLevel === 'debug') {
    console.log(`[proxy]   Inbound Headers:`, JSON.stringify(req.headers));
    console.log(`[proxy]   Inbound Query:`, JSON.stringify(req.query));
    console.log(`[proxy]   Inbound Params:`, JSON.stringify(params));
    if (req.body && Object.keys(req.body).length > 0) {
      console.log(`[proxy]   Inbound Body:`, JSON.stringify(req.body).slice(0, 1000));
    }
  }

  // Load backends into a map
  const backends = new Map<string, BackendApp>();
  const allBackends = db.getAllBackends();
  for (const b of allBackends) {
    backends.set(b.id, b);
  }

  // Load database connections into a map
  const databases = new Map<string, DatabaseConnection>();
  const allDatabases = db.getAllDatabases();
  for (const d of allDatabases) {
    databases.set(d.id, d);
  }

  try {
    const result = await executeOrchestration(matchedRoute, backends, context, databases);

    // Set response headers
    for (const [key, value] of Object.entries(result.headers)) {
      res.setHeader(key, value);
    }

    const duration = Date.now() - startTime;

    // Log execution
    logExecution({
      routeId: matchedRoute.id,
      routeName: matchedRoute.name,
      inboundMethod: req.method,
      inboundPath: req.path,
      inboundHeaders: req.headers as Record<string, string>,
      inboundBody: req.body,
      statusCode: result.statusCode,
      durationMs: duration,
      stepResults: context.stepResults,
      responseBody: result.body,
    });

    // Raw pass-through: send body directly without JSON wrapping
    if ((result as any).raw) {
      const contentType = result.headers['content-type'] || result.headers['Content-Type'];
      if (contentType) {
        res.setHeader('Content-Type', contentType);
      }
      if (logLevel === 'info' || logLevel === 'debug') {
        console.log(`[proxy] ⬅️  ${result.statusCode} (${duration}ms) [raw pass-through]`);
      }
      res.status(result.statusCode).send(result.body);
    } else {
      if (logLevel === 'info' || logLevel === 'debug') {
        console.log(`[proxy] ⬅️  ${result.statusCode} (${duration}ms)`);
      }
      if (logLevel === 'debug') {
        console.log(`[proxy]   Response Body:`, JSON.stringify(result.body).slice(0, 1000));
      }
      res.status(result.statusCode).json(result.body);
    }
  } catch (error: unknown) {
    const duration = Date.now() - startTime;
    const message = error instanceof Error ? error.message : 'Internal orchestration error';

    logExecution({
      routeId: matchedRoute.id,
      routeName: matchedRoute.name,
      inboundMethod: req.method,
      inboundPath: req.path,
      inboundHeaders: req.headers as Record<string, string>,
      inboundBody: req.body,
      statusCode: 500,
      durationMs: duration,
      stepResults: context.stepResults,
      error: message,
    });

    res.status(500).json({ error: message });
  }
});

/**
 * Find a route configuration matching the inbound method and path.
 * Supports path parameters like /users/:id.
 */
function findMatchingRoute(routes: RouteConfig[], method: string, requestPath: string): RouteConfig | null {
  for (const route of routes) {
    if (route.method !== method.toUpperCase()) continue;

    if (matchPath(route.path, requestPath)) {
      return route;
    }
  }
  return null;
}

/**
 * Match a route pattern against a request path.
 * Pattern: /users/:id/orders -> matches /users/123/orders
 */
function matchPath(pattern: string, requestPath: string): boolean {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = requestPath.split('/').filter(Boolean);

  if (patternParts.length !== pathParts.length) return false;

  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) continue; // wildcard param
    if (patternParts[i] !== pathParts[i]) return false;
  }

  return true;
}

/**
 * Extract path parameters from a request path based on a pattern.
 */
function extractParams(pattern: string, requestPath: string): Record<string, string> {
  const params: Record<string, string> = {};
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = requestPath.split('/').filter(Boolean);

  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      const paramName = patternParts[i].slice(1);
      params[paramName] = pathParts[i];
    }
  }

  return params;
}

export default router;
