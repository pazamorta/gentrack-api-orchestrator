# API Orchestrator

A configurable API gateway that takes a single inbound request and orchestrates it across multiple backend APIs with support for parallel fan-out, sequential chaining, conditional routing, data transformation, and per-backend authentication.

## Quick Start

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build and run in production
npm run build
npm start
```

The server starts on port 3000 (configurable via `PORT` env var).

## Architecture

```
Inbound Request → Route Matcher → Orchestration Engine → Backend Calls → Response Builder
                                         ↕
                              Config (YAML / SQLite DB)
```

### Core Components

| File | Purpose |
|------|---------|
| `src/index.ts` | Express server setup, startup logic |
| `src/types.ts` | TypeScript type definitions for all configs |
| `src/orchestrator.ts` | Orchestration engine (parallel, sequential, conditional) |
| `src/transformer.ts` | JSONPath-based data transformation |
| `src/auth.ts` | Per-backend authentication (API key, Bearer, Basic, OAuth2) |
| `src/config-loader.ts` | YAML configuration loader |
| `src/db.ts` | SQLite persistence layer |
| `src/routes/admin.ts` | Admin API for managing backends/routes |
| `src/routes/proxy.ts` | Dynamic proxy that matches and orchestrates requests |

## Configuration

### YAML (Initial Seed)

On first startup with an empty database, the orchestrator loads `config/orchestrator.yaml` to seed the DB. After that, use the Admin API for changes.

See `config/orchestrator.yaml` for a full example with comments.

### Backends

Each backend defines a downstream API service:

```yaml
backends:
  - id: user-service
    name: User Service
    baseUrl: https://api.example.com/users
    auth:
      type: bearer          # none | api-key | bearer | basic | oauth2
      token: "my-token"
    defaultHeaders:
      X-Custom-Header: value
    timeout: 5000           # ms
```

### Routes

Routes define how inbound requests map to backend calls:

```yaml
routes:
  - id: get-user-profile
    name: Get User Profile
    method: GET
    path: /users/:id
    steps:
      - type: parallel      # parallel | sequential | conditional
        calls:
          - stepId: get-user
            backendId: user-service
            method: GET
            path: "/:id"
          - stepId: get-orders
            backendId: order-service
            method: GET
            path: /orders
            queryMapping:
              userId: "$.inboundRequest.params.id"
    responseMapping:
      body:
        user: "$steps.get-user.body"
        orders: "$steps.get-orders.body.items"
```

## Orchestration Patterns

### Parallel Fan-out
Execute multiple calls simultaneously and aggregate results:
```yaml
- type: parallel
  calls:
    - stepId: call-a
      ...
    - stepId: call-b
      ...
```

### Sequential Chaining
Execute calls in order — later calls can reference earlier results:
```yaml
- type: sequential
  calls:
    - stepId: first
      ...
    - stepId: second
      bodyMapping:
        previousResult: "$steps.first.body.id"
```

### Conditional Routing
Execute calls based on conditions evaluated against accumulated context:
```yaml
- type: conditional
  condition:
    expression: "$steps.payment.statusCode"
    operator: lt
    value: 300
  calls:
    - stepId: on-success
      ...
  fallbackCalls:
    - stepId: on-failure
      ...
```

**Condition operators:** `eq`, `neq`, `gt`, `lt`, `gte`, `lte`, `exists`, `not-exists`, `contains`

## Data Transformation

### Body Mapping
Map fields from the inbound request or previous step results:
```yaml
bodyMapping:
  userId: "$.inboundRequest.body.userId"         # from inbound body
  orderId: "$steps.create-order.body.id"         # from a previous step
  status: "active"                                # literal value
```

### Query Mapping
Map query parameters similarly:
```yaml
queryMapping:
  page: "$.inboundRequest.query.page"
  userId: "$.inboundRequest.params.id"
```

### Path Templates
Use path parameters from the inbound request:
```yaml
path: "/users/{{$.inboundRequest.params.id}}/orders"
# or shorthand for inbound params:
path: "/users/:id/orders"
```

## Authentication

Each backend can use a different auth mechanism:

| Type | Config Fields |
|------|--------------|
| `none` | — |
| `api-key` | `headerName`, `token` |
| `bearer` | `token` |
| `basic` | `username`, `password` |
| `oauth2` | `oauth2.tokenUrl`, `oauth2.clientId`, `oauth2.clientSecret`, `oauth2.scope` |

OAuth2 tokens are cached and auto-refreshed before expiry.

## Admin API

### Backends
- `GET /admin/backends` — List all backends
- `GET /admin/backends/:id` — Get one backend
- `POST /admin/backends` — Create a backend
- `PUT /admin/backends/:id` — Update a backend
- `DELETE /admin/backends/:id` — Delete a backend

### Routes
- `GET /admin/routes` — List all routes
- `GET /admin/routes/:id` — Get one route
- `POST /admin/routes` — Create a route
- `PUT /admin/routes/:id` — Update a route
- `DELETE /admin/routes/:id` — Delete a route

### Logs
- `GET /admin/logs?limit=50` — Recent execution logs

## Proxy API

All requests to `/api/*` are matched against configured routes and orchestrated automatically.

```bash
# Example: triggers the "create-order" route
curl -X POST http://localhost:3000/api/orders \
  -H "Content-Type: application/json" \
  -d '{"userId": "123", "items": [...], "total": 99.99, "currency": "USD"}'
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |

Backend auth tokens can reference env vars in YAML using `${VAR_NAME}` syntax (resolved at load time).
