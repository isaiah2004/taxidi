/**
 * Pure diff/apply helpers for `SerializedSnapshot`.
 *
 * Operations are keyed by `originId` so they survive variant re-materialization
 * (where DB-side `node.id` changes but `origin_id` is preserved). Move and
 * update are split: a node whose parent OR sortIndex changes emits a `move`;
 * a node whose other fields change emits an `update`. A node that does both
 * emits both ops, in stable order.
 *
 * Order convention emitted by `diff()`: deletes -> moves -> updates -> adds.
 * `applyDiff()` accepts ops in any order but the canonical order keeps the
 * intermediate snapshot well-formed at every step (no dangling parent
 * references when an add references a freshly-moved parent).
 */
import type { SerializedNode, SerializedSnapshot } from '@/lib/graph';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DiffOp =
  | { kind: 'add'; originId: string; payload: SerializedNode }
  | { kind: 'update'; originId: string; patch: Record<string, unknown> }
  | { kind: 'delete'; originId: string }
  | {
      kind: 'move';
      originId: string;
      newParentOriginId: string | null;
      newSortIndex: number;
    };

export type Diff = { ops: DiffOp[] };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Fields compared when deciding whether two nodes are "structurally equal"
 * (i.e. only differ by parent/sortIndex). If any of these differ between
 * `prev` and `next` we emit an `update` patch.
 *
 * `parentOriginId` and `sortIndex` are intentionally NOT in this list: those
 * changes get reflected via a `move` op instead.
 */
const UPDATE_FIELDS: ReadonlyArray<keyof SerializedNode> = [
  'type',
  'title',
  'notes',
  'startAt',
  'endAt',
  'location',
  'typeData',
  'version',
];

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;

  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;

  const aRec = a as Record<string, unknown>;
  const bRec = b as Record<string, unknown>;
  const aKeys = Object.keys(aRec);
  const bKeys = Object.keys(bRec);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bRec, k)) return false;
    if (!deepEqual(aRec[k], bRec[k])) return false;
  }
  return true;
}

/** Build a Map of originId -> node, dropping items missing originId. */
function indexByOriginId(
  snapshot: SerializedSnapshot,
): Map<string, SerializedNode> {
  const out = new Map<string, SerializedNode>();
  for (const n of snapshot.nodes) {
    if (typeof n.originId === 'string' && n.originId.length > 0) {
      out.set(n.originId, n);
    }
  }
  return out;
}

/**
 * Compute the field-level patch between two SerializedNodes covering only the
 * `UPDATE_FIELDS` (parent/sortIndex changes go through `move`). Returns `null`
 * when the two are equal across every update field.
 */
function diffUpdateFields(
  prev: SerializedNode,
  next: SerializedNode,
): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  let changed = false;
  for (const field of UPDATE_FIELDS) {
    if (!deepEqual(prev[field], next[field])) {
      patch[field] = next[field];
      changed = true;
    }
  }
  return changed ? patch : null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute a diff that, when applied to `prev`, produces a snapshot deeply
 * equal to `next`.
 *
 * Items lacking `originId` in either snapshot are treated as ADD/DELETE pairs:
 * we never try to match them across snapshots. (Origin IDs are how the merge
 * agent identifies "the same logical node" across user edits — a node without
 * one can only ever be brand-new or brand-gone.)
 */
export function diff(
  prev: SerializedSnapshot,
  next: SerializedSnapshot,
): Diff {
  const prevByOrigin = indexByOriginId(prev);
  const nextByOrigin = indexByOriginId(next);

  const deletes: DiffOp[] = [];
  const moves: DiffOp[] = [];
  const updates: DiffOp[] = [];
  const adds: DiffOp[] = [];

  // DELETEs: in prev but not in next.
  for (const [originId] of prevByOrigin) {
    if (!nextByOrigin.has(originId)) {
      deletes.push({ kind: 'delete', originId });
    }
  }

  // UPDATE / MOVE: in both. Same originId.
  for (const [originId, nextNode] of nextByOrigin) {
    const prevNode = prevByOrigin.get(originId);
    if (!prevNode) continue;

    const parentChanged =
      prevNode.parentOriginId !== nextNode.parentOriginId ||
      prevNode.sortIndex !== nextNode.sortIndex;
    if (parentChanged) {
      moves.push({
        kind: 'move',
        originId,
        newParentOriginId: nextNode.parentOriginId,
        newSortIndex: nextNode.sortIndex,
      });
    }

    const patch = diffUpdateFields(prevNode, nextNode);
    if (patch) {
      updates.push({ kind: 'update', originId, patch });
    }
  }

  // ADDs: in next but not in prev. Also: every "next" node lacking an originId
  // is an ADD by definition (we can't match it to anything in prev).
  for (const [originId, nextNode] of nextByOrigin) {
    if (!prevByOrigin.has(originId)) {
      adds.push({ kind: 'add', originId, payload: nextNode });
    }
  }
  for (const n of next.nodes) {
    if (typeof n.originId !== 'string' || n.originId.length === 0) {
      // Synthesize an originId-less ADD. Apply consumer can choose how to key
      // these (typically by appending; we put them at the end).
      adds.push({ kind: 'add', originId: '', payload: n });
    }
  }
  // ... and every prev node lacking an originId is a DELETE (nothing to match
  // it to in next).
  for (const n of prev.nodes) {
    if (typeof n.originId !== 'string' || n.originId.length === 0) {
      deletes.push({ kind: 'delete', originId: '' });
    }
  }

  return { ops: [...deletes, ...moves, ...updates, ...adds] };
}

/**
 * Apply a diff to a snapshot, returning a new snapshot. Does not mutate the
 * input. Ops are applied in the order they appear.
 *
 * For originId-keyed ops we expect each affected node to exist (or not exist)
 * as the op kind requires; we silently ignore mismatches (e.g. a delete for a
 * non-existent originId) so the apply is robust to slightly stale diffs.
 */
export function applyDiff(
  prev: SerializedSnapshot,
  diff: Diff,
): SerializedSnapshot {
  // Work on a shallow array copy of node references; we'll only replace the
  // ones we actually mutate so unchanged nodes stay shared with `prev`.
  let nodes: SerializedNode[] = prev.nodes.slice();
  // Keep a parallel buffer of "originId-less" ADDs to append at the end so
  // they don't churn the index.
  const trailingAdds: SerializedNode[] = [];

  for (const op of diff.ops) {
    switch (op.kind) {
      case 'delete': {
        if (op.originId === '') {
          // Originless delete: pop the first originless node we find.
          const idx = nodes.findIndex(
            (n) => typeof n.originId !== 'string' || n.originId.length === 0,
          );
          if (idx >= 0) nodes = nodes.filter((_, i) => i !== idx);
        } else {
          nodes = nodes.filter((n) => n.originId !== op.originId);
        }
        break;
      }
      case 'move': {
        nodes = nodes.map((n) =>
          n.originId === op.originId
            ? {
                ...n,
                parentOriginId: op.newParentOriginId,
                sortIndex: op.newSortIndex,
              }
            : n,
        );
        break;
      }
      case 'update': {
        nodes = nodes.map((n) =>
          n.originId === op.originId ? { ...n, ...op.patch } : n,
        );
        break;
      }
      case 'add': {
        if (op.originId === '') {
          trailingAdds.push(op.payload);
        } else if (!nodes.some((n) => n.originId === op.originId)) {
          nodes.push(op.payload);
        }
        break;
      }
    }
  }

  return { nodes: [...nodes, ...trailingAdds] };
}
