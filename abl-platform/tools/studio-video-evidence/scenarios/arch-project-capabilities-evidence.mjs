import { REQUEST_TIMEOUT_MS } from '../lib/constants.mjs';
import { createStudioFixture, openStudioSurface } from '../lib/studio-harness.mjs';
import { waitForIdle } from '../lib/studio-chat.mjs';
import { numberFromInput } from '../lib/utils.mjs';

async function apiJson(baseUrl, accessToken, path, init = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `API ${init.method ?? 'GET'} ${path} failed with ${response.status}: ${JSON.stringify(body)}`,
    );
  }
  return body;
}

async function waitForVisibleText(page, text) {
  await page.getByText(text, { exact: false }).first().waitFor({
    state: 'visible',
    timeout: REQUEST_TIMEOUT_MS,
  });
}

export const scenario = {
  id: 'arch-project-capabilities-evidence',
  title: 'Arch Project Capabilities Evidence',
  description:
    'Seeds a disposable project with an auth-backed MCP server and MCP ProjectTool through existing Studio APIs, then records key project capability surfaces for Arch AI verification.',
  example:
    'pnpm studio:video:evidence -- --scenario arch-project-capabilities-evidence --final-pause-ms 1000',

  async run(context) {
    const { baseUrl, page, artifacts, log } = context;
    const finalPauseMs = numberFromInput(context.options.finalPauseMs, 1_500);
    const fixture = await createStudioFixture(context, {
      requireProject: true,
      requireAgent: true,
      projectNamePrefix: 'Arch Project Capabilities Evidence',
      agentNamePrefix: 'arch_capability_agent',
      assistantReply: 'Arch project capability evidence fixture is ready.',
    });

    const projectId = fixture.projectId;
    const mcpServerName = 'arch-evidence-mcp';
    const mcpToolName = 'arch_mcp_search';

    log('Creating auth-backed MCP server through existing Studio API...');
    const mcpServer = await apiJson(
      baseUrl,
      fixture.accessToken,
      `/api/projects/${encodeURIComponent(projectId)}/mcp-servers`,
      {
        method: 'POST',
        body: JSON.stringify({
          name: mcpServerName,
          description: 'Video evidence MCP server created through Studio project API',
          transport: 'http',
          url: 'https://example.com/mcp',
          authType: 'api_key',
          authConfig: {
            headerName: 'X-API-Key',
            value: 'video-evidence-placeholder-key',
          },
          tags: ['arch-ai', 'evidence'],
        }),
      },
    );

    log('Creating MCP ProjectTool bound to the MCP server through existing Studio API...');
    const projectTool = await apiJson(
      baseUrl,
      fixture.accessToken,
      `/api/projects/${encodeURIComponent(projectId)}/tools`,
      {
        method: 'POST',
        body: JSON.stringify({
          name: mcpToolName,
          description: 'Search via the Arch evidence MCP server',
          toolType: 'mcp',
          parameters: [
            {
              name: 'query',
              type: 'string',
              required: true,
              description: 'Search query',
            },
          ],
          returnType: 'object',
          server: mcpServerName,
          serverTool: 'search',
        }),
      },
    );

    const captures = [];

    async function captureSurface(surfaceId, screenshotName, waitText) {
      const navigation = await openStudioSurface(context, surfaceId, fixture);
      await waitForIdle(page, 1_000);
      if (waitText) {
        await waitForVisibleText(page, waitText);
      }
      await artifacts.captureScreenshot(screenshotName);
      await page.waitForTimeout(finalPauseMs);
      captures.push({ surfaceId, route: navigation.route, screenshotName });
    }

    const toolsNavigation = await openStudioSurface(context, 'tools', fixture);
    await waitForIdle(page, 1_000);
    const mcpTab = page
      .locator('button, [role="tab"]')
      .filter({ hasText: /MCP Servers/i })
      .first();
    if (await mcpTab.isVisible({ timeout: REQUEST_TIMEOUT_MS }).catch(() => false)) {
      await mcpTab.click();
      await waitForIdle(page, 1_000);
    }
    await waitForVisibleText(page, mcpServerName);
    await artifacts.captureScreenshot('arch-tools-with-mcp.png');
    await page.waitForTimeout(finalPauseMs);
    captures.push({
      surfaceId: 'tools',
      route: toolsNavigation.route,
      screenshotName: 'arch-tools-with-mcp.png',
    });

    const mcpServersRoute = `${baseUrl}/projects/${encodeURIComponent(projectId)}/mcp-servers`;
    await page.goto(mcpServersRoute, { waitUntil: 'domcontentloaded' });
    await waitForIdle(page, 1_000);
    await waitForVisibleText(page, 'MCP Servers');
    const routeMcpTab = page
      .locator('button, [role="tab"]')
      .filter({ hasText: /MCP Servers/i })
      .first();
    if (await routeMcpTab.isVisible({ timeout: REQUEST_TIMEOUT_MS }).catch(() => false)) {
      await routeMcpTab.click();
      await waitForIdle(page, 1_000);
    }
    await waitForVisibleText(page, mcpServerName);
    await artifacts.captureScreenshot('arch-mcp-servers.png');
    await page.waitForTimeout(finalPauseMs);
    captures.push({
      surfaceId: 'mcp-servers',
      route: mcpServersRoute,
      screenshotName: 'arch-mcp-servers.png',
    });

    await captureSurface('settings-auth-profiles', 'arch-auth-profiles.png', 'Auth');
    await captureSurface('connections', 'arch-connections.png', 'Connections');
    await captureSurface('search-ai', 'arch-knowledge-bases.png', 'Knowledge');

    return {
      summary:
        'Captured Arch project capability surfaces after seeding MCP server and MCP ProjectTool via existing Studio APIs.',
      metadata: {
        projectId,
        projectName: fixture.projectName,
        agentName: fixture.agentName,
        email: fixture.email,
        mcpServerName,
        mcpServerId: mcpServer.server?.id ?? null,
        mcpToolName,
        projectToolId: projectTool.tool?.id ?? null,
        captures,
      },
      assertions: [
        {
          name: 'mcp-server-created',
          passed: Boolean(mcpServer.server?.id),
          details: `Created MCP server ${mcpServerName}`,
        },
        {
          name: 'mcp-project-tool-created',
          passed: Boolean(projectTool.tool?.id),
          details: `Created MCP ProjectTool ${mcpToolName}`,
        },
        {
          name: 'capability-surfaces-captured',
          passed: captures.length === 5,
          details: `Captured ${captures.length} project capability surfaces`,
        },
      ],
    };
  },
};
