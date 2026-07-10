import type { V3DagTemplate, SavedWorkflowBuiltinContextRef, SavedWorkflowParamDef } from './library-schema.js';
import type { V3Node } from './dag.js';

const MARKER_RE = /\$\{(params|context)\.([A-Za-z_][A-Za-z0-9_]{0,63})\}/g;

export interface SavedWorkflowTemplateBindings {
  params: string[];
  context: SavedWorkflowBuiltinContextRef[];
}

function collectFromText(text: string | undefined): SavedWorkflowTemplateBindings {
  const params = new Set<string>();
  const context = new Set<SavedWorkflowBuiltinContextRef>();
  if (text) {
    MARKER_RE.lastIndex = 0;
    for (let match = MARKER_RE.exec(text); match; match = MARKER_RE.exec(text)) {
      if (match[1] === 'params') params.add(match[2]!);
      else context.add(match[2] as SavedWorkflowBuiltinContextRef);
    }
  }
  return { params: [...params], context: [...context] };
}

/** Bindings a single goal worker is authorized to receive. */
export function savedWorkflowBindingsForNode(node: V3Node): SavedWorkflowTemplateBindings {
  const goal = collectFromText(node.goal);
  const instructions = collectFromText(node.override?.systemPromptAppend);
  return {
    params: [...new Set([...goal.params, ...instructions.params])],
    context: [...new Set([...goal.context, ...instructions.context])],
  };
}

/**
 * Validate all markers and keep topology/bot/gate fields non-parameterized.
 * Human gate prompts are deliberately structural/safety text in P0: the host
 * cannot ask a person to approve an unresolved `${params.x}` target.
 */
export function assertSavedWorkflowTemplateBindings(
  dagTemplate: V3DagTemplate,
  inputs: Record<string, SavedWorkflowParamDef>,
  contextRefs: readonly SavedWorkflowBuiltinContextRef[],
): void {
  const allowedTextPath = (path: string): boolean =>
    path.endsWith('.goal') || path.endsWith('.override.systemPromptAppend');

  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      if (!value.includes('${')) return;
      if (!allowedTextPath(path)) {
        throw new Error(
          `Saved Workflow template marker is not allowed in structural/safety field ${path}; ` +
          'rewrite the literal before saving',
        );
      }
      const covered = new Array<boolean>(value.length).fill(false);
      MARKER_RE.lastIndex = 0;
      for (let match = MARKER_RE.exec(value); match; match = MARKER_RE.exec(value)) {
        const [whole, namespace, name] = match;
        for (let i = match.index; i < match.index + whole.length; i++) covered[i] = true;
        if (namespace === 'params' && !Object.prototype.hasOwnProperty.call(inputs, name)) {
          throw new Error(`Saved Workflow template references undeclared parameter ${name} at ${path}`);
        }
        if (namespace === 'context' && !contextRefs.includes(name as SavedWorkflowBuiltinContextRef)) {
          throw new Error(`Saved Workflow template references undeclared context ${name} at ${path}`);
        }
      }
      for (let i = value.indexOf('${'); i >= 0; i = value.indexOf('${', i + 2)) {
        if (!covered[i]) {
          throw new Error(
            `Saved Workflow has malformed/unsupported template marker at ${path}; ` +
            'rewrite literal `${...}` text before saving',
          );
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        walk(child, `${path}.${key}`);
      }
    }
  };
  walk(dagTemplate, 'dagTemplate');
}
