'use client';

/**
 * MapTab — Google Maps view of the same trip graph the GraphTab renders.
 * Geocoded vertices become markers; edges between two geocoded vertices
 * become straight polylines (dashed, light grey) so the user gets a sense of
 * the route without us doing real routing.
 *
 * Uses the public `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`. If the key is absent or
 * the page has no geocoded vertices, we render a friendly empty state rather
 * than crashing the loader.
 */

import { useMemo, useCallback } from 'react';
import {
  GoogleMap,
  Marker,
  Polyline,
  useJsApiLoader,
  type Libraries,
} from '@react-google-maps/api';
import type { GraphEdge, TripGraph, Vertex } from '@/lib/graph';

/**
 * Maps JS API library set. We need `geometry` for
 * `google.maps.geometry.encoding.decodePath` to render Routes-API polylines.
 * `Libraries` is referenced statically so React doesn't reload the script on
 * every render — see @react-google-maps/api docs.
 */
const MAP_LIBRARIES: Libraries = ['geometry'];

const CONTAINER_STYLE = {
  width: '100%',
  height: '100%',
  minHeight: '480px',
};

const DEFAULT_CENTER = { lat: 0, lng: 0 };
const DEFAULT_ZOOM = 2;

/** Dashed grey for straight-line fallback polylines (no Routes data). */
const POLYLINE_OPTIONS: google.maps.PolylineOptions = {
  strokeColor: '#94a3b8',
  strokeOpacity: 0,
  strokeWeight: 2,
  icons: [
    {
      icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, scale: 3 },
      offset: '0',
      repeat: '12px',
    },
  ],
};

/** Solid blue for Routes-API-decoded polylines (real on-the-ground path). */
const ROUTE_POLYLINE_OPTIONS: google.maps.PolylineOptions = {
  strokeColor: '#3b82f6',
  strokeOpacity: 0.9,
  strokeWeight: 3,
};

function isGeocoded(
  v: Vertex,
): v is Vertex & { location: { lat: number; lng: number } } {
  return Boolean(
    v.location &&
      typeof v.location.lat === 'number' &&
      typeof v.location.lng === 'number',
  );
}

export interface MapTabProps {
  graph: TripGraph | null;
  onVertexClick?: (vertex: Vertex) => void;
}

export function MapTab({ graph, onVertexClick }: MapTabProps) {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  const { isLoaded, loadError } = useJsApiLoader({
    id: 'taxidi-google-map',
    googleMapsApiKey: apiKey ?? '',
    libraries: MAP_LIBRARIES,
  });

  const placedVertices = useMemo(
    () => (graph ? graph.vertices.filter(isGeocoded) : []),
    [graph],
  );

  const placedById = useMemo(
    () => new Map(placedVertices.map((v) => [v.originId, v])),
    [placedVertices],
  );

  type MapPolyline = {
    id: string;
    path: google.maps.LatLngLiteral[];
    edge: GraphEdge;
    /** True when `path` came from a decoded Routes API polyline. */
    routed: boolean;
  };

  const polylines = useMemo<MapPolyline[]>(() => {
    if (!graph || !isLoaded) return [];
    return graph.edges
      .filter(
        (e) =>
          placedById.has(e.sourceOriginId) &&
          placedById.has(e.targetOriginId),
      )
      .map((e) => {
        const a = placedById.get(e.sourceOriginId)!;
        const b = placedById.get(e.targetOriginId)!;

        // Prefer the Routes-API encoded polyline (when present on the
        // transport node's typeData) — it's the actual on-the-ground path.
        // Fall back to a straight line between the two endpoints.
        const td = (e as unknown as { typeData?: Record<string, unknown> })
          ?.typeData;
        const encoded =
          typeof td?.encodedPolyline === 'string'
            ? td.encodedPolyline
            : typeof td?.encoded_polyline === 'string'
              ? td.encoded_polyline
              : null;

        if (encoded && google.maps.geometry?.encoding?.decodePath) {
          try {
            const decoded = google.maps.geometry.encoding.decodePath(encoded);
            const path = decoded.map((p) => ({ lat: p.lat(), lng: p.lng() }));
            if (path.length >= 2) {
              return { id: e.originId, path, edge: e, routed: true };
            }
          } catch (err) {
            console.error('[map-tab] failed to decode polyline', err);
          }
        }

        return {
          id: e.originId,
          path: [
            { lat: a.location.lat, lng: a.location.lng },
            { lat: b.location.lat, lng: b.location.lng },
          ],
          edge: e,
          routed: false,
        };
      });
  }, [graph, placedById, isLoaded]);

  const onMapLoad = useCallback(
    (map: google.maps.Map) => {
      if (placedVertices.length === 0) return;
      const bounds = new google.maps.LatLngBounds();
      for (const v of placedVertices) {
        bounds.extend({ lat: v.location.lat, lng: v.location.lng });
      }
      if (placedVertices.length === 1) {
        map.setCenter({
          lat: placedVertices[0].location.lat,
          lng: placedVertices[0].location.lng,
        });
        map.setZoom(11);
      } else {
        map.fitBounds(bounds, 48);
      }
    },
    [placedVertices],
  );

  if (!apiKey) {
    return (
      <div className="flex h-full min-h-[480px] items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
        Map unavailable — set NEXT_PUBLIC_GOOGLE_MAPS_API_KEY to enable.
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex h-full min-h-[480px] items-center justify-center rounded-lg border border-dashed border-destructive/40 text-sm text-destructive">
        Failed to load Google Maps.
      </div>
    );
  }

  if (!isLoaded) {
    return (
      <div className="flex h-full min-h-[480px] items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
        Loading map…
      </div>
    );
  }

  if (placedVertices.length === 0) {
    return (
      <div className="flex h-full min-h-[480px] items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
        No places to map yet — add a destination first.
      </div>
    );
  }

  return (
    <div className="h-full min-h-[480px] w-full overflow-hidden rounded-lg border border-border">
      <GoogleMap
        mapContainerStyle={CONTAINER_STYLE}
        onLoad={onMapLoad}
        center={DEFAULT_CENTER}
        zoom={DEFAULT_ZOOM}
        options={{
          streetViewControl: false,
          mapTypeControl: false,
          fullscreenControl: false,
        }}
      >
        {placedVertices.map((v) => (
          <Marker
            key={v.originId}
            position={{ lat: v.location.lat, lng: v.location.lng }}
            title={v.title}
            onClick={() => onVertexClick?.(v)}
          />
        ))}
        {polylines.map((p) => (
          <Polyline
            key={p.id}
            path={p.path}
            options={p.routed ? ROUTE_POLYLINE_OPTIONS : POLYLINE_OPTIONS}
          />
        ))}
      </GoogleMap>
    </div>
  );
}
