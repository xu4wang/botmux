/**
 * v3 architect runner.
 *
 * The grill layer produces `spec.md` + canonical `spec.json`; architect is a
 * single autonomous goal-worker that compiles those files into `dag.json` plus
 * `architect-notes.md`.  This helper keeps that fixed execution contract in one
 * place so host commands do not hand-roll goal-mode env/layout details.
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createEphemeralPool, type EphemeralPoolDeps } from './ephemeral-pool.js';
import { readAndValidateManifest, ManifestValidationError } from './manifest.js';
import {
  GOAL_ENV,
  SPEC_SCHEMA_VERSION,
  type BotSnapshot,
  type Manifest,
  type RunNode,
  type RunNodeRequest,
  type ValidateManifest,
  type WorkerSessionInfo,
} from './contract.js';

const ARCHITECT_NODE_ID = 'architect';
const ARCHITECT_ATTEMPT_ID = 'architect/attempts/001';

export interface RunArchitectInput {
  runId: string;
  runDir: string;
  specPath: string;
  specJsonPath: string;
  botSnapshot: BotSnapshot;
  timeoutMs?: number;
  cancelSignal?: AbortSignal;
  /**
   * Test seam.  Production callers normally omit this and provide
   * `resolveLarkAppSecret` so the real ephemeral pool is used.
   */
  runNode?: RunNode;
  resolveLarkAppSecret?: EphemeralPoolDeps['resolveLarkAppSecret'];
  validateManifest?: ValidateManifest;
}

export interface RunArchitectResult {
  status: 'ok' | 'fail';
  dagPath?: string;
  notesPath?: string;
  manifestPath: string;
  problems?: string[];
  sessionInfo?: WorkerSessionInfo;
}

export function buildArchitectGoal(specPath: string, specJsonPath: string): string {
  const sketchFields = [
    'sketchId',
    'goal',
    'input_needs',
    'expected_outputs',
    'acceptance',
    'risk_gate',
    'unknowns',
  ].join(', ');
  return [
    'You are the botmux v3 workflow architect.',
    '',
    'Inputs:',
    `- Canonical machine-readable spec: ${specJsonPath}`,
    `- Human narrative spec: ${specPath}`,
    '',
    'Task:',
    `- Read the canonical spec first; it must use schemaVersion ${SPEC_SCHEMA_VERSION}. Use the narrative spec only for context.`,
    `- Each node sketch has these fields: ${sketchFields}.`,
    '- Compile the spec into a valid botmux v3 DAG JSON.',
    '- Write exactly two primary files under the output directory:',
    '  1. dag.json',
    '  2. architect-notes.md',
    '- Do not start or run the workflow. Do not call botmux v3 run.',
    '- The host will validate dag.json with botmux v3 DAG validation and ask the human to review it.',
    '',
    'dag.json requirements:',
    '- Use the v3 DAG schema: { runId, nodes: [{ id, type:"goal", goal, bot?, depends, inputs, timeoutSec?, humanGate? }] }.',
    '- Convert each spec node sketch into one goal node unless the spec explicitly says to merge or drop it.',
    '- Treat input_needs as free-text requirements, NOT as pre-authored edges. Infer depends/inputs only when the dependency is justified by the spec.',
    '- Preserve risk_gate=true as a humanGate prompt on the corresponding node.',
    '- Estimate a per-node timeoutSec from the task size — err on the GENEROUS side (completion is detected early via the manifest, so an oversized budget costs nothing): quick single-file edits ~600, typical research/writing ~1800, long research / refactor / audit tasks 3600-7200. Hard ceiling 14400 (4h). Omit it only for trivially small nodes (default is 1800).',
    '- Keep node ids path-safe: [A-Za-z0-9._-].',
    '- Ensure the graph is acyclic and every inputs.from also appears in depends.',
    '',
    'architect-notes.md requirements:',
    '- Summarize the DAG structure and the reasoning for dependencies/gates.',
    '- List any assumptions or unresolved risks for human review.',
  ].join('\n');
}

