/**
 * Host-neutral execution seam for Saved Workflow IM commands.
 *
 * This module deliberately returns a notification payload instead of sending
 * it.  Persistence/launch completion is therefore never reclassified as a
 * business failure merely because the Lark reply failed afterwards.
 */

import type { BotConfig } from '../../bot-registry.js';
import type { RawParamInput } from '../../workflows/params.js';
import {
  instantiatePublishedSavedWorkflow,
  listVisibleSavedWorkflows,
  resolveOwnedTerminalRunDir,
  resolveVisibleSavedWorkflow,
  saveTerminalRunAsWorkflow,
  type SavedWorkflowActorContext,
} from '../../workflows/v3/library-service.js';
import { loadCurrentSavedWorkflow } from '../../workflows/v3/library-store.js';
import type { V3SavedWorkflowCommand } from './v3-saved-workflow-command.js';
import { v3SavedWorkflowAdHocRunEscapeHint } from './v3-saved-workflow-command.js';

export type ExecutableV3SavedWorkflowCommand = Exclude<V3SavedWorkflowCommand, { kind: 'invalid' }>;

export interface V3SavedWorkflowMessageTargetsInput {
  /** Existing daemon routing anchor; it may be an oc_ chat id in chat scope. */
  anchor: string;
  /** Real thread/fold-back root supplied by the event dispatcher, when any. */
  replyRootId?: string;
  /** Stable inbound message id. */
  messageId: string;
}

export interface V3SavedWorkflowMessageTargets {
  /** Where every user-visible reply for this invocation must land. */
  replyAnchor: string;
  /** Binding frozen into run.json. Always a message id, never the chat id. */
  runRootMessageId: string;
  /** Stable id used by quota deduplication. */
  quotaMessageId: string;
}

export function resolveV3SavedWorkflowMessageTargets(
  input: V3SavedWorkflowMessageTargetsInput,
): V3SavedWorkflowMessageTargets {
  const messageId = input.messageId.trim();
  if (!messageId) throw new Error('Saved Workflow invocation requires a stable messageId');
  const replyRootId = input.replyRootId?.trim();
  const runRootMessageId = replyRootId || messageId;
  if (runRootMessageId.startsWith('oc_')) {
    throw new Error('Saved Workflow run binding requires a message root, not a chat id');
  }
  return {
    replyAnchor: replyRootId || input.anchor,
    runRootMessageId,
    quotaMessageId: messageId,
  };
}

export type V3SavedWorkflowPolicyResult =
  | { ok: true }
  | { ok: false; reason: 'global_requires_operate' | 'quota_denied' };

/**
 * One authorization seam shared by all Saved Workflow verbs. Read commands
 * consume quota too, so a command can never accidentally become a free CLI
 * path merely by moving code between read/write branches.
 */
export async function authorizeV3SavedWorkflowInvocation(
  command: ExecutableV3SavedWorkflowCommand,
  deps: {
    canPublishGlobal(): boolean;
    consumeMessageQuotaOnce(): Promise<boolean>;
  },
): Promise<V3SavedWorkflowPolicyResult> {
  if (command.kind === 'save' && command.global && !deps.canPublishGlobal()) {
    return { ok: false, reason: 'global_requires_operate' };
  }
  if (!await deps.consumeMessageQuotaOnce()) return { ok: false, reason: 'quota_denied' };
  return { ok: true };
}

export interface V3SavedWorkflowExecutionInput {
  command: ExecutableV3SavedWorkflowCommand;
  dataDir: string;
  baseDir: string;
  context: SavedWorkflowActorContext;
}

export interface V3SavedWorkflowExecutionDeps {
  listVisible: typeof listVisibleSavedWorkflows;
  resolveVisible: typeof resolveVisibleSavedWorkflow;
  loadCurrent: typeof loadCurrentSavedWorkflow;
  resolveOwnedRun: typeof resolveOwnedTerminalRunDir;
  saveRun: typeof saveTerminalRunAsWorkflow;
  instantiate: typeof instantiatePublishedSavedWorkflow;
  loadBots(): BotConfig[];
  persistStartIntent(runId: string, runDir: string): void;
  driveDetached(runId: string): void;
}

export type V3SavedWorkflowExecutionEffect =
  | 'read_completed'
  | 'save_committed'
  | 'run_started'
  | 'run_materialized_not_started'
  | 'failed';

export interface V3SavedWorkflowExecutionResult {
  effect: V3SavedWorkflowExecutionEffect;
  message: string;
}

/** Best-effort transport boundary kept outside the business execution try/catch. */
export async function deliverV3SavedWorkflowNotification(
  result: V3SavedWorkflowExecutionResult,
  send: (message: string) => Promise<void>,
  onError: (error: unknown, effect: V3SavedWorkflowExecutionEffect) => void,
): Promise<void> {
  try {
    await send(result.message);
  } catch (err) {
    onError(err, result.effect);
  }
}

