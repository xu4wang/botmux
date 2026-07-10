/** CLI adapter for v3 Saved Workflows. Core policy lives in library-service. */

import { dirname, resolve } from 'node:path';

import { loadBotConfigs } from '../bot-registry.js';
import { resolveCurrentTurnProvenance } from '../core/current-turn-provenance.js';
import { findOnlineDaemon } from '../utils/daemon-discovery.js';
import type { RawParamInput } from '../workflows/params.js';
import { defaultBaseDir } from '../workflows/v3/grill-state.js';
import {
  instantiatePublishedSavedWorkflow,
  listVisibleSavedWorkflows,
  resolveOwnedTerminalRunDir,
  resolveVisibleSavedWorkflow,
  saveTerminalRunAsWorkflow,
  type SavedWorkflowActorContext,
} from '../workflows/v3/library-service.js';
import { loadCurrentSavedWorkflow } from '../workflows/v3/library-store.js';
import { SAVED_WORKFLOW_PARAM_NAME_RE } from '../workflows/v3/library-schema.js';

const FORBIDDEN_PARAM_NAMES = new Set(['__proto__', 'prototype', 'constructor']);
const RUN_FLAGS_WITH_VALUE = new Set(['--library-dir', '--base-dir', '--run-id']);

function argValue(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && i + 1 < args.length) return args[i + 1];
    if (args[i]?.startsWith(`${flag}=`)) return args[i]!.slice(flag.length + 1);
  }
  return undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function positionals(args: string[], flagsWithValue: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (flagsWithValue.includes(token)) { i++; continue; }
    if (flagsWithValue.some((flag) => token.startsWith(`${flag}=`))) continue;
    if (token.startsWith('--')) continue;
    out.push(token);
  }
  return out;
}

export function contextFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  startPid: number = process.ppid,
): SavedWorkflowActorContext {
  const dataDir = env.SESSION_DATA_DIR;
  if (!dataDir) {
    throw new Error(
      'Saved Workflow save/run requires an authenticated current botmux turn ' +
      '(SESSION_DATA_DIR is unavailable)',
    );
  }
  const provenance = resolveCurrentTurnProvenance({
    dataDir,
    envSessionId: env.BOTMUX_SESSION_ID,
    startPid,
  });
  if (!provenance) {
    throw new Error('Saved Workflow save/run requires an authenticated current botmux turn');
  }
  return {
    actor: { larkAppId: provenance.larkAppId, openId: provenance.callerOpenId },
    chatId: provenance.chatId,
    ...(provenance.rootMessageId ? { rootMessageId: provenance.rootMessageId } : {}),
    sessionId: provenance.sessionId,
  };
}

function libraryDataDir(args: string[]): string {
  return argValue(args, '--library-dir') ?? dirname(defaultBaseDir());
}

function runsBaseDir(args: string[]): string {
  return argValue(args, '--base-dir') ?? defaultBaseDir();
}

/**
 * `workflow run` immediately asks the live daemon to start the materialized
 * run. That daemon only resolves ids under its canonical v3 root, so accepting
 * a different CLI directory would create a valid but permanently orphaned run.
 * Core materialization keeps an injectable baseDir for tests/migrations; the
 * user-facing start command does not.
 */
export function assertDaemonManagedRunBaseDir(baseDir: string, canonical = defaultBaseDir()): void {
  if (resolve(baseDir) !== resolve(canonical)) {
    throw new Error(
      `botmux workflow run 不支持自定义 --base-dir；daemon 仅从 ${canonical} 启动 v3 run`,
    );
  }
}

/** Agent-facing CLI cannot prove the daemon's per-chat `canOperate` policy. */
export function assertAgentFacingSaveScope(args: readonly string[]): void {
  if (args.includes('--global')) {
    throw new Error(
      'botmux workflow save 不接受 --global：请由用户在飞书中显式发送 ' +
      '`/workflow save [last|runId] [名称] --global`，由 daemon 校验 canOperate 权限',
    );
  }
  if (args.includes('--ack-unsafe')) {
    throw new Error(
      'botmux workflow save 不接受 --ack-unsafe：agent 不能代替用户确认疑似 secret/绝对路径；' +
      '请先向用户展示 lint，再由用户在飞书中显式发送原 `/workflow save ... --ack-unsafe` 命令',
    );
  }
}

