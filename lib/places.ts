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
 * Only `resolvePlace(query)` is exposed for now — the agent's `resolve_place`
 * tool is the only caller that needs structured place lookups.
 *
 * Errors:
 *   - Missing `GOOGLE_MAPS_API_KEY` -> throws (configuration bug).
 *   - Network / non-OK HTTP        -> throws (transport error).
 *   - Empty result list             -> returns `null` (treated as "not found").
 */

const PLACES_TEXT_SEARCH_URL =
  'https://places.googleapis.com/v1/places:searchText';

const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
].join(',');

export interface ResolvedPlace {
  placeId: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
}

interface PlacesV1SearchTextResponse {
  places?: Array<{
    id?: string;
    displayName?: { text?: string; languageCode?: string };
    formattedAddress?: string;
    location?: { latitude?: number; longitude?: number };
  }>;
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
