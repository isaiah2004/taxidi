'use client';

/**
 * TripView — top-level client wrapper for a trip page. Owns the live graph
 * state (via `useGraphState`), the side-panel target, and the tab switch
 * across Graph / Map / Itinerary. The header bar holds variant controls and
 * the propose action.
 *
 * Server components are responsible for prefetching the initial graph and
 * passing it in as `initialGraph`; if absent the hook fires its own fetch on
 * mount and the tabs render their loading/empty states until data arrives.
 */

import { useCallback, useState } from 'react';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import { useGraphState } from '@/components/trip/use-graph-state';
import { GraphTab } from '@/components/trip/graph-tab';
import { MapTab } from '@/components/trip/map-tab';
import { ItineraryTab } from '@/components/trip/itinerary-tab';
import { SidePanel, type PanelTarget } from '@/components/trip/side-panel';
import {
  VariantSwitcher,
  type VariantOption,
} from '@/components/trip/variant-switcher';
import { ProposeButton } from '@/components/trip/propose-button';
import type { GraphEdge, TripGraph, Vertex } from '@/lib/graph';

export interface TripViewProps {
  tripBookId: string;
  /** Active variant id, or `'main'` for the read-only timeline. */
  variantId: string;
  isOwner: boolean;
  initialGraph?: TripGraph;
  /** Optional list of variants the current user can switch into. */
  variantOptions?: VariantOption[];
}

export function TripView({
  tripBookId,
  variantId,
  isOwner,
  initialGraph,
  variantOptions,
}: TripViewProps) {
  const { graph, isLoading, error, refetch } = useGraphState(
    tripBookId,
    variantId,
    initialGraph,
  );

  const [panelTarget, setPanelTarget] = useState<PanelTarget>(null);
  const [panelOpen, setPanelOpen] = useState(false);

  const isMainVariant = variantId === 'main';

  const handleVertexClick = useCallback((vertex: Vertex) => {
    setPanelTarget({ kind: 'vertex', vertex });
    setPanelOpen(true);
  }, []);

  const handleEdgeClick = useCallback((edge: GraphEdge) => {
    setPanelTarget({ kind: 'edge', edge });
    setPanelOpen(true);
  }, []);

  const fallbackOptions: VariantOption[] = [
    {
      id: 'main',
      label: 'Main',
      hint: 'The merged trip',
      readOnly: true,
    },
    ...(variantId !== 'main'
      ? [
          {
            id: variantId,
            label: 'Your variant',
            hint: 'Active draft',
          } as VariantOption,
        ]
      : []),
  ];

  const options = variantOptions ?? fallbackOptions;

  return (
    <div className="flex h-full min-h-[600px] w-full flex-col gap-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <VariantSwitcher
            tripBookId={tripBookId}
            activeId={variantId}
            options={options}
          />
          {isLoading && (
            <span className="text-xs text-muted-foreground">Syncing…</span>
          )}
          {error && (
            <span className="text-xs text-destructive">{error.message}</span>
          )}
        </div>
        {!isOwner && !isMainVariant && (
          <ProposeButton tripBookId={tripBookId} variantId={variantId} />
        )}
      </header>

      <Tabs defaultValue="graph" className="flex h-full flex-1 flex-col">
        <TabsList>
          <TabsTrigger value="graph">Graph</TabsTrigger>
          <TabsTrigger value="map">Map</TabsTrigger>
          <TabsTrigger value="itinerary">Itinerary</TabsTrigger>
        </TabsList>

        <TabsContent value="graph" className="flex flex-1 flex-col">
          <GraphTab
            graph={graph}
            onVertexClick={handleVertexClick}
            onEdgeClick={handleEdgeClick}
          />
        </TabsContent>

        <TabsContent value="map" className="flex flex-1 flex-col">
          <MapTab graph={graph} onVertexClick={handleVertexClick} />
        </TabsContent>

        <TabsContent value="itinerary" className="flex flex-1 flex-col">
          <ItineraryTab
            graph={graph}
            onVertexClick={handleVertexClick}
            onEdgeClick={handleEdgeClick}
          />
        </TabsContent>
      </Tabs>

      <SidePanel
        open={panelOpen}
        onOpenChange={setPanelOpen}
        target={panelTarget}
        tripBookId={tripBookId}
        variantId={variantId}
        readOnly={isMainVariant}
        onChanged={() => {
          void refetch();
        }}
      />
    </div>
  );
}