export async function assertAgentFacingAppendScope(
  dataDir: string,
  workflowId: string,
  loadCurrent: typeof loadCurrentSavedWorkflow = loadCurrentSavedWorkflow,
): Promise<void> {
  const existing = await loadCurrent(dataDir, workflowId, {
    revision: 'latest',
    requireActive: false,
  });
  if (existing.metadata.scope.kind === 'global') {
    throw new Error(
      `agent-facing CLI 不能修改 global Saved Workflow ${workflowId}：` +
      '该操作需要 daemon 侧 canOperate 授权，当前版本请新建 chat scope 版本或等待 IM 编辑入口',
    );
  }
}

/**
 * Parse Saved Workflow CLI params without confusing another option's value for
 * a bare `key=value` param. The null-prototype result and reserved-name guard
 * keep `__proto__` from becoming an inherited assignment rather than input.
 */
export function collectSavedWorkflowRawParams(args: string[]): Record<string, RawParamInput> {
  const out = Object.create(null) as Record<string, RawParamInput>;
  const ingest = (pair: string | undefined, kind: 'string' | 'json' = 'string'): void => {
    if (!pair) throw new Error('参数必须是 key=value');
    const eq = pair.indexOf('=');
    if (eq <= 0) throw new Error(`参数必须是 key=value：${pair}`);
    const key = pair.slice(0, eq);
    if (!SAVED_WORKFLOW_PARAM_NAME_RE.test(key) || FORBIDDEN_PARAM_NAMES.has(key)) {
      throw new Error(`参数名非法：${key}`);
    }
    if (Object.prototype.hasOwnProperty.call(out, key)) throw new Error(`参数重复：${key}`);
    const value = pair.slice(eq + 1);
    if (kind === 'json') {
      try {
        out[key] = { kind: 'json', value: JSON.parse(value) as unknown };
      } catch (err) {
        throw new Error(
          `--param-json ${key} 不是有效 JSON：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      out[key] = { kind: 'string', value };
    }
  };

  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token === '--param') {
      ingest(args[++i]);
      continue;
    }
    if (token.startsWith('--param=')) {
      ingest(token.slice('--param='.length));
      continue;
    }
    if (token === '--param-json') {
      ingest(args[++i], 'json');
      continue;
    }
    if (token.startsWith('--param-json=')) {
      ingest(token.slice('--param-json='.length), 'json');
      continue;
    }
    if (RUN_FLAGS_WITH_VALUE.has(token)) {
      // The value may legitimately contain '=' (for example a filesystem
      // path); it belongs to the option, never to workflow params.
      if (i + 1 < args.length) i++;
      continue;
    }
    if ([...RUN_FLAGS_WITH_VALUE].some((flag) => token.startsWith(`${flag}=`))) continue;
    if (!token.startsWith('--') && token.includes('=') && i > 0) ingest(token);
  }
  return out;
}

async function startMaterializedRun(runId: string, larkAppId: string): Promise<void> {
  const daemon = findOnlineDaemon(larkAppId);
  if (!daemon) throw new Error(`bot ${larkAppId} 的 daemon 不在线，run 已物化但尚未启动：${runId}`);
  const res = await fetch(
    `http://127.0.0.1:${daemon.ipcPort}/api/v3/runs/${encodeURIComponent(runId)}/start`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
  );
  const body = await res.text();
  if (!res.ok) throw new Error(`daemon start 失败 (HTTP ${res.status}): ${body}`);
}

export async function cmdSavedWorkflow(sub: string, args: string[]): Promise<void> {
  const context = contextFromEnv();
  const dataDir = libraryDataDir(args);
  const baseDir = runsBaseDir(args);
  const json = hasFlag(args, '--json');

  if (sub === 'save') {
    // Global publication is an IM authorization decision (`canOperate`), not
    // something an agent-facing child process can prove from session files.
    // Keep this path chat-scoped and require the daemon-owned slash command
    // for the privileged scope transition.
    assertAgentFacingSaveScope(args);
    const positional = positionals(args, [
      '--library-dir', '--base-dir', '--workflow-id', '--expected-revision',
    ]);
    const source = positional[0] ?? 'last';
    const displayName = positional.slice(1).join(' ').trim() || undefined;
    const workflowId = argValue(args, '--workflow-id');
    if (workflowId) await assertAgentFacingAppendScope(dataDir, workflowId);
    const runDir = await resolveOwnedTerminalRunDir({ baseDir, source, context });
    const result = await saveTerminalRunAsWorkflow(workflowId ? {
      dataDir,
      runDir,
      context,
      workflowId,
      expectedLatestRevision: argValue(args, '--expected-revision'),
      allowDraft: hasFlag(args, '--allow-draft'),
      acknowledgeUnsafeLiterals: false,
    } : {
      dataDir,
      runDir,
      context,
      ...(displayName ? { displayName } : {}),
      scope: 'chat',
      allowDraft: hasFlag(args, '--allow-draft'),
      acknowledgeUnsafeLiterals: false,
    });
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(
        `${result.created ? '✅ 已保存' : '✅ 已追加版本'}：${result.metadata.displayName}\n` +
        `workflowId: ${result.metadata.workflowId}\n` +
        `revision: ${result.revision.revisionId} (v${result.revision.payload.humanVersion})\n` +
        `status: ${result.metadata.status}`,
      );
    }
    return;
  }

  if (sub === 'run') {
    assertDaemonManagedRunBaseDir(baseDir);
    const positional = positionals(args, ['--library-dir', '--base-dir', '--param', '--param-json', '--run-id']);
    const ref = positional.find((token) => !token.includes('='));
    if (!ref) throw new Error('用法: botmux workflow run <名称|workflowId> [--param key=value]');
    const materialized = await instantiatePublishedSavedWorkflow({
      dataDir,
      ref,
      context,
      rawParams: collectSavedWorkflowRawParams(args),
      bots: loadBotConfigs(),
      baseDir,
      runId: argValue(args, '--run-id'),
    });
    await startMaterializedRun(materialized.runId, context.actor.larkAppId);
    if (json) console.log(JSON.stringify({ runId: materialized.runId, runDir: materialized.runDir }, null, 2));
    else console.log(`✅ Saved Workflow 已启动：${materialized.runId}`);
    return;
  }

  if (sub === 'list' || sub === 'ls') {
    const listed = await listVisibleSavedWorkflows({ dataDir, context });
    if (json) console.log(JSON.stringify(listed, null, 2));
    else if (listed.entries.length === 0) {
      console.log('还没有 Saved Workflow。成功跑完一次后用 `botmux workflow save last [名称]` 固化。');
    } else {
      for (const entry of listed.entries) {
        console.log(
          `${entry.displayName}\t${entry.workflowId}\t${entry.scope.kind}\t${entry.status}` +
          `${entry.publishedRevision ? `\t${entry.publishedRevision}` : ''}`,
        );
      }
    }
    return;
  }

  if (sub === 'show') {
    const ref = positionals(args, ['--library-dir', '--base-dir'])[0];
    if (!ref) throw new Error('用法: botmux workflow show <名称|workflowId>');
    const metadata = await resolveVisibleSavedWorkflow({ dataDir, ref, context });
    const loaded = await loadCurrentSavedWorkflow(dataDir, metadata.workflowId, {
      revision: metadata.publishedRevision ? 'published' : 'latest',
      requireActive: false,
    });
    console.log(JSON.stringify(loaded, null, 2));
    return;
  }

  throw new Error(`未知 Saved Workflow 子命令：${sub}`);
}
