import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const studioBundlePath = join(here, '..', '..', 'locales', 'en', 'studio.json');

type StudioBundle = {
  evals: {
    personas: {
      source: Record<string, string>;
    };
  };
};

// API enum from apps/studio/src/app/api/projects/[id]/evals/personas/route.ts
// Front-end interpolates persona.source into t(`personas.source.${persona.source}`),
// so the bundle keys MUST match these enum values verbatim.
const PERSONA_SOURCE_VALUES = ['ai-generated', 'custom', 'template'] as const;

describe('evals.personas.source i18n keys', () => {
  const bundle = JSON.parse(readFileSync(studioBundlePath, 'utf8')) as StudioBundle;

  it('exposes a key for every persona source enum value', () => {
    const keys = Object.keys(bundle.evals.personas.source);
    for (const value of PERSONA_SOURCE_VALUES) {
      expect(keys, `missing personas.source.${value}`).toContain(value);
    }
  });

  it('uses kebab-case keys to match the API enum and front-end interpolation', () => {
    for (const key of Object.keys(bundle.evals.personas.source)) {
      expect(key, `key '${key}' must not contain underscores`).not.toContain('_');
    }
  });
});
