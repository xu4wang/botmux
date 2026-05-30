import { describe, expect, it } from 'vitest';

import { buildDetouredPendingResponseCard, buildPendingResponseCard } from '../src/im/lark/card-builder.js';

describe('pending response card', () => {
  it('builds a processing card without manual quote text', () => {
    const card = JSON.parse(buildPendingResponseCard());
    const bodyText = JSON.stringify(card.body);

    expect(card.schema).toBe('2.0');
    expect(card.header.title).toEqual({ tag: 'plain_text', content: '处理中' });
    expect(bodyText).toContain('🔄 正在处理你的请求...');
    expect(bodyText).not.toContain('| 回复 用户A');
    expect(bodyText).not.toContain('params 顶层业务字段');
  });

  it('builds English processing card text', () => {
    const card = JSON.parse(buildPendingResponseCard('en'));
    expect(card.header.title.content).toBe('Processing');
    expect(JSON.stringify(card.body)).toContain('Processing your request');
  });

  it('builds a detoured card for replies sent elsewhere', () => {
    const card = JSON.parse(buildDetouredPendingResponseCard());

    expect(card.header.title.content).toBe('已发送');
    expect(JSON.stringify(card)).toContain('最终回复已发送到其他目标');
  });

  it('builds English detoured card text', () => {
    const card = JSON.parse(buildDetouredPendingResponseCard('en'));

    expect(card.header.title.content).toBe('Sent');
    expect(JSON.stringify(card)).toContain('sent to another target');
  });
});
