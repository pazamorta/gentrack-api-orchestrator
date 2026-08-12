# API Orchestrator — Configuration Guide

## Overview

All configuration is stored in `data/store.json` and can be managed via:
- The Web UI at `/ui`
- The Admin API at `/admin`
- Direct file editing (requires server restart)

## Environment Variables

| Variable             | Default   | Description                                  |
|----------------------|-----------|----------------------------------------------|
| `PORT`               | `3000`    | Server port                                  |
| `ADMIN_USER`         | `admin`   | Dashboard login username                     |
| `ADMIN_PASS`         | `welcome` | Dashboard login password                     |
| `RATE_LIMIT_MAX`     | `1000`    | Max requests per rate limit window           |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window in milliseconds            |
| `CACHE_TTL_MS`       | `30000`   | GET response cache TTL in milliseconds       |
| `LOG_RETENTION`      | `5000`    | Max execution log entries retained           |

## Backends

A backend represents a downstream API system.

```json
{
  "id": "gtcx-gcis",
  "name": "GTCX GCIS",
  "baseUrl": "https://api-uk.integration.gentrack.cloud/v1/junifer/",
  "auth": { "type": "None" },
  "forwardHeaders": ["authorization", "x-on-behalf-of", "x-trace-id"],
  "defaultHeaders": {
    "Host": "api-uk.integration.gentrack.cloud"
  },
  "timeout": 10000,
  "retry": {
    "maxRetries": 3,
    "initialDelayMs": 500,
    "backoffMultiplier": 2
  }
}
```

### Backend Fields

| Field             | Type                    | Description                                           |
|-------------------|-------------------------|-------------------------------------------------------|
| `id`              | string                  | Unique identifier                                     |
| `name`            | string                  | Display name                                          |
| `baseUrl`         | string                  | Base URL prepended to all call paths                  |
| `auth`            | object                  | Authentication config (`None`, `Bearer`, `Basic`)     |
| `forwardHeaders`  | `true` or `string[]`    | Forward inbound headers to this backend               |
| `defaultHeaders`  | object                  | Headers sent with every request to this backend       |
| `timeout`         | number                  | Request timeout in milliseconds (default 30000)       |
| `retry`           | object                  | Retry configuration                                   |

### Header Forwarding

Backend-level header forwarding can be:
- `true` — Forward all inbound headers (except hop-by-hop headers like host, connection, content-length)
- `string[]` — Forward only named headers (case-insensitive matching)

Headers are forwarded with proper casing (e.g., `authorization` becomes `Authorization`).

### Header Precedence (last wins)

1. Base headers (Content-Type if body present)
2. Forwarded inbound headers
3. `defaultHeaders` from backend config
4. Auth headers (resolved from `auth` config)
5. Per-call `headers` from route step

### Retry Configuration

| Field               | Default | Description                              |
|---------------------|---------|------------------------------------------|
| `maxRetries`        | `3`     | Maximum retry attempts (0 = no retries)  |
| `initialDelayMs`    | `500`   | Delay before first retry                 |
| `backoffMultiplier` | `2`     | Exponential backoff multiplier           |
| `maxDelayMs`        | `10000` | Maximum delay between retries            |
| `retryableStatusCodes` | `[401, 408, 429, 502, 503, 504]` | Codes that trigger retry |
| `retryOnNetworkError` | `true` | Retry on connection/timeout errors      |

Retry includes 10% jitter to avoid thundering herd.

**Important behaviours:**
- **401 is retried** — handles transient auth blips. Auth headers are re-resolved on each attempt.
- **Timeouts are NOT retried** — if the backend exceeds the timeout, the error is returned immediately. Retrying slow backends just adds load and delays the response.
- **Exhausted retries return the real response** — if all retries fail, the actual backend status code and body are passed through (not a generic 500).

## Routes

A route defines an inbound API endpoint and its orchestration flow.

```json
{
  "id": "get-account-services",
  "name": "Get Account Services",
  "logLevel": "debug",
  "method": "GET",
  "path": "v1/accounts/:globalID/services",
  "description": "Gets service and meter point details",
  "suppressErrorPassthrough": false,
  "steps": [...],
  "responseMapping": {...}
}
```

### Route Fields

| Field                      | Type    | Description                                           |
|----------------------------|---------|-------------------------------------------------------|
| `id`                       | string  | Unique identifier                                     |
| `name`                     | string  | Display name                                          |
| `method`                   | string  | HTTP method (GET, POST, PUT, DELETE)                  |
| `path`                     | string  | URL pattern with `:param` placeholders                |
| `logLevel`                 | string  | `none`, `error`, `info`, `debug`                     |
| `description`              | string  | Human-readable description                            |
| `suppressErrorPassthrough` | boolean | If true, response mapping runs even on 4xx/5xx       |
| `steps`                    | array   | Ordered list of orchestration steps                   |
| `responseMapping`          | object  | How to build the final response                       |

### suppressErrorPassthrough

By default, if any backend step returns 4xx/5xx, the orchestrator short-circuits and returns the error response directly. Setting `suppressErrorPassthrough: true` forces response mapping to run regardless:

