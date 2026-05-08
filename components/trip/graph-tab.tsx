'use client';

/**
 * GraphTab — React Flow canvas for the trip graph. Maps the abstract
 * `TripGraph` (vertices + edges) onto React Flow node/edge shapes and runs a
 * dagre auto-layout (left-to-right, ranked chronologically by `startAt`) so
 * the user gets a sensible default position for every place.
 *
 * Layout is recomputed only when the topology actually changes (count or set
 * of ids), debounced 150ms to coalesce bursts of realtime events. Position
 * tweaks the user makes by dragging are preserved across re-renders because
 * we hold them in `useNodesState`'s state and only re-seed when the topology
 * hash changes.
 *
 * Custom node/edge type maps:
 *   - destination/lodging/activity/meal -> <PlaceNode> (single component
 *     swaps icon by `data.vertex.type`)
 *   - transport -> <TransportEdge>
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  useNodesState,
  useEdgesState,
  type NodeMouseHandler,
  type EdgeMouseHandler,
  type NodeTypes,
  type EdgeTypes,
} from '@xyflow/react';
import dagre from 'dagre';
import '@xyflow/react/dist/style.css';

import type { GraphEdge, TripGraph, Vertex } from '@/lib/graph';
import {
  PlaceNode,
  type PlaceNodeType,
} from '@/components/trip/nodes/place-node';
import {
  TransportEdge,
  type TransportEdgeType,
} from '@/components/trip/edges/transport-edge';

const NODE_WIDTH = 180;
const NODE_HEIGHT = 80;
const LAYOUT_DEBOUNCE_MS = 150;

const NODE_TYPES = {
  destination: PlaceNode,
  lodging: PlaceNode,
  activity: PlaceNode,
  meal: PlaceNode,
} as unknown as NodeTypes;

const EDGE_TYPES = {
  transport: TransportEdge,
} as unknown as EdgeTypes;

export interface GraphTabProps {
  graph: TripGraph | null;
  onVertexClick?: (vertex: Vertex) => void;
  onEdgeClick?: (edge: GraphEdge) => void;
}

/**
 * Build React Flow node/edge arrays from a TripGraph and run a dagre
 * left-to-right layout.
 */
function buildAndLayout(graph: TripGraph): {
  nodes: PlaceNodeType[];
  edges: TransportEdgeType[];
} {
  // Optional: seed positions from a chronological sort so dagre's tie-breaks
  // produce a more intuitive ordering when timestamps are missing/equal.
  const sorted = [...graph.vertices].sort(compareByStart);

  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: 'LR', nodesep: 60, ranksep: 120, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const v of sorted) {
    g.setNode(v.originId, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }

  // Only lay out edges whose endpoints we're rendering.
  const renderableIds = new Set(sorted.map((v) => v.originId));
  for (const e of graph.edges) {
    if (
      renderableIds.has(e.sourceOriginId) &&
      renderableIds.has(e.targetOriginId)
    ) {
      g.setEdge(e.sourceOriginId, e.targetOriginId, {}, e.originId);
    }
  }

  dagre.layout(g);

  const nodes: PlaceNodeType[] = sorted.map((v) => {
    const dn = g.node(v.originId);
    return {
      id: v.originId,
      type: v.type,
      position: dn
        ? { x: dn.x - NODE_WIDTH / 2, y: dn.y - NODE_HEIGHT / 2 }
        : { x: 0, y: 0 },
      data: { vertex: v },
    };
  });

  const edges: TransportEdgeType[] = graph.edges
    .filter(
      (e) =>
        renderableIds.has(e.sourceOriginId) &&
        renderableIds.has(e.targetOriginId),
    )
    .map((e) => ({
      id: e.originId,
      source: e.sourceOriginId,
      target: e.targetOriginId,
      type: 'transport' as const,
      data: { edge: e },
    }));

  return { nodes, edges };
}

function compareByStart(a: Vertex, b: Vertex): number {
  const aTime = a.startAt ? new Date(a.startAt).getTime() : Number.MAX_SAFE_INTEGER;
  const bTime = b.startAt ? new Date(b.startAt).getTime() : Number.MAX_SAFE_INTEGER;
  if (aTime !== bTime) return aTime - bTime;
  return (a.sortIndex ?? 0) - (b.sortIndex ?? 0);
}

