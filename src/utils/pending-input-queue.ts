import type { CodexAppTurnInput } from '../types.js';

export interface PendingCliInput {
  content: string;
  turnId?: string;
  codexAppInput?: CodexAppTurnInput;
}

export function mergeQueuedCliInput(
  pending: PendingCliInput[],
  next: PendingCliInput,
): boolean {
  const tail = pending[pending.length - 1];
  if (!tail) return false;
  // Structured turns carry per-message attribution/context. Merging only the
  // visible text would either drop or mis-attach that sidecar, so keep them as
  // distinct queue entries. (codex-app itself does not opt into queued merge;
  // this is a future-proof guard for generic queue callers.)
  if (tail.codexAppInput || next.codexAppInput) return false;
  tail.content = `${tail.content}\n\n${next.content}`;
  tail.turnId = next.turnId ?? tail.turnId;
  return true;
}
