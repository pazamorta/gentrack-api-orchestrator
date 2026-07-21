import axios, { AxiosRequestConfig } from 'axios';
import { BackendApp, BackendCall, Condition, DatabaseConnection, OrchestrationContext, OrchestrationStep, RouteConfig, StepResult } from './types';
import { resolveAuthHeaders } from './auth';
import { applyMapping, resolvePath, resolveValue, buildResponse } from './transformer';
import { withRetry, RetryPolicy, DEFAULT_RETRY_POLICY } from './retry';
import { executeDatabaseStep } from './database';

/**
 * Execute a full orchestration flow for a matched route.
 */
export async function executeOrchestration(
  route: RouteConfig,
  backends: Map<string, BackendApp>,
  context: OrchestrationContext,
  databases?: Map<string, DatabaseConnection>
): Promise<{ statusCode: number; headers: Record<string, string>; body: unknown }> {
  // Execute each step in order
  for (const step of route.steps) {
    await executeStep(step, backends, context, databases);

    // Check if any step in this group returned an error status (skip for forEach — collect all results)
    if (step.type !== 'forEach') {
      for (const call of step.calls) {
        const result = context.stepResults[call.stepId];
        if (result && result.statusCode >= 400) {
          // Pass through the backend error directly
          return {
            statusCode: result.statusCode,
            headers: {},
            body: result.body,
          };
        }
      }

      // Also check fallback calls for conditional steps
      if (step.fallbackCalls) {
        for (const call of step.fallbackCalls) {
          const result = context.stepResults[call.stepId];
          if (result && result.statusCode >= 400) {
            return {
              statusCode: result.statusCode,
              headers: {},
              body: result.body,
            };
          }
        }
      }
    }
  }

  // All steps succeeded — build the mapped response
  // Check for raw pass-through mode
  if (route.responseMapping.rawPassthrough) {
    const stepId = route.responseMapping.rawPassthrough.replace('$steps.', '');
    const stepResult = context.stepResults[stepId];
    if (stepResult) {
      return {
        statusCode: stepResult.statusCode,
        headers: stepResult.headers as Record<string, string>,
        body: stepResult.body,
        raw: true,
      } as any;
    }
  }

  // Build response body — either as array (arrayBody) or object (body)
  let responseBody: unknown;
  if (route.responseMapping.arrayBody) {
    const { applyArrayMap } = require('./transformer');
    responseBody = applyArrayMap(route.responseMapping.arrayBody, context);
  } else {
    responseBody = buildResponse(route.responseMapping.body, context);
  }

  // Strip null/undefined values if configured
  const finalBody = route.responseMapping.stripNulls
    ? stripNullValues(responseBody)
    : responseBody;

  // Resolve status code — supports fixed number or expression like "$steps.step-1.statusCode"
  let statusCode = 200;
  const rawStatus = route.responseMapping.statusCode;
  if (typeof rawStatus === 'number') {
    statusCode = rawStatus;
  } else if (typeof rawStatus === 'string') {
    const resolved = resolveValue(rawStatus, context);
    statusCode = typeof resolved === 'number' ? resolved : parseInt(String(resolved), 10) || 200;
  }

  const headers = route.responseMapping.headers || {};

  return { statusCode, headers, body: finalBody };
}

/**
 * Execute a single orchestration step.
 */
async function executeStep(
  step: OrchestrationStep,
  backends: Map<string, BackendApp>,
  context: OrchestrationContext,
  databases?: Map<string, DatabaseConnection>
): Promise<void> {
  switch (step.type) {
    case 'parallel':
      await executeParallel(step.calls, backends, context);
      break;

    case 'sequential':
      await executeSequential(step.calls, backends, context);
      break;

    case 'conditional':
      await executeConditional(step, backends, context);
      break;

    case 'forEach':
      await executeForEach(step, backends, context);
      break;

    case 'database':
    case 'procedure':
      if (step.database && databases) {
        const result = await executeDatabaseStep(step.database, databases, context);
        context.stepResults[step.database.stepId] = result;
        if (result.statusCode >= 400) {
          console.error(`[orchestrator] Database step "${step.database.stepId}" returned ${result.statusCode}:`, JSON.stringify(result.body).slice(0, 200));
        }
      }
      break;
  }
}

