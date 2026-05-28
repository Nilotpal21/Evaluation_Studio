/**
 * FAILS: reproduces ABLP-1010 (structured diagnostics contract)
 *
 * This test validates that buildModuleRelease returns structured
 * PublishDiagnostic[] objects (with code, toolId, fieldPath, userMessage)
 * when publish safety validation fails — instead of collapsing them
 * into opaque concatenated strings.
 *
 * Today this test FAILS because ModuleReleaseBuildFailure.errors is
 * string[] (e.g. "[LITERAL_AUTH_VALUE] tool:list_users: HTTP tool ..."),
 * not a typed diagnostics array.
 */

// FAILS: reproduces ABLP-1010

import { describe, it, expect } from 'vitest';

import {
  buildModuleRelease,
  type ModuleReleaseInput,
  type CompileFn,
  type ExtractContractFn,
  type ValidatePublishSafetyFn,
} from '../module-release/build-module-release.js';
import { validatePublishSafety } from '../module-release/module-publish-safety.js';

// ─── Expected Diagnostic Shape (ABLP-1010 target contract) ──────────────

interface PublishDiagnostic {
  severity: 'blocking' | 'warning';
  code: string;
  toolId?: string;
  fieldPath?: string;
  userMessage: string;
  supportMessage?: string;
  actionLink?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/** Trivial compile function that always "succeeds" */
const stubCompileFn: CompileFn = () => ({ compiled: true });

/** Trivial contract extractor */
const stubExtractContractFn: ExtractContractFn = () => ({
  providedAgents: [],
  providedTools: [],
  requiredConfigKeys: [],
  requiredSecrets: [],
  requiredAuthProfiles: [],
  requiredConnectors: [],
});

// ─── Tests ───────────────────────────────────────────────────────────────

describe('ABLP-1010: buildModuleRelease returns structured diagnostics', () => {
  it('returns diagnostics[] with code, toolId, fieldPath, userMessage when 2 HTTP tools have literal auth', () => {
    const input: ModuleReleaseInput = {
      entryAgentName: 'main-agent',
      agents: {
        'main-agent': 'AGENT: main-agent\nDESCRIPTION: Test agent',
      },
      tools: {
        list_users: {
          dslContent: 'AUTH: my-literal-secret-token-value\nURL: https://api.example.com/users',
          toolType: 'http',
        },
        get_user: {
          dslContent: 'AUTH: another-literal-secret-token\nURL: https://api.example.com/user',
          toolType: 'http',
        },
      },
      dslFormat: 'legacy',
      hasModelConfigs: false,
    };

    const result = buildModuleRelease(
      input,
      stubCompileFn,
      stubExtractContractFn,
      validatePublishSafety,
    );

    // The build should fail (literal auth values are blocking)
    expect(result.success).toBe(false);

    if (!result.success) {
      // ─── ABLP-1010 contract assertion ───────────────────────────────
      // The result MUST have a `diagnostics` array with typed objects,
      // NOT just a flat `errors: string[]`.

      const resultAsAny = result as Record<string, unknown>;

      // Assert diagnostics array exists
      expect(resultAsAny).toHaveProperty('diagnostics');
      expect(Array.isArray(resultAsAny.diagnostics)).toBe(true);

      const diagnostics = resultAsAny.diagnostics as PublishDiagnostic[];

      // Should have at least 2 diagnostics (one per tool)
      expect(diagnostics.length).toBeGreaterThanOrEqual(2);

      // Each diagnostic must have the required structured fields
      for (const diag of diagnostics) {
        expect(diag).toHaveProperty('code');
        expect(diag).toHaveProperty('userMessage');
        expect(typeof diag.code).toBe('string');
        expect(typeof diag.userMessage).toBe('string');
        expect(diag.code).not.toBe('');
        expect(diag.userMessage).not.toBe('');

        // toolId should be present for tool-scoped diagnostics
        if (diag.code === 'LITERAL_AUTH_VALUE') {
          expect(diag).toHaveProperty('toolId');
          expect(typeof diag.toolId).toBe('string');
          expect(['list_users', 'get_user']).toContain(diag.toolId);
        }
      }

      // Verify diagnostics are NOT flat strings
      for (const diag of diagnostics) {
        expect(typeof diag).not.toBe('string');
        expect(typeof diag).toBe('object');
      }

      // The old flat `errors: string[]` format should NOT be the primary shape
      // (this is what currently exists and what we want to move away from)
      if (Array.isArray(resultAsAny.errors)) {
        // If errors still exists for backward compat, diagnostics must ALSO exist
        expect(resultAsAny.diagnostics).toBeDefined();
      }
    }
  });

  it('diagnostics include fieldPath for auth-related issues', () => {
    const input: ModuleReleaseInput = {
      entryAgentName: 'main-agent',
      agents: {
        'main-agent': 'AGENT: main-agent\nDESCRIPTION: Test agent',
      },
      tools: {
        list_users: {
          dslContent:
            'AUTH: hardcoded-secret-value-here\nAuthorization: Bearer sk-1234567890abcdefghijklmn',
          toolType: 'http',
        },
      },
      dslFormat: 'legacy',
      hasModelConfigs: false,
    };

    const result = buildModuleRelease(
      input,
      stubCompileFn,
      stubExtractContractFn,
      validatePublishSafety,
    );

    expect(result.success).toBe(false);

    if (!result.success) {
      const resultAsAny = result as Record<string, unknown>;
      expect(resultAsAny).toHaveProperty('diagnostics');

      const diagnostics = resultAsAny.diagnostics as PublishDiagnostic[];

      // At least one diagnostic should have fieldPath indicating where the issue is
      const authDiags = diagnostics.filter(
        (d) => d.code === 'LITERAL_AUTH_VALUE' || d.code === 'LITERAL_AUTH_HEADER',
      );
      expect(authDiags.length).toBeGreaterThanOrEqual(1);

      for (const diag of authDiags) {
        expect(diag.toolId).toBe('list_users');
        // fieldPath should indicate the auth-related field
        expect(diag).toHaveProperty('fieldPath');
        expect(typeof diag.fieldPath).toBe('string');
      }
    }
  });
});
