/**
 * Decision logic for "should the worker suppress its transcript-driven
 * fallback emit for this Lark turn?"
 *
 * Pure function with no I/O — kept separate from worker.ts so the rules
 * (including the type-ahead window and the adopt-vs-non-adopt branching)
 * can be tested deterministically. The worker reads marker entries from
 * disk and threads them through here.
 *
 * Rules:
 *   - Adopt mode never suppresses: in /adopt the model in the adopted
 *     session is unaware of botmux, so transcript drain is the ONLY
 *     channel from model to Lark. There's no `botmux send` to compete
 *     with, hence no marker to gate on.
 *   - Non-adopt + isLocal: suppress. A local-typing turn means the
 *     attribution queue saw a user event whose content didn't match any
 *     pending Lark fingerprint. In a worker-spawned CLI that's a Web
 *     terminal hand-typed input — the user is already looking at it, no
 *     reason to push it back to the Lark thread.
 *   - Non-adopt + send observed in window: suppress. The window is
 *     [turn.markTimeMs, nextBoundaryMs). Legacy markers only carry time,
 *     so any marker in the window still suppresses. Newer markers carry
 *     hashes/length of the explicit `botmux send` body; when the transcript
 *     final is available, suppress only if the explicit send appears to
 *     cover that final. This prevents progress updates from hiding a later
 *     substantive final answer without writing plaintext reply snippets into
 *     the marker file. Boundary handling intentionally also considers
 *     queue items that haven't reached "ready" yet (passed in via
 *     nextBoundaryMs) — without that, a model that's still mid-tool-use
 *     for turn N+1 could leak a send credit into turn N's window.
 */
import { createHash } from 'node:crypto';
import { normaliseForFingerprint } from './bridge-turn-queue.js';

const CONTENT_PREFIX_LEN = 30;
const FINAL_COVERAGE_RATIO = 0.95;

export interface BridgeSendMarker {
  sentAtMs: number;
  messageId?: string;
  contentHash?: string;
  contentPrefixHash?: string;
  contentSuffixHash?: string;
  contentLength?: number;
}

export interface BridgeGateInput {
  /** When the user message was queued — defines the lower bound of the
   *  send window. Undefined for legacy turns; the gate degrades to
   *  "never suppress" in that case. */
  markTimeMs: number | undefined;
  /** Whether the queue synthesised this turn from a local-terminal event
   *  (no fingerprint match for a Lark message). */
  isLocal: boolean | undefined;
  /** Transcript final text for this turn, when available. Lets structured
   *  send markers distinguish final-answer sends from earlier progress sends. */
  finalText?: string;
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('base64url');
}

export function buildBridgeSendMarkerContent(content: string): Pick<BridgeSendMarker, 'contentHash' | 'contentPrefixHash' | 'contentSuffixHash' | 'contentLength'> | undefined {
  const normalized = normaliseForFingerprint(content);
  if (!normalized) return undefined;
  return {
    contentHash: hashContent(normalized),
    contentPrefixHash: hashContent(normalized.slice(0, CONTENT_PREFIX_LEN)),
    contentSuffixHash: hashContent(normalized.slice(-CONTENT_PREFIX_LEN)),
    contentLength: normalized.length,
  };
}

type StructuredBridgeSendMarker = BridgeSendMarker & {
  contentHash: string;
  contentPrefixHash: string;
  contentSuffixHash: string;
  contentLength: number;
};

function hasStructuredContentMarker(marker: BridgeSendMarker): marker is StructuredBridgeSendMarker {
  return typeof marker.contentHash === 'string'
    && typeof marker.contentPrefixHash === 'string'
    && typeof marker.contentSuffixHash === 'string'
    && typeof marker.contentLength === 'number';
}

function isLikelySendAcknowledgement(finalNormalized: string): boolean {
  if (finalNormalized.length === 0 || finalNormalized.length > 120) return false;
  return [
    /^(已|已经|我已|我已经).{0,40}(发送|发出|回复|重发)/,
    /^(sent|posted|delivered|done)\b/i,
    /^(i'?ve|i have).{0,40}(sent|posted|replied|resent)/i,
  ].some(re => re.test(finalNormalized));
}

function structuredMarkerCoversFinal(marker: BridgeSendMarker, finalNormalized: string): boolean {
  if (!hasStructuredContentMarker(marker)) return false;
  if (marker.contentHash === hashContent(finalNormalized)) return true;
  if (marker.contentPrefixHash !== hashContent(finalNormalized.slice(0, CONTENT_PREFIX_LEN))) return false;
  if (marker.contentSuffixHash !== hashContent(finalNormalized.slice(-CONTENT_PREFIX_LEN))) return false;
  return marker.contentLength >= Math.ceil(finalNormalized.length * FINAL_COVERAGE_RATIO);
}

function markerSetCoversFinal(markers: readonly BridgeSendMarker[], finalText: string | undefined): boolean {
  if (markers.length === 0) return false;

  // Back-compat: old marker files only have sentAtMs/messageId. Keep the old
  // conservative behavior for those entries instead of risking duplicates.
  if (markers.some(m => !hasStructuredContentMarker(m))) return true;

  const finalNormalized = normaliseForFingerprint(finalText ?? '');
  if (!finalNormalized) return true;
  if (isLikelySendAcknowledgement(finalNormalized)) return true;

  return markers.some(m => structuredMarkerCoversFinal(m, finalNormalized));
}

export function shouldSuppressBridgeEmit(
  turn: BridgeGateInput,
  nextBoundaryMs: number | undefined,
  markers: readonly BridgeSendMarker[],
  adoptMode: boolean,
): boolean {
  if (adoptMode) return false;
  if (turn.isLocal) return true;
  if (turn.markTimeMs === undefined) return false;
  const lower = turn.markTimeMs;
  const upper = nextBoundaryMs ?? Number.POSITIVE_INFINITY;
  const markersInWindow = markers.filter(m => m.sentAtMs >= lower && m.sentAtMs < upper);
  return markerSetCoversFinal(markersInWindow, turn.finalText);
}
