/**
 * v3 workflow runs dashboard page — a DAG graph of a run's nodes (colored by
 * status) with a per-node detail panel that hosts the terminal slot.
 *
 * Read-only: fetches `/api/v3/runs` (list) and `/api/v3/runs/:id` (a RunView —
 * see ops-projection.ts).  The RunView carries NO write token / no raw fs path
 * (codex security review); the per-node terminal component (`v3-terminal.ts`,
 * codex) only needs `(runId, node)`.
 *
 * Vanilla DOM + poll loop, mirroring `workflows.ts` (disposer clears the timer;
 * skip polling while the tab is hidden; stop once the run is terminal).
 */
import { renderNodeTerminal } from './v3-terminal.js';
import type { RunView, RunNodeView } from '../../workflows/v3/ops-projection.js';

const POLL_MS = 2000;

const NODE_COLOR: Record<RunNodeView['status'], string> = {
  pending: '#9aa0a6',
  gateWaiting: '#f9ab00',
  running: '#1a73e8',
  done: '#188038',
  blocked: '#e8710a', // amber — recoverable (retry), distinct from failed red
  failed: '#d93025',
};
const NODE_LABEL: Record<RunNodeView['status'], string> = {
  pending: '待机',
  gateWaiting: '等审批',
  running: '运行中',
  done: '完成',
  blocked: '受阻(可重试)',
  failed: '失败',
};
const RUN_COLOR: Record<string, string> = { running: '#1a73e8', succeeded: '#188038', blocked: '#e8710a', failed: '#d93025' };

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** Signature of a node's terminal-relevant inputs.  The panel remounts the
 *  terminal slot only when this changes (live→closed, webPort appears, pty log
 *  shows up) — so a stable live iframe survives the 2s poll loop. */
function termSig(node: RunNodeView): string {
  const wt = node.webTerminal;
  return `${wt?.status ?? '-'}|${wt?.webPort ?? '-'}|${node.hasPtyLog ? '1' : '0'}`;
}

