import { describe, it, expect, beforeAll } from 'vitest';
import { chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CodexRpcEngine } from '../src/codex-rpc-engine.js';

// A real subprocess app-server stand-in (HTTP /readyz + JSON-RPC WS on one port).
const FIXTURE = fileURLToPath(new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url));
beforeAll(() => { chmodSync(FIXTURE, 0o755); });

function makeEngine(over: Partial<ConstructorParameters<typeof CodexRpcEngine>[0]> = {}) {
  return new CodexRpcEngine({
    cliBin: FIXTURE, cwd: '/tmp', env: process.env,
    sessionId: `test-${Math.round(performance.now())}-${over.sessionId ?? ''}`,
    ...over,
  });
}

describe('CodexRpcEngine — happy-path lifecycle against a fake app-server', () => {
  it('start (spawn → /readyz → connect → initialize) then startThread → sendTurn → stop', async () => {
    const engine = makeEngine();
    await engine.start();
    const tid = await engine.startThread();
    expect(tid).toBe('thread-fake-1');
    expect(engine.activeThreadId).toBe('thread-fake-1');
    expect(engine.wsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
    await engine.sendTurn('hello world'); // resolves on the ack, no throw
    engine.stop();
  }, 20_000);

  it('resumeThread returns the resumed (persisted) thread id — resume-survival path', async () => {
    const engine = makeEngine({ sessionId: 'resume' });
    await engine.start();
    const tid = await engine.resumeThread('thread-persisted-42');
    expect(tid).toBe('thread-persisted-42');
    engine.stop();
  }, 20_000);
});

describe('CodexRpcEngine — failure/recovery paths', () => {
  it('P1-5: a wedged turn/start times out → onDead fires (fatal recovery, not a silent hang)', async () => {
    let deadCount = 0;
    const engine = makeEngine({
      sessionId: 'hang',
      env: { ...process.env, FAKE_HANG_TURN: '1' },
      requestTimeoutMs: 400,
      onDead: () => { deadCount++; },
    });
    await engine.start();
    await engine.startThread();
    await expect(engine.sendTurn('never answered')).rejects.toThrow(/timed out/);
    expect(deadCount).toBe(1); // failAll → onDead exactly once
    engine.stop();
  }, 20_000);

  it('app-server crash → onDead fires so the worker can restart the pane', async () => {
    let dead = false;
    const engine = makeEngine({
      sessionId: 'crash',
      env: { ...process.env, FAKE_DIE_AFTER_MS: '600' },
      onDead: () => { dead = true; },
    });
    await engine.start();
    await engine.startThread();
    await new Promise((r) => setTimeout(r, 1500)); // let the fixture exit(1)
    expect(dead).toBe(true);
    engine.stop();
  }, 20_000);

  it('stop() is idempotent and does NOT fire onDead (expected teardown)', async () => {
    let dead = false;
    const engine = makeEngine({ sessionId: 'stop', onDead: () => { dead = true; } });
    await engine.start();
    await engine.startThread();
    engine.stop();
    engine.stop();
    await new Promise((r) => setTimeout(r, 300));
    expect(dead).toBe(false);
  }, 20_000);
});
