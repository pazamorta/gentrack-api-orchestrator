import { Pool as PgPool } from 'pg';
import * as mysql from 'mysql2/promise';
// @ts-ignore - mssql doesn't ship types, using dynamic access
const mssql = require('mssql');
import { DatabaseConnection, DatabaseStepConfig, OrchestrationContext, StepResult } from './types';
import { resolveValue } from './transformer';

// Connection pools (cached per connection ID)
const pgPools = new Map<string, PgPool>();
const mysqlPools = new Map<string, mysql.Pool>();
const mssqlPools = new Map<string, any>();

/**
 * Execute a database query or stored procedure.
 */
export async function executeDatabaseStep(
  config: DatabaseStepConfig,
  connections: Map<string, DatabaseConnection>,
  context: OrchestrationContext
): Promise<StepResult> {
  const connection = connections.get(config.connectionId);
  if (!connection) {
    throw new Error(`Database connection "${config.connectionId}" not found`);
  }

  // Resolve parameter values from context
  const resolvedParams: Record<string, unknown> = {};
  if (config.params) {
    for (const [key, expr] of Object.entries(config.params)) {
      resolvedParams[key] = resolveValue(expr, context);
    }
  }

  const startTime = Date.now();

  try {
    let rows: unknown[];

    switch (connection.type) {
      case 'postgres':
        rows = await executePostgres(connection, config, resolvedParams);
        break;
      case 'mysql':
        rows = await executeMysql(connection, config, resolvedParams);
        break;
      case 'mssql':
        rows = await executeMssql(connection, config, resolvedParams);
        break;
      default:
        throw new Error(`Unsupported database type: ${connection.type}`);
    }

    const duration = Date.now() - startTime;
    const body = config.singleRow ? (rows[0] || null) : rows;

    return {
      statusCode: 200,
      headers: {},
      body,
      duration,
    };
  } catch (error: unknown) {
    const duration = Date.now() - startTime;
    const message = error instanceof Error ? error.message : 'Database query failed';
    console.error(`[database] Error executing query on ${config.connectionId}:`, message);

    return {
      statusCode: 500,
      headers: {},
      body: { error: message },
      duration,
    };
  }
}

// ---- PostgreSQL ----

async function executePostgres(
  connection: DatabaseConnection,
  config: DatabaseStepConfig,
  params: Record<string, unknown>
): Promise<unknown[]> {
  let pool = pgPools.get(connection.id);
  if (!pool) {
    pool = new PgPool({
      host: connection.host,
      port: connection.port,
      database: connection.database,
      user: connection.username,
      password: connection.password,
      max: 10,
      ...connection.options,
    });
    pgPools.set(connection.id, pool);
  }

  if (config.procedure) {
    // Call stored procedure/function
    const paramKeys = Object.keys(params);
    const paramPlaceholders = paramKeys.map((_, i) => `$${i + 1}`).join(', ');
    const sql = `SELECT * FROM ${config.procedure}(${paramPlaceholders})`;
    const result = await pool.query(sql, paramKeys.map((k) => params[k]));
    return result.rows;
  } else if (config.query) {
    // Execute parameterised query — replace :paramName with $N
    const paramKeys: string[] = [];
    const sql = config.query.replace(/:([a-zA-Z_]\w*)/g, (_match, paramName) => {
      paramKeys.push(paramName);
      return `$${paramKeys.length}`;
    });
    const values = paramKeys.map((k) => params[k]);
    const result = await pool.query(sql, values);
    return result.rows;
  }

  return [];
}

// ---- MySQL ----

async function executeMysql(
  connection: DatabaseConnection,
  config: DatabaseStepConfig,
  params: Record<string, unknown>
): Promise<unknown[]> {
  let pool = mysqlPools.get(connection.id);
  if (!pool) {
    pool = mysql.createPool({
      host: connection.host,
      port: connection.port,
      database: connection.database,
      user: connection.username,
      password: connection.password,
      waitForConnections: true,
      connectionLimit: 10,
      ...connection.options,
    });
    mysqlPools.set(connection.id, pool);
  }

  if (config.procedure) {
    // Call stored procedure
    const paramKeys = Object.keys(params);
    const paramPlaceholders = paramKeys.map(() => '?').join(', ');
    const sql = `CALL ${config.procedure}(${paramPlaceholders})`;
    const [rows] = await pool.execute(sql, paramKeys.map((k) => params[k]) as any[]);
    return Array.isArray(rows) ? (rows as unknown[]) : [rows];
  } else if (config.query) {
    // Execute parameterised query — replace :paramName with ?
    const paramKeys: string[] = [];
    const sql = config.query.replace(/:([a-zA-Z_]\w*)/g, (_match, paramName) => {
      paramKeys.push(paramName);
      return '?';
    });
    const values = paramKeys.map((k) => params[k]) as any[];
    const [rows] = await pool.execute(sql, values);
    return Array.isArray(rows) ? (rows as unknown[]) : [rows];
  }

  return [];
}

// ---- SQL Server (MSSQL) ----

async function executeMssql(
  connection: DatabaseConnection,
  config: DatabaseStepConfig,
  params: Record<string, unknown>
): Promise<unknown[]> {
  let pool = mssqlPools.get(connection.id);
  if (!pool || !pool.connected) {
    const mssqlConfig = {
      server: connection.host,
      port: connection.port,
      database: connection.database,
      user: connection.username,
      password: connection.password,
      options: {
        encrypt: true,
        trustServerCertificate: true,
        ...(connection.options as Record<string, unknown> || {}),
      },
    };
    pool = new mssql.ConnectionPool(mssqlConfig);
    await pool.connect();
    mssqlPools.set(connection.id, pool);
  }

  const request = pool.request();

  // Add parameters to the request
  for (const [key, value] of Object.entries(params)) {
    request.input(key, value);
  }

  if (config.procedure) {
    // Execute stored procedure
    const result = await request.execute(config.procedure);
    return result.recordset || [];
  } else if (config.query) {
    // Execute parameterised query — replace :paramName with @paramName for MSSQL
    const sql = config.query.replace(/:([a-zA-Z_]\w*)/g, '@$1');
    const result = await request.query(sql);
    return result.recordset || [];
  }

  return [];
}

/**
 * Close all database connection pools (for graceful shutdown).
 */
export async function closeDatabasePools(): Promise<void> {
  for (const pool of pgPools.values()) {
    await pool.end();
  }
  pgPools.clear();

  for (const pool of mysqlPools.values()) {
    await pool.end();
  }
  mysqlPools.clear();

  for (const pool of mssqlPools.values()) {
    await pool.close();
  }
  mssqlPools.clear();
}