export async function runArchitect(input: RunArchitectInput): Promise<RunArchitectResult> {
  const attemptDir = join(input.runDir, 'architect', 'attempts', '001');
  const outputDir = join(attemptDir, 'work');
  const inputsPath = join(attemptDir, 'inputs.json');
  const manifestPath = join(attemptDir, 'manifest.json');
  const goalPath = join(attemptDir, 'goal.txt');
  mkdirSync(outputDir, { recursive: true });

  const goal = buildArchitectGoal(input.specPath, input.specJsonPath);
  const inputs = {
    inputs: [
      { from: 'grill', name: 'spec.json', path: input.specJsonPath, kind: 'json' },
      { from: 'grill', name: 'spec.md', path: input.specPath, kind: 'markdown' },
    ],
  };

  const req: RunNodeRequest = {
    runId: input.runId,
    attemptId: ARCHITECT_ATTEMPT_ID,
    node: {
      id: ARCHITECT_NODE_ID,
      type: 'goal',
      goal,
      bot: input.botSnapshot.larkAppId,
      depends: [],
      inputs: [],
      timeoutSec: Math.ceil((input.timeoutMs ?? 10 * 60_000) / 1000),
      humanGate: null,
    },
    botSnapshot: input.botSnapshot,
    runDir: input.runDir,
    attemptDir,
    inputsPath,
    outputDir,
    env: {
      [GOAL_ENV.GOAL_PATH]: goalPath,
      [GOAL_ENV.INPUTS_PATH]: inputsPath,
      [GOAL_ENV.OUTPUT_DIR]: outputDir,
      [GOAL_ENV.MANIFEST_PATH]: manifestPath,
      [GOAL_ENV.ATTEMPT_DIR]: attemptDir,
      [GOAL_ENV.V3_MARKER]: '1',
    },
    timeoutMs: input.timeoutMs ?? 10 * 60_000,
    cancelSignal: input.cancelSignal,
    stdoutPath: join(attemptDir, 'stdout.log'),
    stderrPath: join(attemptDir, 'stderr.log'),
  };

  await writeJsonFile(goalPath, goal);
  await writeJsonFile(inputsPath, inputs);

  const runNode = input.runNode ?? realRunNode(input.resolveLarkAppSecret);
  const validateManifest = input.validateManifest ?? defaultValidateManifest;
  const runResult = await runNode(req);
  const verdict = await validateManifest(runResult.manifestPath, outputDir);

  if (runResult.status !== 'ok') {
    return {
      status: 'fail',
      manifestPath: runResult.manifestPath,
      problems: ['architect worker failed before producing a successful result'],
      sessionInfo: runResult.sessionInfo,
    };
  }
  if (!verdict.ok || !verdict.manifest) {
    return {
      status: 'fail',
      manifestPath: runResult.manifestPath,
      problems: verdict.problems ?? ['architect manifest is invalid'],
      sessionInfo: runResult.sessionInfo,
    };
  }
  if (verdict.manifest.status !== 'ok') {
    return {
      status: 'fail',
      manifestPath: runResult.manifestPath,
      problems: [formatManifestError(verdict.manifest)],
      sessionInfo: runResult.sessionInfo,
    };
  }

  const dagPath = manifestPathFor(verdict.manifest, outputDir, 'dag.json');
  const notesPath = manifestPathFor(verdict.manifest, outputDir, 'architect-notes.md');
  const problems = [
    ...(dagPath ? [] : ['architect manifest must include dag.json']),
    ...(notesPath ? [] : ['architect manifest must include architect-notes.md']),
  ];
  if (problems.length > 0) {
    return {
      status: 'fail',
      manifestPath: runResult.manifestPath,
      problems,
      sessionInfo: runResult.sessionInfo,
    };
  }
  return {
    status: 'ok',
    manifestPath: runResult.manifestPath,
    dagPath,
    notesPath,
    sessionInfo: runResult.sessionInfo,
  };
}

function realRunNode(resolveLarkAppSecret: RunArchitectInput['resolveLarkAppSecret']): RunNode {
  if (!resolveLarkAppSecret) {
    throw new Error('runArchitect requires resolveLarkAppSecret when runNode is not injected');
  }
  return createEphemeralPool({ resolveLarkAppSecret }).runNode;
}

async function defaultValidateManifest(manifestPath: string, outputDir: string) {
  try {
    return { ok: true as const, manifest: await readAndValidateManifest(manifestPath, outputDir) };
  } catch (e) {
    return {
      ok: false as const,
      problems: e instanceof ManifestValidationError ? e.problems : [String(e)],
    };
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

function manifestPathFor(manifest: Manifest, outputDir: string, expectedPath: string): string | undefined {
  const file = manifest.files.find((f) => f.path === expectedPath || f.name === expectedPath);
  if (!file) return undefined;
  const path = join(outputDir, file.path);
  try {
    readFileSync(path);
  } catch {
    return undefined;
  }
  return path;
}

function formatManifestError(manifest: Manifest): string {
  if (!manifest.error) return 'architect reported failure without error details';
  return `${manifest.error.code}: ${manifest.error.message}`;
}