```json
{
  "name": "Post Validate Meter Reads",
  "suppressErrorPassthrough": true,
  "steps": [...],
  "responseMapping": {
    "statusCode": { "$source": "$steps.step-1.statusCode", "$when": [200, 204, 400], "$override": 200 },
    "body": { ... }
  }
}
```

Use this for validation endpoints where 400 from the backend contains structured data you want to reshape and return to the caller.

### Log Levels

| Level   | What's logged                                                    |
|---------|------------------------------------------------------------------|
| `none`  | Nothing                                                          |
| `error` | Backend errors only (full request/response details)              |
| `info`  | Request flow + status codes + duration                           |
| `debug` | Everything: headers, bodies, params in both directions           |

## Steps

### Sequential

Execute calls one after another. Later calls can reference earlier results.

```json
{
  "type": "sequential",
  "calls": [
    { "stepId": "step-1", "backendId": "gtcx-gcis", "method": "GET", "path": "/accounts/..." },
    { "stepId": "step-2", "backendId": "gtcx-gcis", "method": "GET", "path": "/bills/{{$steps.step-1.body.id}}" }
  ]
}
```

### Parallel

Execute all calls simultaneously. Cannot reference each other's results.

```json
{
  "type": "parallel",
  "calls": [
    { "stepId": "get-balance", "backendId": "gtcx-gcis", "method": "GET", "path": "/balance" },
    { "stepId": "get-bills", "backendId": "gtcx-gcis", "method": "GET", "path": "/bills" }
  ]
}
```

### ForEach

Iterate over an array from a previous step. Results accumulate as arrays.

```json
{
  "type": "forEach",
  "iterateOver": "$steps.step-1.body.results",
  "calls": [
    { "stepId": "step-2", "backendId": "gtcx-gcis", "method": "GET", "path": "{{$item.links.detail}}" }
  ]
}
```

- `$item` — The current iteration item
- `$steps.step-2.body` — An array of results (one per iteration)
- Use `$steps.step-2.body[$$].field` in response mapping to cross-reference by index

#### ForEach Filter

Skip items that don't meet a condition using the `filter` field:

```json
{
  "type": "forEach",
  "iterateOver": "$steps.step-1.body.results[*]",
  "filter": "$item.links.meterStructure",
  "calls": [...]
}
```

Only items where the filter expression resolves to a truthy value will be iterated. This avoids unnecessary backend calls for items missing required data.

#### Array Wildcard [*]

Use `[*]` to flatten nested arrays before iterating:

```json
"iterateOver": "$steps.get-meterpoints.body[*].results[*]"
```

This resolves all `results` arrays across all items in the `get-meterpoints` body, flattens them into a single array, and iterates over each item. Always returns an array even if only one match is found.

### Conditional

Execute calls only if a condition is met.

```json
{
  "type": "conditional",
  "condition": { "expression": "$steps.step-1.body.status", "operator": "eq", "value": "active" },
  "calls": [...],
  "fallbackCalls": [...]
}
```

## Call Configuration

Each call within a step:

```json
{
  "stepId": "step-1",
  "backendId": "gtcx-gcis",
  "method": "GET",
  "path": "/accounts/accountNumber/{{$.inboundRequest.params.globalID}}",
  "forwardHeaders": true,
  "headers": { "Host": "api-uk.integration.gentrack.cloud" },
  "queryMapping": { "fromDt": "$.inboundRequest.query.fromDate", "effectiveDt": "$now.date" },
  "bodyMapping": { "field": "$.inboundRequest.body.value" },
  "bodyTemplate": { "static": true, "dynamic": "$steps.step-1.body.id" }
}
```

### Call Fields

| Field            | Description                                                |
|------------------|------------------------------------------------------------|
| `stepId`         | Unique ID for referencing results                          |
| `backendId`      | Which backend to call                                      |
| `method`         | HTTP method                                                |
| `path`           | URL path (supports `{{expression}}` templates)             |
| `forwardHeaders` | Override backend's forwardHeaders for this call             |
| `headers`        | Additional headers for this call (supports `$` expressions)|
| `queryMapping`   | Query parameters (values are resolved expressions)         |
| `bodyMapping`    | Request body built from expressions                        |
| `bodyTemplate`   | Full body template with literal + dynamic values           |
| `responseType`   | Axios response type (default `json`, use `arraybuffer` for binary) |

### Query Mapping

Values in `queryMapping` are resolved by `resolveValue`:
- Expressions starting with `$` are resolved from context (e.g., `"$.inboundRequest.query.fromDate"`)
- Literal strings without `$` are passed as-is (e.g., `"Draft"` sends `?status=Draft`)
- `"$now.date"` resolves to today's date

```json
"queryMapping": {
  "status": "Draft",
  "fromDt": "$.inboundRequest.query.fromDate",
  "effectiveDt": "$now.date"
}
```

### Path Templates

- `:param` — Replaced from inbound path parameters
- `{{$.inboundRequest.params.id}}` — Expression template
- `{{$item.links.self}}` — Current forEach item field
- `{{$steps.step-1.body.entityUrl}}` — Previous step result
- Absolute URLs (starting with `http://`) — Used directly or rewritten (see URL Rewriting)

