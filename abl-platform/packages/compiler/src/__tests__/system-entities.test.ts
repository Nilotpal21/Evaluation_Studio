import { describe, it, expect } from 'vitest';
import {
  SYSTEM_ENTITY_DEFINITIONS,
  getSystemEntityDefinition,
  isSystemEntityType,
} from '../platform/ir/system-entities.js';

describe('SYSTEM_ENTITY_DEFINITIONS', () => {
  it('defines exactly 6 system entity types', () => {
    expect(SYSTEM_ENTITY_DEFINITIONS).toHaveLength(6);
  });

  it('all system entities have source "system"', () => {
    for (const def of SYSTEM_ENTITY_DEFINITIONS) {
      expect(def.source).toBe('system');
    }
  });

  it('all system entity names are prefixed with __system_', () => {
    for (const def of SYSTEM_ENTITY_DEFINITIONS) {
      expect(def.name).toMatch(/^__system_/);
    }
  });

  it('all system entities have intrinsic_validation defined', () => {
    for (const def of SYSTEM_ENTITY_DEFINITIONS) {
      expect(def.intrinsic_validation).toBeDefined();
      expect(typeof def.intrinsic_validation).toBe('string');
      expect(def.intrinsic_validation!.length).toBeGreaterThan(0);
    }
  });

  describe('email entity', () => {
    it('has correct type and intrinsic_validation', () => {
      const def = SYSTEM_ENTITY_DEFINITIONS.find((d) => d.type === 'email');
      expect(def).toBeDefined();
      expect(def!.name).toBe('__system_email');
      expect(def!.type).toBe('email');
      expect(def!.intrinsic_validation).toBe('RFC 5322 compliant email format: local@domain.tld');
    });
  });

  describe('phone entity', () => {
    it('has correct type and intrinsic_validation', () => {
      const def = SYSTEM_ENTITY_DEFINITIONS.find((d) => d.type === 'phone');
      expect(def).toBeDefined();
      expect(def!.name).toBe('__system_phone');
      expect(def!.type).toBe('phone');
      expect(def!.intrinsic_validation).toBe(
        'Valid phone number: minimum 7 digits, optional country code prefix (+1, +44, etc.)',
      );
    });
  });

  describe('date entity', () => {
    it('has correct type and intrinsic_validation', () => {
      const def = SYSTEM_ENTITY_DEFINITIONS.find((d) => d.type === 'date');
      expect(def).toBeDefined();
      expect(def!.name).toBe('__system_date');
      expect(def!.type).toBe('date');
      expect(def!.intrinsic_validation).toBe('Resolves to a real calendar date (YYYY-MM-DD)');
    });
  });

  describe('datetime entity', () => {
    it('has correct type and intrinsic_validation', () => {
      const def = SYSTEM_ENTITY_DEFINITIONS.find((d) => d.type === 'datetime');
      expect(def).toBeDefined();
      expect(def!.name).toBe('__system_datetime');
      expect(def!.type).toBe('datetime');
      expect(def!.intrinsic_validation).toBe(
        'Resolves to a real calendar date and time (ISO 8601)',
      );
    });
  });

  describe('boolean entity', () => {
    it('has correct type and intrinsic_validation', () => {
      const def = SYSTEM_ENTITY_DEFINITIONS.find((d) => d.type === 'boolean');
      expect(def).toBeDefined();
      expect(def!.name).toBe('__system_boolean');
      expect(def!.type).toBe('boolean');
      expect(def!.intrinsic_validation).toBe('Resolves to true or false');
    });

    it('has values array with true/false/yes/no', () => {
      const def = SYSTEM_ENTITY_DEFINITIONS.find((d) => d.type === 'boolean');
      expect(def).toBeDefined();
      expect(def!.values).toEqual(['true', 'false', 'yes', 'no']);
    });
  });

  describe('currency entity', () => {
    it('has correct type and intrinsic_validation', () => {
      const def = SYSTEM_ENTITY_DEFINITIONS.find((d) => d.type === 'currency');
      expect(def).toBeDefined();
      expect(def!.name).toBe('__system_currency');
      expect(def!.type).toBe('currency');
      expect(def!.intrinsic_validation).toBe(
        'Valid numeric amount with optional currency symbol or ISO 4217 code',
      );
    });
  });
});

describe('getSystemEntityDefinition', () => {
  it('returns the definition for system entity types', () => {
    const emailDef = getSystemEntityDefinition('email');
    expect(emailDef).toBeDefined();
    expect(emailDef!.name).toBe('__system_email');
    expect(emailDef!.type).toBe('email');

    const phoneDef = getSystemEntityDefinition('phone');
    expect(phoneDef).toBeDefined();
    expect(phoneDef!.name).toBe('__system_phone');

    const dateDef = getSystemEntityDefinition('date');
    expect(dateDef).toBeDefined();
    expect(dateDef!.name).toBe('__system_date');

    const datetimeDef = getSystemEntityDefinition('datetime');
    expect(datetimeDef).toBeDefined();
    expect(datetimeDef!.name).toBe('__system_datetime');

    const boolDef = getSystemEntityDefinition('boolean');
    expect(boolDef).toBeDefined();
    expect(boolDef!.name).toBe('__system_boolean');

    const currDef = getSystemEntityDefinition('currency');
    expect(currDef).toBeDefined();
    expect(currDef!.name).toBe('__system_currency');
  });

  it('returns undefined for non-system entity types', () => {
    expect(getSystemEntityDefinition('string')).toBeUndefined();
    expect(getSystemEntityDefinition('enum')).toBeUndefined();
    expect(getSystemEntityDefinition('pattern')).toBeUndefined();
    expect(getSystemEntityDefinition('location')).toBeUndefined();
    expect(getSystemEntityDefinition('text')).toBeUndefined();
    expect(getSystemEntityDefinition('free_text')).toBeUndefined();
    expect(getSystemEntityDefinition('number')).toBeUndefined();
    expect(getSystemEntityDefinition('integer')).toBeUndefined();
    expect(getSystemEntityDefinition('float')).toBeUndefined();
  });

  it('returns undefined for unknown type strings', () => {
    expect(getSystemEntityDefinition('unknown')).toBeUndefined();
    expect(getSystemEntityDefinition('')).toBeUndefined();
    expect(getSystemEntityDefinition('EMAIL')).toBeUndefined();
  });
});

describe('isSystemEntityType', () => {
  it('returns true for system entity types', () => {
    expect(isSystemEntityType('email')).toBe(true);
    expect(isSystemEntityType('phone')).toBe(true);
    expect(isSystemEntityType('date')).toBe(true);
    expect(isSystemEntityType('datetime')).toBe(true);
    expect(isSystemEntityType('boolean')).toBe(true);
    expect(isSystemEntityType('currency')).toBe(true);
  });

  it('returns false for non-system entity types', () => {
    expect(isSystemEntityType('string')).toBe(false);
    expect(isSystemEntityType('enum')).toBe(false);
    expect(isSystemEntityType('pattern')).toBe(false);
    expect(isSystemEntityType('location')).toBe(false);
    expect(isSystemEntityType('text')).toBe(false);
    expect(isSystemEntityType('free_text')).toBe(false);
    expect(isSystemEntityType('number')).toBe(false);
    expect(isSystemEntityType('integer')).toBe(false);
    expect(isSystemEntityType('float')).toBe(false);
  });

  it('returns false for unknown type strings', () => {
    expect(isSystemEntityType('unknown')).toBe(false);
    expect(isSystemEntityType('')).toBe(false);
    expect(isSystemEntityType('EMAIL')).toBe(false);
  });
});
