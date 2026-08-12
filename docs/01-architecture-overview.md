# API Orchestrator — Architecture Overview

## Purpose

The API Orchestrator is a lightweight middleware that sits between frontend consumers (Salesforce, Postman, etc.) and one or more backend APIs. It provides:

- **Route-based orchestration** — Define multi-step API workflows declaratively via JSON config
- **Data transformation** — Map and reshape backend responses into the format consumers expect
- **Mock responses** — Serve pre-configured mock data for testing without backend dependencies
- **Execution logging** — Full visibility into every request, including outbound calls and timing
- **Performance monitoring** — Real-time stats, time-series charts, and per-step breakdowns
- **Connection pooling** — Reuse TCP connections for faster backend calls
- **In-memory caching** — TTL-based GET response cache to reduce backend load
- **Authentication** — Cookie-based login with sliding session expiry

## System Architecture

![Architecture Diagram](/ui/assets/architecture-diagram.svg)

## Core Components

### 1. Express Server (`src/index.ts`)

The entry point mounts four route handlers and applies cross-cutting middleware:

| Path      | Handler         | Purpose                                    |
|-----------|-----------------|-------------------------------------------|
| `/api/*`  | Proxy Router    | Matches configured routes, executes orchestration |
| `/mock/*` | Mock Router     | Matches active mocks, returns configured responses |
| `/admin`  | Admin Router    | CRUD for backends, routes, mocks, databases; performance stats |
| `/ui`     | Static Files    | Web-based management dashboard             |

Middleware stack:
- JSON body parsing (10mb limit)
- Rate limiting on `/api` (configurable max/window)
- Cookie-based authentication on `/ui` and `/admin`

### 2. Authentication & Login

The dashboard is protected by Basic Auth / session cookie authentication:

- Login page at `/ui/login.html` accepts username/password
- On success, sets `orch_auth=valid` HttpOnly cookie with 30-minute sliding expiry
- Every authenticated request refreshes the cookie (sliding window)
- Credentials configurable via `ADMIN_USER` and `ADMIN_PASS` environment variables
- Default: `admin` / `welcome`
- Logout clears the cookie and redirects to login

### 3. Orchestrator (`src/orchestrator.ts`)

The core engine that executes route configurations:

1. Receives a matched route config
2. Iterates through steps (sequential, parallel, forEach, conditional)
3. For each step, calls backend APIs via axios with connection pooling
4. Checks in-memory cache for GET requests before calling backends
5. Stores results in `context.stepResults`
6. Tracks per-step timing and wall-clock backend time (`_backendWallTime`)
7. Applies response mapping to build the final output

### 4. Connection Pooling

HTTP and HTTPS agents with persistent connections:

- `keepAlive: true` — Reuse TCP connections across requests
- `maxSockets: 50` — Up to 50 concurrent connections per host
- `maxFreeSockets: 10` — Idle connections kept warm

Both agents are passed to every axios request via `httpAgent`/`httpsAgent` config. This eliminates TCP handshake overhead on repeated calls to the same backend.

### 5. In-Memory Response Cache

TTL-based cache for GET responses:

- Cache key: `${url}|${JSON.stringify(params)}`
- Only caches successful responses (status 200–399)
- TTL configurable via `CACHE_TTL_MS` environment variable (default 30s)
- Max 1000 entries, expired entries evicted automatically
- Non-GET requests bypass cache entirely
- Cache hits return immediately without making a backend call

### 6. URL Rewriting (Foreign Host Resolution)

When a forEach step iterates over entity URLs from backend responses, those URLs may point to a different host (e.g., an internal database host). The orchestrator handles this:

1. If a resolved path is an absolute URL, parse the host
2. If the host matches the configured backend's `baseUrl`, use it directly
3. If the host is different (foreign), extract just the path portion
4. Strip common internal prefixes (e.g., `/rest/v1/`)
5. Append the cleaned path to the backend's `baseUrl`

This allows entity links like `http://internal-db:8080/rest/v1/meterPoints/123` to be correctly routed to the configured backend URL.

### 7. Transformer (`src/transformer.ts`)

Handles all data transformation:

- **`resolveValue`** — Resolves expressions like `$steps.step-1.body.field`, `$.inboundRequest.query.param`, `$now.date`
- **`resolvePath`** — Resolves URL templates like `/accounts/{{$.inboundRequest.params.id}}`
- **`applyMapping`** — Builds response objects from mapping declarations
- **`applyArrayMap`** — Transforms arrays using `$source`/`$pick` patterns
- **Array wildcard `[*]`** — Always returns array when expression contains `[*]`, preventing forEach from treating single objects as dictionaries

### 8. Data Store (`src/db.ts`)

JSON file-based persistence:

- `data/store.json` — Backends, routes, mocks, databases
- `data/logs.json` — Execution logs, audit trail
- Log retention: configurable via `LOG_RETENTION` env var (default 5000 entries)

### 9. Retry Logic (`src/retry.ts`)

Configurable retry with exponential backoff:

- Per-backend defaults
- Per-call overrides
- Retryable status codes: 401, 408, 429, 502, 503, 504
- 401 retried for transient auth blips (re-resolves auth headers each attempt)
- Network error retry (connection refused, reset, DNS) with jitter
- **Timeouts are NOT retried** — if the backend is slow, retrying just adds load
- When all retries are exhausted, the actual backend response (real status code and body) is returned, not a generic 500
- Default: max 3 retries, 500ms initial delay, 2x backoff multiplier

### 10. Authentication (`src/auth.ts`)

Resolves auth headers for outbound calls:

- None (pass-through)
- Bearer token
- Basic auth
- Custom header injection

