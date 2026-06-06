/**
 * v3 blocked 重试卡点击处理 —— card-handler 的 v3 分支（对称于
 * `v3-gate-card-handler`）。把一次「🔄 重试」点击翻译成：
 * 权限校验 → `requestV3Retry`（幂等：unconsumed reservation → already-requested）
 * → 冻结卡 / toast + 触发 `driveV3Run` 以新 attempt 重跑。
 *
 * 纯逻辑 + 注入 seam（requestRetry / driveRun / canResolve），单测友好。
 */

import { join } from 'node:path';
import {
  V3_BLOCKED_RETRY_ACTION,
  buildV3BlockedCard,
  v3BlockedCardNonce,
  type V3BlockedActionValue,
} from './v3-blocked-card.js';
import { requestV3Retry, blockedInfoFor } from '../../workflows/v3/daemon-run.js';
import { readJournal } from '../../workflows/v3/journal.js';
import {
  readGrillState,
  defaultBaseDir,
  type RunChatBinding,
} from '../../workflows/v3/grill-state.js';
import { isValidRunId } from '../../workflows/v3/ops-projection.js';

export function isV3BlockedAction(action: unknown): boolean {
  return action === V3_BLOCKED_RETRY_ACTION;
}

export interface V3BlockedCardHandlerDeps {
  baseDir?: string;
  /** Re-enter the run after a retry append.  Fire-and-forget (daemon logs errors). */
  driveRun: (runId: string) => void;
  /** Permission: may this operator retry nodes of this run?  Same semantics as
   *  the gate handler's canResolve (daemon injects a canOperate-backed check). */
  canResolve?: (binding: RunChatBinding | undefined, operatorOpenId: string | undefined) => boolean;
  /** Injectable for tests. Default = real requestV3Retry. */
  requestRetry?: typeof requestV3Retry;
}

/**
 * Handle a v3 blocked-card retry click.  Returns the Lark card-action response:
 * a frozen「已重试」card, or a `{ toast }`.  Triggers `driveRun` on success.
 */
export async function handleV3BlockedAction(
  value: V3BlockedActionValue,
  operatorOpenId: string | undefined,
  deps: V3BlockedCardHandlerDeps,
): Promise<unknown> {
  const baseDir = deps.baseDir ?? defaultBaseDir();
  if (!isValidRunId(value.runId)) {
    return { toast: { type: 'warning', content: '重试已失效（非法 run）' } };
  }
  // attempt 入 nonce：重试过的节点（attempt 已前进）的旧卡 nonce 对不上 → stale。
  if (value.nonce !== v3BlockedCardNonce(value.runId, value.nodeId, value.attemptId)) {
    return { toast: { type: 'warning', content: '重试卡已失效（nonce 不匹配）' } };
  }
  const runDir = join(baseDir, value.runId);
  const grill = readGrillState(runDir);
  const binding = grill?.chatBinding;

  if (deps.canResolve && !deps.canResolve(binding, operatorOpenId)) {
    return { toast: { type: 'warning', content: '你没有权限重试这个节点' } };
  }

  const requestRetry = deps.requestRetry ?? requestV3Retry;
  let outcome;
  try {
    // expectedAttemptId（codex blocker）：nonce 只证明这张卡自身没被改，证不了
    // 它指向的 attempt 还是"当前 blocked 的那个"——core 必须再比一次，否则
    // 001 的旧卡能把 002 的 blocked 推进到 003。
    outcome = requestRetry(baseDir, value.runId, {
      nodeId: value.nodeId,
      expectedAttemptId: value.attemptId,
    });
  } catch (err) {
    return {
      toast: {
        type: 'error',
        content: `重试失败，请再试：${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  if (outcome.kind === 'stale-run') {
    return {
      toast: {
        type: 'warning',
        content:
          outcome.reason === 'missing' ? '该 run 不存在或已清理'
          : outcome.reason === 'stale-attempt' ? '该节点已进入新一轮 attempt，这张旧卡失效（看最新那张卡）'
          : '该节点已不在受阻状态，重试卡失效',
      },
    };
  }
  if (outcome.kind === 'already-requested') {
    // Idempotent: a prior click already reserved the retry — make sure the
    // run is actually moving (covers click → daemon crash → click after restart).
    deps.driveRun(value.runId);
    return { toast: { type: 'info', content: '已在重试中' } };
  }

  // requested → drive the run (fresh replay re-dispatches with the reserved
  // attempt) + freeze this card.
  deps.driveRun(value.runId);
  const events = readJournal(join(runDir, 'journal.ndjson'));
  const info = blockedInfoFor(events, value.nodeId);
  const frozen = buildV3BlockedCard({
    runId: value.runId,
    nodeId: value.nodeId,
    attemptId: value.attemptId,
    errorClass: info.errorClass,
    errorCode: info.errorCode,
    message: info.message,
    retried: { nextAttemptId: outcome.nextAttemptId, by: operatorOpenId },
  });
  return JSON.parse(frozen);
}
