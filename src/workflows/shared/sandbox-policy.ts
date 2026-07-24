import type { DaemonToWorker } from '../../types.js';

type WorkerInit = Extract<DaemonToWorker, { type: 'init' }>;

export type WorkflowSandboxPolicySource = {
  sandbox?: boolean;
  /** New three-tier fs-policy lists (deny-by-default). Must be carried through
   *  the whole workflow chain so workflow workers get the SAME policy as a
   *  normal session — legacy sandboxHidePaths/sandboxReadonlyPaths alone lose
   *  the readWrite tier and any deny the user expressed via sandboxPaths. */
  sandboxPaths?: { readWrite?: string[]; readOnly?: string[]; deny?: string[] };
  sandboxHidePaths?: string[];
  sandboxReadonlyPaths?: string[];
  sandboxNetwork?: boolean;
};

export type WorkflowSandboxInitFields = Pick<
  WorkerInit,
  'sandbox' | 'sandboxPaths' | 'sandboxHidePaths' | 'sandboxReadonlyPaths' | 'sandboxNetwork'
>;

export function workflowSandboxInitFields(
  policy: WorkflowSandboxPolicySource | undefined,
): WorkflowSandboxInitFields {
  const sp = policy?.sandboxPaths;
  return {
    sandbox: policy?.sandbox === true,
    // Only forward sandboxPaths when present so the worker's `cfg.sandboxPaths ??
    // legacyMapped?.sandboxPaths` fallback keeps working for legacy-only configs.
    ...(sp
      ? {
          sandboxPaths: {
            ...(sp.readWrite ? { readWrite: [...sp.readWrite] } : {}),
            ...(sp.readOnly ? { readOnly: [...sp.readOnly] } : {}),
            ...(sp.deny ? { deny: [...sp.deny] } : {}),
          },
        }
      : {}),
    sandboxHidePaths: [...(policy?.sandboxHidePaths ?? [])],
    sandboxReadonlyPaths: [...(policy?.sandboxReadonlyPaths ?? [])],
    sandboxNetwork: policy?.sandboxNetwork !== false,
  };
}
