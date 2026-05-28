/**
 * Tests for Post-Import Validator
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  validatePostImport,
  type PostImportDbAdapter,
  type PostImportInput,
} from '../import/post-import-validator.js';

// ─── Mock DB Adapter ────────────────────────────────────────────────────

function createMockDb(): PostImportDbAdapter {
  return {
    getProjectEnvVars: vi.fn().mockResolvedValue([]),
    getProjectConnectors: vi.fn().mockResolvedValue([]),
    getProjectMCPServers: vi.fn().mockResolvedValue([]),
    getProjectGuardrails: vi.fn().mockResolvedValue([]),
    getTenantGuardrailProviders: vi.fn().mockResolvedValue([]),
    getProjectAuthProfiles: vi.fn().mockResolvedValue([]),
  };
}

function makeInput(overrides?: Partial<PostImportInput>): PostImportInput {
  return {
    projectId: 'proj-1',
    tenantId: 'tenant-1',
    importedLayers: ['core'],
    referencedEnvVars: [],
    referencedConnectors: [],
    referencedMCPServers: [],
    layerCounts: { core: { imported: 5, skipped: 0 } },
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('validatePostImport', () => {
  let db: PostImportDbAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
  });

  describe('status determination', () => {
    it('should return "ready" when no issues', async () => {
      const report = await validatePostImport(makeInput(), db);
      expect(report.status).toBe('ready');
    });

    it('should return "action_required" when env vars missing', async () => {
      const input = makeInput({
        referencedEnvVars: ['OPENAI_API_KEY', 'SLACK_TOKEN'],
      });

      const report = await validatePostImport(input, db);
      expect(report.status).toBe('action_required');
      expect(report.provisioning_required.env_vars).toContain('OPENAI_API_KEY');
      expect(report.provisioning_required.env_vars).toContain('SLACK_TOKEN');
    });

    it('should return "imported_with_warnings" for env vars without values', async () => {
      (db.getProjectEnvVars as ReturnType<typeof vi.fn>).mockResolvedValue([
        { key: 'OPENAI_API_KEY', hasValue: false },
      ]);

      const input = makeInput({
        referencedEnvVars: ['OPENAI_API_KEY'],
      });

      const report = await validatePostImport(input, db);
      expect(report.status).toBe('imported_with_warnings');
      expect(report.warnings.some((w) => w.includes('OPENAI_API_KEY'))).toBe(true);
    });
  });

  describe('connector validation', () => {
    it('should report connectors needing credentials', async () => {
      (db.getProjectConnectors as ReturnType<typeof vi.fn>).mockResolvedValue([
        { name: 'salesforce', hasCredentials: false },
      ]);

      const input = makeInput({
        referencedConnectors: ['salesforce', 'zendesk'],
      });

      const report = await validatePostImport(input, db);
      expect(report.provisioning_required.connectors_needing_credentials).toContain('salesforce');
      expect(report.provisioning_required.connectors_needing_credentials).toContain('zendesk');
    });

    it('should not report connectors that have credentials', async () => {
      (db.getProjectConnectors as ReturnType<typeof vi.fn>).mockResolvedValue([
        { name: 'salesforce', hasCredentials: true },
      ]);

      const input = makeInput({
        referencedConnectors: ['salesforce'],
      });

      const report = await validatePostImport(input, db);
      expect(report.provisioning_required.connectors_needing_credentials.length).toBe(0);
    });
  });

  describe('MCP server validation', () => {
    it('should report MCP servers needing auth', async () => {
      const input = makeInput({
        referencedMCPServers: ['internal-tools'],
      });

      const report = await validatePostImport(input, db);
      expect(report.provisioning_required.mcp_servers_needing_auth).toContain('internal-tools');
    });

    it('should not report MCP servers that have auth', async () => {
      (db.getProjectMCPServers as ReturnType<typeof vi.fn>).mockResolvedValue([
        { serverName: 'internal-tools', hasAuth: true },
      ]);

      const input = makeInput({
        referencedMCPServers: ['internal-tools'],
      });

      const report = await validatePostImport(input, db);
      expect(report.provisioning_required.mcp_servers_needing_auth.length).toBe(0);
    });
  });

  describe('guardrail provider validation', () => {
    it('should warn about unconfigured guardrail providers', async () => {
      (db.getProjectGuardrails as ReturnType<typeof vi.fn>).mockResolvedValue([
        { name: 'input-filter', providerNames: ['azure-content-safety'] },
      ]);
      (db.getTenantGuardrailProviders as ReturnType<typeof vi.fn>).mockResolvedValue([
        { providerName: 'openai-moderation' },
      ]);

      const input = makeInput({
        importedLayers: ['core', 'guardrails'],
      });

      const report = await validatePostImport(input, db);
      expect(report.warnings.some((w) => w.includes('azure-content-safety'))).toBe(true);
    });

    it('should inspect rule providers and provider override names independently', async () => {
      (db.getProjectGuardrails as ReturnType<typeof vi.fn>).mockResolvedValue([
        { name: 'rich-policy', providerNames: ['rule-provider', 'override-provider'] },
      ]);
      (db.getTenantGuardrailProviders as ReturnType<typeof vi.fn>).mockResolvedValue([
        { providerName: 'rule-provider' },
      ]);

      const report = await validatePostImport(
        makeInput({ importedLayers: ['core', 'guardrails'] }),
        db,
      );

      expect(report.warnings).toContain(
        'Guardrail "rich-policy" references provider "override-provider" which is not configured in this tenant',
      );
      expect(report.warnings.some((warning) => warning.includes('rule-provider'))).toBe(false);
    });

    it('should treat built-in guardrail providers as runtime available', async () => {
      (db.getProjectGuardrails as ReturnType<typeof vi.fn>).mockResolvedValue([
        { name: 'pii-policy', providerNames: ['builtin-pii'] },
      ]);
      (db.getTenantGuardrailProviders as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const report = await validatePostImport(
        makeInput({ importedLayers: ['core', 'guardrails'] }),
        db,
      );

      expect(report.warnings.some((warning) => warning.includes('builtin-pii'))).toBe(false);
    });

    it('should not check guardrails if guardrails layer not imported', async () => {
      const input = makeInput({
        importedLayers: ['core'],
      });

      await validatePostImport(input, db);
      expect(db.getProjectGuardrails).not.toHaveBeenCalled();
    });
  });

  describe('layer summary', () => {
    it('should include layer counts in report', async () => {
      const input = makeInput({
        layerCounts: {
          core: { imported: 10, skipped: 2 },
          connections: { imported: 3, skipped: 0 },
        },
      });

      const report = await validatePostImport(input, db);
      expect(report.layer_summary.core).toEqual({ imported: 10, skipped: 2 });
      expect(report.layer_summary.connections).toEqual({ imported: 3, skipped: 0 });
    });
  });

  describe('auth profile validation', () => {
    it('should report missing auth profiles in provisioning_required', async () => {
      const input = makeInput({
        referencedAuthProfiles: ['missing-profile'],
      });

      const report = await validatePostImport(input, db);
      expect(report.status).toBe('action_required');
      expect(report.provisioning_required.auth_profiles).toHaveLength(1);
      expect(report.provisioning_required.auth_profiles[0].name).toBe('missing-profile');
    });

    it('should not report auth profiles that exist in target project', async () => {
      (db.getProjectAuthProfiles as ReturnType<typeof vi.fn>).mockResolvedValue([
        { name: 'existing-profile', authType: 'api_key' },
      ]);

      const input = makeInput({
        referencedAuthProfiles: ['existing-profile'],
      });

      const report = await validatePostImport(input, db);
      expect(report.provisioning_required.auth_profiles).toHaveLength(0);
    });

    it('should not check auth profiles when none referenced', async () => {
      const input = makeInput({
        referencedAuthProfiles: [],
      });

      await validatePostImport(input, db);
      expect(db.getProjectAuthProfiles).not.toHaveBeenCalled();
    });

    it('should report auth_profiles as empty array when no auth profiles referenced', async () => {
      const report = await validatePostImport(makeInput(), db);
      expect(report.provisioning_required.auth_profiles).toEqual([]);
    });
  });
});
