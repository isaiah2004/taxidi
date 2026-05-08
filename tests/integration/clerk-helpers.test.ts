/**
 * Integration tests for `lib/test/clerk-helpers.ts`.
 *
 * SKIPPED BY DEFAULT. These tests hit the live Clerk Backend API and create
 * (then delete) a real dummy user, so they require a valid `CLERK_SECRET_KEY`
 * pointed at a development / staging Clerk instance.
 *
 *   To enable:
 *     CLERK_INTEGRATION_TEST=1 pnpm test:run
 *
 *   On Windows PowerShell:
 *     $env:CLERK_INTEGRATION_TEST = '1'; pnpm test:run
 *
 * Never run these against a production Clerk key — they create users and a
 * sign-in ticket. Always sanity-check `CLERK_SECRET_KEY` is `sk_test_...`
 * before turning the flag on.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createSignInTicket,
  createTestUser,
  deleteTestUser,
  getTestingToken,
  type TestUser,
} from '@/lib/test/clerk-helpers';

const integrationEnabled = Boolean(process.env.CLERK_INTEGRATION_TEST);

// `describe.skipIf` keeps the suite OFF unless the flag is set. Using a guarded
// `describe` instead of `describe.skip` so the test plan is still discoverable
// in the test runner's tree view.
describe.skipIf(!integrationEnabled)('clerk-helpers (integration)', () => {
  let user: TestUser | null = null;

  beforeAll(() => {
    if (!process.env.CLERK_SECRET_KEY) {
      throw new Error(
        'CLERK_SECRET_KEY must be set when CLERK_INTEGRATION_TEST=1.',
      );
    }
  });

  afterAll(async () => {
    if (user) {
      await deleteTestUser(user.userId);
    }
  });

  it('getTestingToken returns a non-empty token', async () => {
    const result = await getTestingToken();
    expect(result.token).toBeTypeOf('string');
    expect(result.token.length).toBeGreaterThan(0);
    expect(result.expiresAt).toBeTypeOf('number');
  });

  it('createTestUser + deleteTestUser round-trip', async () => {
    user = await createTestUser({ emailLocal: `vitest-${Date.now()}` });
    expect(user.userId).toMatch(/^user_/);
    expect(user.emailAddress).toMatch(/\+clerk_test@example\.com$/);
    expect(user.password).toBeTypeOf('string');
    // `afterAll` will exercise `deleteTestUser` for the cleanup path.
  });

  it('createSignInTicket returns a JWT-shaped token', async () => {
    if (!user) {
      // The previous test should have populated `user`; if it didn't, fail
      // loudly rather than silently skipping.
      throw new Error(
        'Expected a test user from the previous test; check earlier failures.',
      );
    }
    const ticket = await createSignInTicket(user.userId);
    expect(ticket.token).toBeTypeOf('string');
    // JWT shape: three base64url-ish segments separated by dots.
    expect(ticket.token.split('.')).toHaveLength(3);
    expect(ticket.expiresAt).toBeTypeOf('number');
  });
});
