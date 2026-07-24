# API Orchestrator — Configuration Guide

## Overview

All configuration is stored in `data/store.json` and can be managed via:
- The Web UI at `/ui`
- The Admin API at `/admin`
- Direct file editing (requires server restart)

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
| `timeout`         | number                  | Request timeout in milliseconds                       |
| `retry`           | object                  | Retry configuration                                   |

### Header Precedence (last wins)

1. Base headers (Content-Type if body present)
2. Forwarded inbound headers
3. `defaultHeaders` from backend config
4. Auth headers (resolved from `auth` config)
5. Per-call `headers` from route step

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
| `suppressErrorPassthrough` | boolean | If true, response mapping runs even on 4xx/5xx       |
| `steps`                    | array   | Ordered list of orchestration steps                   |
| `responseMapping`          | object  | How to build the final response                       |

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
  "queryMapping": { "fromDt": "$.inboundRequest.query.fromDate" },
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
| `headers`        | Additional headers for this call                           |
| `queryMapping`   | Query parameters (values are resolved expressions)         |
| `bodyMapping`    | Request body built from expressions                        |
| `bodyTemplate`   | Full body template with literal + dynamic values           |

### Path Templates

- `:param` — Replaced from inbound path parameters
- `{{$.inboundRequest.params.id}}` — Expression template
- `{{$item.links.self}}` — Current forEach item field
- Absolute URLs (starting with `http://`) are used directly (skip baseUrl)

## Response Mapping

### Status Code

```json
"statusCode": 200
"statusCode": "$steps.step-1.statusCode"
"statusCode": {
  "$source": "$steps.step-1.statusCode",
  "$when": [200, 204, 400],
  "$override": 200
}
```

The conditional form returns `$override` when the actual status is in `$when`, otherwise passes through.

### Body

```json
"body": {
  "fieldA": "$steps.step-1.body.name",
  "fieldB": "literal value",
  "nested.field": "$steps.step-1.body.deep.value"
}
```

Dot-notation keys create nested objects automatically.

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
2. Route pattern match via associated `routeId`

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
