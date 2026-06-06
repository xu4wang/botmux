# v3 Edge Activation — 条件边 + skipped + triggerRule 设计稿（P0）

> 状态：**收敛终稿**（codex review 全合入；裁决见 §9，硬约束 H1–H8）
> 起草：claude-loopy ｜ 评审：codex-loopy ｜ 2026-06-06
> 来源：seedclaw agent-team-workflow 对比调研 → 两 bot 收敛结论（飞书话题 2026-06-06）。
> 本稿覆盖收敛结论中的 P0 最小闭环：**edge predicate、edgeResolved journal、skipped 状态、triggerRule**。
> 不在本稿范围（后续版本）：early-release / 败者取消（P4）、host node、动态 expand、loop body 内条件边。

## 0. 背景与目标

v3 当前的 DAG 是"画死的"：`decideNext` 的就绪判定只有 `dep.status === 'done'`
（orchestrator.ts），运行路径与 dag.json 一一对应，没有任何运行时分叉能力。
对比 seedclaw 的 judge + routes（任意 goto，状态机模型，靠 MAX_STEP_REPLAYS=20
兜底终止性），结论是：**借"结构化裁决驱动路由"的思想，不借 goto 的实现**——

- **向前条件分叉** → 本稿的 edge activation（条件边只指向拓扑序靠后的节点，图保持无环）
- **向后返工** → 已有的 loop node（结构化环，2026-06-03 loop 设计稿），本稿不动它

目标：一个 goal node 产出结构化 `result.json`（已有 resultSchema 机制），下游边
根据 result 字段激活或失活；未激活路径上的节点确定性地进入 `skipped` 终态；
多上游节点用 `triggerRule` 声明汇合语义（all/any/quorum）。

三条不可破坏的底线（运行性质）：

1. **DAG 无环** — 条件边一并参与 Kahn 环检测；
2. **journal 可重放** — 一切依赖 result 内容的决策必须先事件化再生效；
3. **有界返工** — 回跳仍然只准在 loop 内表达。

## 1. Schema 变更（dag.ts）

### 1.1 `depends` 升级为可携带谓词的边

不新增独立 `edges` 数组——`depends` 本来就是入边集合，分裂成两个字段会引入
"edges/depends/inputs 三方一致性"这种新校验负担。`depends` 数组元素从
`string` 放宽为 `string | V3DependRef`：

```jsonc
{
  "id": "deploy",
  "type": "goal",
  "depends": [
    "build",                                                    // 无条件边（原样兼容）
    { "from": "review", "when": { "path": "result.decision", "equals": "pass" } }
  ],
  "inputs": [{ "from": "build" }]
}
```

```ts
/** 归一化后的入边。无 when = 无条件边（源 done 即激活）。 */
export interface V3DependRef {
  from: string;
  when?: V3EdgeWhen;       // 谓词形状与 V3LoopExitWhen 完全一致
}

export type V3EdgeWhen = V3LoopExitWhen;   // path: "result.<key>" + 恰好一个比较算子
```

归一化：validateDag 把 string 形式转为 `{ from }`，`V3Node.depends` 内部统一为
`V3DependRef[]`。所有现有读 `depends` 的代码（topologicalOrder、decideNext、
buildInputs、inputs.from ⊆ depends 校验）改为读 `.from`。

同一目标节点内，归一化后的 `depends[].from` 必须去重。第一版不支持同一个
`from -> to` 上挂多条候选条件边；需要表达 OR 时，应把 OR 收敛到 source 的
结构化 `result` 字段里，或者拆成中间 judge/transform 节点。这样 `edgeResolved`
可以稳定用 `(from,to)` 作为幂等键。

### 1.2 节点级 `triggerRule`

```ts
export type V3TriggerRule = 'all_success' | 'one_success' | { quorum: number };

export interface V3Node {
  // ...
  triggerRule?: V3TriggerRule;   // 缺省 'all_success'
}
```

语义（详见 §5，全部基于"入边激活状态"定义）：

| 规则 | 节点运行条件 | 节点 skip 条件 |
|------|-------------|---------------|
| `all_success`（默认） | 所有入边 active | 任一入边 inactive |
| `one_success` | ≥1 入边 active | 全部入边 inactive |
| `{ quorum: N }` | ≥N 入边 active | active 数 < N 且全部入边已定 |

