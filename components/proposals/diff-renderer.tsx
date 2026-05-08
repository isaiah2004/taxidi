'use client';

/**
 * Renders a computed `Diff` (between a "main" and a "variant" snapshot) as a
 * two-column review layout. Left column is the "ours" view (main); right is
 * "theirs" (variant). Each row corresponds to one DiffOp, color- and
 * icon-coded so it's still legible to color-blind reviewers.
 *
 *   ADD     -> green background, Plus icon       (only on the variant side)
 *   UPDATE  -> amber background, Pencil icon     (with a per-field diff table)
 *   DELETE  -> red background, Trash icon        (only on the main side)
 *   MOVE    -> violet background, ArrowRight icon (parent / sortIndex change)
 *
 * All sort comparators are stable: ops are grouped by originId so each row
 * shows the same node on both sides where applicable.
 */

import { useMemo } from 'react';
import {
  ArrowRight,
  Pencil,
  Plus,
  Trash,
  type LucideIcon,
} from 'lucide-react';

import type { DiffOp } from '@/lib/diff';
import type { SerializedNode, SerializedSnapshot } from '@/lib/graph';
import { cn } from '@/lib/utils';

interface DiffRendererProps {
  ops: DiffOp[];
  mainSnapshot: SerializedSnapshot;
  variantSnapshot: SerializedSnapshot;
}

interface RowDescriptor {
  /** A stable key for React. */
  key: string;
  /** The originId being affected. Empty string for originless adds/deletes. */
  originId: string;
  op: DiffOp;
  /** The node as it appears in main (if any). */
  mainNode: SerializedNode | null;
  /** The node as it appears in the variant (if any). */
  variantNode: SerializedNode | null;
}

const STYLE_BY_KIND: Record<
  DiffOp['kind'],
  {
    bg: string;
    border: string;
    text: string;
    icon: LucideIcon;
    label: string;
  }
> = {
  add: {
    bg: 'bg-emerald-50 dark:bg-emerald-950/40',
    border: 'border-emerald-300 dark:border-emerald-800',
    text: 'text-emerald-800 dark:text-emerald-300',
    icon: Plus,
    label: 'ADD',
  },
  update: {
    bg: 'bg-amber-50 dark:bg-amber-950/40',
    border: 'border-amber-300 dark:border-amber-800',
    text: 'text-amber-800 dark:text-amber-300',
    icon: Pencil,
    label: 'UPDATE',
  },
  delete: {
    bg: 'bg-rose-50 dark:bg-rose-950/40',
    border: 'border-rose-300 dark:border-rose-800',
    text: 'text-rose-800 dark:text-rose-300',
    icon: Trash,
    label: 'DELETE',
  },
  move: {
    bg: 'bg-violet-50 dark:bg-violet-950/40',
    border: 'border-violet-300 dark:border-violet-800',
    text: 'text-violet-800 dark:text-violet-300',
    icon: ArrowRight,
    label: 'MOVE',
  },
};

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function nodeSummary(node: SerializedNode | null): string {
  if (!node) return '—';
  return `${node.type}: ${node.title}`;
}

/** Indexes a snapshot by originId for O(1) row joining below. */
function indexSnapshot(
  snapshot: SerializedSnapshot,
): Map<string, SerializedNode> {
  const out = new Map<string, SerializedNode>();
  for (const n of snapshot.nodes) {
    if (n.originId) out.set(n.originId, n);
  }
  return out;
}

/**
 * Per-field UPDATE table. Renders one line per changed field with the prior
 * and the new value side-by-side. Used inside the right column of an UPDATE row.
 */
