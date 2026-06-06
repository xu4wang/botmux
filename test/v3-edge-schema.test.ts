/**
 * v3 edge activation — schema 层测试（edge-activation design 2026-06-06 §8）。
 *
 * 覆盖 validateDag 的条件边 / triggerRule / enum 子集规则、Kahn 对条件边的
 * 环检测、findSinks 的 `.from` 适配，以及 validateResult / renderGoalFile 的
 * enum 行为。引擎层（edgeResolved / skipped / decideNext）测试随 codex 的
 * 引擎实现落地，不在本文件。
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  validateDag,
  DagValidationError,
  type V3ResultSchema,
} from '../src/workflows/v3/dag.js';
import { findSinks } from '../src/workflows/v3/orchestrator.js';
import { renderGoalFile, validateResult } from '../src/workflows/v3/runtime.js';

// ─── helpers ────────────────────────────────────────────────────────────────

const decisionSchema: V3ResultSchema = {
  type: 'object',
  properties: { decision: { type: 'string', enum: ['pass', 'fail'] } },
  required: ['decision'],
};

/** 最小合法 goal 节点。 */
function goal(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, type: 'goal', goal: `do ${id}`, depends: [], inputs: [], ...extra };
}

function dag(nodes: Record<string, unknown>[]): Record<string, unknown> {
  return { runId: 'edge-test', nodes };
}

function problemsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof DagValidationError) return err.problems;
    throw err;
  }
  return [];
}

// ─── depends 归一化 ─────────────────────────────────────────────────────────

describe('validateDag: depends 归一化', () => {
  it('string / {from} / {from,when} 混排归一化为 V3DependRef[]', () => {
    const d = validateDag(
      dag([
        goal('build'),
        goal('review', { resultSchema: decisionSchema }),
        goal('deploy', {
          depends: ['build', { from: 'review', when: { path: 'result.decision', equals: 'pass' } }],
        }),
      ]),
    );
    const deploy = d.nodes.find((n) => n.id === 'deploy')!;
    expect(deploy.depends).toEqual([
      { from: 'build' },
      { from: 'review', when: { path: 'result.decision', equals: 'pass' } },
    ]);
  });

  it('同一 from 重复（string + object 混合）→ 报错（P0 一对节点一条边）', () => {
    const problems = problemsOf(() =>
      validateDag(
        dag([
          goal('a', { resultSchema: decisionSchema }),
          goal('b', { depends: ['a', { from: 'a', when: { path: 'result.decision', equals: 'pass' } }] }),
        ]),
      ),
    );
    expect(problems.some((p) => p.includes('duplicates'))).toBe(true);
  });

  it('object 形式 self-dep → 报错', () => {
    const problems = problemsOf(() => validateDag(dag([goal('a', { depends: [{ from: 'a' }] })])));
    expect(problems.some((p) => p.includes('depends on itself'))).toBe(true);
  });

  it('depends 条目带未知 key → 报错', () => {
    const problems = problemsOf(() =>
      validateDag(dag([goal('a'), goal('b', { depends: [{ from: 'a', goto: 'x' }] })])),
    );
    expect(problems.some((p) => p.includes('unsupported key'))).toBe(true);
  });
});

// ─── 条件边谓词校验 ─────────────────────────────────────────────────────────