表中 skip 条件的前提都是**全部入边已定**；P0 不做提前跳过，也不在 quorum
已经不可能满足时提前取消还在跑的上游。

**P0 时序约束**：triggerRule 只在**全部上游 source 进入可接受终态
（done / skipped）之后**判定一次。不做"够票即提前发车"（early-release 属于
P4 败者取消的范畴，需要 AbortController + failure suppression，本稿不碰）。

### 1.3 resultSchema 增加 string enum（judge 的 decision_values 等价物）

当前 resultSchema 子集没有 enum，`decision` 拼错只能运行时发现（收敛结论里
codex 点名的前提项）。子集扩展：

```jsonc
"resultSchema": {
  "type": "object",
  "properties": { "decision": { "type": "string", "enum": ["pass", "fail", "rework"] } },
  "required": ["decision"]
}
```

约束（沿用"validator 执行不了的 schema 不准进 dag"的 fail-loud 立场）：
- `enum` 只允许出现在 `type:'string'` 字段上，其余类型出现 enum → validate 报错；
- 非空、去重、≤16 个值、每个值 ≤64 字符（防 prompt 膨胀，计入 4KB 总上限）；
- `validateResult`（runtime.ts）追加检查：字段值必须 ∈ enum，违反 → `resultInvalid`（blocked，复用现有分类）；
- goal 渲染（renderGoalFile）把 enum 写进给 agent 的 result 契约说明。

## 2. Predicate 校验规则（validateDag）

逐条复用 loop exit 谓词的既有校验器（`normLoopExitWhen`），对**源节点**的
resultSchema 做交叉检查：

1. `when.path` 必须是 `result.<key>`，`<key>` 在源节点 resultSchema 中
   **declared 且 required**（运行时字段缺失成为 validate 期不可能事件）；
2. 恰好一个比较算子；类型相容（boolean/string → equals/notEquals；
   number → 另加 gt/gte/lt/lte；array/object → 不可比）；
3. **enum 提前对账**：源字段声明了 enum 时，`equals`/`notEquals` 的操作数必须
   ∈ enum，否则 validate 报错——这是 seedclaw `decision_values` 防 typo 能力的对位实现；
4. 带 `when` 的边，其 **source 必须是声明了 resultSchema 的 goal node**。
   P0 不允许条件边的源是 loop node（loop 封口的 manifest 来自 output 投影节点，
   result.json 的归属语义不是 loop 本身的一等产物）；source 是 host 同样不允许
   （host 本身 MVP 未开放）。未来如确有需求，应通过显式 `outputResult` 语义或
   在 loop 后接一个普通 verifier goal 节点来表达，不能隐式读取 loop 内部 body 节点；
5. **环检测覆盖条件边**：归一化后 `depends[].from` 全量进入 `topologicalOrder`
   的 Kahn 入度统计（实现上零额外工作——本来就是同一个数组），加上条件边后
   成环 → `DagValidationError`。不需要单独的"只准向前"规则：所有边都在
   无环图里，任意合法拓扑序下边自然全部向前（收敛结论硬约束 #2）；
6. `triggerRule` 校验：声明在 0 入度节点上 → 报错；`quorum.N` 必须为整数且
   `1 ≤ N ≤ 入边数`；`one_success`/`quorum` 节点的 `inputs` 允许引用可能失活的
   上游（见 §6），`all_success` 节点行为与现状完全一致；
7. **loop body 内禁止条件边与 triggerRule**（first cut，与 body 禁 humanGate
   同列）；loop 自身的 `depends` 允许携带条件边（loop 作为目标节点可被 skip，
   见 §5.3）。

## 3. Journal Event（journal.ts）

新增两个事件。命名与载荷沿用现有风格（扁平、可 grep、携带 attemptId 审计）：

```ts
// 条件边的谓词判定结果。仅 when 边产生此事件；无条件边的激活状态是
// "源 done ⇒ active" 的纯函数，无需事件化（见 §10 H4 讨论）。
| {
    type: 'edgeResolved';
    from: string;
    to: string;
    /** 判定所读 result.json 所属的 attempt（审计：哪次产出决定了这条边）。 */
    sourceAttemptId: string;
    active: boolean;
    /** 人类可读判定说明，如 `result.decision="fail" ≠ "pass"`。 */
    detail?: string;
  }
// 节点因 triggerRule 不满足而进入 skipped 终态。
| {
    type: 'nodeSkipped';
    nodeId: string;
    reason: 'triggerRuleUnsatisfied';
    /** 审计快照：判定时各入边的激活状态。 */
    detail?: string;
  }
```

