import { describe, expect, it } from 'vitest';

import {
  buildJiraAssigneeWorkflowPlan,
  buildJiraIssueModelTriagePayload,
  parseJiraIssueModelDecisions,
  buildSimpleIssueHelixCommand,
  triageJiraIssue,
} from '../integrations/jira-assignee-workflow.js';
import type { JiraAssignedIssue } from '../integrations/jira-client.js';

describe('jira-assignee-workflow', () => {
  it('does not classify open issues without model decisions', () => {
    const plan = buildJiraAssigneeWorkflowPlan(
      [
        issue({
          key: 'ABLP-1',
          summary: 'Fix typo in runtime banner',
          descriptionText:
            'Expected: banner text is spelled correctly. Actual: banner has a typo. Steps: open runtime banner.',
          labels: ['runtime', 'typo'],
          components: ['runtime'],
        }),
        issue({
          key: 'ABLP-2',
          summary: 'Tenant isolation migration for credentials',
          descriptionText:
            'Migrate credential storage, preserve rollback, cover auth, tenant isolation, and concurrency.',
          labels: ['security'],
          components: ['runtime', 'database'],
        }),
        issue({
          key: 'ABLP-3',
          summary: 'Already fixed',
          status: 'Done',
          statusCategoryKey: 'done',
        }),
      ],
      { simpleLimit: 2 },
    );

    expect(plan.total).toBe(3);
    expect(plan.resolved.map((entry) => entry.issue.key)).toEqual(['ABLP-3']);
    expect(plan.simple).toEqual([]);
    expect(plan.medium.map((entry) => entry.issue.key)).toEqual(['ABLP-1', 'ABLP-2']);
    expect(plan.complex).toEqual([]);
    expect(plan.runnableSimple).toEqual([]);
    expect(plan.medium[0]?.action).toBe('needs-human-triage');
    expect(plan.medium[0]?.questions.join('\n')).toContain('Model triage is required');
  });

  it('uses model decisions to group and promote runnable simple issues', () => {
    const plan = buildJiraAssigneeWorkflowPlan(
      [
        issue({
          key: 'ABLP-1',
          summary: 'Fix typo in runtime banner',
          descriptionText:
            'Expected: banner text is spelled correctly. Actual: banner has a typo. Steps: open runtime banner.',
          labels: ['runtime', 'typo'],
          components: ['runtime'],
        }),
        issue({
          key: 'ABLP-2',
          summary: 'Tenant isolation migration for credentials',
          descriptionText:
            'Migrate credential storage, preserve rollback, cover auth, tenant isolation, and concurrency.',
          labels: ['security'],
          components: ['runtime', 'database'],
        }),
      ],
      {
        modelDecisions: [
          {
            key: 'ABLP-1',
            complexity: 'simple',
            action: 'autonomous-candidate',
            confidence: 'high',
            inferredScope: ['apps/runtime'],
            questions: [],
            reasoning: 'Clear typo fix with scoped proof and low blast radius.',
          },
          {
            key: 'ABLP-2',
            complexity: 'complex',
            action: 'needs-clarification',
            confidence: 'high',
            inferredScope: ['apps/runtime', 'packages/database'],
            questions: ['What rollout and rollback contract is required?'],
            reasoning: 'Security-sensitive migration with isolation and data integrity risk.',
          },
        ],
      },
    );

    expect(plan.runnableSimple.map((entry) => entry.issue.key)).toEqual(['ABLP-1']);
    expect(plan.runnableSimple[0]?.action).toBe('autonomous-candidate');
    expect(plan.complex.map((entry) => entry.issue.key)).toEqual(['ABLP-2']);
    expect(plan.complex[0]?.questions).toEqual(['What rollout and rollback contract is required?']);
  });

  it('requires model triage when no decision is available even for simple-looking issues', () => {
    const triage = triageJiraIssue(
      issue({
        key: 'ABLP-4',
        summary: 'Fix documentation typo',
        labels: ['docs'],
        components: [],
        descriptionText: 'Expected: spelling is corrected. Actual: typo remains. Steps: open docs.',
      }),
    );

    expect(triage.complexity).toBe('medium');
    expect(triage.action).toBe('needs-human-triage');
    expect(triage.reasons).toEqual([
      'awaiting required model triage; no local complexity decision applied',
    ]);
  });

  it('emits quality-oriented helix commands for model-approved simple issues', () => {
    const plan = buildJiraAssigneeWorkflowPlan(
      [
        issue({
          key: 'ABLP-5',
          summary: 'Fix compiler lint typo',
          labels: ['compiler', 'lint'],
          components: ['compiler'],
          descriptionText:
            'Expected: lint passes. Actual: lint typo remains. Steps: run package-local lint.',
        }),
      ],
      {
        modelDecisions: [
          {
            key: 'ABLP-5',
            complexity: 'simple',
            action: 'autonomous-candidate',
            confidence: 'high',
            inferredScope: ['packages/compiler'],
            questions: [],
            reasoning: 'Scoped lint fix with clear expected behavior.',
          },
        ],
      },
    );
    const triage = plan.runnableSimple[0];

    expect(triage).toBeDefined();

    expect(buildSimpleIssueHelixCommand(triage!)).toContain('--budget 75');
    expect(buildSimpleIssueHelixCommand(triage!)).toContain("--scope 'packages/compiler'");
    expect(buildSimpleIssueHelixCommand(triage!)).toContain('--auto-commit-confidence 9');
  });

  it('does not run model-approved simple issues without an implementation scope', () => {
    const plan = buildJiraAssigneeWorkflowPlan(
      [
        issue({
          key: 'ABLP-9',
          summary: 'Fix copy typo',
          labels: ['copy'],
          components: [],
        }),
      ],
      {
        modelDecisions: [
          {
            key: 'ABLP-9',
            complexity: 'simple',
            action: 'autonomous-candidate',
            confidence: 'high',
            inferredScope: [],
            questions: [],
            reasoning: 'Clear copy typo.',
          },
        ],
      },
    );

    expect(plan.runnableSimple).toEqual([]);
    expect(plan.blockedSimple.map((entry) => entry.issue.key)).toEqual(['ABLP-9']);
    expect(plan.blockedSimple[0]?.questions.join('\n')).toContain(
      'no implementation scope was available',
    );
  });

  it('builds compact model triage payloads for open issues only', () => {
    const payload = buildJiraIssueModelTriagePayload([
      issue({
        key: 'ABLP-6',
        summary: 'Open issue',
        descriptionText: 'x'.repeat(2000),
      }),
      issue({
        key: 'ABLP-7',
        summary: 'Done issue',
        status: 'Done',
        statusCategoryKey: 'done',
      }),
    ]);

    expect(payload.issues.map((entry) => entry.key)).toEqual(['ABLP-6']);
    expect(payload.issues[0]?.descriptionText).toContain('[truncated]');
    expect(payload.issues[0]?.descriptionText.length).toBeLessThanOrEqual(1400);
  });

  it('parses validated model decisions from JSON output', () => {
    const decisions = parseJiraIssueModelDecisions(`
      {"decisions":[{"key":"ABLP-8","complexity":"medium","action":"needs-human-triage","confidence":"medium","inferredScope":["apps/studio"],"questions":["Need repro?"],"reasoning":"Missing reproduction details."}]}
    `);

    expect(decisions).toEqual([
      {
        key: 'ABLP-8',
        complexity: 'medium',
        action: 'needs-human-triage',
        confidence: 'medium',
        inferredScope: ['apps/studio'],
        questions: ['Need repro?'],
        reasoning: 'Missing reproduction details.',
      },
    ]);
  });
});

function issue(overrides: Partial<JiraAssignedIssue>): JiraAssignedIssue {
  return {
    key: 'ABLP-0',
    summary: 'Issue',
    status: 'To Do',
    statusCategoryKey: 'indeterminate',
    description: null,
    descriptionText: '',
    labels: [],
    components: [],
    ...overrides,
  };
}
