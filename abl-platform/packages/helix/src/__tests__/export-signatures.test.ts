import { describe, expect, it } from 'vitest';

import { extractExportSignatures } from '../intelligence/export-signatures.js';

describe('export-signatures', () => {
  it('extracts concise signatures for common exported declarations', () => {
    const signatures = extractExportSignatures(
      'src/example.ts',
      [
        'export function build(userId: string, retries = 1): Promise<Result> {',
        '  return Promise.resolve({ ok: true } as Result);',
        '}',
        'export interface Shape { x: number; y?: string; z: boolean; hidden: Date }',
        "export type Mode = 'strict' | 'loose';",
        'export enum Status { Ready, Waiting, Failed, Done, Retrying }',
        'export const enabled = true;',
        'export const render = (input: string): string => input.trim();',
        'export default class Service extends BaseService implements Runner, Disposable {}',
      ].join('\n'),
    );

    expect(signatures).toMatchObject({
      build: 'function build(userId: string, retries = 1): Promise<Result>',
      Shape: 'interface Shape { x: number; y?: string; z: boolean; +1 more }',
      Mode: "type Mode = 'strict' | 'loose'",
      Status: 'enum Status { Ready, Waiting, Failed, Done, +1 more }',
      enabled: 'const enabled: boolean',
      render: 'const render(input: string): string',
      default: 'default class Service extends BaseService implements Runner, Disposable',
    });
  });
});