现有 `runFailed` 事件增加可选 `reason`，并把 `failedNodeId` 放宽为可选：

```ts
| {
    type: 'runFailed';
    failedNodeId?: string;
    reason?: 'allSinksSkipped';
  }
```

普通节点失败继续写 `failedNodeId`；`allSinksSkipped` 不伪造失败节点，见 §5.4。

**硬约束（收敛结论 #3）**：`result.json` 只在 runtime 执行 `resolveEdge`
action 时读取**一次**，判定结果立即落 `edgeResolved`；此后 materialize、
decideNext、dashboard 一律只 replay 该事件，**永不重读 result.json**。
崩溃语义：若在读取后、append 前崩溃，重放时该边仍是未决态，decideNext 会重新
发出 `resolveEdge`——重读重判幂等（源 attempt 不变 ⇒ result.json 不变 ⇒ 判定不变）。

重复事件幂等：materialize 对同一 `(from,to)` 的多条 `edgeResolved` 取**首条**
（first-wins）。同一源 attempt 的重复判定值必然相同；同一目标内 `from`
去重后，`(from,to)` 就是稳定 edge key，first-wins 仅为防御性确定性。

## 4. STATE 投影（state.ts）

### 4.1 V3NodeStatus 增加 `skipped`

```ts
export type V3NodeStatus =
  | 'pending' | 'gateWaiting' | 'running' | 'done'
  | 'blocked' | 'failed'
  | 'skipped';   // triggerRule 不满足 — 可接受终态，不阻塞有 done sink 的 run 成功
```

### 4.2 V3RunSnapshot 增加 edges / failureReason 投影

```ts
export interface V3RunSnapshot {
  // ...
  /** workflow-level 失败原因；普通节点失败可继续只看 failedNodeId。 */
  failureReason?: 'allSinksSkipped';
  /** `${from}->${to}` → 判定结果。只含已 resolved 的条件边。 */
  edges: Map<string, { active: boolean; sourceAttemptId: string }>;
}
```

materialize 新增折叠分支（保持 **dag-free 纯函数**——只折叠事件，不需要
dag.json 参与，这是现有 materialize 的核心性质，本设计刻意保住它）：

```
edgeResolved  → edges.set(`${from}->${to}`, {...})   // first-wins
nodeSkipped   → set(nodeId, 'skipped')
runFailed     → runStatus='failed' + failedNodeId? + failureReason?
```

STATE 文件（StateFile）增加 `failureReason?: 'allSinksSkipped'` 与
`edges?: Record<string, {...}>` 字段，空表省略（与 loops 同款处理），旧 STATE
文件无此字段 → readState 回退 `failureReason=undefined` / 空 Map。

## 5. decideNext 就绪 / skip 算法（orchestrator.ts）

### 5.1 新增 actions

```ts
| { kind: 'resolveEdge'; from: string; to: string }   // runtime：读源 result.json 一次 → append edgeResolved
| { kind: 'skipNode'; nodeId: string }                 // runtime：append nodeSkipped
| { kind: 'completeRunFailed'; failedNodeId?: string; reason?: 'allSinksSkipped' }
```

第三行是现有 `completeRunFailed` action 的载荷放宽：普通节点失败仍填
`failedNodeId`，`allSinksSkipped` 只填 `reason`。

### 5.2 入边激活状态（纯函数，输入 = 静态 dag + snapshot）

对节点 X 的每条入边 `e = {from, when?}`：

| 源状态 | 边状态 |
|--------|--------|
| `done` 且无 `when` | **active**（纯函数推导，无事件） |
| `done` 且有 `when`，`edges` 含判定 | **active / inactive**（按事件） |
| `done` 且有 `when`，`edges` 无判定 | **unresolved** → 发 `resolveEdge` |
| `skipped` | **inactive**（skip 传播；纯函数推导，无事件） |
| `pending / running / gateWaiting` | **unsettled**（继续等） |
| `failed / blocked` | 不参与判定——fail-fast 扫描在此之前已把 run 收掉 |

