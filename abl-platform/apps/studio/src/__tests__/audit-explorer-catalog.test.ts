import { describe, expect, it } from 'vitest';
import {
  getAuditExplorerCategoryValues,
  resolveAuditExplorerCategory,
  resolveAuditExplorerCategoryLabel,
} from '../lib/audit/audit-explorer-catalog';

describe('audit explorer catalog', () => {
  it('classifies runtime auth failures as auth instead of system plugin', () => {
    expect(resolveAuditExplorerCategory('auth.user.failure', 'auth.user.failure')).toBe(
      'auth_access',
    );
    expect(resolveAuditExplorerCategoryLabel('auth.user.failure', 'auth.user.failure')).toBe(
      'Auth & access',
    );
  });

  it('does not classify execution-only events as compliance audit events', () => {
    expect(resolveAuditExplorerCategory('handoff.executed', 'handoff.executed')).toBe(
      'uncategorized',
    );
    expect(resolveAuditExplorerCategoryLabel('handoff.executed', 'handoff.executed')).toBe(
      'Uncategorized',
    );
  });

  it('classifies explicit agent configuration events', () => {
    expect(resolveAuditExplorerCategory('agent_updated', 'agent_updated')).toBe(
      'project_agent_configuration',
    );
    expect(resolveAuditExplorerCategory('agent_dsl_updated', 'agent_dsl_updated')).toBe(
      'project_agent_configuration',
    );
    expect(resolveAuditExplorerCategoryLabel('agent_dsl_updated', 'agent_dsl_updated')).toBe(
      'Project, agent & workflow configuration',
    );
  });

  it('keeps generic plugin writes out of compliance audit categories', () => {
    expect(resolveAuditExplorerCategory('create')).toBe('uncategorized');
    expect(resolveAuditExplorerCategoryLabel('create')).toBe('Uncategorized');
  });

  it('expands auth filters without routine runtime auth successes or refreshes', () => {
    const filters = getAuditExplorerCategoryValues(['auth_access']);

    expect(filters.values).toContain('auth.user.failure');
    expect(filters.values).not.toContain('auth.user.success');
    expect(filters.values).not.toContain('token_refresh');
    expect(filters.prefixes).not.toContain('auth.');
  });

  it('expands project configuration filters without raw plugin collection prefixes', () => {
    const filters = getAuditExplorerCategoryValues(['project_agent_configuration']);

    expect(filters.values).toContain('agent_updated');
    expect(filters.values).toContain('agent_dsl_updated');
    expect(filters.prefixes).not.toContain('project_agents.');
  });

  it('classifies workspace member invitation and join events as governance', () => {
    expect(resolveAuditExplorerCategory('invitation_accepted', 'invitation_accepted')).toBe(
      'workspace_governance',
    );
    expect(resolveAuditExplorerCategory('member_joined', 'member_joined')).toBe(
      'workspace_governance',
    );

    const filters = getAuditExplorerCategoryValues(['workspace_governance']);
    expect(filters.values).toContain('invitation_sent');
    expect(filters.values).toContain('invitation_accepted');
    expect(filters.values).toContain('member_joined');
  });
});
