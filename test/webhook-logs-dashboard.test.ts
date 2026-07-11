import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildWebhookLogSearchParams } from '../src/dashboard/web/webhook-logs-page.js';

describe('webhook invocation log dashboard', () => {
  it('builds server-side filters and paging parameters', () => {
    const params = buildWebhookLogSearchParams({
      connectorId: 'conn_alerts',
      status: 'error',
      timeWindow: '24h',
      query: 'oc_target',
    }, 50);
    expect(params.get('connectorId')).toBe('conn_alerts');
    expect(params.get('status')).toBe('error');
    expect(params.get('q')).toBe('oc_target');
    expect(params.get('limit')).toBe('50');
    expect(params.get('offset')).toBe('50');
    expect(Date.parse(params.get('since') || '')).not.toBeNaN();
  });

  it('is wired into the private management navigation and lazy route table', () => {
    const app = readFileSync(new URL('../src/dashboard/web/app.tsx', import.meta.url), 'utf8');
    const routes = readFileSync(new URL('../src/dashboard/web/dashboard-routes.ts', import.meta.url), 'utf8');
    const page = readFileSync(new URL('../src/dashboard/web/webhook-logs-page.tsx', import.meta.url), 'utf8');
    const connectors = readFileSync(new URL('../src/dashboard/web/connectors-page.tsx', import.meta.url), 'utf8');
    expect(app).toContain("id: 'connectors'");
    expect(app).not.toContain("id: 'webhook-logs'");
    expect(connectors).toContain("href=\"#/connectors/logs\"");
    expect(connectors).toContain("connectors.tabLogs");
    expect(routes).toContain("pageRoute('connectors-logs', '#/connectors/logs'");
    expect(routes).toContain("pageRoute('webhook-logs', '#/webhook-logs'");
    expect(page).toContain('const query = event.currentTarget.value;');
    expect(page).not.toContain('query: event.currentTarget.value');
  });
});
