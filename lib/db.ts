import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';

import * as schema from '@/db/schema';

/**
 * Single shared `pg.Pool` + Drizzle instance for the Cloud Run process.
 *
 * Two connection modes are supported and selected via env:
 *
 * 1. **Cloud Run (production)** — set `INSTANCE_CONNECTION_NAME`, leave
 *    `DB_HOST` unset. We connect over the Unix socket Cloud Run mounts at
 *    `/cloudsql/${INSTANCE_CONNECTION_NAME}`. No SSL config: the socket is
 *    a local UDS, not TCP. The Cloud Run service must be deployed with
 *    `--add-cloudsql-instances=<connection-name>` and the runtime service
 *    account must have `roles/cloudsql.client`. There is no JSON key file:
 *    auth is via the runtime SA, brokered by the Cloud SQL connector that
 *    Cloud Run injects when `--add-cloudsql-instances` is set.
 *
 * 2. **Local dev / Cloud SQL Auth Proxy** — set `DB_HOST` (typically
 *    `127.0.0.1`) and `DB_PORT`. We connect TCP; SSL is disabled because
 *    the proxy upgrades the connection itself.
 *
 * Pool sizing: Cloud Run instances are small (1 vCPU, ~512MiB) and the
 * agent endpoints are mostly IO-bound, so 10 connections per instance with
 * a 30s idle timeout is plenty. Connection acquisition is bounded at 10s
 * so a stuck pool fails fast rather than hanging the request.
 */

type DbMode = 'socket' | 'tcp';

interface ResolvedConfig {
  poolConfig: PoolConfig;
  mode: DbMode;
  instance: string | null;
}

// Pool sizing: kept low so total connections stay below Cloud SQL's
// `max_connections` ceiling. With Cloud Run `--concurrency=80
// --max-instances=10`, max=5 caps us at ~50 in-app connections, leaving
// headroom for migrations, Drizzle Studio, and admin sessions.
const POOL_DEFAULTS: Pick<
  PoolConfig,
  'max' | 'idleTimeoutMillis' | 'connectionTimeoutMillis'
> = {
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
};

function resolveConfig(): ResolvedConfig {
  const instance = process.env.INSTANCE_CONNECTION_NAME?.trim() || null;
  const dbHost = process.env.DB_HOST?.trim() || null;
  const database = process.env.DB_NAME ?? '';
  const user = process.env.DB_USER ?? '';
  const password = process.env.DB_PASSWORD ?? '';

  // Cloud Run / Cloud SQL Unix socket — preferred when available and the
  // dev override (`DB_HOST`) is not set.
  if (instance && !dbHost) {
    return {
      mode: 'socket',
      instance,
      poolConfig: {
        ...POOL_DEFAULTS,
        host: `/cloudsql/${instance}`,
        user,
        password,
        database,
        // No `port` and no `ssl`: this is a Unix domain socket.
      },
    };
  }

  // Local dev via Cloud SQL Auth Proxy (or direct TCP, not recommended).
  const port = Number.parseInt(process.env.DB_PORT ?? '5432', 10);

  return {
    mode: 'tcp',
    instance,
    poolConfig: {
      ...POOL_DEFAULTS,
      host: dbHost ?? '127.0.0.1',
      port: Number.isFinite(port) ? port : 5432,
      user,
      password,
      database,
      ssl: false,
    },
  };
}

const resolved = resolveConfig();

export const dbMode: DbMode = resolved.mode;
export const dbInstanceConnectionName: string | null = resolved.instance;

export const pool = new Pool(resolved.poolConfig);

// Surface unexpected idle-client errors instead of swallowing them; never log
// the connection config (it carries credentials).
pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});

export const db = drizzle(pool, { schema });

// Cloud Run sends SIGTERM ahead of instance shutdown; closing the pool lets
// in-flight queries drain rather than getting torn down mid-statement.
// Guarded so re-imports during `next dev` don't pile up listeners.
declare global {
  var __taxidi_db_sigterm_attached__: boolean | undefined;
}

if (!globalThis.__taxidi_db_sigterm_attached__) {
  globalThis.__taxidi_db_sigterm_attached__ = true;
  const shutdown = (signal: string) => {
    console.log(`[db] ${signal} received, closing pool`);
    pool
      .end()
      .catch((err) =>
        console.error('[db] error while closing pool:', err.message),
      );
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

export type Db = typeof db;
