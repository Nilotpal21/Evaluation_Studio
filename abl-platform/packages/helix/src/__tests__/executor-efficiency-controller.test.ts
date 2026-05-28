import { describe, expect, it } from 'vitest';

import { ExecutorEfficiencyController } from '../models/executor-efficiency-controller.js';

describe('ExecutorEfficiencyController', () => {
  it('reduces executor max turns to the HELIX hard cap for simple slices', () => {
    const controller = new ExecutorEfficiencyController({
      targetTurns: 18,
      explorationTurns: 6,
      summary: '1 direct file, 0 dependents',
    });

    expect(controller.hardTurnCap).toBe(36);
    expect(controller.resolveMaxTurns(50)).toBe(36);
    expect(controller.resolveMaxTurns(20)).toBe(20);
  });

  it('respects an explicit hard turn cap override when provided', () => {
    const controller = new ExecutorEfficiencyController({
      targetTurns: 18,
      explorationTurns: 6,
      hardTurnCap: 4,
    });

    expect(controller.hardTurnCap).toBe(4);
    expect(controller.resolveMaxTurns(50)).toBe(4);
  });

  it('emits milestone messages when exploration and target budgets are crossed', () => {
    const controller = new ExecutorEfficiencyController({
      targetTurns: 20,
      explorationTurns: 6,
    });

    expect(controller.noteTurn(5)).toEqual([]);
    expect(controller.noteTurn(6)).toEqual([expect.stringContaining('exploration budget reached')]);
    expect(controller.noteTurn(20)).toEqual([
      expect.stringContaining('target turn budget reached'),
    ]);
  });

  it('denies repeated Claude file reads after the exploration budget is exhausted', () => {
    const controller = new ExecutorEfficiencyController({
      targetTurns: 24,
      explorationTurns: 8,
    });

    expect(
      controller.evaluateToolUse(
        'Read',
        { file_path: 'packages/helix/src/pipeline/pipeline-engine.ts' },
        8,
      ),
    ).toMatchObject({ behavior: 'allow' });
    expect(
      controller.evaluateToolUse(
        'Read',
        { file_path: 'packages/helix/src/pipeline/pipeline-engine.ts' },
        8,
      ),
    ).toMatchObject({ behavior: 'allow' });
    expect(
      controller.evaluateToolUse(
        'Read',
        { file_path: 'packages/helix/src/pipeline/pipeline-engine.ts' },
        8,
      ),
    ).toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('repeated Read lookup'),
    });
  });

  it('denies all Claude tool use when the budget marks a recovery retry as tool-free', () => {
    const controller = new ExecutorEfficiencyController({
      targetTurns: 6,
      explorationTurns: 1,
      disableToolUse: true,
    });

    expect(
      controller.evaluateToolUse(
        'Read',
        { file_path: 'packages/helix/src/pipeline/pipeline-engine.ts' },
        0,
      ),
    ).toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('disabled tool use'),
    });
  });

  it('blocks exploratory Claude grep/glob lookups after the target budget when configured', () => {
    const controller = new ExecutorEfficiencyController({
      targetTurns: 14,
      explorationTurns: 5,
      abortExploratoryToolUseAfterTargetTurns: true,
    });

    expect(
      controller.evaluateToolUse('Glob', { path: 'apps/studio/src', pattern: '**/*members*' }, 14),
    ).toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('after the target turn budget'),
    });
  });

  it('aborts helper-level scoped tool inspection once the replay seam window is exhausted', () => {
    const controller = new ExecutorEfficiencyController({
      targetTurns: 21,
      explorationTurns: 8,
      scopedToolInspectionCountLimit: 2,
      abortScopedToolInspectionAfterLimit: true,
    });

    expect(
      controller.evaluateToolUse(
        'Read',
        { file_path: 'apps/studio/src/__tests__/api-routes/api-project-members.test.ts' },
        8,
      ),
    ).toMatchObject({ behavior: 'allow' });
    expect(
      controller.evaluateToolUse('Read', { file_path: 'apps/studio/vitest.config.ts' }, 8),
    ).toMatchObject({ behavior: 'allow' });
    expect(
      controller.evaluateToolUse(
        'Grep',
        {
          path: 'apps/studio/src/app/api/projects/[id]/members',
          pattern: 'requireProjectPermission',
        },
        12,
      ),
    ).toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('replay seam window'),
    });
  });

  it('warns, then aborts, repeated shell exploration commands once the target budget is reached', () => {
    const controller = new ExecutorEfficiencyController({
      targetTurns: 20,
      explorationTurns: 6,
    });

    expect(controller.evaluateShellCommand('git status --short', 6, false)).toEqual({
      warnings: [],
    });
    expect(controller.evaluateShellCommand('git status --short', 6, false)).toEqual({
      warnings: [expect.stringContaining('repeated shell exploration command')],
    });
    expect(controller.evaluateShellCommand('git status --short', 20, false)).toMatchObject({
      warnings: [],
      abortMessage: expect.stringContaining('Stopping this trajectory'),
    });
  });

  it('aborts new exploratory shell commands after the target budget when configured', () => {
    const controller = new ExecutorEfficiencyController({
      targetTurns: 14,
      explorationTurns: 5,
      abortExploratoryToolUseAfterTargetTurns: true,
    });

    expect(
      controller.evaluateShellCommand('ls apps/studio/src/app/api/projects', 14, false),
    ).toMatchObject({
      warnings: [],
      abortMessage: expect.stringContaining('after reaching the HELIX target turn budget'),
    });
    expect(
      controller.evaluateShellCommand(
        "sed -n '1,120p' apps/studio/src/repos/project-repo.ts",
        14,
        false,
      ),
    ).toEqual({ warnings: [] });
  });

  it('aborts zero-turn shell saturation once the replay shell floor is exceeded', () => {
    const controller = new ExecutorEfficiencyController({
      targetTurns: 20,
      explorationTurns: 6,
      zeroTurnShellAbortFloor: 4,
    });

    expect(
      controller.evaluateShellCommand(
        "sed -n '1,220p' apps/studio/src/app/api/projects/[id]/members/route.ts",
        0,
        false,
      ),
    ).toEqual({ warnings: [] });
    expect(
      controller.evaluateShellCommand(
        "sed -n '1,220p' apps/studio/src/app/api/projects/[id]/members/[userId]/route.ts",
        0,
        false,
      ),
    ).toEqual({ warnings: [] });
    expect(
      controller.evaluateShellCommand(
        "sed -n '1,220p' apps/studio/src/repos/project-repo.ts",
        0,
        false,
      ),
    ).toEqual({ warnings: [] });

    expect(
      controller.evaluateShellCommand(
        "sed -n '1,220p' packages/database/src/models/project-member.model.ts",
        0,
        false,
      ),
    ).toMatchObject({
      warnings: [],
      abortMessage: expect.stringContaining('zero-turn shell saturation floor'),
    });
  });

  it('aborts zero-turn shell startup once the elapsed rescue window is exceeded', () => {
    const controller = new ExecutorEfficiencyController({
      targetTurns: 20,
      explorationTurns: 6,
      zeroTurnElapsedAbortMs: 30_000,
    });

    expect(
      controller.evaluateShellCommand(
        "sed -n '1,220p' apps/studio/src/app/api/projects/[id]/members/route.ts",
        0,
        false,
        12_000,
      ),
    ).toEqual({ warnings: [] });

    expect(
      controller.evaluateShellCommand(
        "sed -n '1,220p' apps/studio/src/repos/project-repo.ts",
        0,
        false,
        31_000,
      ),
    ).toMatchObject({
      warnings: [],
      abortMessage: expect.stringContaining('zero-turn elapsed rescue window'),
    });
  });

  it('warns and aborts when too many unique shell exploration commands accumulate after the budget', () => {
    const controller = new ExecutorEfficiencyController({
      targetTurns: 10,
      explorationTurns: 3,
    });

    const exploratoryCommands = [
      'pwd',
      'ls -la apps/studio/src/components/auth',
      "grep -rn 'create-workspace' apps/studio/src/",
      'find apps/studio/src -name "*UserMenu*"',
      'fd UserMenu apps/studio/src',
      "rg -n 'useTranslations|useNavigationStore' apps/studio/src/__tests__",
      'git status --short',
      'git diff --stat -- apps/studio',
      "rg -n 'onboarding' apps/studio/src",
      'find apps/studio/src/__tests__ -name "*menu*"',
      'fd workspace apps/studio/src/__tests__',
      "grep -rn 'NextIntlClientProvider' apps/studio/src/__tests__",
      'ls -la apps/studio/src/__tests__/components',
    ];

    exploratoryCommands.slice(0, 5).forEach((command) => {
      expect(controller.evaluateShellCommand(command, 0, false)).toEqual({ warnings: [] });
    });

    expect(controller.evaluateShellCommand(exploratoryCommands[5], 0, false)).toEqual({
      warnings: [expect.stringContaining('too many shell exploration commands')],
    });

    exploratoryCommands.slice(6, 12).forEach((command) => {
      expect(controller.evaluateShellCommand(command, 0, false)).toEqual({ warnings: [] });
    });

    expect(controller.evaluateShellCommand(exploratoryCommands[12], 0, false)).toMatchObject({
      warnings: [],
      abortMessage: expect.stringContaining('shell-heavy trajectory'),
    });
  });

  it('aborts exploratory shell commands immediately after the hard turn cap is reached', () => {
    const controller = new ExecutorEfficiencyController({
      targetTurns: 18,
      explorationTurns: 6,
    });

    expect(
      controller.evaluateShellCommand('git ls-files | grep project-member', 36, false),
    ).toMatchObject({
      warnings: [],
      abortMessage: expect.stringContaining('HELIX efficiency hard cap'),
    });
  });

  it('supports stage-specific shell floors for narrow bug-fix replay paths', () => {
    const controller = new ExecutorEfficiencyController({
      targetTurns: 10,
      explorationTurns: 3,
      shellWarnFloor: 8,
      shellAbortFloor: 14,
    });

    const exploratoryCommands = [
      'pwd',
      'ls -la apps/studio/src/components/auth',
      "grep -rn 'create-workspace' apps/studio/src/",
      'find apps/studio/src -name "*UserMenu*"',
      'fd UserMenu apps/studio/src',
      "rg -n 'useTranslations|useNavigationStore' apps/studio/src/__tests__",
      'git status --short',
      'git diff --stat -- apps/studio',
      "rg -n 'onboarding' apps/studio/src",
      'find apps/studio/src/__tests__ -name "*menu*"',
      'fd workspace apps/studio/src/__tests__',
      "grep -rn 'NextIntlClientProvider' apps/studio/src/__tests__",
      'ls -la apps/studio/src/__tests__/components',
      'find apps/studio/src -name "*workspace*"',
    ];

    exploratoryCommands.slice(0, 7).forEach((command) => {
      expect(controller.evaluateShellCommand(command, 0, false)).toEqual({ warnings: [] });
    });

    expect(controller.evaluateShellCommand(exploratoryCommands[7], 0, false)).toEqual({
      warnings: [expect.stringContaining('too many shell exploration commands')],
    });

    exploratoryCommands.slice(8, 13).forEach((command) => {
      expect(controller.evaluateShellCommand(command, 0, false)).toEqual({ warnings: [] });
    });

    expect(controller.evaluateShellCommand(exploratoryCommands[13], 0, false)).toMatchObject({
      warnings: [],
      abortMessage: expect.stringContaining('shell-heavy trajectory'),
    });
  });

  it('denies replay-forbidden shell inventory commands after the exploration budget', () => {
    const controller = new ExecutorEfficiencyController({
      targetTurns: 22,
      explorationTurns: 8,
      forbiddenShellPatterns: ['^ls(?:\\s|$)', '^find(?:\\s|$)', '^fd(?:\\s|$)'],
    });

    expect(controller.evaluateShellCommand('ls apps/', 7, false)).toEqual({
      warnings: [],
    });

    expect(controller.evaluateShellCommand('ls apps/', 8, false)).toMatchObject({
      warnings: [],
      abortMessage: expect.stringContaining('replay-disallowed exploratory shell command'),
    });

    expect(controller.evaluateShellCommand('find . -maxdepth 3 -type f', 8, false)).toMatchObject({
      warnings: [],
      abortMessage: expect.stringContaining('replay-disallowed exploratory shell command'),
    });
  });

  it('treats explicit shell floors as direct overrides, not minimums', () => {
    const controller = new ExecutorEfficiencyController({
      targetTurns: 21,
      explorationTurns: 8,
      shellWarnFloor: 12,
      shellAbortFloor: 18,
    });

    const exploratoryCommands = [
      'pwd',
      'ls apps/studio/src/app/api/projects/[id]/members',
      "rg -n 'findProjectMembers' apps/studio/src/repos/project-repo.ts",
      'find apps/studio/src -name "*project-member*"',
      "grep -rn 'customRoleId' apps/studio/src packages/database/src",
      'git status --short',
      'git diff --stat -- apps/studio packages/database',
      "rg -n 'RoleDefinition' packages/database/src/models",
      'fd project-member apps/studio/src',
      "grep -rn 'audit' apps/studio/src/services",
      'ls apps/studio/src/lib',
      "rg -n 'PROJECT_ROLE_NAMES' packages/shared-auth/src",
      "find apps/studio/src/components -name '*Members*'",
      "grep -rn 'permission-resolver' apps/studio/src",
      "rg -n 'ProjectMembersTab' apps/studio/src/components",
      'git log -1 --stat',
      'find apps/studio/src -name "*permission*"',
      'fd resolver apps/studio/src',
    ];

    exploratoryCommands.slice(0, 11).forEach((command) => {
      expect(controller.evaluateShellCommand(command, 0, false)).toEqual({ warnings: [] });
    });

    expect(controller.evaluateShellCommand(exploratoryCommands[11], 0, false)).toEqual({
      warnings: [expect.stringContaining('too many shell exploration commands')],
    });

    exploratoryCommands.slice(12, 17).forEach((command) => {
      expect(controller.evaluateShellCommand(command, 0, false)).toEqual({ warnings: [] });
    });

    expect(controller.evaluateShellCommand(exploratoryCommands[17], 0, false)).toMatchObject({
      warnings: [],
      abortMessage: expect.stringContaining('shell-heavy trajectory'),
    });
  });

  it('does not count direct shell file reads toward the shell exploration total', () => {
    const controller = new ExecutorEfficiencyController({
      targetTurns: 10,
      explorationTurns: 3,
    });

    const directReads = [
      "sed -n '1,220p' apps/studio/src/components/auth/UserMenu.tsx",
      "sed -n '1,220p' apps/studio/src/app/onboarding/page.tsx",
      'cat -n apps/studio/src/store/auth-store.ts',
      'head -n 40 apps/studio/src/store/navigation-store.ts',
      'tail -n 40 packages/i18n/locales/en/studio.json',
    ];

    directReads.forEach((command) => {
      expect(controller.evaluateShellCommand(command, 0, false)).toEqual({ warnings: [] });
    });

    expect(controller.evaluateShellCommand('pwd', 0, false)).toEqual({ warnings: [] });
    expect(controller.evaluateShellCommand('ls -la apps/studio/src/components', 0, false)).toEqual({
      warnings: [],
    });
    expect(
      controller.evaluateShellCommand("rg -n 'create-workspace' apps/studio/src", 0, false),
    ).toEqual({ warnings: [] });
  });

  it('treats repeated line-number shell lookups as exploratory churn after proof work', () => {
    const controller = new ExecutorEfficiencyController({
      targetTurns: 20,
      explorationTurns: 6,
    });

    expect(
      controller.evaluateShellCommand('nl -ba apps/studio/src/app/page.tsx', 6, false),
    ).toEqual({
      warnings: [],
    });
    expect(
      controller.evaluateShellCommand('nl -ba apps/studio/src/app/page.tsx', 6, false),
    ).toEqual({
      warnings: [expect.stringContaining('repeated shell exploration command')],
    });
    expect(
      controller.evaluateShellCommand('nl -ba apps/studio/src/app/page.tsx', 20, false),
    ).toMatchObject({
      warnings: [],
      abortMessage: expect.stringContaining('Stopping this trajectory'),
    });
  });

  it('does not count scoped replay seam inspection commands toward shell churn when enabled', () => {
    const controller = new ExecutorEfficiencyController({
      targetTurns: 12,
      explorationTurns: 4,
      shellWarnFloor: 5,
      shellAbortFloor: 7,
      allowScopedShellInspection: true,
    });

    const scopedInspectionCommands = [
      "rg -n 'customRoleId' apps/studio/src/__tests__/api-routes/api-project-members.test.ts",
      "rg -n 'findProjectMember' apps/studio/src/app/api/projects/[id]/members/route.ts apps/studio/src/repos/project-repo.ts",
      "nl -ba apps/studio/src/app/api/projects/[id]/members/[userId]/route.ts | sed -n '1,180p'",
      'find apps/studio/src/app/api/projects/[id]/members -maxdepth 2 -type f | sort',
    ];

    scopedInspectionCommands.forEach((command) => {
      expect(controller.evaluateShellCommand(command, 6, false)).toEqual({ warnings: [] });
    });

    expect(controller.evaluateShellCommand('pwd', 6, false)).toEqual({ warnings: [] });
    expect(controller.evaluateShellCommand('git status --short', 6, false)).toEqual({
      warnings: [],
    });
    expect(controller.evaluateShellCommand('fd member apps/studio/src', 6, false)).toEqual({
      warnings: [],
    });
    expect(controller.evaluateShellCommand('ls apps/studio/src/lib', 6, false)).toEqual({
      warnings: [expect.stringContaining('too many shell exploration commands')],
    });
  });

  it('starts counting scoped seam inspection once the allowance is exhausted', () => {
    const controller = new ExecutorEfficiencyController({
      targetTurns: 12,
      explorationTurns: 4,
      shellWarnFloor: 5,
      shellAbortFloor: 7,
      allowScopedShellInspection: true,
      scopedShellInspectionCountLimit: 2,
    });

    expect(
      controller.evaluateShellCommand(
        "rg -n 'customRoleId' apps/studio/src/__tests__/api-routes/api-project-members.test.ts",
        6,
        false,
      ),
    ).toEqual({ warnings: [] });
    expect(
      controller.evaluateShellCommand(
        "nl -ba apps/studio/src/app/api/projects/[id]/members/[userId]/route.ts | sed -n '1,180p'",
        6,
        false,
      ),
    ).toEqual({ warnings: [] });

    expect(
      controller.evaluateShellCommand(
        'find apps/studio/src/app/api/projects/[id]/members -maxdepth 2 -type f | sort',
        6,
        false,
      ),
    ).toEqual({ warnings: [] });
    expect(controller.evaluateShellCommand('pwd', 6, false)).toEqual({ warnings: [] });
    expect(controller.evaluateShellCommand('git status --short', 6, false)).toEqual({
      warnings: [],
    });
    expect(controller.evaluateShellCommand('fd member apps/studio/src', 6, false)).toEqual({
      warnings: [],
    });
    expect(controller.evaluateShellCommand('ls apps/studio/src/lib', 6, false)).toEqual({
      warnings: [expect.stringContaining('too many shell exploration commands')],
    });
  });

  it('aborts helper-level scoped inspection once a replay seam window is exhausted', () => {
    const controller = new ExecutorEfficiencyController({
      targetTurns: 21,
      explorationTurns: 8,
      allowScopedShellInspection: true,
      scopedShellInspectionCountLimit: 8,
      abortScopedShellInspectionAfterLimit: true,
    });

    const primarySeamCommands = [
      "sed -n '1,180p' apps/studio/src/app/api/projects/[id]/members/route.ts",
      "sed -n '1,180p' apps/studio/src/app/api/projects/[id]/members/[userId]/route.ts",
      "sed -n '1,220p' apps/studio/src/repos/project-repo.ts",
      "sed -n '1,220p' apps/studio/src/services/audit-service.ts",
      "sed -n '1,120p' packages/database/src/models/project-member.model.ts",
      "sed -n '1,120p' packages/database/src/models/role-definition.model.ts",
      "sed -n '1,220p' apps/studio/src/__tests__/api-routes/api-project-members.test.ts",
      "sed -n '1,120p' apps/studio/vitest.config.ts",
    ];

    primarySeamCommands.forEach((command) => {
      expect(controller.evaluateShellCommand(command, 8, false)).toEqual({ warnings: [] });
    });

    expect(
      controller.evaluateShellCommand(
        "sed -n '1,80p' apps/studio/src/lib/route-handler.ts",
        8,
        false,
      ),
    ).toMatchObject({
      warnings: [],
      abortMessage: expect.stringContaining('seam-inspection window'),
    });
  });

  it('normalizes repeated direct file reads with different sed ranges once the seam allowance is exhausted', () => {
    const controller = new ExecutorEfficiencyController({
      targetTurns: 12,
      explorationTurns: 4,
      shellWarnFloor: 8,
      shellAbortFloor: 12,
      allowScopedShellInspection: true,
      scopedShellInspectionCountLimit: 1,
    });

    expect(
      controller.evaluateShellCommand(
        "sed -n '1,180p' apps/studio/src/repos/project-repo.ts",
        6,
        false,
      ),
    ).toEqual({ warnings: [] });

    expect(
      controller.evaluateShellCommand(
        "sed -n '181,360p' apps/studio/src/repos/project-repo.ts",
        6,
        false,
      ),
    ).toEqual({
      warnings: [expect.stringContaining('repeated shell exploration command')],
    });
  });

  it('treats a line-number reread of the same seam file as repeated exploration after the first pass', () => {
    const controller = new ExecutorEfficiencyController({
      targetTurns: 12,
      explorationTurns: 4,
      shellWarnFloor: 8,
      shellAbortFloor: 12,
      allowScopedShellInspection: true,
      scopedShellInspectionCountLimit: 8,
    });

    expect(
      controller.evaluateShellCommand(
        "sed -n '1,180p' apps/studio/src/repos/project-repo.ts",
        6,
        false,
      ),
    ).toEqual({ warnings: [] });

    expect(
      controller.evaluateShellCommand(
        "nl -ba apps/studio/src/repos/project-repo.ts | sed -n '470,570p'",
        6,
        false,
      ),
    ).toEqual({
      warnings: [expect.stringContaining('repeated shell exploration command')],
    });
  });

  it('warns, then aborts, repeated broad build commands after the target budget is reached', () => {
    const controller = new ExecutorEfficiencyController({
      targetTurns: 20,
      explorationTurns: 6,
    });

    expect(controller.evaluateShellCommand('pnpm --dir apps/studio build', 6, true)).toEqual({
      warnings: [],
    });
    expect(controller.evaluateShellCommand('pnpm --dir apps/studio build', 6, true)).toEqual({
      warnings: [expect.stringContaining('repeated broad proof command')],
    });
    expect(controller.evaluateShellCommand('pnpm --dir apps/studio build', 20, true)).toEqual({
      warnings: [],
    });
    expect(controller.evaluateShellCommand('pnpm --dir apps/studio build', 20, true)).toMatchObject(
      {
        warnings: [],
        abortMessage: expect.stringContaining('Stop rerunning the same full build'),
      },
    );
  });
});
