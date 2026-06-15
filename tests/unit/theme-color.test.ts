import { describe, it, expect } from 'vitest';
import {
  isValidHex,
  normalizeHex,
  lightenHex,
  isDefaultBrandColor,
  DEFAULT_BRAND_COLOR,
} from '../../src/popup/theme-color';

describe('theme-color helpers', () => {
  describe('isValidHex', () => {
    it('accepts #RRGGBB and #RRGGBBAA', () => {
      expect(isValidHex('#5E6AD2')).toBe(true);
      expect(isValidHex('#5e6ad2')).toBe(true);
      expect(isValidHex('#5E6AD2FF')).toBe(true);
      expect(isValidHex('  #ABCDEF  ')).toBe(true);
    });
    it('rejects malformed input', () => {
      expect(isValidHex('5E6AD2')).toBe(false);
      expect(isValidHex('#FFF')).toBe(false);
      expect(isValidHex('#GGGGGG')).toBe(false);
      expect(isValidHex('')).toBe(false);
    });
  });

  describe('normalizeHex', () => {
    it('uppercases, adds # and drops alpha', () => {
      expect(normalizeHex('5e6ad2')).toBe('#5E6AD2');
      expect(normalizeHex('#5e6ad2ff')).toBe('#5E6AD2');
      expect(normalizeHex('  #abcdef ')).toBe('#ABCDEF');
    });
    it('returns null for invalid', () => {
      expect(normalizeHex('#FFF')).toBeNull();
      expect(normalizeHex('nope')).toBeNull();
    });
  });

  describe('lightenHex', () => {
    it('mixes toward white by amount', () => {
      expect(lightenHex('#000000', 0)).toBe('#000000');
      expect(lightenHex('#000000', 1)).toBe('#FFFFFF');
      expect(lightenHex('#000000', 0.5)).toBe('#808080');
    });
    it('lightens the default brand color', () => {
      const out = lightenHex(DEFAULT_BRAND_COLOR, 0.12);
      expect(isValidHex(out)).toBe(true);
      expect(out).not.toBe(DEFAULT_BRAND_COLOR);
    });
    it('returns input unchanged when invalid', () => {
      expect(lightenHex('bad', 0.5)).toBe('bad');
    });
  });

  describe('isDefaultBrandColor', () => {
    it('treats empty / invalid / default as default', () => {
      expect(isDefaultBrandColor('')).toBe(true);
      expect(isDefaultBrandColor(null)).toBe(true);
      expect(isDefaultBrandColor(undefined)).toBe(true);
      expect(isDefaultBrandColor('garbage')).toBe(true);
      expect(isDefaultBrandColor('#5e6ad2')).toBe(true);
    });
    it('treats a real custom color as non-default', () => {
      expect(isDefaultBrandColor('#2EDDA8')).toBe(false);
    });
  });
});
