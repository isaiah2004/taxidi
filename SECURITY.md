# Security

This document captures the security posture of Taxidi: what we defend
against, how, and what an operator must verify before pushing to
production. It is intentionally short — security checklists that nobody
reads protect nothing.

## Threat model

Taxidi is a multi-user, collaborative trip-planning app with an AI agent
that writes to a shared graph. Risks worth thinking about:

1. **Cross-tenant data access.** A user reading or mutating another
   user's trip book, variant, proposal, or chat history.
2. **Variant tampering.** A trip-book member overwriting someone else's
   variant or proposing on behalf of another member.
3. **Agent prompt injection.** A user (or content embedded in a place
   listing) coercing the planner / merge agent into doing something it
   shouldn't — running shell, exfiltrating data, mutating an unrelated
   trip.
4. **Information leakage in errors.** DB rows, stack traces, or env
   values bleeding out via 500 responses.
5. **Malicious form values.** Oversized strings, junk JSON, NaNs,
   prototype pollution attempts in mutation bodies.
6. **SSRF via web tools.** The agent fetching internal URLs or
   metadata-service endpoints because a malicious tool input asked it
   to.
7. **Session hijacking / clickjacking.** Standard browser-side risks if
   the app is iframed or HTTPS is downgraded.
8. **Lost-update races.** Two members or an agent + a member editing
   the same node concurrently and losing one of the edits.

## Mitigations

### Authentication and authorization

- **Clerk session** is the source of identity for all server code.
  `getCurrentUserId()` (`lib/auth.ts`) is the single entry point;
  Route Handlers, Server Actions, and Server Components call it at
  the top of the function and throw `UnauthenticatedError` (401)
  otherwise.
- **Per-trip membership table** (`db/schema.ts: membership`) gates
  data access. `requireMembership(tripBookId, userId)` is called
  before any DB read or write that could leak data; without an
  active row the helper throws `ForbiddenError` (403).
- **Owner-only endpoints** (e.g. `merge`, `commit`) additionally
  call `isOwner(tripBookId, userId)` and return 403 to non-owners
  even if they're members.
- **Variant-owner endpoints** (node POST/PATCH/DELETE, propose)
  verify `variant.ownerUserId === userId` so members can't tamper
  with each other's variants.
- **Pusher channels** are server-signed via `/api/pusher/auth`
  which itself runs the same `requireMembership` check. Clients
  cannot subscribe to a private channel without a valid signature.

### Input validation

- Every Route Handler runs its body through a **Zod schema**
  (`safeParse`). On failure the response is `400 { error: 'Invalid
  request', details: [{ path, message }] }` — we strip Zod's
  internal tree so we don't echo back the parser's structure.
- Path parameters (`tripBookId`, `variantId`, `proposalId`,
  `originId`) are validated as UUIDs (or as the literal token
  `mine` for variant ids on first-load convenience) **before** any
  DB call. This avoids 500-by-malformed-UUID and removes the
  not-found oracle for malformed ids.
- String fields are length-capped: `title <= 200`, `notes <= 2000`,
  `address <= 500`, `placeId <= 256`, `originId <= 64`, agent
  instructions <= 2000, commit messages <= 500. These mirror the
  DB column lengths and keep payload-DoS costs bounded.
