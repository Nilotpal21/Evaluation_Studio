import { test, expect } from '@playwright/test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SHOWCASE_ROUTE = '/packages/web-sdk/examples/vanilla-html/rich-content-showcase.html';
const SCREENSHOT_DIR = path.resolve(REPO_ROOT, 'apps/studio/.codex-artifacts/sdk-rich-content');
const MIME_TYPES = new Map<string, string>([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);

declare global {
  interface Window {
    __showcaseIds?: string[];
    __showcaseReady?: boolean;
  }
}

let staticServer: Server | null = null;
let staticBaseUrl = '';

function toRepoFilePath(requestPath: string): string {
  return path.resolve(REPO_ROOT, `.${requestPath}`);
}

function isInsideRepo(candidatePath: string): boolean {
  return candidatePath.startsWith(REPO_ROOT);
}

function contentTypeFor(filePath: string): string {
  return MIME_TYPES.get(path.extname(filePath)) ?? 'application/octet-stream';
}

async function resolveRequestedPath(requestPath: string): Promise<string | null> {
  const normalizedPath = requestPath === '/' ? SHOWCASE_ROUTE : requestPath;
  const candidatePath = toRepoFilePath(normalizedPath);
  if (!isInsideRepo(candidatePath)) {
    return null;
  }

  if (existsSync(candidatePath)) {
    const candidateStats = await stat(candidatePath);
    if (candidateStats.isDirectory()) {
      const indexPath = path.join(candidatePath, 'index.html');
      return existsSync(indexPath) ? indexPath : null;
    }
    return candidatePath;
  }

  return null;
}

async function serveRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const resolvedPath = await resolveRequestedPath(url.pathname);

  if (!resolvedPath) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  try {
    const body = await readFile(resolvedPath);
    res.writeHead(200, { 'Content-Type': contentTypeFor(resolvedPath) });
    res.end(body);
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(error instanceof Error ? error.message : String(error));
  }
}

async function startStaticServer(): Promise<{ baseUrl: string; server: Server }> {
  return await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      void serveRequest(req, res).catch((error) => {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(error instanceof Error ? error.message : String(error));
      });
    });

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to bind static showcase server.'));
        return;
      }

      resolve({
        baseUrl: `http://127.0.0.1:${String(address.port)}`,
        server,
      });
    });
  });
}

test.beforeAll(async () => {
  await rm(SCREENSHOT_DIR, { recursive: true, force: true });
  await mkdir(SCREENSHOT_DIR, { recursive: true });

  const started = await startStaticServer();
  staticBaseUrl = started.baseUrl;
  staticServer = started.server;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    if (!staticServer) {
      resolve();
      return;
    }

    staticServer.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
});

test('captures every SDK rich-content template with complex data', async ({ page }) => {
  await page.goto(`${staticBaseUrl}${SHOWCASE_ROUTE}`);

  await expect(page.locator('#status')).toContainText('Showcase ready', { timeout: 30_000 });
  await expect
    .poll(
      async () =>
        await page.evaluate(() => {
          return window.__showcaseReady === true ? (window.__showcaseIds?.length ?? 0) : 0;
        }),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);

  await page.waitForTimeout(1_000);

  const showcaseIds =
    (await page.evaluate(() => {
      return Array.isArray(window.__showcaseIds) ? window.__showcaseIds : [];
    })) ?? [];

  expect(showcaseIds.length).toBeGreaterThan(0);

  const manifest: Array<{ id: string; title: string; path: string; assertSelector: string }> = [];

  for (const showcaseId of showcaseIds) {
    const section = page.locator(`[data-screenshot-id="${showcaseId}"]`);
    await expect(section).toBeVisible();

    const assertSelector = await section.getAttribute('data-assert-selector');
    expect(assertSelector).toBeTruthy();

    const assertionTarget = section.locator(assertSelector ?? '');
    await expect(assertionTarget.first()).toBeVisible();

    const title =
      (await section.locator('.template-title-row h2').textContent())?.trim() ?? showcaseId;
    const screenshotPath = path.join(SCREENSHOT_DIR, `${showcaseId}.png`);

    await section.scrollIntoViewIfNeeded();
    await section.screenshot({
      path: screenshotPath,
      animations: 'disabled',
    });

    manifest.push({
      id: showcaseId,
      title,
      path: screenshotPath,
      assertSelector: assertSelector ?? '',
    });
  }

  const fullPagePath = path.join(SCREENSHOT_DIR, 'full-page.png');
  await page.screenshot({
    path: fullPagePath,
    fullPage: true,
    animations: 'disabled',
  });

  await writeFile(
    path.join(SCREENSHOT_DIR, 'manifest.json'),
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        showcaseRoute: `${staticBaseUrl}${SHOWCASE_ROUTE}`,
        fullPage: fullPagePath,
        screenshots: manifest,
      },
      null,
      2,
    ),
    'utf8',
  );
});
