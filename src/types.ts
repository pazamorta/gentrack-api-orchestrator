// ============================================================
// Core types for the API Orchestrator
// ============================================================

/** Supported authentication mechanisms for backend APIs */
export type AuthType = 'none' | 'api-key' | 'bearer' | 'basic' | 'oauth2';

export interface AuthConfig {
  type: AuthType;
  /** For api-key: the header name (e.g. "X-API-Key") */
  headerName?: string;
  /** For api-key/bearer: the token or key value */
  token?: string;
  /** For basic auth */
  username?: string;
  password?: string;
  /** For OAuth2 client credentials flow */
  oauth2?: {
    tokenUrl: string;
    clientId: string;
    clientSecret: string;
    scope?: string;
  };
}

/** Retry policy for a backend or individual call */
export interface RetryConfig {
  /** Max retries (0 = disabled) */
  maxRetries?: number;
  /** Initial delay in ms */
  initialDelayMs?: number;
  /** Backoff multiplier */
  backoffMultiplier?: number;
  /** Max delay cap in ms */
  maxDelayMs?: number;
  /** Status codes that trigger retry */
  retryableStatusCodes?: number[];
  /** Retry on network errors */
  retryOnNetworkError?: boolean;
}

/** A registered backend application */
export interface BackendApp {
  id: string;
  name: string;
  baseUrl: string;
  auth: AuthConfig;
  /** Default headers sent with every request to this backend */
  defaultHeaders?: Record<string, string>;
  /** Connection timeout in ms */
  timeout?: number;
  /** Default retry policy for this backend */
  retry?: RetryConfig;
  /** Forward inbound request headers to this backend by default (true = all, or array of names) */
  forwardHeaders?: boolean | string[];
}

/** HTTP methods */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** A single backend API call within an orchestration */
export interface BackendCall {
  /** Unique step ID within the orchestration */
  stepId: string;
  /** Reference to a registered backend app */
  backendId: string;
  /** HTTP method */
  method: HttpMethod;
  /** Path appended to the backend's baseUrl (supports template variables) */
  path: string;
  /** Headers specific to this call (merged with backend defaults) */
  headers?: Record<string, string>;
  /** Forward inbound request headers. true = forward all (except hop-by-hop), or array of header names to forward */
  forwardHeaders?: boolean | string[];
  /** Request body transformation — JSONPath mappings from inbound request */
  bodyMapping?: Record<string, string>;
  /** Query parameter mappings */
  queryMapping?: Record<string, string>;
  /** Static body to send (used if bodyMapping is not set) */
  staticBody?: unknown;
  /** Template body — supports $source/$pick for building arrays in request body */
  bodyTemplate?: Record<string, unknown>;
  /** Override retry policy for this specific call */
  retry?: RetryConfig;
  /** Response type: 'json' (default) or 'arraybuffer' for binary responses */
  responseType?: 'json' | 'arraybuffer';
  /** Filter the response body array before storing (applies to the field specified by responseFilterPath, or body directly) */
  responseFilter?: {
    /** JSONPath to the array within the response body (e.g., "results"). If omitted, filters body directly */
    path?: string;
    field: string;
    operator: string;
    value?: unknown;
  };
}

/** Condition for conditional routing */
export interface Condition {
  /** JSONPath expression evaluated against accumulated context */
  expression: string;
  /** Operator for comparison */
  operator: 'eq' | 'neq' | 'gt' | 'lt' | 'gte' | 'lte' | 'exists' | 'not-exists' | 'contains';
  /** Value to compare against (not needed for exists/not-exists) */
  value?: unknown;
}

/** Orchestration step types */
export type StepType = 'parallel' | 'sequential' | 'conditional' | 'forEach' | 'database' | 'procedure';

/** An orchestration step that groups backend calls */
export interface OrchestrationStep {
  type: StepType;
  /** For conditional steps */
  condition?: Condition;
  /** Backend calls to execute in this step */
  calls: BackendCall[];
  /** For conditional: calls to execute if condition is false */
  fallbackCalls?: BackendCall[];
  /** For forEach: expression that resolves to an array to iterate over */
  iterateOver?: string;
  /** For forEach: variable name for the current item (used as $item in expressions) */
  itemVariable?: string;
  /** For forEach: only process items where this expression resolves to a truthy value */
  filter?: string;
  /** For database/procedure steps */
  database?: DatabaseStepConfig;
}