describe('validateDag: 条件边谓词', () => {
  it('source 无 resultSchema → 报错', () => {
    const problems = problemsOf(() =>
      validateDag(
        dag([goal('a'), goal('b', { depends: [{ from: 'a', when: { path: 'result.decision', equals: 'pass' } }] })]),
      ),
    );
    expect(problems.some((p) => p.includes('must declare a resultSchema'))).toBe(true);
  });

  it('source 是 loop → 报错（P0：loop 后接 verifier goal）', () => {
    const problems = problemsOf(() =>
      validateDag(
        dag([
          goal('prep'),
          {
            id: 'fix',
            type: 'loop',
            depends: ['prep'],
            inputs: [],
            maxIterations: 3,
            body: {
              nodes: [goal('test', { resultSchema: { type: 'object', properties: { passed: { type: 'boolean' } }, required: ['passed'] } })],
            },
            exit: { node: 'test', when: { path: 'result.passed', equals: true } },
          },
          goal('after', { depends: [{ from: 'fix', when: { path: 'result.passed', equals: true } }] }),
        ]),
      ),
    );
    expect(problems.some((p) => p.includes('must be a goal node'))).toBe(true);
  });

  it('path 引用未声明字段 / 未 required 字段 → 报错', () => {
    const undeclared = problemsOf(() =>
      validateDag(
        dag([
          goal('a', { resultSchema: decisionSchema }),
          goal('b', { depends: [{ from: 'a', when: { path: 'result.ghost', equals: 'x' } }] }),
        ]),
      ),
    );
    expect(undeclared.some((p) => p.includes('not declared'))).toBe(true);

    const optionalSchema: V3ResultSchema = { type: 'object', properties: { note: { type: 'string' } } };
    const notRequired = problemsOf(() =>
      validateDag(
        dag([
          goal('a', { resultSchema: optionalSchema }),
          goal('b', { depends: [{ from: 'a', when: { path: 'result.note', equals: 'x' } }] }),
        ]),
      ),
    );
    expect(notRequired.some((p) => p.includes('required'))).toBe(true);
  });

  it('算子类型不相容（gt 用于 string 字段）→ 报错', () => {
    const problems = problemsOf(() =>
      validateDag(
        dag([
          goal('a', { resultSchema: decisionSchema }),
          goal('b', { depends: [{ from: 'a', when: { path: 'result.decision', gt: 1 } }] }),
        ]),
      ),
    );
    expect(problems.some((p) => p.includes('number field'))).toBe(true);
  });

  it('enum 对账：equals 操作数 ∉ enum → 报错；∈ enum → 通过', () => {
    const bad = problemsOf(() =>
      validateDag(
        dag([
          goal('a', { resultSchema: decisionSchema }),
          goal('b', { depends: [{ from: 'a', when: { path: 'result.decision', equals: 'pas' } }] }),
        ]),
      ),
    );
    expect(bad.some((p) => p.includes("enum"))).toBe(true);

    expect(() =>
      validateDag(
        dag([
          goal('a', { resultSchema: decisionSchema }),
          goal('b', { depends: [{ from: 'a', when: { path: 'result.decision', equals: 'pass' } }] }),
        ]),
      ),
    ).not.toThrow();
  });

  it('条件边参与环检测：含 when 的回边 → DagValidationError', () => {
    const problems = problemsOf(() =>
      validateDag(
        dag([
          goal('a', { resultSchema: decisionSchema, depends: ['b'] }),
          goal('b', { depends: [{ from: 'a', when: { path: 'result.decision', equals: 'pass' } }] }),
        ]),
      ),
    );
    expect(problems.some((p) => p.includes('cycle'))).toBe(true);
  });
});

// ─── triggerRule ────────────────────────────────────────────────────────────

describe('validateDag: triggerRule', () => {
  it('0 入度节点声明 triggerRule → 报错', () => {
    const problems = problemsOf(() => validateDag(dag([goal('a', { triggerRule: 'one_success' })])));
    expect(problems.some((p) => p.includes('at least one incoming edge'))).toBe(true);
  });

  it('quorum 越界（0 / 超入边数 / 非整数）→ 报错', () => {
    for (const q of [0, 3, 1.5]) {
      const problems = problemsOf(() =>
        validateDag(dag([goal('a'), goal('b'), goal('c', { depends: ['a', 'b'], triggerRule: { quorum: q } })])),
      );
      expect(problems.some((p) => p.includes('quorum')), `quorum=${q}`).toBe(true);
    }
  });

  it('triggerRule 对象带额外 key → 报错；非法字符串 → 报错', () => {
    const extra = problemsOf(() =>
      validateDag(dag([goal('a'), goal('b', { depends: ['a'], triggerRule: { quorum: 1, mode: 'x' } })])),
    );
    expect(extra.some((p) => p.includes('only supports'))).toBe(true);

    const badStr = problemsOf(() =>
      validateDag(dag([goal('a'), goal('b', { depends: ['a'], triggerRule: 'any' })])),
    );
    expect(badStr.some((p) => p.includes('triggerRule must be'))).toBe(true);
  });

  it('合法 one_success / quorum 归一化保留', () => {
    const d = validateDag(
      dag([goal('a'), goal('b'), goal('c', { depends: ['a', 'b'], triggerRule: { quorum: 2 } })]),
    );
    expect(d.nodes.find((n) => n.id === 'c')!.triggerRule).toEqual({ quorum: 2 });
  });
});

// ─── enum 子集 ──────────────────────────────────────────────────────────────

describe('validateDag: resultSchema enum 子集', () => {
  function schemaWith(spec: Record<string, unknown>): Record<string, unknown> {
    return dag([goal('a', { resultSchema: { type: 'object', properties: { f: spec }, required: ['f'] } })]);
  }

  it('非 string 字段带 enum → 报错', () => {
    const problems = problemsOf(() => validateDag(schemaWith({ type: 'number', enum: ['1'] })));
    expect(problems.some((p) => p.includes('only supported on string'))).toBe(true);
  });

  it('空 enum / 重复值 / 超过 16 个 / 超长值 → 报错', () => {
    expect(problemsOf(() => validateDag(schemaWith({ type: 'string', enum: [] }))).length).toBeGreaterThan(0);
    expect(
      problemsOf(() => validateDag(schemaWith({ type: 'string', enum: ['x', 'x'] }))).some((p) =>
        p.includes('duplicates'),
      ),
    ).toBe(true);
    expect(
      problemsOf(() =>
        validateDag(schemaWith({ type: 'string', enum: Array.from({ length: 17 }, (_, i) => `v${i}`) })),
      ).some((p) => p.includes('max 16')),
    ).toBe(true);
    expect(
      problemsOf(() => validateDag(schemaWith({ type: 'string', enum: ['y'.repeat(65)] }))).some((p) =>
        p.includes('exceed'),
      ),
    ).toBe(true);
  });

  it('合法 enum 保留在归一化 schema 中', () => {
    const d = validateDag(dag([goal('a', { resultSchema: decisionSchema })]));
    expect(d.nodes[0]!.resultSchema!.properties.decision!.enum).toEqual(['pass', 'fail']);
  });

  it('loop exit 谓词同样吃 enum 对账', () => {
    const problems = problemsOf(() =>
      validateDag(
        dag([
          {
            id: 'l',
            type: 'loop',
            depends: [],
            inputs: [],
            maxIterations: 2,
            body: { nodes: [goal('judge', { resultSchema: decisionSchema })] },
            exit: { node: 'judge', when: { path: 'result.decision', equals: 'paas' } },
          },
        ]),
      ),
    );
    expect(problems.some((p) => p.includes('enum'))).toBe(true);
  });
});