- `Permissions-Policy`, etc. — see [Security headers](#security-headers).

### SQL injection

- All queries go through **Drizzle ORM**, which parameterizes
  values. We do not concatenate user input into SQL anywhere. The
  one `sql` template usage (`version + 1` in PATCH/DELETE) only
  references the column object, not request data.

### Prompt injection / agent abuse

- **Tools are allow-listed**: the planner and merge agents only
  have access to the tools registered with the AI SDK. There is no
  shell, no `eval`, no arbitrary `fetch`. Each tool has a Zod
  input schema that the SDK enforces.
- **No untrusted code execution**: agents do not run user-supplied
  code. The merge agent applies a finite set of structural ops to
  the snapshot.
- **Context isolation**: each agent run is scoped to a single
  `tripBookId` + `variantId`; tools that read/write state do so
  through helpers that ignore identifiers outside that scope.
- **Owner gate on commit**: even if an agent went rogue inside a
  merge run, the proposed snapshot is shown to the owner for
  review before `/commit` writes a new `main_version`. The agent
  cannot commit on its own.

### Concurrency

- **Optimistic locking** on `node.version`: PATCH/DELETE include
  `eq(node.version, expectedVersion)` in the `WHERE`; a zero-row
  update returns 409 with the current version so the client can
  re-fetch and retry.
- **Fork-safe main pointer**: `main_version (trip_book_id,
  parent_version_id)` is `UNIQUE`, so two concurrent commits race
  for the slot and only one wins; the loser gets 409.
- **Frozen merge input**: `merge_proposal.variantSnapshot` is
  stored as JSONB at proposal time. The member can keep editing
  their variant after proposing without changing what the merge
  agent sees, and the owner reviews against a stable input.

### Secrets and env

- **Secret Manager** holds prod credentials (Clerk, Google, DB,
  Pusher) and Cloud Run pulls them at boot. Versions are pinned so
  a Secret Manager rotate does not silently change behavior in
  prod without a redeploy.
- **`.env*` files are git-ignored**. CI does not log env values.
- **`GOOGLE_MAPS_API_KEY`** is restricted by IP at the server
  (Cloud Run egress) and by HTTP referrer for the browser key.

### Image and remote-resource policy

- `next.config.ts` `images.remotePatterns` allow-lists only
  `**.googleusercontent.com` and `**.gstatic.com` so we cannot be
  tricked into proxying arbitrary remote images.

### Security headers

`next.config.ts` returns these on every path:

| Header | Value | Why |
|---|---|---|
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` | Force HTTPS for two years on us and every subdomain. |
| `X-Content-Type-Options` | `nosniff` | Block MIME-sniff XSS. |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Don't leak full URLs to off-site links. |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(self)` | Deny camera/mic; allow geolocation only on same origin (used by the trip planner map). |
| `X-Frame-Options` | `DENY` | Defense-in-depth against clickjacking. |

Content-Security-Policy is intentionally **not** set yet — Clerk
and Pusher inject inline scripts that need careful nonce/hash
configuration. Adding CSP is a tracked TODO.

## DISABLE_AUTH (DEV-ONLY)

`lib/auth.ts` honors a `DISABLE_AUTH=true` environment variable that
short-circuits both `getCurrentUserId` and `requireMembership` to a
fixed `dev-user`. This exists ONLY so contributors can run the dev
server and the integration tests without standing up a Clerk session.

When the flag is active, the module prints

    [auth] DISABLE_AUTH=true — auth checks are bypassed. Never set this in production.

at module-load (server start). If this line ever appears in a
production log, treat it as a P1 incident: every endpoint is
unauthenticated, every member of every trip book is reachable.

**This flag MUST be unset in production deploys.** The production
checklist below verifies that.

## Production deploy checklist

Run through this **before** promoting a build to the public-facing
Cloud Run service:

- [ ] **Confirm `DISABLE_AUTH` is unset** in the Cloud Run service env.
      `gcloud run services describe taxidi --format='value(spec.template.spec.containers[0].env)' | grep -i disable_auth`
      should return nothing. Watch the boot logs for the
      `[auth] DISABLE_AUTH=true` warning — if it appears, the deploy
      is unsafe.
- [ ] **Rotate Clerk + Google API keys** to the prod set; verify the
      Clerk dashboard's allowed origins list does not include the
      preview domain.
- [ ] **Pin Secret Manager versions** for every secret. `latest` is
      forbidden in prod.
- [ ] **Restrict `GOOGLE_MAPS_API_KEY`**: server key restricted by
      Cloud Run egress IP; browser key restricted by HTTP referrer
      to the prod domain.
- [ ] **Verify HSTS reaches the browser** by curl-ing the prod URL
      and checking `Strict-Transport-Security` is present.
- [ ] **Verify `next.config.ts` security headers** apply on all
      paths via the same curl.
- [ ] **Database**: confirm Cloud SQL only accepts connections from
      the Cloud Run service account; no public IP.
- [ ] **Future**: enable Cloud Armor / WAF in front of the load
      balancer once the abuse rate justifies it.

## Reporting

Security issues should be emailed privately to the maintainer
listed in the repo's profile. Please do not file public GitHub
issues for vulnerabilities.