export function renderV3RunsPage(root: HTMLElement): () => void {
  const m = location.hash.match(/^#\/v3\/([^?#]+)/);
  if (m) return renderV3DetailPage(root, decodeURIComponent(m[1]!));
  return renderV3ListPage(root);
}

// ─── List ───────────────────────────────────────────────────────────────────

function renderV3ListPage(root: HTMLElement): () => void {
  root.innerHTML = `
    <div class="page-head">
      <h1>V3 Runs</h1>
      <p class="muted">LLM 编排的 workflow 运行 — DAG 图 + 每节点终端</p>
    </div>
    <table class="data-table">
      <thead><tr><th>Run</th><th>状态</th><th>节点数</th></tr></thead>
      <tbody id="v3-tbody"></tbody>
    </table>
    <div id="v3-empty" class="muted" hidden style="padding:1rem">暂无 v3 run（用 <code>/workflow new</code> 发起一个）</div>`;
  const tbody = root.querySelector<HTMLElement>('#v3-tbody')!;
  const empty = root.querySelector<HTMLElement>('#v3-empty')!;
  let timer: number | null = null;
  let disposed = false;

  async function poll(): Promise<void> {
    if (disposed || document.hidden) return;
    try {
      const r = await fetch('/api/v3/runs');
      const body = r.ok ? ((await r.json()) as { runs: Array<{ runId: string; runStatus: string; nodeCount: number }> }) : { runs: [] };
      if (disposed) return;
      const runs = body.runs ?? [];
      empty.hidden = runs.length > 0;
      tbody.innerHTML = runs
        .map(
          (rn) => `<tr>
            <td><a href="#/v3/${encodeURIComponent(rn.runId)}">${esc(rn.runId)}</a></td>
            <td><span class="badge" style="background:${RUN_COLOR[rn.runStatus] ?? '#666'};color:#fff">${esc(rn.runStatus)}</span></td>
            <td>${rn.nodeCount}</td>
          </tr>`,
        )
        .join('');
    } catch {
      /* transient fetch error — next tick retries */
    }
  }

  function loop(): void {
    if (disposed) return;
    void poll().then(() => { if (!disposed) timer = window.setTimeout(loop, POLL_MS); });
  }
  loop();
  return () => { disposed = true; if (timer !== null) window.clearTimeout(timer); };
}

// ─── Detail (DAG graph + node panel) ─────────────────────────────────────────

function renderV3DetailPage(root: HTMLElement, runId: string): () => void {
  root.innerHTML = `
    <div class="page-head">
      <a href="#/v3" class="btn-link">← Runs</a>
      <h1 style="display:inline-block;margin-left:.5rem">${esc(runId)}</h1>
      <span id="v3-runstatus" class="badge" style="margin-left:.5rem"></span>
    </div>
    <div style="display:flex;flex-direction:column;gap:1rem;align-items:stretch">
      <div id="v3-graph" style="max-height:48vh;overflow:auto;border:1px solid var(--border,#333);border-radius:8px;background:var(--panel,#1b1b1b)"></div>
      <div id="v3-node-panel" style="border:1px solid var(--border,#333);border-radius:8px;padding:1rem;background:var(--panel,#1b1b1b)">
        <p class="muted">点一个节点看详情与终端</p>
      </div>
    </div>`;
  const graphEl = root.querySelector<HTMLElement>('#v3-graph')!;
  const panelEl = root.querySelector<HTMLElement>('#v3-node-panel')!;
  const runStatusEl = root.querySelector<HTMLElement>('#v3-runstatus')!;

  let timer: number | null = null;
  let disposed = false;
  let selected: string | null = null;
  let lastView: RunView | null = null;
  // Which node the panel SHELL is built for, and the signature of the terminal
  // currently mounted in the slot.  Both gate re-renders so a live iframe is
  // NOT rebuilt on every 2s poll (codex caveat — only remount when the node
  // selection or the terminal's own inputs actually change).
  let panelSelected: string | null = null;
  let renderedTermSig: string | null = null;

  function renderPanel(): void {
    const node = lastView?.nodes.find((n) => n.id === selected) ?? null;
    if (!node) {
      panelEl.innerHTML = '<p class="muted">点一个节点看详情与终端</p>';
      panelSelected = null;
      renderedTermSig = null;
      return;
    }
    // (Re)build the shell only when the selected node changes — keeps the
    // terminal slot's DOM (and any live iframe) alive across polls.
    if (panelSelected !== node.id) {
      panelEl.innerHTML = `
        <h3 style="margin-top:0">${esc(node.id)}</h3>
        <div id="v3-node-meta"></div>
        <div id="v3-term-slot" style="margin-top:.75rem"></div>`;
      panelSelected = node.id;
      renderedTermSig = null; // force a terminal (re)mount for the new selection
    }
    // Cheap meta updates in place every poll (no iframe involved).
    const errLine = node.errorClass
      ? `<p class="muted">原因：${esc(node.errorClass)}${node.errorCode ? ` (${esc(node.errorCode)})` : ''}${
          node.status === 'blocked' ? ' — 处理后可在飞书卡片或 `botmux workflow retry` 重试' : ''
        }</p>`
      : '';
    panelEl.querySelector<HTMLElement>('#v3-node-meta')!.innerHTML = `
      <p><span class="badge" style="background:${NODE_COLOR[node.status]};color:#fff">${NODE_LABEL[node.status]}</span></p>
      ${node.goal ? `<p class="muted">${esc(node.goal)}</p>` : ''}
      ${node.depends.length ? `<p class="muted">依赖：${node.depends.map(esc).join(', ')}</p>` : ''}
      ${errLine}`;
    // Only (re)mount the terminal when its inputs changed (status / webPort /
    // hasPtyLog) — otherwise leave codex's live iframe untouched (no flicker).
    const sig = termSig(node);
    if (sig !== renderedTermSig) {
      renderNodeTerminal(panelEl.querySelector<HTMLElement>('#v3-term-slot')!, runId, node);
      renderedTermSig = sig;
    }
  }

  function renderGraph(view: RunView): void {
    const depthOf = computeDepth(view.nodes);
    const byDepth = new Map<number, RunNodeView[]>();
    for (const n of view.nodes) {
      const d = depthOf.get(n.id) ?? 0;
      (byDepth.get(d) ?? byDepth.set(d, []).get(d)!).push(n);
    }
    const COL = 200, ROW = 84, NW = 150, NH = 48, PAD = 24;
    const pos = new Map<string, { x: number; y: number }>();
    let maxRows = 0;
    for (const [d, ns] of byDepth) {
      maxRows = Math.max(maxRows, ns.length);
      ns.forEach((n, i) => pos.set(n.id, { x: PAD + d * COL, y: PAD + i * ROW }));
    }
    const width = PAD * 2 + (byDepth.size === 0 ? 0 : (Math.max(...byDepth.keys()) * COL + NW));
    const height = PAD * 2 + Math.max(0, maxRows - 1) * ROW + NH;

    const edges: string[] = [];
    for (const n of view.nodes) {
      const to = pos.get(n.id);
      if (!to) continue;
      for (const dep of n.depends) {
        const from = pos.get(dep);
        if (!from) continue;
        const x1 = from.x + NW, y1 = from.y + NH / 2, x2 = to.x, y2 = to.y + NH / 2;
        const mx = (x1 + x2) / 2;
        edges.push(`<path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" fill="none" stroke="#5f6368" stroke-width="1.5" marker-end="url(#v3arrow)"/>`);
      }
    }
    const boxes = view.nodes.map((n) => {
      const p = pos.get(n.id)!;
      const sel = n.id === selected;
      return `<g class="v3-node" data-node="${esc(n.id)}" style="cursor:pointer">
        <rect x="${p.x}" y="${p.y}" width="${NW}" height="${NH}" rx="8"
              fill="${NODE_COLOR[n.status]}" fill-opacity="${sel ? '1' : '0.85'}"
              stroke="${sel ? '#fff' : 'none'}" stroke-width="2"/>
        <text x="${p.x + NW / 2}" y="${p.y + 19}" fill="#fff" font-size="12" font-weight="600" text-anchor="middle">${esc(trunc(n.id, 18))}</text>
        <text x="${p.x + NW / 2}" y="${p.y + 36}" fill="#fff" font-size="10" text-anchor="middle" fill-opacity="0.85">${NODE_LABEL[n.status]}</text>
      </g>`;
    });

    graphEl.innerHTML = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="display:block">
      <defs><marker id="v3arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 z" fill="#5f6368"/></marker></defs>
      ${edges.join('')}${boxes.join('')}
    </svg>`;
    for (const g of graphEl.querySelectorAll<SVGGElement>('[data-node]')) {
      g.addEventListener('click', () => {
        selected = g.getAttribute('data-node');
        renderGraph(view); // re-render to move the selection outline
        renderPanel();
      });
    }
  }

  async function poll(): Promise<void> {
    if (disposed || document.hidden) return;
    try {
      const r = await fetch(`/api/v3/runs/${encodeURIComponent(runId)}`);
      if (!r.ok) {
        if (!disposed) runStatusEl.textContent = r.status === 404 ? 'not found' : `HTTP ${r.status}`;
        return;
      }
      const view = (await r.json()) as RunView;
      if (disposed) return;
      lastView = view;
      runStatusEl.textContent = view.runStatus;
      runStatusEl.style.background = RUN_COLOR[view.runStatus] ?? '#666';
      runStatusEl.style.color = '#fff';
      if (selected === null && view.nodes.length) selected = view.nodes[0]!.id;
      renderGraph(view);
      renderPanel();
      // Stop polling once the run is terminal (one final render already done).
      if (view.runStatus !== 'running') { if (timer !== null) window.clearTimeout(timer); timer = null; return; }
    } catch {
      /* transient — next tick retries */
    }
  }

  function loop(): void {
    if (disposed) return;
    void poll().then(() => { if (!disposed && lastView?.runStatus !== 'failed' && lastView?.runStatus !== 'succeeded') timer = window.setTimeout(loop, POLL_MS); });
  }
  loop();
  return () => { disposed = true; if (timer !== null) window.clearTimeout(timer); };
}

/** Longest-path depth from a root (no-deps node) — the node's graph column. */
function computeDepth(nodes: RunNodeView[]): Map<string, number> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  function depth(id: string): number {
    if (memo.has(id)) return memo.get(id)!;
    if (visiting.has(id)) return 0; // defensive: dag is acyclic, but never loop
    visiting.add(id);
    const n = byId.get(id);
    const deps = (n?.depends ?? []).filter((d) => byId.has(d));
    const d = deps.length ? 1 + Math.max(...deps.map(depth)) : 0;
    visiting.delete(id);
    memo.set(id, d);
    return d;
  }
  for (const n of nodes) depth(n.id);
  return memo;
}

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
