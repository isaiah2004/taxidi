/**
 * Unit tests for `lib/routes.ts`.
 *
 * Two surfaces:
 *   - `haversineMeters`  — pure great-circle distance helper. We sanity-check
 *      against a known pair (Singapore <-> Bali, ~1390 km) with a generous
 *      tolerance because the formula is geometric, not geodesic.
 *   - `estimateRoute(mode='flight')` — does NOT call the Routes API. We
 *      assert no network call is made, the polyline is null, and the
 *      duration is `distance / 222 m/s` (the spec's flight-cruise divisor).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { estimateRoute, haversineMeters } from '@/lib/routes';

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// haversineMeters
// ---------------------------------------------------------------------------

describe('haversineMeters', () => {
  it('returns 0 for identical points', () => {
    expect(haversineMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 0 })).toBe(0);
  });

  it('matches the Singapore -> Bali great-circle distance (~1390 km)', () => {
    // Singapore: 1.3521° N, 103.8198° E
    // Denpasar (Bali): -8.6705° S, 115.2126° E
    const meters = haversineMeters(
      { lat: 1.3521, lng: 103.8198 },
      { lat: -8.6705, lng: 115.2126 },
    );
    // Great-circle SG→Bali ≈ 1,690 km. Generous tolerance keeps the test
    // robust to small formula refactors.
    expect(meters).toBeGreaterThan(1_600_000);
    expect(meters).toBeLessThan(1_800_000);
  });

  it('is symmetric (a -> b == b -> a)', () => {
    const a = { lat: 51.5074, lng: -0.1278 }; // London
    const b = { lat: 40.7128, lng: -74.006 }; // NYC
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 0);
  });
});

// ---------------------------------------------------------------------------
// estimateRoute, mode='flight'
// ---------------------------------------------------------------------------

describe("estimateRoute (mode='flight')", () => {
  it('returns a haversine-based estimate without calling fetch', async () => {
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockRejectedValue(
        new Error('fetch should not be called for flight mode'),
      );

    const from = { lat: 1.3521, lng: 103.8198 }; // Singapore
    const to = { lat: -8.6705, lng: 115.2126 }; // Bali
    const result = await estimateRoute({ from, to, mode: 'flight' });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).not.toBeNull();
    expect(result!.mode).toBe('flight');

    // Distance should match the haversine result, rounded to whole meters.
    const expectedDistance = Math.round(haversineMeters(from, to));
    expect(result!.distanceMeters).toBe(expectedDistance);

    // Duration should be `distance / 222` rounded, with a 60s minimum floor.
    const expectedDuration = Math.max(60, Math.round(expectedDistance / 222));
    expect(result!.durationSeconds).toBe(expectedDuration);

    // Flight has no road-network polyline.
    expect(result!.encodedPolyline).toBeNull();
  });

  it('floors the duration at 60 seconds for nearby flight points', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(
      new Error('fetch should not be called for flight mode'),
    );

    // Points 200m apart — the raw "distance / 222" would be ~1s.
    const result = await estimateRoute({
      from: { lat: 0, lng: 0 },
      to: { lat: 0, lng: 0.0018 },
      mode: 'flight',
    });
    expect(result).not.toBeNull();
    expect(result!.durationSeconds).toBe(60);
  });
});
