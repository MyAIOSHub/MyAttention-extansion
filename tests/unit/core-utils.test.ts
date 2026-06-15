import { describe, it, expect } from 'vitest';
import { cleanUrl } from '../../src/core/url';
import { asNonEmptyString } from '../../src/core/string';

describe('cleanUrl', () => {
  it('strips query and hash', () => {
    expect(cleanUrl('https://a.com/p?x=1#frag')).toBe('https://a.com/p');
    expect(cleanUrl('https://a.com/p#frag?x')).toBe('https://a.com/p');
    expect(cleanUrl('https://a.com/p')).toBe('https://a.com/p');
  });
  it('handles nullish input safely', () => {
    expect(cleanUrl('')).toBe('');
    expect(cleanUrl(null)).toBe('');
    expect(cleanUrl(undefined)).toBe('');
  });
});

describe('asNonEmptyString', () => {
  it('returns trimmed value for non-empty strings', () => {
    expect(asNonEmptyString('  hi ')).toBe('hi');
    expect(asNonEmptyString('x')).toBe('x');
  });
  it('returns null for empty / non-strings', () => {
    expect(asNonEmptyString('')).toBeNull();
    expect(asNonEmptyString('   ')).toBeNull();
    expect(asNonEmptyString(undefined)).toBeNull();
    expect(asNonEmptyString(42)).toBeNull();
    expect(asNonEmptyString(null)).toBeNull();
  });
});
