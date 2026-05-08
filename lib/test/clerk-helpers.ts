/**
 * Clerk test-helper library for Taxidi.
 *
 * Programmatically signs in Clerk dummy users via the Clerk Backend API and
 * sign-in tickets — bypassing Cloudflare Turnstile bot protection that breaks
 * browser-automation testing (Chrome DevTools MCP, Playwright, etc.).
 *
 * Usage outline:
 *
 *   1. `getTestingToken()`         -> short-lived `__clerk_testing_token` URL param
 *   2. `createTestUser({ ... })`   -> creates a `+clerk_test@example.com` user
 *   3. `createSignInTicket(id)`    -> short-lived `__clerk_ticket` URL param
 *   4. `buildSignInUrl({ ... })`   -> stitches both params onto `${baseUrl}/sign-in`
 *   5. (in test cleanup) `deleteTestUser(id)`
 *
 * All functions hit `https://api.clerk.com/v1/` directly and read
 * `CLERK_SECRET_KEY` from `process.env`. They have no Vitest dependency, so
 * you can also call them from a Chrome DevTools MCP session, a `tsx` REPL, or
 * any plain Node script.
 *
 * Never log the secret key. Never reuse production Clerk keys here — point
 * `CLERK_SECRET_KEY` at a development/staging Clerk instance.
 */

const CLERK_API_BASE = 'https://api.clerk.com/v1';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A test user created through the Backend API. The password is returned so
 *  callers can also use credential-based sign-in flows in addition to the
 *  ticket flow. */
export type TestUser = {
  userId: string;
  emailAddress: string;
  password: string;
};

/** A sign-in ticket. `expiresAt` is a Unix epoch in seconds (Clerk's wire
 *  format). Tickets are single-use and short-lived (~30s by default). */
export type SignInTicket = {
  token: string;
  expiresAt: number;
};

/** A testing token for bypassing Turnstile / bot protection on the frontend.
 *  `expiresAt` is a Unix epoch in seconds. Tokens are short-lived (~1h). */
export type TestingToken = {
  token: string;
  expiresAt: number;
};

/** Optional inputs to `createTestUser`. */
export type CreateTestUserOptions = {
  /** Local-part of the email; will be combined into
   *  `<emailLocal>+clerk_test@example.com`. Defaults to a timestamped value. */
  emailLocal?: string;
  /** Plain-text password to assign to the user. Defaults to a generated value. */
  password?: string;
};

/** Inputs for `buildSignInUrl`. Both query params are optional but recommended:
 *  the ticket signs the user in; the testing token bypasses Turnstile. */
export type BuildSignInUrlOptions = {
  baseUrl: string;
  ticket?: string;
  testingToken?: string;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Reads `CLERK_SECRET_KEY` from the environment, throwing a clear error if
 *  it is missing or empty. The secret itself is never returned in error
 *  messages. */
function getClerkSecretKey(): string {
  const key = process.env.CLERK_SECRET_KEY;
  if (!key) {
    throw new Error(
      'CLERK_SECRET_KEY is not set. Add it to .env.local (point it at a ' +
        'development Clerk instance, never production) before using ' +
        'lib/test/clerk-helpers.ts.',
    );
  }
  return key;
}

/** Thin wrapper around `fetch` that targets the Clerk Backend API and surfaces
 *  non-2xx responses as informative errors without leaking the bearer token. */
async function clerkFetch<T>(
  path: string,
  init: { method: string; body?: unknown },
): Promise<T> {
  const secret = getClerkSecretKey();
  const url = `${CLERK_API_BASE}${path}`;
  const response = await fetch(url, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  if (!response.ok) {
    let detail = '';
    try {
      detail = await response.text();
    } catch {
      // ignore — we'll report status alone
    }
    throw new Error(
      `Clerk API ${init.method} ${path} failed: ${response.status} ${response.statusText}${
        detail ? ` — ${detail}` : ''
      }`,
    );
  }

  // 204 No Content (e.g. on DELETE) returns an empty body.
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

/** Generate a reasonably-strong throwaway password for a test user. */
function generateTestPassword(): string {
  // Two random chunks plus a fixed-but-safe suffix that satisfies the default
  // Clerk password policy (length, mixed case, digit, symbol). We bypass policy
  // anyway via `skip_password_checks: true`, but a real password keeps the
  // sign-in fallback flows working.
  const chunk = () =>
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 10).toUpperCase();
  return `${chunk()}-Test!9`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a Clerk dummy user via the Backend API.
 *
 * Uses Clerk's `+clerk_test@example.com` magic-email pattern so the user can
 * be deterministically signed in from automated tests without sending real
 * verification emails. The password is also returned so callers can drive
 * credential-based flows as well.
 */
export async function createTestUser(
  options: CreateTestUserOptions = {},
): Promise<TestUser> {
  const local = options.emailLocal ?? `taxidi-test-${Date.now()}`;
  const emailAddress = `${local}+clerk_test@example.com`;
  const password = options.password ?? generateTestPassword();

  type CreateUserResponse = {
    id: string;
    email_addresses?: Array<{ email_address: string }>;
  };

  const user = await clerkFetch<CreateUserResponse>('/users', {
    method: 'POST',
    body: {
      email_address: [emailAddress],
      password,
      skip_password_checks: true,
    },
  });

  return {
    userId: user.id,
    emailAddress: user.email_addresses?.[0]?.email_address ?? emailAddress,
    password,
  };
}

/**
 * Mint a one-shot sign-in ticket for the given user. Pass the returned `token`
 * as the `__clerk_ticket` URL param on `/sign-in` to complete sign-in without
 * a password prompt and without going through Turnstile.
 */
export async function createSignInTicket(userId: string): Promise<SignInTicket> {
  type CreateSignInTokenResponse = {
    token: string;
    expires_at: number;
  };

  const result = await clerkFetch<CreateSignInTokenResponse>(
    '/sign_in_tokens',
    {
      method: 'POST',
      body: { user_id: userId },
    },
  );

  return { token: result.token, expiresAt: result.expires_at };
}

/**
 * Mint a testing token — passes the `__clerk_testing_token` URL param to skip
 * Cloudflare Turnstile / bot protection in development environments. Required
 * for any browser-automation flow (Chrome DevTools MCP, Playwright, ...).
 */
export async function getTestingToken(): Promise<TestingToken> {
  type CreateTestingTokenResponse = {
    token: string;
    expires_at: number;
  };

  const result = await clerkFetch<CreateTestingTokenResponse>(
    '/testing_tokens',
    {
      method: 'POST',
    },
  );

  return { token: result.token, expiresAt: result.expires_at };
}

/**
 * Build a `${baseUrl}/sign-in` URL with the testing-token and sign-in-ticket
 * URL params attached. Both params are optional but you almost always want
 * both: the testing token bypasses Turnstile, the ticket completes sign-in.
 */
export function buildSignInUrl(options: BuildSignInUrlOptions): string {
  const params = new URLSearchParams();
  if (options.testingToken) {
    params.set('__clerk_testing_token', options.testingToken);
  }
  if (options.ticket) {
    params.set('__clerk_ticket', options.ticket);
  }
  const trimmed = options.baseUrl.replace(/\/+$/, '');
  const query = params.toString();
  return query ? `${trimmed}/sign-in?${query}` : `${trimmed}/sign-in`;
}

/**
 * Delete a test user by id. Use this in test cleanup (e.g. `afterAll`) so
 * dummy users don't pile up in the Clerk dashboard.
 */
export async function deleteTestUser(userId: string): Promise<void> {
  await clerkFetch<void>(`/users/${userId}`, { method: 'DELETE' });
}
