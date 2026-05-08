import { dbInstanceConnectionName, dbMode, pool } from '@/lib/db';

/**
 * Deployment health probe. Runs `SELECT 1` against the pool so we can verify
 * Cloud Run is connected to Cloud SQL via the expected mode (Unix socket in
 * prod, TCP via Cloud SQL Auth Proxy in dev). Intentionally not auth-gated.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface HealthResponse {
  status: 'ok' | 'error';
  db: 'up' | 'down';
  mode: typeof dbMode;
  instanceConfigured: boolean;
  error?: string;
}

export async function GET(): Promise<Response> {
  // Don't surface the literal Cloud SQL instance connection name on a public,
  // unauthenticated probe — it's not strictly secret, but advertising the
  // exact `project:region:instance` triple narrows reconnaissance for free.
  const base = {
    mode: dbMode,
    instanceConfigured: Boolean(dbInstanceConnectionName),
  } as const;

  try {
    await pool.query('SELECT 1');
    const body: HealthResponse = {
      status: 'ok',
      db: 'up',
      ...base,
    };
    return Response.json(body);
  } catch (err) {
    const body: HealthResponse = {
      status: 'error',
      db: 'down',
      ...base,
      error: err instanceof Error ? err.message : 'unknown error',
    };
    return Response.json(body, { status: 503 });
  }
}