// ─── loop body 限制 ─────────────────────────────────────────────────────────

describe('validateDag: loop body 禁条件边 / triggerRule', () => {
  const passedSchema: V3ResultSchema = {
    type: 'object',
    properties: { passed: { type: 'boolean' } },
    required: ['passed'],
  };

  function loopWith(bodyNodes: Record<string, unknown>[]): Record<string, unknown> {
    return dag([
      {
        id: 'l',
        type: 'loop',
        depends: [],
        inputs: [],
        maxIterations: 2,
        body: { nodes: bodyNodes },
        exit: { node: 'test', when: { path: 'result.passed', equals: true } },
      },
    ]);
  }

  it('body 内条件边 → 报错', () => {
    const problems = problemsOf(() =>
      validateDag(
        loopWith([
          goal('code', { resultSchema: decisionSchema }),
          goal('test', {
            resultSchema: passedSchema,
            depends: [{ from: 'code', when: { path: 'result.decision', equals: 'pass' } }],
          }),
        ]),
      ),
    );
    expect(problems.some((p) => p.includes('not supported inside a loop body'))).toBe(true);
  });

  it('body 内 triggerRule → 报错', () => {
    const problems = problemsOf(() =>
      validateDag(
        loopWith([
          goal('code'),
          goal('test', { resultSchema: passedSchema, depends: ['code'], triggerRule: 'one_success' }),
        ]),
      ),
    );
    expect(problems.some((p) => p.includes('triggerRule is not supported inside a loop body'))).toBe(true);
  });

  it('loop 自身 depends 带 when → 合法（loop 可作条件边目标）', () => {
    expect(() =>
      validateDag(
        dag([
          goal('review', { resultSchema: decisionSchema }),
          {
            id: 'l',
            type: 'loop',
            depends: [{ from: 'review', when: { path: 'result.decision', equals: 'fail' } }],
            inputs: [],
            maxIterations: 2,
            body: { nodes: [goal('test', { resultSchema: passedSchema })] },
            exit: { node: 'test', when: { path: 'result.passed', equals: true } },
          },
        ]),
      ),
    ).not.toThrow();
  });
});

// ─── 消费方 `.from` 适配 ────────────────────────────────────────────────────

describe('findSinks: 读取 depends[].from', () => {
  it('混排 string/object depends 下 sink 计算正确', () => {
    const d = validateDag(
      dag([
        goal('a', { resultSchema: decisionSchema }),
        goal('b', { depends: [{ from: 'a', when: { path: 'result.decision', equals: 'pass' } }] }),
        goal('c', { depends: ['a'] }),
      ]),
    );
    expect(findSinks(d).sort()).toEqual(['b', 'c']);
  });
});

// ─── validateResult enum ────────────────────────────────────────────────────

describe('validateResult: enum 约束', () => {
  it('值 ∉ enum → resultInvalid 级 problem；∈ enum → ok', () => {
    const dir = mkdtempSync(join(tmpdir(), 'v3-edge-'));
    try {
      const file = join(dir, 'result.json');
      writeFileSync(file, JSON.stringify({ decision: 'maybe' }));
      const bad = validateResult(file, decisionSchema);
      expect(bad.ok).toBe(false);
      expect(bad.problems!.some((p) => p.includes('must be one of'))).toBe(true);

      writeFileSync(file, JSON.stringify({ decision: 'pass' }));
      expect(validateResult(file, decisionSchema).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── renderGoalFile enum 契约说明 ───────────────────────────────────────────

describe('renderGoalFile: enum 说明行', () => {
  it('schema 含 enum → 渲染 enum 警示；不含 → 不渲染', () => {
    const withEnum = renderGoalFile('do x', decisionSchema);
    expect(withEnum).toContain('enum');
    expect(withEnum).toContain('"enum":["pass","fail"]');

    const noEnum = renderGoalFile('do x', {
      type: 'object',
      properties: { n: { type: 'number' } },
      required: ['n'],
    });
    expect(noEnum).not.toContain('MUST use one of the listed values');
  });
});
