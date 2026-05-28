/**
 * Pure unit conversion functions.
 * Built-in registry for temperature, distance, weight, currency (static), time, volume.
 * No I/O, no runtime dependencies.
 */

interface ConversionEntry {
  toBase: (v: number) => number;
  fromBase: (v: number) => number;
}

// Temperature (base: celsius)
const TEMPERATURE: Record<string, ConversionEntry> = {
  celsius: { toBase: (v) => v, fromBase: (v) => v },
  fahrenheit: { toBase: (v) => (v - 32) * (5 / 9), fromBase: (v) => v * (9 / 5) + 32 },
  kelvin: { toBase: (v) => v - 273.15, fromBase: (v) => v + 273.15 },
};

// Distance (base: meters)
const DISTANCE: Record<string, ConversionEntry> = {
  meters: { toBase: (v) => v, fromBase: (v) => v },
  km: { toBase: (v) => v * 1000, fromBase: (v) => v / 1000 },
  miles: { toBase: (v) => v * 1609.344, fromBase: (v) => v / 1609.344 },
  feet: { toBase: (v) => v * 0.3048, fromBase: (v) => v / 0.3048 },
  yards: { toBase: (v) => v * 0.9144, fromBase: (v) => v / 0.9144 },
};

// Weight (base: grams)
const WEIGHT: Record<string, ConversionEntry> = {
  grams: { toBase: (v) => v, fromBase: (v) => v },
  kg: { toBase: (v) => v * 1000, fromBase: (v) => v / 1000 },
  lbs: { toBase: (v) => v * 453.592, fromBase: (v) => v / 453.592 },
  ounces: { toBase: (v) => v * 28.3495, fromBase: (v) => v / 28.3495 },
};

// Time (base: seconds)
const TIME: Record<string, ConversionEntry> = {
  seconds: { toBase: (v) => v, fromBase: (v) => v },
  minutes: { toBase: (v) => v * 60, fromBase: (v) => v / 60 },
  hours: { toBase: (v) => v * 3600, fromBase: (v) => v / 3600 },
  days: { toBase: (v) => v * 86400, fromBase: (v) => v / 86400 },
};

// Volume (base: ml)
const VOLUME: Record<string, ConversionEntry> = {
  ml: { toBase: (v) => v, fromBase: (v) => v },
  liters: { toBase: (v) => v * 1000, fromBase: (v) => v / 1000 },
  gallons: { toBase: (v) => v * 3785.41, fromBase: (v) => v / 3785.41 },
  cups: { toBase: (v) => v * 236.588, fromBase: (v) => v / 236.588 },
};

// Currency (static rates vs USD)
const CURRENCY_TO_USD: Record<string, number> = {
  USD: 1.0,
  EUR: 1.08,
  GBP: 1.27,
  JPY: 0.0067,
  CAD: 0.74,
  AUD: 0.65,
  CHF: 1.13,
  CNY: 0.14,
  INR: 0.012,
  MXN: 0.058,
  BRL: 0.2,
  KRW: 0.00075,
  SGD: 0.75,
  HKD: 0.13,
  SEK: 0.096,
  NOK: 0.094,
};

const CURRENCY: Record<string, ConversionEntry> = {};
for (const [code, rate] of Object.entries(CURRENCY_TO_USD)) {
  CURRENCY[code] = {
    toBase: (v) => v * rate,
    fromBase: (v) => v / rate,
  };
}

const CATEGORIES: Record<string, Record<string, ConversionEntry>> = {
  temperature: TEMPERATURE,
  distance: DISTANCE,
  weight: WEIGHT,
  time: TIME,
  volume: VOLUME,
  currency: CURRENCY,
};

function findCategory(unit: string): Record<string, ConversionEntry> | null {
  const normalized = unit.toLowerCase();
  for (const cat of Object.values(CATEGORIES)) {
    if (cat[normalized] || cat[unit]) return cat;
  }
  return null;
}

function getEntry(category: Record<string, ConversionEntry>, unit: string): ConversionEntry | null {
  return category[unit.toLowerCase()] ?? category[unit] ?? null;
}

/**
 * Convert a numeric value from one unit to another.
 * Both units must belong to the same category (e.g. both temperature, both distance).
 * Throws if the conversion is not supported.
 */
export function convertValue(value: number, fromUnit: string, toUnit: string): number {
  if (fromUnit === toUnit || fromUnit.toLowerCase() === toUnit.toLowerCase()) return value;

  const fromCat = findCategory(fromUnit);
  const toCat = findCategory(toUnit);

  if (!fromCat || !toCat || fromCat !== toCat) {
    throw new Error(`Unsupported conversion: ${fromUnit} \u2192 ${toUnit}`);
  }

  const fromEntry = getEntry(fromCat, fromUnit);
  const toEntry = getEntry(fromCat, toUnit);

  if (!fromEntry || !toEntry) {
    throw new Error(`Unsupported conversion: ${fromUnit} \u2192 ${toUnit}`);
  }

  const base = fromEntry.toBase(value);
  return toEntry.fromBase(base);
}

/**
 * Check whether a conversion between two units is supported.
 * Returns true if both units are recognized and belong to the same category.
 */
export function isConversionSupported(fromUnit: string, toUnit: string): boolean {
  if (fromUnit === toUnit || fromUnit.toLowerCase() === toUnit.toLowerCase()) return true;

  const fromCat = findCategory(fromUnit);
  const toCat = findCategory(toUnit);

  return !!fromCat && !!toCat && fromCat === toCat;
}

/**
 * List all supported conversion categories.
 * Returns category names such as 'temperature', 'distance', 'weight', etc.
 */
export function listSupportedConversions(): string[] {
  return Object.keys(CATEGORIES);
}
