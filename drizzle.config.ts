import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit config for Taxidi (Postgres on Cloud SQL).
 *
 * Migrations live in `db/migrations`. The schema source is `db/schema.ts`.
 * `DATABASE_URL` is expected when running `drizzle-kit` commands locally
 * (typically pointed at the Cloud SQL Auth Proxy on `127.0.0.1`).
 */
export default defineConfig({
  schema: './db/schema.ts',
  out: './db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  strict: true,
  verbose: true,
});