> 设计取舍：源 skipped 与无条件边这两种激活状态是"journaled 节点状态 + 静态
> dag"的纯函数，重放确定，**不额外事件化**；只有依赖 result.json **内容**的
> 谓词判定必须事件化。这把 journal 增量压到最小，同时不破坏重放确定性。
> （替代方案"所有边一律 edgeResolved"被否：E 条边 E 个事件，skip 级联时
> 事件雪崩，且 nodeSkipped 与其下游 edgeResolved 之间的 torn-write 窗口
> 需要额外自愈逻辑——纯函数推导天然没有这个窗口。）

### 5.3 节点就绪判定（替换现行 `depsOk`）

```
对 pending 节点 X：
  1. 任一入边 unsettled            → 等（pending++，不发 action）
  2. 任一入边 unresolved           → 发 resolveEdge（pending++；本 tick 不判 trigger）
  3. 全部入边已定（active/inactive）：
       triggerRule 满足   → 现行路径：humanGate 未清 → dispatchGate；否则 dispatchWork
       triggerRule 不满足 → 发 skipNode
```

- skip 级联自然发生：X skipped 后，其下游 all_success 节点的对应入边变 inactive
  → 下游也 skipNode → 逐层传播，全程确定性、全程可重放；
- **humanGate 与 trigger 的顺序**：先 trigger 后 gate——被 skip 的节点不会弹审批卡
  （未选中分支上的 gate 不该骚扰人）；
- loop 节点作为边目标：外层 depends 判定逻辑同上，trigger 不满足 → loop 整体
  skipped（loopStarted 永不发生）；trigger 满足 → 现行 startLoop 路径不变；
- 失败扫描（failed/blocked sweep）保持现状、顺序在前：skipped **不**触发扫描。

### 5.4 run 成功语义（替换 `pending === 0`）

```
pending 计数：状态 ∉ {done, skipped} 的节点数
actions 为空 且 pending === 0 时：
  ≥1 个 sink 为 done       → completeRunSucceeded
  所有 sink 均为 skipped   → completeRunFailed { reason: 'allSinksSkipped' }
```

`runFailed` 事件载荷增加可选 `reason?: 'allSinksSkipped'`，此场景下
`failedNodeId` **不填**。不要复用 skipped sink 作为失败节点：它会污染
dashboard 的 root-cause 展示，把"图的条件覆盖不全"误报成某个节点失败。
理由：所有出口都被裁决路死、零产出的 run 不能算 succeeded——这是 dag 作者的
逻辑错误（条件覆盖不全），应当显式失败并可在 dashboard 上看到原因。

## 6. inputs 与未激活边（runtime.ts buildInputs / contract.ts）

- 不变式 `inputs[].from ⊆ depends[].from` 保持；
- `all_success` 节点：能运行 ⇒ 所有上游 done ⇒ inputs 全量可得，**行为与现状
  逐字节一致**；
- `one_success` / `quorum` 节点：按语义本来就可能带着部分上游产物运行。
  buildInputs 只注入**active 入边**对应上游的产物；失活/被 skip 上游的 inputs
  条目**显式记录**而非静默丢弃（收敛结论对现行 silent-skip 的修正）：

```ts
export interface GoalInputs {
  inputs: Array<{ from: string; name: string; path: string; kind: ManifestFileKind; preview?: string }>;
  /** 因边失活/源被 skip 而未注入的声明输入——告知 agent“缺这个是设计行为”。 */
  omitted?: Array<{ from: string; reason: 'edgeInactive' | 'sourceSkipped' }>;
}
```

renderGoalFile 同步把 omitted 列表写进 goal 提示（一句话即可），避免 agent
对着缺失的输入自行脑补。

## 7. 兼容迁移

| 面 | 旧物 | 行为 |
|----|------|------|
| dag.json | `depends: string[]` | string 形式永久合法，归一化为 `{from}`；无 when、无 triggerRule → 全部默认值，调度行为与现状逐字节一致 |
| journal | 旧 run 无新事件 | materialize 的 switch 新增 case 对旧事件流是 no-op；旧 journal 重放结果不变 |
| STATE | 无 `edges` / 无 `skipped` | readState 回退空 Map；`skipped` 只会出现在新 run |
| resume / cold-attach | 中断的新 run | 重放即恢复：未决边重新 resolveEdge（幂等，§3），已决边按事件折叠 |
| dashboard / ops-projection | 新状态/新事件 | 需要渲染 `skipped` 节点态与 edge 判定（**注意：ops-projection.ts 当前有另一会话的未提交改动，实现期协调，本稿不规划其内部结构**） |
| CLI (`workflow ls/show/tail`) | 新事件类型 | tail 的事件简表直接透传新 type；show 的 Snapshot 摘要带出 edges/skipped |

