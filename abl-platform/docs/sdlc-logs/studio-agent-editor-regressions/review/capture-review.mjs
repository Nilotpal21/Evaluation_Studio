import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { pathToFileURL } from 'url';

const repoRoot = process.cwd();
const outputDir = path.join(
  repoRoot,
  'docs',
  'sdlc-logs',
  'studio-agent-editor-regressions',
  'review',
  'artifacts',
);
const videoDir = path.join(outputDir, 'video');
const htmlPath = path.join(outputDir, 'implementation-review.html');
const playwrightEntry = path.join(
  repoRoot,
  'apps',
  'studio',
  'node_modules',
  '@playwright',
  'test',
  'index.mjs',
);

fs.mkdirSync(outputDir, { recursive: true });
fs.mkdirSync(videoDir, { recursive: true });

const { chromium } = await import(pathToFileURL(playwrightEntry).href);

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function readSnippet(relativePath, start, end) {
  const absolutePath = path.join(repoRoot, relativePath);
  const lines = fs.readFileSync(absolutePath, 'utf8').split('\n');
  const snippet = lines
    .slice(start - 1, end)
    .map((line, index) => {
      const lineNumber = String(start + index).padStart(4, ' ');
      return `${lineNumber} ${line}`;
    })
    .join('\n');

  return {
    relativePath,
    snippet,
  };
}

const sections = [
  {
    id: 'import',
    title: '.abl Import Normalization',
    summary:
      'Loose top-level agent, tool, and behavior profile files now normalize into canonical import paths, and project manifests are rewritten to match the normalized paths.',
    snippets: [
      readSnippet('packages/project-io/src/import/path-normalizer.ts', 27, 129),
      readSnippet('packages/project-io/src/__tests__/project-importer.test.ts', 80, 137),
    ],
  },
  {
    id: 'runtime-save',
    title: 'Runtime Model Save Semantics',
    summary:
      'Agent model config updates now preserve omitted fields instead of nulling them out, which fixes the model selection reverting during partial saves.',
    snippets: [
      readSnippet('apps/runtime/src/routes/agent-model-config.ts', 205, 267),
      readSnippet('apps/runtime/src/repos/project-repo.ts', 471, 526),
      readSnippet('apps/runtime/src/__tests__/sessions/repos-project.test.ts', 705, 729),
    ],
  },
  {
    id: 'execution-ux',
    title: 'Execution Config UX',
    summary:
      'The DSL primary model stays in the main execution section, while runtime-only model overrides live in a collapsed advanced panel with separate save semantics and explicit copy.',
    snippets: [
      readSnippet('apps/studio/src/components/agent-editor/sections/ExecutionEditor.tsx', 39, 159),
      readSnippet('apps/studio/src/components/agents/AgentModelTab.tsx', 44, 51),
      readSnippet('apps/studio/src/components/agents/AgentModelTab.tsx', 360, 381),
      readSnippet('apps/studio/src/__tests__/components/execution-editor.test.tsx', 417, 461),
    ],
  },
  {
    id: 'studio-nav-delete',
    title: 'Studio Editor Navigation And Delete',
    summary:
      'The unified agent editor now exposes delete with dependency warnings, and Studio Chat now has a direct Back to Agent action for a tighter build-test loop.',
    snippets: [
      readSnippet('apps/studio/src/components/agent-editor/AgentEditor.tsx', 262, 330),
      readSnippet('apps/studio/src/components/agent-editor/AgentEditor.tsx', 577, 633),
      readSnippet('apps/studio/src/components/chat/StudioChatHeader.tsx', 33, 102),
      readSnippet('apps/studio/src/components/chat/StudioChatPanel.tsx', 194, 366),
    ],
  },
  {
    id: 'sdk-traces',
    title: 'SDK Activity And Trace Readability',
    summary:
      'Channel-level activity suppression is now honored in the React widget, handoff cards are compact and customizable, and trace details collapse behind a summary-first footer.',
    snippets: [
      readSnippet('packages/web-sdk/src/react/components/ChatWidget.tsx', 44, 79),
      readSnippet('packages/web-sdk/src/react/components/MessageList.tsx', 26, 113),
      readSnippet('packages/web-sdk/src/react/components/HandoffMessage.tsx', 19, 55),
      readSnippet('packages/web-sdk/src/react/strings/types.ts', 19, 31),
      readSnippet('apps/studio/src/components/analytics/TracesExplorerTab.tsx', 978, 1032),
    ],
  },
  {
    id: 'verification',
    title: 'Verification And Test Locks',
    summary:
      'The fixes are locked with focused regression coverage across runtime, project import, SDK rendering, and Studio component behavior, plus a shared observer-mock hardening for future Radix tests.',
    bullets: [
      'Scoped build: @agent-platform/project-io, @agent-platform/web-sdk, @agent-platform/runtime, @agent-platform/studio',
      'Runtime regression: 59 tests passed',
      'Project import regressions: 29 tests passed',
      'Web SDK regressions: 35 tests passed',
      'Studio component bundle: 557 tests passed / 106 todo / 1 skipped',
    ],
    snippets: [
      readSnippet('apps/studio/src/__tests__/setup.tsx', 276, 297),
      readSnippet('apps/studio/src/__tests__/components/model-management.test.tsx', 871, 955),
      readSnippet('packages/web-sdk/src/__tests__/react-components.test.tsx', 471, 505),
    ],
  },
];