### URL Rewriting

When a resolved path is an absolute URL pointing to a different host than the backend's `baseUrl`, the orchestrator:

1. Parses the URL host
2. Compares to the backend's `baseUrl` host
3. If different, extracts just the path portion
4. Strips common internal prefixes (e.g., `/rest/v1/`)
5. Appends the cleaned path to the backend's `baseUrl`

This handles entity URLs from backends that point to internal hosts rather than the API gateway.

### Body Template vs Body Mapping

- `bodyMapping` — Simple key-value pairs resolved from context
- `bodyTemplate` — Full JSON structure with mixed literal and dynamic values

In `bodyTemplate`, use `$.inboundRequest.body.field` for values resolved by `resolveValue`. In `$pick` contexts (within response mapping), use `$context.inboundRequest.body.field` to access the full orchestration context.

## Response Mapping

### Status Code

Simple:
```json
"statusCode": 200
"statusCode": "$steps.step-1.statusCode"
```

Conditional (override based on backend response):
```json
"statusCode": {
  "$source": "$steps.step-1.statusCode",
  "$when": [200, 204, 400],
  "$override": 200
}
```

If the backend returns a status in `$when`, the response returns `$override`. Otherwise, the actual status passes through. Useful with `suppressErrorPassthrough` for validation endpoints.

### Body

```json
"body": {
  "fieldA": "$steps.step-1.body.name",
  "fieldB": "literal value",
  "nested.field": "$steps.step-1.body.deep.value"
}
```

Dot-notation keys create nested objects automatically.

### Validation Response (Array Mapping from Errors)

For validation endpoints, map backend error arrays to a response array:

```json
"body": {
  "validationResponse": {
    "$source": "$steps.step-1.body.errors",
    "$pick": {
      "field": "$.field",
      "message": "$.message"
    }
  }
}
```

## Mocks

Pre-configured responses served from `/mock/*`:

```json
{
  "id": "mock-uuid",
  "routeId": "get-account",
  "name": "Mock - GET Account",
  "active": true,
  "request": {
    "method": "GET",
    "path": "v1/accounts/00000101"
  },
  "response": {
    "statusCode": 200,
    "headers": { "Content-Type": "application/json" },
    "body": { "id": 101, "name": "Test Account" }
  }
}
```

Mock matching priority:
1. Exact path match on `mock.request.path`
2. Pattern match on `mock.request.path` (supports `:param` placeholders, e.g., `v1/accounts/:globalID/outages`)
3. Route pattern match via associated `routeId`

Using `:param` placeholders in the mock's `request.path` allows a single mock to serve responses for any value of that parameter — no route definition required:

```json
{
  "request": {
    "method": "GET",
    "path": "v1/accounts/:globalID/outages"
  },
  "response": {
    "statusCode": 200,
    "body": { "outages": [] }
  }
}
```

The mock list in the UI displays the full `mock.request.path` (including v1 prefix) for clarity.

## Database Connections

For routes that query databases directly (MSSQL):

```json
{
  "id": "db-uuid",
  "name": "juniferlocal",
  "type": "mssql",
  "host": "localhost",
  "database": "junifertraining",
  "username": "sa",
  "password": "***",
  "options": {
    "encrypt": false,
    "trustServerCertificate": true,
    "instanceName": "JUNIFERDEMO"
  }
}
```

## Performance & Caching

### Connection Pooling

The orchestrator maintains persistent HTTP/HTTPS connection pools:
- `keepAlive: true` — Reuses TCP connections
- `maxSockets: 50` — Up to 50 concurrent connections per host
- `maxFreeSockets: 10` — Idle connections kept warm

No configuration needed — always active.

### Response Cache

GET requests are cached in-memory with configurable TTL:
- Only successful responses (2xx/3xx) are cached
- Cache key: URL + serialized query params
- Max 1000 entries; expired entries evicted on access
- Set `CACHE_TTL_MS=0` to disable caching

### Rate Limiting

Applied to `/api` proxy endpoint only:
- Default: 1000 requests per 60 seconds
- Returns HTTP 429 with `Retry-After` header when exceeded
- Set `RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW_MS` to tune

## Execution Logging

### Log Retention

Controlled by `LOG_RETENTION` env var (default 5000). When the log exceeds this count, oldest entries are pruned.

### What's Logged

Each execution log entry contains:
- Route ID and name
- Inbound method, path, query parameters, headers, body
- Response status code and body
- Total duration (ms)
- Step results with per-step:
  - Status code
  - Duration (ms)
  - Response body and headers
  - Outbound request details (method, URL, headers, params, body)
- `_backendWallTime` — Wall-clock time for backend calls (handles parallel step overlap)

### Unmatched Request Logging

Requests that don't match any route or mock are logged with:
- Route ID: `unmatched` or `unmatched-mock`
- Route name: `[NO MATCH]`
- Full request details including query parameters
- 404 status code

This provides visibility into misconfigured paths or unexpected traffic.
