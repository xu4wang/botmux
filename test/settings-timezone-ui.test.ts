import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { TimeZoneRow } from '../src/dashboard/web/settings-page.js';

/** Find the single <input> node in the rendered tree. */
function findInput(r: TestRenderer.ReactTestRenderer) {
  return r.root.findByType('input');
}

describe('TimeZoneRow (dashboard settings)', () => {
  it('renders the configured value + host placeholder + effective hint', () => {
    let r!: TestRenderer.ReactTestRenderer;
    act(() => {
      r = TestRenderer.create(React.createElement(TimeZoneRow, {
        value: 'Asia/Shanghai',
        host: 'America/Los_Angeles',
        disabled: false,
        onSave: vi.fn(),
      }));
    });
    const input = findInput(r);
    expect(input.props.value).toBe('Asia/Shanghai');
    expect(input.props.placeholder).toBe('America/Los_Angeles');
    // datalist of common zones is present
    const options = r.root.findAllByType('option');
    expect(options.some(o => o.props.value === 'Asia/Shanghai')).toBe(true);
    // hint mentions the host + the effective zone (zh default dict interpolates both)
    const small = r.root.findByType('small');
    const hint = String(small.props.children);
    expect(hint).toContain('America/Los_Angeles'); // host
    expect(hint).toContain('Asia/Shanghai');        // effective (= configured)
  });

  it('empty value ⇒ placeholder = host and hint effective falls back to host', () => {
    let r!: TestRenderer.ReactTestRenderer;
    act(() => {
      r = TestRenderer.create(React.createElement(TimeZoneRow, {
        value: '',
        host: 'America/Los_Angeles',
        disabled: false,
        onSave: vi.fn(),
      }));
    });
    expect(findInput(r).props.value).toBe('');
    const hint = String(r.root.findByType('small').props.children);
    expect(hint).toContain('America/Los_Angeles'); // both host and effective are the host
  });

  it('commits a new zone on blur (fires onSave with the trimmed value)', () => {
    const onSave = vi.fn();
    let r!: TestRenderer.ReactTestRenderer;
    act(() => {
      r = TestRenderer.create(React.createElement(TimeZoneRow, {
        value: 'Asia/Shanghai', host: 'America/Los_Angeles', disabled: false, onSave,
      }));
    });
    const input = findInput(r);
    act(() => { input.props.onChange({ currentTarget: { value: '  Asia/Tokyo  ' } }); });
    act(() => { input.props.onBlur(); });
    expect(onSave).toHaveBeenCalledWith('Asia/Tokyo');
  });

  it('clearing the field to empty commits null (clear override → follow host)', () => {
    const onSave = vi.fn();
    let r!: TestRenderer.ReactTestRenderer;
    act(() => {
      r = TestRenderer.create(React.createElement(TimeZoneRow, {
        value: 'Asia/Shanghai', host: 'America/Los_Angeles', disabled: false, onSave,
      }));
    });
    const input = findInput(r);
    act(() => { input.props.onChange({ currentTarget: { value: '' } }); });
    act(() => { input.props.onBlur(); });
    expect(onSave).toHaveBeenCalledWith(null);
  });

  it('does NOT fire onSave when the value is unchanged on blur', () => {
    const onSave = vi.fn();
    let r!: TestRenderer.ReactTestRenderer;
    act(() => {
      r = TestRenderer.create(React.createElement(TimeZoneRow, {
        value: 'Asia/Shanghai', host: 'America/Los_Angeles', disabled: false, onSave,
      }));
    });
    act(() => { findInput(r).props.onBlur(); });
    expect(onSave).not.toHaveBeenCalled();
  });
});