const sectionHtml = sections
  .map((section) => {
    const bullets = section.bullets
      ? `<ul>${section.bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join('')}</ul>`
      : '';
    const snippets = section.snippets
      .map(
        ({ relativePath, snippet }) => `
          <div class="snippet">
            <div class="path">${escapeHtml(relativePath)}</div>
            <pre>${escapeHtml(snippet)}</pre>
          </div>
        `,
      )
      .join('');

    return `
      <section id="${section.id}" class="card" data-shot="${section.id}">
        <div class="eyebrow">Implementation Slice</div>
        <h2>${escapeHtml(section.title)}</h2>
        <p>${escapeHtml(section.summary)}</p>
        ${bullets}
        ${snippets}
      </section>
    `;
  })
  .join('');

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Studio Agent Editor Regression Review</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f3efe7;
        --paper: #fffdf9;
        --ink: #1d1d1b;
        --muted: #5b5a57;
        --line: #d9d2c4;
        --accent: #0d6b57;
        --accent-soft: rgba(13, 107, 87, 0.08);
        --mono-bg: #f5f1e9;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: Georgia, "Iowan Old Style", "Palatino Linotype", serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(13, 107, 87, 0.08), transparent 30%),
          linear-gradient(180deg, #f7f3eb 0%, var(--bg) 100%);
      }
      .page {
        width: 1440px;
        margin: 0 auto;
        padding: 48px 48px 80px;
      }
      .hero {
        padding: 36px 40px;
        border: 1px solid var(--line);
        border-radius: 28px;
        background: linear-gradient(135deg, rgba(255,255,255,0.96), rgba(255,250,241,0.92));
        box-shadow: 0 18px 60px rgba(55, 42, 23, 0.08);
      }
      .eyebrow {
        display: inline-block;
        padding: 6px 10px;
        border-radius: 999px;
        background: var(--accent-soft);
        color: var(--accent);
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      h1 {
        margin: 18px 0 10px;
        font-size: 52px;
        line-height: 1.05;
      }
      .hero p {
        margin: 0;
        max-width: 980px;
        font-size: 20px;
        line-height: 1.6;
        color: var(--muted);
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 24px;
        margin-top: 28px;
      }
      .card {
        margin-top: 28px;
        padding: 28px;
        border-radius: 24px;
        border: 1px solid var(--line);
        background: rgba(255, 253, 249, 0.94);
        box-shadow: 0 14px 42px rgba(50, 38, 23, 0.08);
      }
      h2 {
        margin: 14px 0 12px;
        font-size: 30px;
        line-height: 1.15;
      }
      p, li {
        font-size: 18px;
        line-height: 1.6;
        color: var(--muted);
      }
      ul {
        margin: 12px 0 0 20px;
        padding: 0;
      }
      .snippet {
        margin-top: 18px;
        border-radius: 18px;
        overflow: hidden;
        border: 1px solid var(--line);
        background: var(--mono-bg);
      }
      .path {
        padding: 10px 14px;
        background: rgba(13, 107, 87, 0.09);
        color: var(--accent);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 13px;
        font-weight: 700;
      }
      pre {
        margin: 0;
        padding: 16px 18px 18px;
        overflow: hidden;
        white-space: pre-wrap;
        word-break: break-word;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 13px;
        line-height: 1.45;
        color: #233036;
      }
    </style>
  </head>
  <body>
    <div class="page">
      <section class="hero" data-shot="hero">
        <div class="eyebrow">Review Walkthrough</div>
        <h1>Studio Agent Editor Fixes</h1>
        <p>
          This review page was generated from the actual changed source so you can inspect the
          implementation end to end: import normalization, model-save semantics, Studio UX cleanup,
          delete/navigation flows, trace readability, SDK handoff behavior, and the regression locks
          that keep the fixes from drifting.
        </p>
      </section>
      ${sectionHtml}
    </div>
  </body>
</html>`;

fs.writeFileSync(htmlPath, html);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: {
    dir: videoDir,
    size: { width: 1440, height: 900 },
  },
});
const page = await context.newPage();
await page.goto(`file://${htmlPath}`, { waitUntil: 'load' });
await page.screenshot({ path: path.join(outputDir, '00-full-page.png'), fullPage: true });

for (const section of ['hero', ...sections.map((entry) => entry.id)]) {
  const locator = page.locator(`[data-shot="${section}"]`);
  await locator.scrollIntoViewIfNeeded();
  await page.waitForTimeout(350);
  await locator.screenshot({
    path: path.join(outputDir, `${section}.png`),
  });
}

for (const section of ['hero', ...sections.map((entry) => entry.id)]) {
  const locator = page.locator(`[data-shot="${section}"]`);
  await locator.scrollIntoViewIfNeeded();
  await page.waitForTimeout(900);
}

await page.waitForTimeout(1200);
await page.close();
await context.close();
await browser.close();

const recordedVideo = fs
  .readdirSync(videoDir)
  .filter((entry) => entry.endsWith('.webm'))
  .map((entry) => path.join(videoDir, entry))
  .sort()
  .at(-1);

const mp4Path = path.join(outputDir, 'implementation-review.mp4');
if (recordedVideo) {
  try {
    execFileSync(
      'ffmpeg',
      ['-y', '-i', recordedVideo, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mp4Path],
      {
        stdio: 'ignore',
      },
    );
  } catch {
    // Keep the .webm if ffmpeg conversion is unavailable.
  }
}

const summary = {
  html: htmlPath,
  screenshots: fs
    .readdirSync(outputDir)
    .filter((entry) => entry.endsWith('.png'))
    .sort()
    .map((entry) => path.join(outputDir, entry)),
  video: fs.existsSync(mp4Path) ? mp4Path : recordedVideo,
};

console.log(JSON.stringify(summary, null, 2));