/**
 * Execute all calls in parallel and wait for all to complete.
 */
async function executeParallel(
  calls: BackendCall[],
  backends: Map<string, BackendApp>,
  context: OrchestrationContext
): Promise<void> {
  const promises = calls.map((call) => executeBackendCall(call, backends, context));
  const results = await Promise.allSettled(promises);

  results.forEach((result, index) => {
    const call = calls[index];
    if (result.status === 'fulfilled') {
      context.stepResults[call.stepId] = result.value;
      if (result.value.statusCode >= 400) {
        console.error(`[orchestrator] Step "${call.stepId}" returned ${result.value.statusCode}:`, JSON.stringify(result.value.body).slice(0, 200));
      }
    } else {
      console.error(`[orchestrator] Step "${call.stepId}" failed:`, result.reason?.message || 'Unknown error');
      context.stepResults[call.stepId] = {
        statusCode: 500,
        headers: {},
        body: { error: result.reason?.message || 'Unknown error' },
        duration: 0,
      };
    }
  });
}

/**
 * Execute calls one after another, allowing later calls to use earlier results.
 */
async function executeSequential(
  calls: BackendCall[],
  backends: Map<string, BackendApp>,
  context: OrchestrationContext
): Promise<void> {
  for (const call of calls) {
    try {
      const result = await executeBackendCall(call, backends, context);
      context.stepResults[call.stepId] = result;
      if (result.statusCode >= 400) {
        console.error(`[orchestrator] Step "${call.stepId}" returned ${result.statusCode}:`, JSON.stringify(result.body).slice(0, 200));
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[orchestrator] Step "${call.stepId}" failed:`, message);
      context.stepResults[call.stepId] = {
        statusCode: 500,
        headers: {},
        body: { error: message },
        duration: 0,
      };
    }
  }
}

/**
 * Execute calls conditionally based on a condition evaluation.
 */
async function executeConditional(
  step: OrchestrationStep,
  backends: Map<string, BackendApp>,
  context: OrchestrationContext
): Promise<void> {
  const conditionMet = step.condition ? evaluateCondition(step.condition, context) : true;

  const callsToExecute = conditionMet ? step.calls : (step.fallbackCalls || []);

  if (callsToExecute.length > 0) {
    // Execute conditional calls sequentially by default
    await executeSequential(callsToExecute, backends, context);
  }
}

/**
 * Execute calls for each item in an array or each value in an object.
 * Results are stored as arrays keyed by stepId (e.g., stepResults["get-meter"].body = [result1, result2, ...])
 */
async function executeForEach(
  step: OrchestrationStep,
  backends: Map<string, BackendApp>,
  context: OrchestrationContext
): Promise<void> {
  if (!step.iterateOver) {
    console.warn('[orchestrator] forEach step missing iterateOver expression');
    return;
  }

  // Resolve the collection to iterate over
  const collection = resolveValue(step.iterateOver, context);

  let items: unknown[];

  if (Array.isArray(collection)) {
    items = collection;
  } else if (collection !== null && typeof collection === 'object') {
    // Object — iterate over its values
    items = Object.values(collection as Record<string, unknown>);
  } else if (collection) {
    // Single value — wrap in array
    items = [collection];
  } else {
    console.warn(`[orchestrator] forEach: iterateOver resolved to ${typeof collection}`);
    items = [];
  }

  await iterateItems(items, step, backends, context);
}

async function iterateItems(
  items: unknown[],
  step: OrchestrationStep,
  backends: Map<string, BackendApp>,
  context: OrchestrationContext
): Promise<void> {
  // Initialize result arrays for each call's stepId
  for (const call of step.calls) {
    context.stepResults[call.stepId] = {
      statusCode: 200,
      headers: {},
      body: [],
      duration: 0,
    };
  }

  for (let i = 0; i < items.length; i++) {
    // Set the current item and index in context
    context.currentItem = items[i];
    context.currentIndex = i;

    // Apply filter — insert null for non-matching items to preserve index alignment
    if (step.filter) {
      const filterValue = resolveValue(step.filter, context);
      if (!filterValue || filterValue === undefined || filterValue === null) {
        // Push null to maintain index alignment with source array
        for (const call of step.calls) {
          const existing = context.stepResults[call.stepId];
          (existing.body as unknown[]).push(null);
        }
        continue;
      }
    }

    for (const call of step.calls) {
      try {
        const result = await executeBackendCall(call, backends, context);
        // Accumulate results as an array
        const existing = context.stepResults[call.stepId];
        (existing.body as unknown[]).push(result.body);
        existing.duration += result.duration;
        // Keep the worst status code
        if (result.statusCode > existing.statusCode) {
          existing.statusCode = result.statusCode;
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        const existing = context.stepResults[call.stepId];
        (existing.body as unknown[]).push({ error: message, itemIndex: i });
        existing.statusCode = 500;
      }
    }
  }

  // Clean up loop variables
  context.currentItem = undefined;
  context.currentIndex = undefined;
}

/**
 * Evaluate a condition against the orchestration context.
 */
function evaluateCondition(condition: Condition, context: OrchestrationContext): boolean {
  const actualValue = resolveValue(condition.expression, context);

  switch (condition.operator) {
    case 'exists':
      return actualValue !== undefined && actualValue !== null;
    case 'not-exists':
      return actualValue === undefined || actualValue === null;
    case 'eq':
      return actualValue == condition.value;
    case 'neq':
      return actualValue != condition.value;
    case 'gt':
      return Number(actualValue) > Number(condition.value);
    case 'lt':
      return Number(actualValue) < Number(condition.value);
    case 'gte':
      return Number(actualValue) >= Number(condition.value);
    case 'lte':
      return Number(actualValue) <= Number(condition.value);
    case 'contains':
      if (typeof actualValue === 'string') {
        return actualValue.includes(String(condition.value));
      }
      if (Array.isArray(actualValue)) {
        return actualValue.includes(condition.value);
      }
      return false;
    default:
      return false;
  }
}

/**
 * Execute a single backend API call with retry support.
 */
async function executeBackendCall(
  call: BackendCall,
  backends: Map<string, BackendApp>,
  context: OrchestrationContext
): Promise<StepResult> {
  const backend = backends.get(call.backendId);
  if (!backend) {
    throw new Error(`Backend "${call.backendId}" not found`);
  }

  // Merge retry policies: default < backend-level < call-level
  const retryPolicy: Partial<RetryPolicy> = {
    ...DEFAULT_RETRY_POLICY,
    ...(backend.retry || {}),
    ...(call.retry || {}),
  };

  const startTime = Date.now();

  const retryResult = await withRetry(
    async () => {
      // Resolve auth headers (re-resolved on each attempt for token refresh)
      const authHeaders = await resolveAuthHeaders(backend.auth);

      // Resolve the URL path
      const resolvedPath = resolvePath(call.path, context);
      // Support absolute URLs (if path resolves to http:// or https://, use it directly)
      const url = resolvedPath.startsWith('http://') || resolvedPath.startsWith('https://')
        ? resolvedPath
        : `${backend.baseUrl.replace(/\/$/, '')}/${resolvedPath.replace(/^\//, '')}`;

      const logLvl = context.logLevel || 'error';
      if (logLvl === 'info' || logLvl === 'debug') {
        console.log(`[orchestrator] ${call.method} ${url}`);
      }

      // Build query params
      let params: Record<string, string> | undefined;
      if (call.queryMapping) {
        params = {};
        for (const [key, expr] of Object.entries(call.queryMapping)) {
          const value = resolveValue(expr, context);
          if (value !== undefined) {
            params[key] = String(value);
          }
        }
      }

      // Build request body
      let data: unknown = undefined;
      if (call.bodyTemplate && Object.keys(call.bodyTemplate).length > 0) {
        // Use bodyTemplate — supports $source/$pick for building arrays
        data = applyMapping(call.bodyTemplate as Record<string, unknown>, context);
      } else if (call.bodyMapping && Object.keys(call.bodyMapping).length > 0) {
        data = applyMapping(call.bodyMapping, context);
      } else if (call.staticBody !== undefined) {
        data = call.staticBody;
      }

      // Merge headers — resolve any $ expressions in call headers
      const resolvedCallHeaders: Record<string, string> = {};
      if (call.headers) {
        for (const [key, value] of Object.entries(call.headers)) {
          if (typeof value === 'string' && value.startsWith('$')) {
            const resolved = resolveValue(value, context);
            resolvedCallHeaders[key] = resolved !== undefined ? String(resolved) : '';
          } else {
            resolvedCallHeaders[key] = value;
          }
        }
      }

      // Only include Content-Type if there's a body
      const baseHeaders: Record<string, string> = {};
      if (data !== undefined) {
        baseHeaders['Content-Type'] = 'application/json';
      }

      // Forward inbound headers if configured (call-level overrides backend-level)
      const forwardedHeaders: Record<string, string> = {};
      const effectiveForwardHeaders = call.forwardHeaders || backend.forwardHeaders;
      if (effectiveForwardHeaders) {
        const inboundHeaders = context.inboundRequest.headers;
        // Headers to never forward (hop-by-hop and problematic)
        const skipHeaders = new Set([
          'host', 'connection', 'content-length', 'transfer-encoding',
          'keep-alive', 'upgrade', 'proxy-authorization', 'proxy-connection',
          'te', 'trailer', 'content-type', 'postman-token'
        ]);

        // Standard header casing map
        const headerCasing: Record<string, string> = {
          'authorization': 'Authorization',
          'accept': 'Accept',
          'accept-encoding': 'Accept-Encoding',
          'user-agent': 'User-Agent',
          'cache-control': 'Cache-Control',
          'accept-language': 'Accept-Language',
          'x-tenant-id': 'X-Tenant-Id',
          'x-request-id': 'X-Request-Id',
        };

        if (effectiveForwardHeaders === true) {
          // Forward all headers except skip list
          for (const [key, value] of Object.entries(inboundHeaders)) {
            if (!skipHeaders.has(key.toLowerCase()) && value) {
              const properKey = headerCasing[key.toLowerCase()] || key;
              forwardedHeaders[properKey] = String(value);
            }
          }
        } else if (Array.isArray(effectiveForwardHeaders)) {
          // Forward only specified headers
          for (const headerName of effectiveForwardHeaders) {
            const value = inboundHeaders[headerName.toLowerCase()];
            if (value) {
              const properKey = headerCasing[headerName.toLowerCase()] || headerName;
              forwardedHeaders[properKey] = String(value);
            }
          }
        }
      }

      const headers: Record<string, string> = {
        ...baseHeaders,
        ...forwardedHeaders,
        ...backend.defaultHeaders,
        ...authHeaders,
        ...resolvedCallHeaders,
      };

      if (logLvl === 'debug') {
        console.log(`[orchestrator]   Outbound Headers:`, JSON.stringify(headers));
        if (params) console.log(`[orchestrator]   Outbound Params:`, JSON.stringify(params));
        if (data) console.log(`[orchestrator]   Outbound Body:`, JSON.stringify(data).slice(0, 1000));
      }

      const config: AxiosRequestConfig = {
        method: call.method,
        url,
        headers,
        params,
        data,
        timeout: backend.timeout || 30_000,
        responseType: call.responseType || 'json',
        validateStatus: () => true, // Don't throw on non-2xx
      };

      const response = await axios(config);

      // Log full details on error responses or debug all responses
      if (response.status >= 400) {
        if (logLvl !== 'none') {
          console.error(`[orchestrator] ❌ BACKEND ERROR — Step "${call.stepId}"`);
          console.error(`[orchestrator]   URL: ${call.method} ${url}`);
          console.error(`[orchestrator]   Request Headers:`, JSON.stringify(headers));
          if (params) console.error(`[orchestrator]   Request Params:`, JSON.stringify(params));
          if (data) console.error(`[orchestrator]   Request Body:`, JSON.stringify(data).slice(0, 500));
          console.error(`[orchestrator]   Response Status: ${response.status}`);
          console.error(`[orchestrator]   Response Headers:`, JSON.stringify(response.headers));
          console.error(`[orchestrator]   Response Body:`, JSON.stringify(response.data).slice(0, 500));
        }
      } else if (logLvl === 'debug') {
        console.log(`[orchestrator] ✅ Step "${call.stepId}" → ${response.status}`);
        console.log(`[orchestrator]   Response Body:`, JSON.stringify(response.data).slice(0, 500));
      }

      // Throw on retryable status codes so retry logic can catch them
      if (retryPolicy.retryableStatusCodes?.includes(response.status)) {
        const err = new Error(`Backend returned ${response.status}`);
        (err as unknown as { response: { status: number } }).response = { status: response.status };
        throw err;
      }

      return response;
    },
    retryPolicy
  );

  const duration = Date.now() - startTime;

  if (retryResult.success && retryResult.result) {
    const response = retryResult.result;
    let body = response.data;

    // Apply response filter if configured
    if (call.responseFilter) {
      const rf = call.responseFilter;
      let targetArray: unknown[];

      if (rf.path) {
        // Filter a nested array within the response
        const { JSONPath } = require('jsonpath-plus');
        const results = JSONPath({ path: `$.${rf.path}`, json: body });
        targetArray = Array.isArray(results[0]) ? results[0] : [];
      } else {
        targetArray = Array.isArray(body) ? body : [];
      }

      const { JSONPath } = require('jsonpath-plus');
      const filtered = targetArray.filter((item: unknown) => {
        const results = JSONPath({ path: `$.${rf.field}`, json: item as object });
        const actualValue = results.length > 0 ? results[0] : undefined;

        switch (rf.operator) {
          case 'eq': return actualValue == rf.value;
          case 'neq': return actualValue != rf.value;
          case 'gt': return Number(actualValue) > Number(rf.value);
          case 'lt': return Number(actualValue) < Number(rf.value);
          case 'gte': return Number(actualValue) >= Number(rf.value);
          case 'lte': return Number(actualValue) <= Number(rf.value);
          case 'exists': return actualValue !== undefined && actualValue !== null;
          case 'not-exists': return actualValue === undefined || actualValue === null;
          case 'contains': return typeof actualValue === 'string' && actualValue.includes(String(rf.value));
          default: return true;
        }
      });

      if (rf.path) {
        // Replace the nested array with filtered version
        body = { ...body, [rf.path]: filtered };
      } else {
        body = filtered;
      }
    }

    return {
      statusCode: response.status,
      headers: response.headers as Record<string, string>,
      body,
      duration,
    };
  }

  // All retries exhausted — return error result
  throw retryResult.error || new Error(`Backend call "${call.stepId}" failed after ${retryResult.attempts} attempts`);
}

/**
 * Recursively remove null and undefined values from an object.
 */
function stripNullValues(obj: unknown): unknown {
  if (obj === null || obj === undefined) return undefined;
  if (Array.isArray(obj)) {
    return obj.map(stripNullValues).filter((v) => v !== undefined);
  }
  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const stripped = stripNullValues(value);
      if (stripped !== undefined && stripped !== null) {
        result[key] = stripped;
      }
    }
    return result;
  }
  return obj;
}
