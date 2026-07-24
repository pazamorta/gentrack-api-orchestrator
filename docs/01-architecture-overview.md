# API Orchestrator — Architecture Overview

## Purpose

The API Orchestrator is a lightweight middleware that sits between frontend consumers (Salesforce, Postman, etc.) and one or more backend APIs. It provides:

- **Route-based orchestration** — Define multi-step API workflows declaratively via JSON config
- **Data transformation** — Map and reshape backend responses into the format consumers expect
- **Mock responses** — Serve pre-configured mock data for testing without backend dependencies
- **Execution logging** — Full visibility into every request, including outbound calls and timing

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    CONSUMERS                                 │
│  Salesforce CRM  │  Postman  │  Other Integrations          │
└────────┬────────────────┬────────────────┬──────────────────┘
         │                │                │
         └────────────────┴────────────────┘
                          │
              ┌───────────▼───────────┐
              │   API Orchestrator    │
              │   (Express + Node.js) │
              ├───────────────────────┤
              │                       │
              │  /api/*  → Proxy      │  Orchestrates multi-step flows
              │  /mock/* → Mock       │  Serves mock responses
              │  /admin  → Admin API  │  Configuration CRUD
              │  /ui     → Web UI     │  Dashboard for management
              │                       │
              └───────────┬───────────┘
                          │
         ┌────────────────┼────────────────┐
         │                │                │
┌────────▼──────┐ ┌──────▼───────┐ ┌──────▼───────┐
│  Backend A    │ │  Backend B   │ │  Backend C   │
│  (GCIS/UAPI) │ │  (Junifer)   │ │  (Other)     │
└───────────────┘ └──────────────┘ └──────────────┘
```

## Core Components

### 1. Express Server (`src/index.ts`)

The entry point mounts four route handlers:

| Path      | Handler         | Purpose                                    |
|-----------|-----------------|-------------------------------------------|
| `/api/*`  | Proxy Router    | Matches configured routes, executes orchestration |
| `/mock/*` | Mock Router     | Matches active mocks, returns configured responses |
| `/admin`  | Admin Router    | CRUD for backends, routes, mocks, databases |
| `/ui`     | Static Files    | Web-based management dashboard             |

### 2. Orchestrator (`src/orchestrator.ts`)

The core engine that executes route configurations:

1. Receives a matched route config
2. Iterates through steps (sequential, parallel, forEach, conditional)
3. For each step, calls backend APIs via axios
4. Stores results in `context.stepResults`
5. Applies response mapping to build the final output

### 3. Transformer (`src/transformer.ts`)

Handles all data transformation:

- **`resolveValue`** — Resolves expressions like `$steps.step-1.body.field`, `$.inboundRequest.query.param`, `$now.date`
- **`resolvePath`** — Resolves URL templates like `/accounts/{{$.inboundRequest.params.id}}`
- **`applyMapping`** — Builds response objects from mapping declarations
- **`applyArrayMap`** — Transforms arrays using `$source`/`$pick` patterns

### 4. Data Store (`src/db.ts`)

JSON file-based persistence:

- `data/store.json` — Backends, routes, mocks, databases
- `data/logs.json` — Execution logs, audit trail

### 5. Retry Logic (`src/retry.ts`)

Configurable retry with exponential backoff:

- Per-backend defaults
- Per-call overrides
- Configurable retryable status codes

### 6. Authentication (`src/auth.ts`)

Resolves auth headers for outbound calls:

- None (pass-through)
- Bearer token
- Basic auth
- Custom header injection

## Request Flow

```
1. Inbound Request
   GET /api/v1/accounts/00000101/services
   Headers: Authorization, X-Tenant-Id, X-Trace-Id

2. Route Matching
   proxy.ts → findMatchingRoute() → matches "v1/accounts/:globalID/services"

3. Context Creation
   {
     inboundRequest: { method, path, headers, query, params, body },
     stepResults: {},
     logLevel: "debug"
   }

4. Step Execution
   Step 1 (sequential): GET /propertys → stepResults["get-propertys"]
   Step 2 (forEach):    GET /meterPoints → stepResults["get-meterpoints"]
   Step 3 (forEach):    GET /meterStructure → stepResults["get-meterpoints-structure"]

5. Response Mapping
   Apply $source/$pick transforms to build final JSON

6. Response
   200 OK { serviceSupplies: [...] }

7. Logging
   Full execution details saved to logs.json
```

## Step Types

| Type          | Behaviour                                              |
|---------------|-------------------------------------------------------|
| `sequential`  | Execute calls one after another                        |
| `parallel`    | Execute all calls simultaneously                       |
| `forEach`     | Iterate over an array, execute calls per item          |
| `conditional` | Execute calls only if a condition is met               |

## Key Features

### Header Forwarding

Backend-level or per-call configuration to forward inbound headers (e.g., Authorization) to downstream APIs.

### Error Handling

- Default: 4xx/5xx from backend steps short-circuits and returns error
- `suppressErrorPassthrough: true`: Response mapping always runs (for validation flows)
- Conditional status codes: Override based on backend response

### Execution Logging

Every request is logged with:
- Inbound method, path, query, headers, body
- Each step's outbound URL, headers, params, body
- Each step's response status, headers, body, duration
- Final response body and status code

### Mock Mode

Callers use `/mock/*` prefix to get pre-configured mock responses without hitting real backends. Useful for Salesforce development without backend dependencies.

## Technology Stack

- **Runtime**: Node.js 22.x
- **Framework**: Express
- **Language**: TypeScript
- **HTTP Client**: Axios
- **JSONPath**: jsonpath-plus
- **Storage**: JSON files (no database required)
- **Hosting**: Render (or any Node.js host)
