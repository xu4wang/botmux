/**
 * v3 blocked-node 重试卡 —— blocked/failed 两档里 blocked（契约性失败，可恢复）
 * 的飞书入口。daemon 驱动的 run 走到 runBlocked 时发这张卡；点「重试」=
 * `requestV3Retry`（append nodeRetryRequested）+ 重驱动，幂等沿 humanGate wait
 * 那套思路（codex 拍的第一版边界：卡只带 runId/nodeId/attemptId/errorCode/
 * message + Retry，不塞 live 终端 / 复杂诊断）。
 *
 * 自带 action namespace（`v3_blocked_retry`），不与 gate 卡混用。纯函数，单测友好。
 */

import { config } from '../../config.js';

export const V3_BLOCKED_RETRY_ACTION = 'v3_blocked_retry';

/** card 按钮回传的 value 形态——v3-blocked-card-handler 据此解析。 */
export interface V3BlockedActionValue {
  action: typeof V3_BLOCKED_RETRY_ACTION;
  runId: string;
  nodeId: string;
  /** 受阻的 attemptId —— nonce 按它推导，旧 attempt 的 stale 卡天然失效。 */
  attemptId: string;
  nonce: string;
}

export interface V3BlockedCardInput {
  runId: string;
  nodeId: string;
  attemptId: string;
  errorClass?: string;
  errorCode?: string;
  message?: string;
  /** 省略则按 runId/nodeId/attemptId 推导（幂等校验用）。 */
  nonce?: string;
  webDetailUrl?: string;
  messageMaxChars?: number;
  /** 有值 → 渲染冻结的「已重试」卡（无按钮，防 stale UI 重复提交）。 */
  retried?: { nextAttemptId: string; by?: string };
}

const DEFAULT_MESSAGE_MAX_CHARS = 500;

/** 稳定 nonce：同一 run 同一节点同一 attempt 的卡 nonce 固定（重发卡一致）；
 *  attempt 入 nonce —— 重试后旧卡的 nonce 对不上新 attempt，不会误触。 */
export function v3BlockedCardNonce(runId: string, nodeId: string, attemptId: string): string {
  return `v3blocked:${runId}:${nodeId}:${attemptId}`;
}

function v3RunDetailUrl(runId: string): string {
  return `http://${config.dashboard.externalHost}:${config.dashboard.port}/#/v3/${encodeURIComponent(runId)}`;
}

export function buildV3BlockedCard(input: V3BlockedCardInput): string {
  const nonce = input.nonce ?? v3BlockedCardNonce(input.runId, input.nodeId, input.attemptId);
  const webDetailUrl = input.webDetailUrl ?? v3RunDetailUrl(input.runId);
  const msgMax = input.messageMaxChars ?? DEFAULT_MESSAGE_MAX_CHARS;
  const retried = input.retried;

  const title = retried ? `已重试：节点 ${input.nodeId}` : `节点受阻：${input.nodeId}`;
  // amber/orange = 受阻可恢复（区别于 gate 蓝 / 失败红）；重试后转绿。
  const template = retried ? 'green' : 'orange';

  const attemptNNN = input.attemptId.slice(input.attemptId.lastIndexOf('/') + 1);
  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'div',
      fields: [
        { is_short: true, text: { tag: 'lark_md', content: `**Run**\n${escapeMd(short(input.runId, 24))}` } },
        { is_short: true, text: { tag: 'lark_md', content: `**节点 / attempt**\n${escapeMd(input.nodeId)} · ${escapeMd(attemptNNN)}` } },
      ],
    },
    { tag: 'hr' },
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content:
          `**原因**\n${escapeMd(input.errorClass ?? 'blocked')}` +
          (input.errorCode ? ` · \`${escapeMd(input.errorCode)}\`` : '') +
          (input.message ? `\n${escapeMd(truncate(input.message, msgMax))}` : ''),
      },
    },
  ];

  if (retried) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content:
          `🔄 已重试 → ${escapeMd(retried.nextAttemptId.slice(retried.nextAttemptId.lastIndexOf('/') + 1))}` +
          (retried.by ? ` · by ${escapeMd(short(retried.by, 20))}` : ''),
      },
    });
  } else {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: '处理掉阻塞原因（如完成鉴权）后点重试，会以新 attempt 重跑该节点。' },
    });
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '🔄 重试' },
          type: 'primary',
          value: {
            action: V3_BLOCKED_RETRY_ACTION,
            runId: input.runId,
            nodeId: input.nodeId,
            attemptId: input.attemptId,
            nonce,
          } satisfies V3BlockedActionValue,
        },
      ],
    });
  }

  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: 'Web 详情' },
        type: 'default',
        multi_url: {
          url: webDetailUrl, pc_url: webDetailUrl, android_url: webDetailUrl, ios_url: webDetailUrl,
        },
      },
    ],
  });

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { template, title: { tag: 'plain_text', content: title } },
    elements,
  });
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…（截断，完整见 Web 详情）`;
}

function short(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/** 转义 lark_md 里会被解析的字符，防 message 注入破坏卡片结构。 */
function escapeMd(s: string): string {
  return s.replace(/[\\*_~`\[\]]/g, (c) => `\\${c}`);
}
