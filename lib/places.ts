/**
 * Thin wrapper over the Google Places API (New, v1).
 *
 * `@googlemaps/places` is published primarily as a gRPC client that authenticates
 * via Google Application Default Credentials (a service-account JSON or ADC) —
 * not via a plain API key. Taxidi runs server-side with a single API key in
 * `GOOGLE_MAPS_API_KEY`, so we hit the v1 REST surface directly with a
 * `X-Goog-Api-Key` header. The v1 API requires `X-Goog-FieldMask` on every
 * call (no implicit `*`), which is why we set it explicitly.
 *
 * Public surface:
 *   - `resolvePlace(query)`       -> single-best-match used by the agent's
 *                                    `resolve_place` tool
 *   - `searchPlaces({ query, ... })` -> ranked list with photo + price-level
 *                                    metadata used by the place-picker UI
 *
 * Errors:
 *   - Missing `GOOGLE_MAPS_API_KEY` -> throws (configuration bug).
 *   - Network / non-OK HTTP        -> throws (transport error).
 *   - Empty result list             -> returns `null` / `[]` ("not found").
 */

const PLACES_TEXT_SEARCH_URL =
  'https://places.googleapis.com/v1/places:searchText';

const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
].join(',');

/**
 * Field mask for the richer place-picker flow. Includes rating, price level,
 * the first photo (so the UI can show a thumbnail), and the type vector so
 * we can colour / filter results client-side.
 */
const SEARCH_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.rating',
  'places.userRatingCount',
  'places.priceLevel',
  'places.websiteUri',
  'places.photos.name',
  'places.types',
].join(',');

export interface ResolvedPlace {
  placeId: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
}

export interface PlaceSearchResult {
  placeId: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  rating: number | null;
  userRatingCount: number | null;
  priceLevel: string | null;
  websiteUri: string | null;
  /** Resource name of the first photo (e.g. `places/.../photos/...`), or null. */
  photoName: string | null;
  types: string[];
}

interface PlacesV1Place {
  id?: string;
  displayName?: { text?: string; languageCode?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  rating?: number;
  userRatingCount?: number;
  priceLevel?: string;
  websiteUri?: string;
  photos?: Array<{ name?: string }>;
  types?: string[];
}

interface PlacesV1SearchTextResponse {
  places?: Array<PlacesV1Place>;
}

function getApiKey(): string {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    throw new Error(
      'GOOGLE_MAPS_API_KEY is not configured. Set it in the server environment.',
    );
  }
  return key;
}

/**
 * Performs a Places API (New) Text Search and returns the first match,
 * normalized to the fields Taxidi cares about. Returns `null` when the API
 * returns no candidates. Throws on missing API key or transport errors so
 * callers can surface a real error instead of silently treating it as
 * "not found".
 */
export async function resolvePlace(
  query: string,
): Promise<ResolvedPlace | null> {
  const trimmed = query.trim();
  if (!trimmed) return null;

  const apiKey = getApiKey();

  const response = await fetch(PLACES_TEXT_SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': FIELD_MASK,
    },
    body: JSON.stringify({ textQuery: trimmed }),
    // Server-only call: never let Next's fetch cache linger across requests
    // — the same query may surface different top picks over time.
    cache: 'no-store',
  });

  if (!response.ok) {
    // Log the full body server-side for debugging, but don't surface it in
    // the thrown error — Google's error responses can include request IDs,
    // quota info, and key fingerprints that shouldn't leak to callers.
    const body = await response.text().catch(() => '');
    if (body) {
      console.error('[places] API request failed', {
        status: response.status,
        body,
      });
    }
    throw new Error(
      `Places API request failed: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as PlacesV1SearchTextResponse;
  const top = data.places?.[0];

  if (
    !top ||
    !top.id ||
    typeof top.location?.latitude !== 'number' ||
    typeof top.location?.longitude !== 'number'
  ) {
    return null;
  }

  return {
    placeId: top.id,
    name: top.displayName?.text ?? top.formattedAddress ?? trimmed,
    address: top.formattedAddress ?? '',
    lat: top.location.latitude,
    lng: top.location.longitude,
  };
}

/**
 * Bias circle for the v1 `searchText` endpoint. Defaults to a 50km radius
 * which covers a typical metro area without dragging in irrelevant
 * cross-country results.
 */
const DEFAULT_NEAR_RADIUS_METERS = 50_000;

/**
 * Free-form Places search returning a ranked list of matches with the
 * thumbnail / price / rating fields the place-picker UI needs. Returns an
 * empty array when there are no candidates; throws on missing API key or
 * transport errors.
 *
 * `near` adds a `locationBias` circle so e.g. "coffee" near a known city
 * returns local matches first. `type` (e.g. `'restaurant'`, `'lodging'`)
 * narrows by Places primary type. `limit` caps the number of results
 * returned to the UI; the API always returns at most 20 per request.
 */
export async function searchPlaces(opts: {
  query: string;
  near?: { lat: number; lng: number; radiusMeters?: number };
  type?: string;
  limit?: number;
}): Promise<PlaceSearchResult[]> {
  const trimmed = opts.query.trim();
  if (!trimmed) return [];

  const apiKey = getApiKey();
  const limit = Math.max(1, Math.min(opts.limit ?? 5, 20));

  type SearchTextRequestBody = {
    textQuery: string;
    pageSize?: number;
    includedType?: string;
    locationBias?: {
      circle: {
        center: { latitude: number; longitude: number };
        radius: number;
      };
    };
  };

  const body: SearchTextRequestBody = {
    textQuery: trimmed,
    pageSize: limit,
  };
  if (opts.type) {
    body.includedType = opts.type;
  }
  if (opts.near) {
    body.locationBias = {
      circle: {
        center: { latitude: opts.near.lat, longitude: opts.near.lng },
        radius: opts.near.radiusMeters ?? DEFAULT_NEAR_RADIUS_METERS,
      },
    };
  }

  const response = await fetch(PLACES_TEXT_SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': SEARCH_FIELD_MASK,
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    if (errBody) {
      console.error('[places] search request failed', {
        status: response.status,
        body: errBody,
      });
    }
    throw new Error(
      `Places API request failed: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as PlacesV1SearchTextResponse;
  const places = data.places ?? [];

  const out: PlaceSearchResult[] = [];
  for (const p of places) {
    if (
      !p.id ||
      typeof p.location?.latitude !== 'number' ||
      typeof p.location?.longitude !== 'number'
    ) {
      continue;
    }
    out.push({
      placeId: p.id,
      name: p.displayName?.text ?? p.formattedAddress ?? trimmed,
      address: p.formattedAddress ?? '',
      lat: p.location.latitude,
      lng: p.location.longitude,
      rating: typeof p.rating === 'number' ? p.rating : null,
      userRatingCount:
        typeof p.userRatingCount === 'number' ? p.userRatingCount : null,
      priceLevel: typeof p.priceLevel === 'string' ? p.priceLevel : null,
      websiteUri: typeof p.websiteUri === 'string' ? p.websiteUri : null,
      photoName: p.photos?.[0]?.name ?? null,
      types: Array.isArray(p.types) ? p.types : [],
    });
    if (out.length >= limit) break;
  }
  return out;
}
