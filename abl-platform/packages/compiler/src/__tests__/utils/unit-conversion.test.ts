import { describe, it, expect } from 'vitest';
import {
  convertValue,
  isConversionSupported,
  listSupportedConversions,
} from '../../platform/utils/unit-conversion.js';

describe('convertValue', () => {
  describe('temperature', () => {
    it('converts fahrenheit to celsius', () => {
      expect(convertValue(32, 'fahrenheit', 'celsius')).toBeCloseTo(0, 2);
      expect(convertValue(212, 'fahrenheit', 'celsius')).toBeCloseTo(100, 2);
      expect(convertValue(98.6, 'fahrenheit', 'celsius')).toBeCloseTo(37, 2);
    });

    it('converts celsius to fahrenheit', () => {
      expect(convertValue(0, 'celsius', 'fahrenheit')).toBeCloseTo(32, 2);
      expect(convertValue(100, 'celsius', 'fahrenheit')).toBeCloseTo(212, 2);
      expect(convertValue(37, 'celsius', 'fahrenheit')).toBeCloseTo(98.6, 2);
    });

    it('converts celsius to kelvin', () => {
      expect(convertValue(0, 'celsius', 'kelvin')).toBeCloseTo(273.15, 2);
      expect(convertValue(100, 'celsius', 'kelvin')).toBeCloseTo(373.15, 2);
      expect(convertValue(-273.15, 'celsius', 'kelvin')).toBeCloseTo(0, 2);
    });

    it('converts kelvin to celsius', () => {
      expect(convertValue(273.15, 'kelvin', 'celsius')).toBeCloseTo(0, 2);
      expect(convertValue(373.15, 'kelvin', 'celsius')).toBeCloseTo(100, 2);
      expect(convertValue(0, 'kelvin', 'celsius')).toBeCloseTo(-273.15, 2);
    });

    it('converts fahrenheit to kelvin', () => {
      expect(convertValue(32, 'fahrenheit', 'kelvin')).toBeCloseTo(273.15, 2);
      expect(convertValue(212, 'fahrenheit', 'kelvin')).toBeCloseTo(373.15, 2);
    });
  });

  describe('distance', () => {
    it('converts km to miles', () => {
      expect(convertValue(1, 'km', 'miles')).toBeCloseTo(0.6214, 3);
      expect(convertValue(10, 'km', 'miles')).toBeCloseTo(6.2137, 3);
    });

    it('converts miles to km', () => {
      expect(convertValue(1, 'miles', 'km')).toBeCloseTo(1.6093, 3);
      expect(convertValue(5, 'miles', 'km')).toBeCloseTo(8.0467, 3);
    });

    it('converts meters to feet', () => {
      expect(convertValue(1, 'meters', 'feet')).toBeCloseTo(3.2808, 3);
      expect(convertValue(100, 'meters', 'feet')).toBeCloseTo(328.084, 2);
    });

    it('converts feet to meters', () => {
      expect(convertValue(1, 'feet', 'meters')).toBeCloseTo(0.3048, 4);
      expect(convertValue(5280, 'feet', 'meters')).toBeCloseTo(1609.344, 2);
    });

    it('converts yards to meters', () => {
      expect(convertValue(1, 'yards', 'meters')).toBeCloseTo(0.9144, 4);
      expect(convertValue(100, 'yards', 'meters')).toBeCloseTo(91.44, 2);
    });
  });

  describe('weight', () => {
    it('converts kg to lbs', () => {
      expect(convertValue(1, 'kg', 'lbs')).toBeCloseTo(2.2046, 3);
      expect(convertValue(100, 'kg', 'lbs')).toBeCloseTo(220.462, 2);
    });

    it('converts lbs to kg', () => {
      expect(convertValue(1, 'lbs', 'kg')).toBeCloseTo(0.4536, 3);
      expect(convertValue(10, 'lbs', 'kg')).toBeCloseTo(4.5359, 3);
    });

    it('converts grams to ounces', () => {
      expect(convertValue(28.3495, 'grams', 'ounces')).toBeCloseTo(1, 2);
      expect(convertValue(100, 'grams', 'ounces')).toBeCloseTo(3.5274, 3);
    });

    it('converts ounces to grams', () => {
      expect(convertValue(1, 'ounces', 'grams')).toBeCloseTo(28.3495, 3);
      expect(convertValue(16, 'ounces', 'grams')).toBeCloseTo(453.592, 2);
    });
  });

  describe('time', () => {
    it('converts hours to minutes', () => {
      expect(convertValue(1, 'hours', 'minutes')).toBeCloseTo(60, 2);
      expect(convertValue(2.5, 'hours', 'minutes')).toBeCloseTo(150, 2);
    });

    it('converts days to hours', () => {
      expect(convertValue(1, 'days', 'hours')).toBeCloseTo(24, 2);
      expect(convertValue(7, 'days', 'hours')).toBeCloseTo(168, 2);
    });

    it('converts minutes to seconds', () => {
      expect(convertValue(1, 'minutes', 'seconds')).toBeCloseTo(60, 2);
      expect(convertValue(5, 'minutes', 'seconds')).toBeCloseTo(300, 2);
    });
  });

  describe('volume', () => {
    it('converts liters to gallons', () => {
      expect(convertValue(1, 'liters', 'gallons')).toBeCloseTo(0.2642, 3);
      expect(convertValue(3.78541, 'liters', 'gallons')).toBeCloseTo(1, 2);
    });

    it('converts gallons to liters', () => {
      expect(convertValue(1, 'gallons', 'liters')).toBeCloseTo(3.7854, 3);
      expect(convertValue(5, 'gallons', 'liters')).toBeCloseTo(18.927, 2);
    });

    it('converts ml to cups', () => {
      expect(convertValue(236.588, 'ml', 'cups')).toBeCloseTo(1, 2);
      expect(convertValue(1000, 'ml', 'cups')).toBeCloseTo(4.2268, 3);
    });
  });

  describe('currency', () => {
    it('converts USD to EUR', () => {
      // USD rate = 1.0, EUR rate = 1.08
      // 100 USD -> base = 100 * 1.0 = 100 -> EUR = 100 / 1.08
      const result = convertValue(100, 'USD', 'EUR');
      expect(result).toBeCloseTo(92.5926, 2);
    });

    it('converts GBP to USD', () => {
      // GBP rate = 1.27, USD rate = 1.0
      // 100 GBP -> base = 100 * 1.27 = 127 -> USD = 127 / 1.0 = 127
      const result = convertValue(100, 'GBP', 'USD');
      expect(result).toBeCloseTo(127, 2);
    });

    it('converts EUR to GBP', () => {
      // EUR rate = 1.08, GBP rate = 1.27
      // 100 EUR -> base = 100 * 1.08 = 108 -> GBP = 108 / 1.27
      const result = convertValue(100, 'EUR', 'GBP');
      expect(result).toBeCloseTo(85.0394, 2);
    });
  });

  describe('edge cases', () => {
    it('returns same value for same unit', () => {
      expect(convertValue(42, 'celsius', 'celsius')).toBe(42);
      expect(convertValue(100, 'meters', 'meters')).toBe(100);
      expect(convertValue(5.5, 'kg', 'kg')).toBe(5.5);
    });

    it('handles case-insensitive same unit', () => {
      expect(convertValue(42, 'Celsius', 'celsius')).toBe(42);
      expect(convertValue(100, 'METERS', 'meters')).toBe(100);
    });

    it('handles case-insensitive different units', () => {
      expect(convertValue(32, 'Fahrenheit', 'Celsius')).toBeCloseTo(0, 2);
      expect(convertValue(1, 'KM', 'Miles')).toBeCloseTo(0.6214, 3);
    });

    it('converts zero correctly', () => {
      expect(convertValue(0, 'celsius', 'fahrenheit')).toBeCloseTo(32, 2);
      expect(convertValue(0, 'km', 'miles')).toBe(0);
      expect(convertValue(0, 'kg', 'lbs')).toBe(0);
    });

    it('converts negative values correctly', () => {
      expect(convertValue(-40, 'fahrenheit', 'celsius')).toBeCloseTo(-40, 2);
      expect(convertValue(-10, 'celsius', 'fahrenheit')).toBeCloseTo(14, 2);
    });

    it('throws for unsupported unit', () => {
      expect(() => convertValue(1, 'parsecs', 'km')).toThrow('Unsupported conversion');
    });

    it('throws for cross-category conversion', () => {
      expect(() => convertValue(1, 'celsius', 'meters')).toThrow('Unsupported conversion');
      expect(() => convertValue(1, 'kg', 'liters')).toThrow('Unsupported conversion');
    });
  });
});

