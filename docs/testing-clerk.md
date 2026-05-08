# Testing Clerk-protected flows

Taxidi's sign-in page is protected by Cloudflare Turnstile, Clerk's default bot
shield. Turnstile fingerprints the browser, blocks headless / automated agents,
and silently fails the challenge for tools like Chrome DevTools MCP and
Playwright. The result: you can't drive sign-in from a test or an MCP session
without a bypass.

Clerk ships two official bypass primitives — both implemented in
`lib/test/clerk-helpers.ts`.

## Bypass primitives

| Primitive       | URL param                | What it does                                      | Lifetime |
| --------------- | ------------------------ | ------------------------------------------------- | -------- |
| Testing token   | `__clerk_testing_token`  | Skips Turnstile / bot protection on the frontend  | ~1 hour  |
| Sign-in ticket  | `__clerk_ticket`         | Signs the user in without password / OTP prompts  | ~30 sec  |

Both are minted from the Clerk Backend API at `https://api.clerk.com/v1/`
with your `CLERK_SECRET_KEY` (point it at a **development** instance — never
production).

## Test-only email + OTP shortcuts

- Any email matching `*+clerk_test@example.com` is a magic test address; Clerk
  doesn't actually send mail to it.
- The verification code `424242` is always accepted in dev for OTP flows on
  test addresses.

## Helpers

```ts
import {
  createTestUser,
  createSignInTicket,
  getTestingToken,
  buildSignInUrl,
  deleteTestUser,
} from '@/lib/test/clerk-helpers';
```

All five are pure Node — no Vitest dependency — so they work from a Vitest
test, a `tsx` script, or a Chrome DevTools MCP session.

## Example: Vitest + Chrome DevTools MCP

```ts
const user = await createTestUser({ emailLocal: 'demo' });
const ticket = await createSignInTicket(user.userId);
const testingToken = (await getTestingToken()).token;

const url = buildSignInUrl({
  baseUrl: 'http://localhost:3000',
  ticket: ticket.token,
  testingToken,
});

// From an MCP session: navigate the page directly to `url`. Clerk consumes the
// `__clerk_ticket` param, completes sign-in, and redirects to the app.
//   await mcp__chrome_devtools__navigate_page({ url });

// Cleanup once the test is done.
await deleteTestUser(user.userId);
```

## Operational notes

- **Never ship test users to production.** Run helpers only against a Clerk
  dev/staging instance. The integration test in `tests/integration/` is
  skipped by default and gated by `CLERK_INTEGRATION_TEST=1`.
- Tickets are single-use and expire in ~30 seconds — mint one per sign-in.
- `CLERK_SECRET_KEY` must start with `sk_test_` for these helpers; the
  Backend API will reject `sk_live_` for testing-token / sign-in-token routes
  on most plans, and you don't want to leak the live key into a test harness.
- `deleteTestUser` is best-effort cleanup — Clerk will also auto-purge inactive
  test users, but explicit deletes keep the dashboard clean.