/** Database step configuration */
export interface DatabaseStepConfig {
  /** Step ID for storing results */
  stepId: string;
  /** Reference to a configured database connection */
  connectionId: string;
  /** SQL query with parameter placeholders (use :paramName for parameters) */
  query?: string;
  /** Stored procedure name (for procedure steps) */
  procedure?: string;
  /** Parameters — values can be expressions ($steps., $.inboundRequest., etc.) */
  params?: Record<string, string>;
  /** Whether to return single row (first result) or all rows */
  singleRow?: boolean;
}

/** Database connection types */
export type DatabaseType = 'postgres' | 'mysql' | 'mssql';

/** A configured database connection */
export interface DatabaseConnection {
  id: string;
  name: string;
  type: DatabaseType;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  /** Additional connection options */
  options?: Record<string, unknown>;
}

/** Response transformation — how to build the final response */
export interface ResponseMapping {
  /** JSONPath expressions mapping step results into the final response body (supports nested objects) */
  body: Record<string, unknown>;
  /** HTTP status code — fixed number, expression like "$steps.step-1.statusCode", or conditional object */
  statusCode?: number | string | { $source: string; $when: number[]; $override: number };
  /** Response headers to set */
  headers?: Record<string, string>;
  /** Pass through a step's raw response (body + content-type) without JSON wrapping */
  rawPassthrough?: string;
  /** Remove null/undefined values from the response */
  stripNulls?: boolean;
  /** Return body as a top-level array using $source/$pick (body field is ignored when this is set) */
  arrayBody?: Record<string, unknown>;
}

/** A complete route configuration */
export interface RouteConfig {
  id: string;
  /** Display name */
  name: string;
  /** Inbound HTTP method */
  method: HttpMethod;
  /** Inbound path pattern (e.g. /api/orders/:id) */
  path: string;
  /** Description of what this route does */
  description?: string;
  /** Ordered orchestration steps */
  steps: OrchestrationStep[];
  /** How to transform step results into the final response */
  responseMapping: ResponseMapping;
  /** Log level for this route: 'none' | 'error' | 'info' | 'debug' */
  logLevel?: 'none' | 'error' | 'info' | 'debug';
  /** When true, 4xx/5xx step results won't short-circuit — response mapping always runs */
  suppressErrorPassthrough?: boolean;
}

/** Top-level orchestrator configuration (YAML file structure) */
export interface OrchestratorConfig {
  backends: BackendApp[];
  routes: RouteConfig[];
}

/** Runtime context passed through orchestration steps */
export interface OrchestrationContext {
  /** The original inbound request */
  inboundRequest: {
    method: string;
    path: string;
    headers: Record<string, string>;
    query: Record<string, string>;
    params: Record<string, string>;
    body: unknown;
  };
  /** Results from completed steps, keyed by stepId */
  stepResults: Record<string, StepResult>;
  /** Current loop item for forEach steps (available as $item) */
  currentItem?: unknown;
  /** Current loop index for forEach steps (available as $index) */
  currentIndex?: number;
  /** Log level for this execution */
  logLevel?: 'none' | 'error' | 'info' | 'debug';
}

export interface StepResult {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  duration: number;
  /** Outbound request details (for debugging) */
  request?: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    params?: Record<string, string>;
    body?: unknown;
  };
}

/** A mock definition for a route */
export interface MockDefinition {
  id: string;
  /** Route ID this mock is for */
  routeId: string;
  /** Display name for the mock */
  name: string;
  /** Mock request — what the caller should send */
  request: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    params?: Record<string, string>;
    query?: Record<string, string>;
    body?: unknown;
  };
  /** Mock response — what the system returns */
  response: {
    statusCode: number;
    headers?: Record<string, string>;
    body: unknown;
  };
  /** Whether this mock is active */
  active: boolean;
  createdAt: string;
}