function formatExecutionError(command: ExecutableV3SavedWorkflowCommand, err: unknown): string {
  const errorText = err instanceof Error ? err.message : String(err);
  const matches = (err as { matches?: Array<{ displayName: string; workflowId: string }> }).matches;
  const candidates = matches?.length
    ? `\n候选：\n${matches.map((item) => `- ${item.displayName} — ${item.workflowId}`).join('\n')}`
    : '';
  const runHint = command.kind === 'run' ? `\n${v3SavedWorkflowAdHocRunEscapeHint()}` : '';
  const unsafeSaveHint = command.kind === 'save' &&
    !command.acknowledgeUnsafeLiterals &&
    /Saved Workflow lint requires confirmation|acknowledgeUnsafeLiterals/.test(errorText)
    ? '\n若提示包含疑似 secret 或本机绝对路径，请先审查/脱敏；确认安全后在原命令末尾加 `--ack-unsafe` 重试。'
    : '';
  return `❌ Saved Workflow 命令失败：${errorText}${candidates}${runHint}${unsafeSaveHint}`;
}

export async function executeV3SavedWorkflowCommand(
  input: V3SavedWorkflowExecutionInput,
  deps: V3SavedWorkflowExecutionDeps,
): Promise<V3SavedWorkflowExecutionResult> {
  const { command, dataDir, baseDir, context } = input;
  try {
    if (command.kind === 'list') {
      const listed = await deps.listVisible({ dataDir, context });
      const lines = listed.entries.length === 0
        ? ['还没有 Saved Workflow。成功跑完后发 `/workflow save last [名称]` 即可固化。']
        : listed.entries.map((entry) =>
            `- ${entry.displayName} — \`${entry.workflowId}\` · ${entry.scope.kind} · ${entry.status}`,
          );
      if (listed.invalid.length > 0) lines.push(`\n⚠️ ${listed.invalid.length} 个目录项损坏，已隔离不展示。`);
      return { effect: 'read_completed', message: lines.join('\n') };
    }

    if (command.kind === 'show') {
      const metadata = await deps.resolveVisible({ dataDir, ref: command.ref, context });
      const loaded = await deps.loadCurrent(dataDir, metadata.workflowId, {
        revision: metadata.publishedRevision ? 'published' : 'latest',
        requireActive: false,
      });
      const params = Object.keys(loaded.revision.payload.inputs);
      return {
        effect: 'read_completed',
        message: [
          `Saved Workflow：${metadata.displayName}`,
          `workflowId: ${metadata.workflowId}`,
          `scope: ${metadata.scope.kind}`,
          `status: ${metadata.status}`,
          `revision: v${loaded.revision.payload.humanVersion} (${loaded.revision.revisionId})`,
          `params: ${params.length > 0 ? params.join(', ') : '(无)'}`,
          `source run: ${loaded.revision.payload.sourceRunId}`,
        ].join('\n'),
      };
    }

    if (command.kind === 'save') {
      const runDir = await deps.resolveOwnedRun({ baseDir, source: command.source, context });
      const result = await deps.saveRun({
        dataDir,
        runDir,
        context,
        ...(command.displayName ? { displayName: command.displayName } : {}),
        scope: command.global ? 'global' : 'chat',
        acknowledgeUnsafeLiterals: command.acknowledgeUnsafeLiterals,
      });
      return {
        effect: 'save_committed',
        message: [
          `✅ 已固化 Saved Workflow：${result.metadata.displayName}`,
          `workflowId: ${result.metadata.workflowId}`,
          `revision: v${result.revision.payload.humanVersion} (${result.revision.revisionId})`,
          `scope: ${result.metadata.scope.kind}`,
          `status: ${result.metadata.status}`,
        ].join('\n'),
      };
    }

    const rawParams = Object.create(null) as Record<string, RawParamInput>;
    for (const [name, value] of Object.entries(command.rawParams)) {
      rawParams[name] = { kind: 'string', value };
    }
    const materialized = await deps.instantiate({
      dataDir,
      ref: command.ref,
      context,
      rawParams,
      bots: deps.loadBots(),
      baseDir,
    });
    try {
      deps.persistStartIntent(materialized.runId, materialized.runDir);
      deps.driveDetached(materialized.runId);
    } catch (err) {
      return {
        effect: 'run_materialized_not_started',
        message:
          `⚠️ Saved Workflow 已物化但未启动：${materialized.runId}\n` +
          `原因：${err instanceof Error ? err.message : String(err)}\n` +
          `修复后可执行 botmux workflow start ${materialized.runId}，不要重复创建。`,
      };
    }
    return {
      effect: 'run_started',
      message:
        `✅ Saved Workflow 已启动：${materialized.runId}\n` +
        `definition: ${materialized.envelope.source.workflowId} v${materialized.envelope.source.humanVersion}`,
    };
  } catch (err) {
    return { effect: 'failed', message: formatExecutionError(command, err) };
  }
}

export const defaultV3SavedWorkflowExecutionServices = {
  listVisible: listVisibleSavedWorkflows,
  resolveVisible: resolveVisibleSavedWorkflow,
  loadCurrent: loadCurrentSavedWorkflow,
  resolveOwnedRun: resolveOwnedTerminalRunDir,
  saveRun: saveTerminalRunAsWorkflow,
  instantiate: instantiatePublishedSavedWorkflow,
} satisfies Pick<
  V3SavedWorkflowExecutionDeps,
  'listVisible' | 'resolveVisible' | 'loadCurrent' | 'resolveOwnedRun' | 'saveRun' | 'instantiate'
>;