describe('isConversionSupported', () => {
  it('returns true for same unit', () => {
    expect(isConversionSupported('celsius', 'celsius')).toBe(true);
  });

  it('returns true for same category units', () => {
    expect(isConversionSupported('fahrenheit', 'celsius')).toBe(true);
    expect(isConversionSupported('km', 'miles')).toBe(true);
    expect(isConversionSupported('kg', 'lbs')).toBe(true);
    expect(isConversionSupported('USD', 'EUR')).toBe(true);
    expect(isConversionSupported('hours', 'minutes')).toBe(true);
    expect(isConversionSupported('liters', 'gallons')).toBe(true);
  });

  it('returns false for cross-category units', () => {
    expect(isConversionSupported('celsius', 'meters')).toBe(false);
    expect(isConversionSupported('kg', 'liters')).toBe(false);
    expect(isConversionSupported('USD', 'celsius')).toBe(false);
  });

  it('returns false for unknown units', () => {
    expect(isConversionSupported('parsecs', 'lightyears')).toBe(false);
    expect(isConversionSupported('cubits', 'meters')).toBe(false);
  });
});

describe('listSupportedConversions', () => {
  it('returns all category names', () => {
    const categories = listSupportedConversions();
    expect(categories).toContain('temperature');
    expect(categories).toContain('distance');
    expect(categories).toContain('weight');
    expect(categories).toContain('time');
    expect(categories).toContain('volume');
    expect(categories).toContain('currency');
  });

  it('returns exactly 6 categories', () => {
    expect(listSupportedConversions()).toHaveLength(6);
  });
});