/** Stable hash for the topology — recompute layout only when it changes. */
function topologyKey(graph: TripGraph | null): string {
  if (!graph) return '';
  const v = graph.vertices
    .map((x) => x.originId)
    .sort()
    .join(',');
  const e = graph.edges
    .map((x) => `${x.sourceOriginId}->${x.targetOriginId}:${x.originId}`)
    .sort()
    .join(',');
  return `${v}|${e}`;
}

export function GraphTab({ graph, onVertexClick, onEdgeClick }: GraphTabProps) {
  const initial = useMemo(
    () => (graph ? buildAndLayout(graph) : { nodes: [], edges: [] }),
    // Only seed once on mount; we update via setNodes/setEdges below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<PlaceNodeType>(
    initial.nodes,
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<TransportEdgeType>(
    initial.edges,
  );

  const layoutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTopologyKey = useRef<string>(topologyKey(graph));

  // Re-layout when topology changes. Position tweaks survive content-only
  // updates (e.g. title / time edits) because we re-merge into the existing
  // node array instead of replacing it.
  useEffect(() => {
    if (!graph) {
      setNodes([]);
      setEdges([]);
      lastTopologyKey.current = '';
      return;
    }
    const nextKey = topologyKey(graph);

    if (nextKey === lastTopologyKey.current) {
      // Same topology — just refresh `data` on existing nodes/edges.
      const byId = new Map(graph.vertices.map((v) => [v.originId, v]));
      setNodes((current) =>
        current.map((n) =>
          byId.has(n.id) ? { ...n, data: { vertex: byId.get(n.id)! } } : n,
        ),
      );
      const edgesById = new Map(graph.edges.map((e) => [e.originId, e]));
      setEdges((current) =>
        current.map((e) =>
          edgesById.has(e.id)
            ? { ...e, data: { edge: edgesById.get(e.id)! } }
            : e,
        ),
      );
      return;
    }

    // Topology changed — debounce the layout pass so a burst of realtime
    // updates only triggers one dagre run.
    if (layoutTimer.current) clearTimeout(layoutTimer.current);
    layoutTimer.current = setTimeout(() => {
      const next = buildAndLayout(graph);
      lastTopologyKey.current = nextKey;
      setNodes(next.nodes);
      setEdges(next.edges);
    }, LAYOUT_DEBOUNCE_MS);
  }, [graph, setNodes, setEdges]);

  useEffect(() => {
    return () => {
      if (layoutTimer.current) clearTimeout(layoutTimer.current);
    };
  }, []);

  const handleNodeClick = useCallback<NodeMouseHandler<PlaceNodeType>>(
    (_e, node) => {
      onVertexClick?.(node.data.vertex);
    },
    [onVertexClick],
  );

  const handleEdgeClick = useCallback<EdgeMouseHandler<TransportEdgeType>>(
    (_e, edge) => {
      if (edge.data?.edge) onEdgeClick?.(edge.data.edge);
    },
    [onEdgeClick],
  );

  if (!graph || nodes.length === 0) {
    return (
      <div
        role="status"
        className="flex h-full min-h-[400px] flex-1 items-center justify-center rounded-lg border border-dashed border-border bg-background/40 text-sm text-muted-foreground"
      >
        No places yet — ask @taxidi or click Add Place.
      </div>
    );
  }

  return (
    <div
      role="region"
      aria-label="Trip graph"
      className="h-full min-h-[480px] w-full rounded-lg border border-border bg-background"
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodeClick={handleNodeClick as unknown as NodeMouseHandler}
        onEdgeClick={handleEdgeClick as unknown as EdgeMouseHandler}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
        aria-label={`Trip graph with ${nodes.length} ${
          nodes.length === 1 ? 'place' : 'places'
        } and ${edges.length} ${
          edges.length === 1 ? 'transport leg' : 'transport legs'
        }`}
      >
        <Background gap={20} />
        <Controls position="bottom-right" />
      </ReactFlow>
    </div>
  );
}
