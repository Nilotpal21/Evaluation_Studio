import { z } from 'zod';
import type { Environment } from '../environment.js';

/**
 * Environment schema using canonical short-form values.
 * Accepts aliases ('development', 'production') and normalizes them.
 */
export const EnvironmentSchema = z
  .string()
  .default('dev')
  .transform((val): Environment => {
    const aliases: Record<string, Environment> = {
      development: 'dev',
      dev: 'dev',
      test: 'dev',
      staging: 'staging',
      stg: 'staging',
      production: 'production',
      prod: 'production',
    };
    const normalized = aliases[val.toLowerCase().trim()];
    if (!normalized) {
      throw new Error(`Unknown environment: ${val}`);
    }
    return normalized;
  });
