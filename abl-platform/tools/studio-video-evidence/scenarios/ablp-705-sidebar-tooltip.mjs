import { REQUEST_TIMEOUT_MS } from '../lib/constants.mjs';
import { createStudioFixture, openStudioSurface } from '../lib/studio-harness.mjs';
import { numberFromInput } from '../lib/utils.mjs';

export const scenario = {
  id: 'ablp-705-sidebar-tooltip',
  title: 'ABLP-705 Sidebar Tooltip',
  description:
    'Opens the Agent Editor sidebar, proves the Behavior Profiles label is visually truncated, then hovers it and captures the accessible full-label tooltip.',
  example: 'pnpm studio:video:evidence -- --scenario ablp-705-sidebar-tooltip',
  async run(context) {
    const { options, artifacts, page } = context;
    const fixture = await createStudioFixture(context, {
      requireProject: true,
      requireAgent: true,
      assistantReply: String(
        options.assistantReply ??
          'Acknowledged. Scaffolded Studio evidence scenario reply completed successfully.',
      ).trim(),
    });

    const navigation = await openStudioSurface(context, 'agent-editor', fixture);
    const behaviorProfilesItem = page.getByTestId('sidebar-nav-behavior');
    await behaviorProfilesItem.waitFor({ state: 'visible', timeout: REQUEST_TIMEOUT_MS });
    const behaviorProfilesLabel = behaviorProfilesItem.getByText('Behavior Profiles', {
      exact: true,
    });
    await behaviorProfilesLabel.waitFor({ state: 'visible', timeout: REQUEST_TIMEOUT_MS });

    const labelOverflow = await behaviorProfilesLabel.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    );
    if (!labelOverflow) {
      throw new Error(
        'ABLP-705 evidence requires the Behavior Profiles sidebar label to be visually truncated, but it fit in the current Agent Editor sidebar.',
      );
    }

    await artifacts.captureScreenshot('ablp-705-behavior-profiles-truncated.png');
    await behaviorProfilesItem.hover({ timeout: REQUEST_TIMEOUT_MS });
    const tooltip = page.getByRole('tooltip', { name: 'Behavior Profiles' });
    await tooltip.waitFor({ state: 'visible', timeout: REQUEST_TIMEOUT_MS });
    await artifacts.captureScreenshot('ablp-705-behavior-profiles-tooltip.png');

    const finalPauseMs = numberFromInput(options.finalPauseMs, 2_000);
    await page.waitForTimeout(finalPauseMs);

    return {
      summary:
        'ABLP-705: the truncated Agent Editor sidebar label exposes its full text through an accessible hover tooltip.',
      metadata: {
        issue: 'ABLP-705',
        surfaceId: navigation.surface.id,
        route: navigation.route,
        projectId: fixture.projectId ?? null,
        projectName: fixture.projectName ?? null,
        agentName: fixture.agentName ?? null,
        email: fixture.email,
        sidebarItemTestId: 'sidebar-nav-behavior',
        hoveredLabel: 'Behavior Profiles',
      },
      assertions: [
        {
          name: 'surface-ready',
          passed: true,
          details: `Loaded ${navigation.surface.title} at ${navigation.route}`,
        },
        {
          name: 'behavior-profiles-label-truncated',
          passed: labelOverflow,
          details: 'Behavior Profiles had scrollWidth greater than clientWidth before hover.',
        },
        {
          name: 'full-label-tooltip-visible',
          passed: true,
          details: 'Hovering the truncated Behavior Profiles item rendered role="tooltip".',
        },
      ],
    };
  },
};
