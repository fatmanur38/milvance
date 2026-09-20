import { describe, expect, it } from 'vitest';

import {
  compareUnits,
  formatUsdc,
  formatUsdcUnits,
  marginPercent,
  parseUsdcInput,
  subtractUnits,
} from './amounts';

describe('formatting exact USDC units', () => {
  it.each([
    ['100000000000', '10,000.00'],
    ['0', '0.00'],
    ['1', '0.0000001'],
    ['123456789', '12.3456789'],
    ['15000000', '1.50'],
    ['-20000000', '-2.00'],
  ])('%s units → %s', (units, expected) => {
    expect(formatUsdcUnits(units)).toBe(expected);
  });

  it('keeps precision far beyond Number.MAX_SAFE_INTEGER', () => {
    // i128 max: a JavaScript number would round this to 1.7014118346046923e38.
    const huge = '170141183460469231731687303715884105727';
    expect(formatUsdcUnits(huge)).toBe('17,014,118,346,046,923,173,168,730,371,588.4105727');
  });

  it('appends the asset code', () => {
    expect(formatUsdc('50000000')).toBe('5.00 USDC');
  });

  it('refuses a non-integer amount rather than guessing', () => {
    expect(() => formatUsdcUnits('1.5')).toThrow();
    expect(() => formatUsdcUnits('1e7')).toThrow();
  });
});

describe('parsing what a person typed', () => {
  it.each([
    ['2000', 20_000_000_000n],
    ['1400.5', 14_005_000_000n],
    ['0.0000001', 1n],
    [' 5 ', 50_000_000n],
  ])('%s → %s units', (input, units) => {
    expect(parseUsdcInput(input)).toEqual({ ok: true, units });
  });

  it.each([
    ['', /Enter an amount/],
    ['abc', /digits/],
    ['1,000', /digits/],
    ['1e3', /digits/],
    ['-5', /digits/],
    ['0', /greater than zero/],
    ['1.12345678', /7 decimal/],
  ])('rejects %j', (input, message) => {
    const parsed = parseUsdcInput(input);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(message);
  });

  it('does not suffer floating-point drift', () => {
    // 0.1 + 0.2 in floating point is 0.30000000000000004.
    const a = parseUsdcInput('0.1');
    const b = parseUsdcInput('0.2');
    if (!a.ok || !b.ok) throw new Error('parse failed');
    expect(formatUsdcUnits(a.units + b.units)).toBe('0.30');
  });
});

describe('exact arithmetic helpers', () => {
  it('subtracts and compares exactly', () => {
    expect(subtractUnits('100000000000', '73500000000')).toBe('26500000000');
    expect(compareUnits('73500000000', '100000000000')).toBe(-1);
    expect(compareUnits('5', '5')).toBe(0);
  });

  it('computes the funder margin in exact basis points', () => {
    expect(marginPercent('70000000000', '73500000000')).toBe('5.00');
    expect(marginPercent('14000000000', '14450000000')).toBe('3.21');
    expect(marginPercent('0', '1')).toBe('0.00');
  });
});
