import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Membership } from '@/db/schema';

// `vi.mock` is hoisted above all imports, so any variables it references must
// also be hoisted via `vi.hoisted`. This builds a chainable stub for the
// Drizzle `db.select().from().where().limit()` pattern; the terminal
// `.limit()` resolves to whatever rows we feed it from each test.
const { limitMock, whereMock, fromMock, selectMock } = vi.hoisted(() => {
  const limitMock = vi.fn();
  const whereMock = vi.fn(() => ({ limit: limitMock }));
  const fromMock = vi.fn(() => ({ where: whereMock }));
  const selectMock = vi.fn(() => ({ from: fromMock }));
  return { limitMock, whereMock, fromMock, selectMock };
});

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    select: selectMock,
  },
}));

import { auth } from '@clerk/nextjs/server';
import {
  ForbiddenError,
  UnauthenticatedError,
  getCurrentUserId,
  requireMembership,
} from '@/lib/auth';

const authMock = vi.mocked(auth);

afterEach(() => {
  authMock.mockReset();
  limitMock.mockReset();
  whereMock.mockClear();
  fromMock.mockClear();
  selectMock.mockClear();
});

const activeRow: Membership = {
  tripBookId: 'tb-1',
  userId: 'user-1',
  role: 'member',
  status: 'active',
  invitedByUserId: null,
  invitationToken: null,
  joinedAt: new Date('2026-01-01T00:00:00Z'),
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

describe('getCurrentUserId', () => {
  it('throws UnauthenticatedError (status 401) when Clerk has no session', async () => {
    authMock.mockResolvedValue({ userId: null } as Awaited<
      ReturnType<typeof auth>
    >);

    const promise = getCurrentUserId();
    await expect(promise).rejects.toBeInstanceOf(UnauthenticatedError);
    // 401 must round-trip so callers can map it to a Response.
    await expect(promise).rejects.toMatchObject({ status: 401 });
  });

  it('returns the Clerk userId when authenticated', async () => {
    authMock.mockResolvedValue({ userId: 'user-1' } as Awaited<
      ReturnType<typeof auth>
    >);

    await expect(getCurrentUserId()).resolves.toBe('user-1');
  });
});

describe('requireMembership', () => {
  it('throws ForbiddenError when no row exists', async () => {
    limitMock.mockResolvedValueOnce([]);

    await expect(requireMembership('tb-1', 'user-1')).rejects.toMatchObject({
      // 403 specifically (not generic 500) so handlers don't accidentally
      // leak that the user is logged in but unauthorized vs. not logged in.
      status: 403,
      message: 'Not a member of this trip book',
    });
    expect(selectMock).toHaveBeenCalledOnce();
  });

  it('throws ForbiddenError when membership is not active', async () => {
    limitMock.mockResolvedValueOnce([
      { ...activeRow, status: 'invited' satisfies Membership['status'] },
    ]);

    const promise = requireMembership('tb-1', 'user-1');
    await expect(promise).rejects.toBeInstanceOf(ForbiddenError);
    await expect(promise).rejects.toMatchObject({
      message: 'Membership is not active',
    });
  });

  it('returns the row when membership is active', async () => {
    limitMock.mockResolvedValueOnce([activeRow]);

    await expect(requireMembership('tb-1', 'user-1')).resolves.toEqual(
      activeRow,
    );
  });
});