### 11. Rate Limiting (`src/rate-limiter.ts`)

Per-window request limiting on the `/api` proxy endpoint:

- Default: 1000 requests per 60 seconds
- Configurable via `RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW_MS` env vars
- Returns 429 with rate limit headers when exceeded

## Request Flow

```
1. Inbound Request
   GET /api/v1/accounts/00000101/services
   Headers: Authorization, X-Tenant-Id, X-Trace-Id

2. Rate Limit Check
   Current window count vs RATE_LIMIT_MAX

3. Route Matching
   proxy.ts → findMatchingRoute() → matches "v1/accounts/:globalID/services"
   (Unmatched requests logged with [NO MATCH] and return 404)

4. Context Creation
   {
     inboundRequest: { method, path, headers, query, params, body },
     stepResults: {},
     logLevel: "debug"
   }

5. Step Execution (with connection pooling + caching)
   Step 1 (sequential): GET /propertys → check cache → stepResults["get-propertys"]
   Step 2 (forEach):    GET /meterPoints → stepResults["get-meterpoints"]
   Step 3 (forEach):    GET /meterStructure → stepResults["get-meterpoints-structure"]
   (Foreign host URLs rewritten to backend baseUrl)

6. Response Mapping
   Apply $source/$pick transforms to build final JSON

7. Response
   200 OK { serviceSupplies: [...] }

8. Performance Tracking
   Record _backendWallTime, per-step durations, total duration

9. Logging
   Full execution details saved to logs.json (with query params, request details)
```

## Step Types

| Type          | Behaviour                                              |
|---------------|-------------------------------------------------------|
| `sequential`  | Execute calls one after another                        |
| `parallel`    | Execute all calls simultaneously                       |
| `forEach`     | Iterate over an array, execute calls per item          |
| `conditional` | Execute calls only if a condition is met               |

### forEach Filtering

ForEach steps support an optional `filter` field to skip items that don't meet criteria:

```json
{
  "type": "forEach",
  "iterateOver": "$steps.step-1.body.results",
  "filter": "$item.links.meterStructure",
  "calls": [...]
}
```

Only items where the filter expression is truthy will be iterated.

## Key Features

### Header Forwarding

Backend-level or per-call configuration to forward inbound headers (e.g., Authorization) to downstream APIs.

### Error Handling

- Default: 4xx/5xx from backend steps short-circuits and returns error
- `suppressErrorPassthrough: true`: Response mapping always runs (for validation flows)
- Conditional status codes: Override based on backend response

### Execution Logging

Every request is logged with:
- Inbound method, path, query parameters, headers, body
- Each step's outbound URL, method, headers, params, body (via `request` field in step results)
- Each step's response status, headers, body, duration
- Final response body and status code
- Backend wall time (`_backendWallTime`) for accurate overhead calculation

Unmatched requests (no route found) are logged with `[NO MATCH]` for visibility.

### Performance Monitoring

Real-time performance data available via `/admin/performance`:
- Per-route statistics: call count, mean, standard deviation, min, max
- Separate success/failure breakdowns
- Per-step duration breakdowns with individual success/failure stats
- Overhead calculation: total duration minus backend wall time
- Time-series data via `/admin/performance/timeseries` for graphing

### Mock Mode

Callers use `/mock/*` prefix to get pre-configured mock responses without hitting real backends. Useful for Salesforce development without backend dependencies. Mock paths support `:param` placeholders for matching any URL parameter value.

## Web Dashboard

The dashboard provides:

| Tab          | Features                                                    |
|--------------|-------------------------------------------------------------|
| Routes       | CRUD management of orchestration routes                     |
| Backends     | Manage downstream API connections                           |
| Mocks        | Configure mock responses (shows full path with v1 prefix)   |
| Logs         | Execution logs with pagination (50/page), route filter, backend/overhead columns |
| Performance  | Time-series charts, route stats table, per-step breakdown   |
| Docs         | Searchable markdown documentation viewer                    |

### Performance Tab

- Chart.js time-series graph showing mean response time, concurrent requests, calls/sec, and overhead
- Route filter checkboxes integrated into table rows
- Sortable table columns
- Sticky chart with scrollable table
- "Logs" button to jump to filtered execution logs for any route
- Success/failure breakdown per route and per step
- **From/To date-time filter** — filter graph, table, and exports by time range (defaults to last 10 minutes)
- **CSV Export** — two options:
  - Export Summary: one row per route with all stats
  - Export Detail: per-route + per-step breakdown with success/failure/overhead

### Execution Logs

- Paginated (50 entries per page)
- Route filter dropdown
- Backend and Overhead duration columns
- Query parameters displayed
- Full step result inspection

## Technology Stack

- **Runtime**: Node.js 22.x
- **Framework**: Express
- **Language**: TypeScript
- **HTTP Client**: Axios (with connection pooling)
- **JSONPath**: jsonpath-plus
- **Storage**: JSON files (no database required)
- **Charts**: Chart.js (frontend)
- **Hosting**: Render (or any Node.js host)

## Environment Variables

| Variable             | Default   | Description                                  |
|----------------------|-----------|----------------------------------------------|
| `PORT`               | `3000`    | Server port                                  |
| `ADMIN_USER`         | `admin`   | Dashboard login username                     |
| `ADMIN_PASS`         | `welcome` | Dashboard login password                     |
| `RATE_LIMIT_MAX`     | `1000`    | Max requests per window                      |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window in milliseconds            |
| `CACHE_TTL_MS`       | `30000`   | GET response cache TTL in milliseconds       |
| `LOG_RETENTION`      | `5000`    | Max execution log entries retained           |
