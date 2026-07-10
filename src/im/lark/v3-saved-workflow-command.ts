/** Lightweight IM parser for the Saved Workflow portion of `/workflow`. */

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const FORBIDDEN_PARAM_NAMES = new Set(['__proto__', 'prototype', 'constructor']);

const AD_HOC_RUN_ESCAPE_HINT =
  '如果你是想发起一个以“run”开头的即兴目标，请用 `/workflow new run ...`。';

export type V3SavedWorkflowCommand =
  | {
      kind: 'save';
      source: 'last' | string;
      displayName?: string;
      global: boolean;
      acknowledgeUnsafeLiterals: boolean;
    }
  | { kind: 'run'; ref: string; rawParams: Record<string, string> }
  | { kind: 'list' }
  | { kind: 'show'; ref: string }
  | { kind: 'invalid'; error: string };

/**
 * Return null for ordinary ad-hoc goals and non-workflow messages. The daemon
 * invokes this before the grill parser, so reserved verbs can never become an
 * accidental natural-language DAG goal.
 */
export function parseV3SavedWorkflowCommand(content: string): V3SavedWorkflowCommand | null {
  const match = /^\/workflow(?:\s+([\s\S]*))?$/.exec(content.trim());
  if (!match) return null;
  const tail = (match[1] ?? '').trim();
  if (!tail) return null;
  const tokens = tail.split(/\s+/);
  const sub = tokens[0]!.toLowerCase();
  if (!['save', 'run', 'list', 'show'].includes(sub)) return null;

  if (sub === 'list') {
    return tokens.length === 1 ? { kind: 'list' } : { kind: 'invalid', error: '/workflow list 不接受其它参数' };
  }
  if (sub === 'show') {
    const ref = tokens.slice(1).join(' ').trim();
    if (!ref) return { kind: 'invalid', error: '用法：/workflow show <名称或 workflowId>' };
    return { kind: 'show', ref };
  }
  if (sub === 'save') {
    const firstSaveArg = tokens[1];
    // Flags do not force callers to spell the optional `last` source:
    // `/workflow save --ack-unsafe` retries the latest owned run.
    const source = firstSaveArg && !firstSaveArg.startsWith('--') ? firstSaveArg : 'last';
    if (source !== 'last' && !SAFE_RUN_ID.test(source)) {
      return { kind: 'invalid', error: 'save 的 runId 非法' };
    }
    const rest = tokens.slice(source === 'last' && firstSaveArg?.startsWith('--') ? 1 : 2);
    const global = rest.includes('--global');
    const acknowledgeUnsafeLiterals = rest.includes('--ack-unsafe');
    const nameTokens = rest.filter((token) => token !== '--global' && token !== '--ack-unsafe');
    const displayName = nameTokens.join(' ').trim();
    return {
      kind: 'save',
      source,
      ...(displayName ? { displayName } : {}),
      global,
      acknowledgeUnsafeLiterals,
    };
  }

  const runTokens = tokens.slice(1);
  const firstParamIndex = runTokens.findIndex((token) => token.includes('='));
  const refTokens = firstParamIndex === -1 ? runTokens : runTokens.slice(0, firstParamIndex);
  const ref = refTokens.join(' ').trim();
  if (!ref) {
    return {
      kind: 'invalid',
      error: `用法：/workflow run <名称或 workflowId> [key=value ...]。${AD_HOC_RUN_ESCAPE_HINT}`,
    };
  }
  const rawParams = Object.create(null) as Record<string, string>;
  const paramTokens = firstParamIndex === -1 ? [] : runTokens.slice(firstParamIndex);
  for (const token of paramTokens) {
    const eq = token.indexOf('=');
    if (eq <= 0) {
      return {
        kind: 'invalid',
        error: `参数必须是 key=value：${token}。${AD_HOC_RUN_ESCAPE_HINT}`,
      };
    }
    const key = token.slice(0, eq);
    if (!SAFE_PARAM_NAME.test(key) || FORBIDDEN_PARAM_NAMES.has(key)) {
      return { kind: 'invalid', error: `参数名非法：${key}` };
    }
    if (Object.prototype.hasOwnProperty.call(rawParams, key)) {
      return { kind: 'invalid', error: `参数重复：${key}` };
    }
    rawParams[key] = token.slice(eq + 1);
  }
  return { kind: 'run', ref, rawParams };
}

export function v3SavedWorkflowUsage(): string {
  return [
    'Saved Workflow：',
    '/workflow save [last|runId] [名称] [--global] [--ack-unsafe]',
    '/workflow run <名称或 workflowId> [key=value ...]',
    '/workflow list',
    '/workflow show <名称或 workflowId>',
    '若即兴目标本身以 run 开头，请使用 /workflow new run ...',
  ].join('\n');
}

/** Actionable hint shared by the IM execution adapter when a multi-word
 * `run ...` lookup fails and the user may have intended an ad-hoc goal. */
export function v3SavedWorkflowAdHocRunEscapeHint(): string {
  return AD_HOC_RUN_ESCAPE_HINT;
}
