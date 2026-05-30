import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { config } from '../config.js';

// Crash-recovery marker for the gap between Feishu PATCH success and session save.
export interface PendingResponsePatchMarker {
  sessionId: string;
  cardId: string;
  state: 'patching' | 'patched';
  createdAt: string;
  patchedAt?: string;
}

function markerPath(sessionId: string): string {
  return join(config.session.dataDir, 'pending-response-patches', `${sessionId}.json`);
}

export function readPendingResponsePatchMarker(sessionId: string): PendingResponsePatchMarker | undefined {
  const fp = markerPath(sessionId);
  if (!existsSync(fp)) return undefined;
  try {
    const marker = JSON.parse(readFileSync(fp, 'utf-8')) as PendingResponsePatchMarker;
    if (marker.sessionId !== sessionId || !marker.cardId) return undefined;
    if (marker.state !== 'patching' && marker.state !== 'patched') return undefined;
    return marker;
  } catch {
    return undefined;
  }
}

function writeMarker(marker: PendingResponsePatchMarker): void {
  const fp = markerPath(marker.sessionId);
  mkdirSync(dirname(fp), { recursive: true });
  const tmp = `${fp}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(marker, null, 2), 'utf-8');
  renameSync(tmp, fp);
}

export function writePendingResponsePatchMarker(sessionId: string, cardId: string): void {
  writeMarker({
    sessionId,
    cardId,
    state: 'patching',
    createdAt: new Date().toISOString(),
  });
}

export function markPendingResponsePatchMarkerPatched(sessionId: string): void {
  const marker = readPendingResponsePatchMarker(sessionId);
  if (!marker) return;
  writeMarker({ ...marker, state: 'patched', patchedAt: new Date().toISOString() });
}

export function clearPendingResponsePatchMarker(sessionId: string): void {
  const fp = markerPath(sessionId);
  try { unlinkSync(fp); } catch { /* already gone */ }
}