不引入 dag schemaVersion 字段：变更是纯增量放宽（旧文件全部继续合法），
validateDag 的 fail-loud 立场覆盖新字段的非法形态。

## 8. 测试矩阵

**validateDag**
- depends 混排 string / {from,when} 归一化；同一目标重复 from 报错；when 源无 resultSchema；
  path 未声明 / 未 required / 类型不相容；enum 对账（操作数 ∉ enum 报错）；
- enum 子集：非 string 字段带 enum / 空 enum / 重复值 / 超长值 / >16 个；
- triggerRule：0 入度节点报错；quorum 越界（0、> 入边数、非整数）；
- 条件边成环 → DagValidationError（含 when 的回边必须被 Kahn 抓住）；
- loop body 内条件边 / triggerRule → 报错；loop 节点自身 depends 带 when → 合法。
- 条件边 source 是 loop / host / 无 resultSchema goal → 报错；loop 后接 verifier goal
  再作为条件源 → 合法。

**materialize（重放确定性）**
- edgeResolved 折叠；同边重复事件 first-wins；nodeSkipped → skipped；
- `runFailed(reason='allSinksSkipped')` 不设置 failedNodeId，materialize 保留 reason；
- 同一 journal 重放 N 次结果逐字节一致（含新事件）；
- 旧 journal（无新事件）重放结果与改动前基线一致（golden file）。

**decideNext**
- 二选一分叉：active 路 dispatch、inactive 路 skipNode、skip 级联到 sink；
- one_success：3 上游 1 active → 运行；0 active → skip；
- quorum 2/3：恰好 2 active → 运行；1 active 且第三边已定 → skip；
- 部分上游未 terminal 时不判 trigger（unsettled 优先级）；
- unresolved 条件边 → 只发 resolveEdge、不发 dispatchWork；
- 带 humanGate 的节点被 skip → 不发 dispatchGate；
- 全 sink skipped → completeRunFailed(reason=allSinksSkipped)；混合 → succeeded；
- failed/blocked 扫描优先级仍高于一切 skip 逻辑。
- source skipped 的条件边与无条件边都纯函数 inactive，不发 resolveEdge。
- sink 集合计算改为读取 `depends[].from`，覆盖旧 string depends 与新对象 depends。

**runtime 集成**
- resolveEdge 只读一次 result.json：判定后删源文件再 re-tick，调度不受影响（证明决策来自 journal）；
- 读后写前崩溃 → 重启后重新 resolveEdge，run 正常推进；
- resolveEdge 作为 control-phase 串行 action：同 tick 有多个 unresolved 条件边时顺序 append，
  不进入 inFlight、不占 worker 并发配额；
- skipped 节点的 runDir：无 attempts 目录、无 LOCK；
- one_success 节点 inputs.json 含 omitted 列表，goal.txt 含说明行；
- allSinksSkipped 写 `runFailed(reason='allSinksSkipped')` 且不写 failedNodeId；
- resume 后已 edgeResolved 的边不再读取 result.json；未 edgeResolved 的边会重新 resolve。

**CLI / 投影**
- `workflow show` 输出 edges 与 skipped；`workflow tail` 透传新事件不崩。
- dashboard/ops-projection 对 `skipped` 使用中性终态样式，不并入 failed/blocked 计数；
  对 `allSinksSkipped` 展示为 workflow-level authoring error，而不是 node-level failure。

## 9. 裁决结论（实现期按此执行）

1. **loop 作为条件边的源**：P0 禁止。loop 可以作为条件边目标被 skip / run；
   如需根据 loop 内结果分叉，在 loop 后显式接一个 verifier goal 节点，由该
   goal 写自己的 result.json 再作为条件源。未来扩展必须引入显式 `outputResult`
   或等价 schema，不能隐式读取 `output.from` 的内部 result。
2. **allSinksSkipped 的终态形状**：复用 `runFailed`，增加 `reason:'allSinksSkipped'`，
   但不填 `failedNodeId`，避免伪造节点失败。runtime outcome / dashboard 应展示
   为 workflow-level authoring error。