function UpdatePatchTable({
  patch,
  mainNode,
}: {
  patch: Record<string, unknown>;
  mainNode: SerializedNode | null;
}): React.ReactElement {
  const entries = Object.entries(patch);
  if (entries.length === 0) {
    return (
      <p className="text-xs text-muted-foreground italic">No field changes.</p>
    );
  }
  return (
    <table className="w-full border-collapse text-xs">
      <thead>
        <tr className="text-left text-muted-foreground">
          <th className="border-b py-1 pr-2 font-medium">Field</th>
          <th className="border-b py-1 pr-2 font-medium">Was</th>
          <th className="border-b py-1 font-medium">Now</th>
        </tr>
      </thead>
      <tbody>
        {entries.map(([field, value]) => (
          <tr key={field} className="align-top">
            <td className="py-1 pr-2 font-mono text-[11px]">{field}</td>
            <td className="py-1 pr-2 break-words text-muted-foreground line-through">
              {formatValue(
                mainNode
                  ? (mainNode as unknown as Record<string, unknown>)[field]
                  : undefined,
              )}
            </td>
            <td className="py-1 break-words">{formatValue(value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function NodeBox({
  node,
  faded,
  className,
}: {
  node: SerializedNode | null;
  faded?: boolean;
  className?: string;
}): React.ReactElement {
  if (!node) {
    return (
      <div
        className={cn(
          'rounded border border-dashed border-border p-2 text-xs text-muted-foreground italic',
          className,
        )}
      >
        Not present
      </div>
    );
  }
  return (
    <div
      className={cn(
        'rounded border border-border bg-background/50 p-2 text-xs',
        faded && 'opacity-60',
        className,
      )}
    >
      <div className="font-mono text-[10px] text-muted-foreground">
        {node.originId.slice(0, 8)}
      </div>
      <div className="font-medium">{nodeSummary(node)}</div>
      {node.notes && (
        <div className="mt-1 text-muted-foreground">{node.notes}</div>
      )}
    </div>
  );
}

function DiffRow({ row }: { row: RowDescriptor }): React.ReactElement {
  const style = STYLE_BY_KIND[row.op.kind];
  const Icon = style.icon;

  return (
    <div
      className={cn(
        'grid grid-cols-[140px_1fr_1fr] gap-3 rounded-md border p-3',
        style.bg,
        style.border,
      )}
    >
      <div className={cn('flex flex-col gap-1', style.text)}>
        <div className="flex items-center gap-1 font-semibold text-xs">
          <Icon aria-hidden className="h-3.5 w-3.5" />
          <span>{style.label}</span>
        </div>
        <div className="font-mono text-[10px] text-muted-foreground break-all">
          {row.originId.slice(0, 12) || '—'}
        </div>
      </div>

      {/* Left: main / "ours" */}
      <div>
        {row.op.kind === 'add' ? (
          <div className="rounded border border-dashed border-border p-2 text-xs text-muted-foreground italic">
            Not in main
          </div>
        ) : row.op.kind === 'delete' ? (
          <NodeBox node={row.mainNode} />
        ) : row.op.kind === 'move' ? (
          <NodeBox node={row.mainNode} />
        ) : (
          <NodeBox node={row.mainNode} faded />
        )}
      </div>

      {/* Right: variant / "theirs" — also where UPDATE patches surface. */}
      <div>
        {row.op.kind === 'add' ? (
          <NodeBox node={row.variantNode ?? row.op.payload} />
        ) : row.op.kind === 'delete' ? (
          <div className="rounded border border-dashed border-border p-2 text-xs text-muted-foreground italic">
            Removed in variant
          </div>
        ) : row.op.kind === 'move' ? (
          <div className="space-y-1 text-xs">
            <NodeBox node={row.variantNode} />
            <div className="rounded bg-background/60 px-2 py-1 font-mono text-[11px]">
              parent: {row.op.newParentOriginId?.slice(0, 8) ?? 'root'} ·
              sortIndex: {row.op.newSortIndex}
            </div>
          </div>
        ) : (
          <UpdatePatchTable
            patch={row.op.patch}
            mainNode={row.mainNode}
          />
        )}
      </div>
    </div>
  );
}

export function DiffRenderer({
  ops,
  mainSnapshot,
  variantSnapshot,
}: DiffRendererProps): React.ReactElement {
  const rows = useMemo<RowDescriptor[]>(() => {
    const mainByOrigin = indexSnapshot(mainSnapshot);
    const variantByOrigin = indexSnapshot(variantSnapshot);
    return ops.map((op, i) => ({
      key: `${op.kind}:${op.originId}:${i}`,
      originId: op.originId,
      op,
      mainNode: op.originId ? mainByOrigin.get(op.originId) ?? null : null,
      variantNode: op.originId
        ? variantByOrigin.get(op.originId) ?? null
        : null,
    }));
  }, [ops, mainSnapshot, variantSnapshot]);

  if (rows.length === 0) {
    return (
      <div className="rounded border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        No differences. The variant is already aligned with main.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[140px_1fr_1fr] gap-3 px-3 text-xs font-medium uppercase text-muted-foreground">
        <div>Op</div>
        <div>Main (current)</div>
        <div>Variant (proposed)</div>
      </div>
      {rows.map((row) => (
        <DiffRow key={row.key} row={row} />
      ))}
    </div>
  );
}
