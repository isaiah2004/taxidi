/**
 * Thin wrapper over the Google Routes API v2.
 *
 * Endpoint: `https://routes.googleapis.com/directions/v2:computeRoutes`. The
 * v2 API requires `X-Goog-FieldMask` on every request — there's no implicit
 * `*` — so we name the exact fields we read.
 *
 * Mode mapping (Taxidi `TransportMode` -> Routes API `travelMode`):
 *   - `car`                  -> `DRIVE`
 *   - `walk`                 -> `WALK`
 *   - `train` | `bus` | `ferry` -> `TRANSIT` (with `transitPreferences.allowedTravelModes`)
 *   - `flight`               -> bail out, use a great-circle estimate at
 *                               ~800 km/h cruise (Routes does not cover air)
 *
 * On error we log + return `null`. Callers must tolerate a missing estimate
 * gracefully — the planner agent calls this in a hot path and a flaky network
 * shouldn't break the chat.
 */

export type RouteMode = 'flight' | 'train' | 'bus' | 'car' | 'ferry' | 'walk';

export interface RouteEstimate {
  mode: RouteMode;
  durationSeconds: number;
  distanceMeters: number;
  encodedPolyline: string | null;
}

const ROUTES_URL =
  'https://routes.googleapis.com/directions/v2:computeRoutes';

const FIELD_MASK = [
  'routes.duration',
  'routes.distanceMeters',
  'routes.polyline.encodedPolyline',
].join(',');

/** ~800 km/h cruise speed in meters per second, used for flight fallback. */
const FLIGHT_CRUISE_MPS = 222;

const EARTH_RADIUS_METERS = 6_371_000;

/**
 * Haversine great-circle distance between two lat/lng points in meters.
 * Pure helper — no API call, no I/O. Accurate enough for the flight fallback
 * and for any "approximate, before we pay for a Routes call" heuristic.
 */
export function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return EARTH_RADIUS_METERS * c;
}

interface RoutesV2Route {
  /** ISO-8601 duration string e.g. `"930s"`. */
  duration?: string;
  distanceMeters?: number;
  polyline?: { encodedPolyline?: string };
}

interface RoutesV2Response {
  routes?: RoutesV2Route[];
}

/** Parse Google's "930s" duration form into a number of seconds. */
function parseDurationSeconds(value: string | undefined): number | null {
  if (typeof value !== 'string') return null;
  const m = value.match(/^(\d+(?:\.\d+)?)s$/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function travelModeFor(mode: RouteMode):
  | { travelMode: 'DRIVE' }
  | { travelMode: 'WALK' }
  | { travelMode: 'TRANSIT'; transitPreferences: { allowedTravelModes: string[] } }
  | null {
  switch (mode) {
    case 'car':
      return { travelMode: 'DRIVE' };
    case 'walk':
      return { travelMode: 'WALK' };
    case 'train':
      return {
        travelMode: 'TRANSIT',
        transitPreferences: { allowedTravelModes: ['TRAIN', 'RAIL'] },
      };
    case 'bus':
      return {
        travelMode: 'TRANSIT',
        transitPreferences: { allowedTravelModes: ['BUS'] },
      };
    case 'ferry':
      // Routes API doesn't have a dedicated ferry mode; TRANSIT covers ferry
      // service in supported regions.
      return {
        travelMode: 'TRANSIT',
        transitPreferences: { allowedTravelModes: ['TRAIN', 'BUS'] },
      };
    case 'flight':
      return null;
  }
}

/**
 * Estimate duration and distance between two points in the given mode.
 * Returns `null` if the API errors, the response is empty, or the input is
 * missing the API key. Never throws — callers can drop the estimate without
 * breaking the surrounding flow.
 */
export async function estimateRoute(input: {
  from: { lat: number; lng: number };
  to: { lat: number; lng: number };
  mode: RouteMode;
}): Promise<RouteEstimate | null> {
  const { from, to, mode } = input;

  // Flight: Routes API doesn't cover air travel. Approximate with a great-
  // circle distance + cruise speed. Polyline is null because the projection
  // isn't a useful path on the road network.
  if (mode === 'flight') {
    const distanceMeters = Math.round(haversineMeters(from, to));
    const durationSeconds = Math.max(
      60,
      Math.round(distanceMeters / FLIGHT_CRUISE_MPS),
    );
    return {
      mode,
      durationSeconds,
      distanceMeters,
      encodedPolyline: null,
    };
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    console.error(
      '[routes] GOOGLE_MAPS_API_KEY is not set — skipping route estimate.',
    );
    return null;
  }

  const travel = travelModeFor(mode);
  if (!travel) return null;

  const body: Record<string, unknown> = {
    origin: { location: { latLng: { latitude: from.lat, longitude: from.lng } } },
    destination: { location: { latLng: { latitude: to.lat, longitude: to.lng } } },
    travelMode: travel.travelMode,
  };
  if ('transitPreferences' in travel) {
    body.transitPreferences = travel.transitPreferences;
  } else if (travel.travelMode === 'DRIVE') {
    // Sensible default for car routing — `routingPreference` is required for
    // some response richness but optional here. We pick the cheaper option.
    body.routingPreference = 'TRAFFIC_UNAWARE';
  }

  let response: Response;
  try {
    response = await fetch(ROUTES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
  } catch (err) {
    console.error('[routes] network error', err);
    return null;
  }

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    console.error('[routes] API request failed', {
      status: response.status,
      body: errBody,
    });
    return null;
  }

  let data: RoutesV2Response;
  try {
    data = (await response.json()) as RoutesV2Response;
  } catch (err) {
    console.error('[routes] failed to parse response', err);
    return null;
  }

  const top = data.routes?.[0];
  if (!top) return null;

  const durationSeconds = parseDurationSeconds(top.duration);
  const distanceMeters =
    typeof top.distanceMeters === 'number' ? top.distanceMeters : null;

  if (durationSeconds === null || distanceMeters === null) return null;

  return {
    mode,
    durationSeconds,
    distanceMeters,
    encodedPolyline: top.polyline?.encodedPolyline ?? null,
  };
}