3. **resolveEdge 的阶段归属**：放在 runtime 的串行 control phase，和 loop control
   action 同相位处理：读取 source 最新成功 attempt 的 result.json，立即 append
   `edgeResolved`，然后 re-tick。它不进入 worker dispatch 队列，不占并发配额，
   也不需要 AbortController。

## 10. 硬约束清单（合入前逐条复核）

- **H1** 谓词判定只发生在 resolveEdge 执行时，读一次 result.json，结果落
  `edgeResolved`；materialize / decideNext / 投影**永不重读 result.json**；
- **H2** 归一化后的全部入边（含条件边）参与 Kahn 环检测；回跳仅 loop 内合法；
- **H3** triggerRule 仅在全部入边脱离 unsettled/unresolved 后判定一次；P0 无
  early-release、无败者取消；
- **H4** materialize 保持 dag-free 纯函数；凡依赖 result **内容**的决策必须
  事件化，凡"节点状态 + 静态图"可推导的状态不事件化；
- **H5** 旧 dag.json / 旧 journal / 旧 STATE 在新代码下行为逐字节不变
  （golden 测试锁定）；
- **H6** skipped 是可接受终态：不触发 fail-fast 扫描、不阻塞有 done sink 的
  run 成功、其上的 humanGate 永不弹卡。
- **H7** `allSinksSkipped` 是 workflow-level authoring error：写
  `runFailed(reason='allSinksSkipped')`，不得伪造 `failedNodeId`。
- **H8** `resolveEdge` 是串行 control action：不进入 inFlight、不占并发配额、
  不参与 P4 的取消/败者处理。

## 11. 实现分工（设计稿收敛后启动）

| 模块 | Owner | 内容 |
|------|-------|------|
| dag.ts | claude-loopy | V3DependRef / V3EdgeWhen / triggerRule / enum 子集 + 全部 validate 规则 + 校验测试 |
| contract.ts / goal 渲染 / buildInputs | claude-loopy | GoalInputs.omitted + renderGoalFile 说明行 |
| journal.ts / state.ts | codex-loopy | 新事件 + materialize 折叠 + STATE edges 投影 + 重放测试 |
| orchestrator.ts | codex-loopy | 入边激活状态机 + triggerRule 判定 + skip 级联 + 成功语义 + decideNext 测试 |
| runtime.ts | codex-loopy | resolveEdge / skipNode 的 action 翻译 + 集成测试 |
| ops-projection / dashboard | 实现期协调 | 该文件当前有另一会话未提交改动，等工作区干净后认领 |

顺序所有权：schema 层（claude）先合入 → 引擎层（codex）基于其上 → 各自测试
随模块走 + 一套共享的 golden 重放套件。

## 12. P1 附录：humanGate options / approvers

P1 只扩展 humanGate 的审批表达力，不引入任意 option goto；流程控制仍是
二值 gate：

```ts
humanGate: {
  prompt: string,
  options?: string[],
  approveOptions?: string[],
  approvers?: string[],
}
```

- `options` 缺省为 `['approve', 'reject']`；必须非空、去重，最多 8 个，每个
  option 最多 32 字符。
- `approveOptions` 必须是 `options` 的非空子集；缺省规则是：若 options 含
  `approve`，则为 `['approve']`，否则取 `options[0]`。
- `approvers` 是 open_id 白名单；空数组或缺省表示不额外限制，仍受 daemon
  外层 `canOperate` 权限约束。
- 卡片按 `options` 渲染按钮，按钮 value 带 `selected`；runtime / daemon 将
  `selected ∈ approveOptions` 映射为 `resolution:'approved'`，否则映射为
  `resolution:'rejected'`。
- `gateResolved` 增加可选 `selected` 字段；materialize 继续只看旧的
  `resolution` 二值字段，因此旧 journal 无 `selected` 时重放语义不变。
- wait 文件持久化 `options` / `approveOptions` / `approvers` / `selected`；
  daemon 冷启动重挂卡片时从 wait 文件恢复按钮和白名单。若 crash 发生在
  `gateDispatched` 后、wait 文件写入前，则从已验证 dag 的 humanGate 配置重建
  wait 文件。
- approver allowlist 在 wait 权威层校验；非白名单点击返回 toast，不改 wait，
  不追加 `gateResolved`，不 redrive。
