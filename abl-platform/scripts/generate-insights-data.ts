#!/usr/bin/env npx tsx
/**
 * Generate test conversations for insights/analytics data.
 *
 * Drives N LLM-generated persona conversations against a deployed agent,
 * ending each session to trigger insights pipelines (sentiment, quality,
 * intent, friction, hallucination, etc.).
 *
 * Usage (manual share token):
 *   ANTHROPIC_API_KEY=sk-ant-... SHARE_TOKEN=eyJ... tsx scripts/generate-insights-data.ts
 *
 * Usage (auto-login, dev only — requires ENABLE_DEV_LOGIN=true in Studio):
 *   ANTHROPIC_API_KEY=sk-ant-... STUDIO_EMAIL=you@example.com PROJECT_ID=proj-xxx \
 *     tsx scripts/generate-insights-data.ts
 *
 * Usage (all agents — discovers bot topology and generates per-agent scenarios):
 *   ANTHROPIC_API_KEY=sk-ant-... STUDIO_EMAIL=you@example.com PROJECT_ID=proj-xxx \
 *     tsx scripts/generate-insights-data.ts --all
 *
 * See scripts/conversation-testing/README.md for full env var reference.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createLogger } from '@agent-platform/shared-observability/logger';
import {
  generateScenarios,
  runConversation,
  pickLLMFromEnv,
  makeLimit,
  PRESET_NAMES,
  DEFAULT_PRESET,
  type AgentSummary,
  type PresetName,
  type Transcript,
} from './conversation-testing/src/index.js';

const log = createLogger('generate-insights-data');

// ── Config from env vars ───────────────────────────────────────────────

const ALL_AGENTS = process.argv.includes('--all') || process.env.ALL_AGENTS === '1';
const RUNS_PER_AGENT_DEFAULT = 3;
const ALL_MODE_CONCURRENCY = 5;
const ALL_MODE_MAX_TURNS = 10;

const SHARE_TOKEN = process.env.SHARE_TOKEN;
const STUDIO_EMAIL = process.env.STUDIO_EMAIL;
const PROJECT_ID = process.env.PROJECT_ID;
const STUDIO_URL = process.env.STUDIO_URL || 'http://localhost:5173';
const RUNTIME_WS_URL = process.env.RUNTIME_WS_URL || 'ws://localhost:3112/ws/sdk';
const RUNS_EXPLICIT = process.env.RUNS !== undefined && process.env.RUNS.trim() !== '';
const RUNS = parseInt(process.env.RUNS || '10', 10);
const RUNS_PER_AGENT = Math.max(
  1,
  parseInt(process.env.RUNS_PER_AGENT || String(RUNS_PER_AGENT_DEFAULT), 10),
);
const CONCURRENCY = ALL_AGENTS
  ? ALL_MODE_CONCURRENCY
  : Math.max(1, parseInt(process.env.CONCURRENCY || '5', 10));
const PRESET = (process.env.PRESET || DEFAULT_PRESET) as PresetName;
const INSTRUCTIONS = process.env.INSTRUCTIONS || '';
const DOMAIN_HINT = process.env.DOMAIN_HINT || '';
const MAX_TURNS = ALL_AGENTS ? ALL_MODE_MAX_TURNS : parseInt(process.env.MAX_TURNS || '15', 10);
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || '120000', 10);
const SAVE_TRANSCRIPTS = process.env.SAVE_TRANSCRIPTS === '1';
const DEBUG_PROMPTS = process.env.DEBUG_PROMPTS === '1';

// ── Preflight validation ───────────────────────────────────────────────

function preflight(): void {
  const hasShareToken = !!SHARE_TOKEN?.trim();
  const hasDevLogin = !!STUDIO_EMAIL?.trim() && !!PROJECT_ID?.trim();

  if (ALL_AGENTS && !hasDevLogin) {
    log.error(
      '--all mode requires STUDIO_EMAIL + PROJECT_ID (dev auto-login). ' +
        'The topology API is only reachable via authenticated requests, not share tokens.',
    );
    process.exit(1);
  }

  if (!hasShareToken && !hasDevLogin) {
    log.error(
      'Authentication required. Provide either:\n' +
        '  SHARE_TOKEN=eyJ...  (from Studio share dialog)\n' +
        '  STUDIO_EMAIL + PROJECT_ID  (dev auto-login, requires ENABLE_DEV_LOGIN=true in Studio)',
    );
    process.exit(1);
  }

  // pickLLMFromEnv() will validate provider credentials — we call it in main().

  if (!ALL_AGENTS && (RUNS < 1 || RUNS > 100)) {
    log.error('RUNS must be between 1 and 100', { runs: RUNS });
    process.exit(1);
  }

  if (ALL_AGENTS && RUNS_EXPLICIT && (RUNS < 1 || RUNS > 100)) {
    log.error('RUNS must be between 1 and 100', { runs: RUNS });
    process.exit(1);
  }

  if (ALL_AGENTS && (RUNS_PER_AGENT < 1 || RUNS_PER_AGENT > 10)) {
    log.error('RUNS_PER_AGENT must be between 1 and 10', { runsPerAgent: RUNS_PER_AGENT });
    process.exit(1);
  }

  if (!PRESET_NAMES.includes(PRESET)) {
    log.error('Invalid PRESET', { preset: PRESET, valid: PRESET_NAMES });
    process.exit(1);
  }
}

// ── Dev auto-login ─────────────────────────────────────────────────────

async function devLogin(email: string): Promise<string> {
  const res = await fetch(`${STUDIO_URL}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Dev login failed (${res.status}): ${text}\n` +
        'Ensure ENABLE_DEV_LOGIN=true is set in Studio env.',
    );
  }

  const data = (await res.json()) as { accessToken?: string };
  if (!data.accessToken) {
    throw new Error('Dev login response missing accessToken');
  }

  return data.accessToken;
}

async function fetchShareToken(projectId: string, accessToken: string): Promise<string> {
  const res = await fetch(`${STUDIO_URL}/api/sdk/share`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      Origin: STUDIO_URL,
    },
    body: JSON.stringify({ projectId }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Share token fetch failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as { token?: string };
  if (!data.token) {
    throw new Error('Share token response missing token');
  }

  return data.token;
}

async function fetchTopology(
  projectId: string,
  accessToken: string,
): Promise<{ agents: AgentSummary[] }> {
  const res = await fetch(`${STUDIO_URL}/api/projects/${encodeURIComponent(projectId)}/topology`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'X-Tenant-Id': 'tenant-dev-001',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Topology fetch failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    agentSummaries?: Record<string, { goal?: string; description?: string }>;
  };

  const summaries = data.agentSummaries || {};
  const agents: AgentSummary[] = Object.entries(summaries).map(([name, s]) => ({
    name,
    goal: s.goal || '',
    description: s.description || '',
  }));

  if (agents.length === 0) {
    throw new Error('Topology returned zero agents');
  }

  return { agents };
}

let cachedAccessToken: string | undefined;

async function getAccessToken(): Promise<string> {
  if (cachedAccessToken) return cachedAccessToken;
  cachedAccessToken = await devLogin(STUDIO_EMAIL!);
  return cachedAccessToken;
}

async function resolveShareToken(): Promise<string> {
  if (SHARE_TOKEN?.trim()) {
    return SHARE_TOKEN.trim();
  }

  log.info('Auto-login: fetching share token via dev-login', {
    email: STUDIO_EMAIL,
    projectId: PROJECT_ID,
  });
  const accessToken = await getAccessToken();
  const shareToken = await fetchShareToken(PROJECT_ID!, accessToken);
  log.info('Share token obtained via dev-login');
  return shareToken;
}

// ── Share-token exchange ───────────────────────────────────────────────

interface ExchangeResult {
  sdkToken: string;
  projectName: string;
  welcomeMessage: string;
}

async function exchangeShareToken(shareToken: string): Promise<ExchangeResult> {
  const res = await fetch(`${STUDIO_URL}/api/sdk/share/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: STUDIO_URL },
    body: JSON.stringify({ token: shareToken }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    valid?: boolean;
    sdkToken?: string;
    projectName?: string;
    welcomeMessage?: string;
  };

  if (!data.valid || !data.sdkToken) {
    throw new Error('Invalid token exchange response');
  }

  return {
    sdkToken: data.sdkToken,
    projectName: data.projectName || 'Unknown Bot',
    welcomeMessage: data.welcomeMessage || '',
  };
}

// ── Transcript saving ──────────────────────────────────────────────────

async function saveTranscripts(transcripts: Transcript[], scenarios: unknown[]): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    'conversation-testing',
    'outputs',
    timestamp,
  );

  await fs.mkdir(path.join(outputDir, 'transcripts'), { recursive: true });

  // Save redacted run config
  await fs.writeFile(
    path.join(outputDir, 'run-config.json'),
    JSON.stringify(
      {
        mode: ALL_AGENTS ? 'all-agents' : 'default',
        runs: ALL_AGENTS ? transcripts.length : RUNS,
        runsPerAgent: ALL_AGENTS ? RUNS_PER_AGENT : null,
        concurrency: CONCURRENCY,
        preset: PRESET,
        instructions: INSTRUCTIONS || null,
        domainHint: DOMAIN_HINT || null,
        provider: process.env.PROVIDER || 'anthropic',
        model: process.env.MODEL || null,
        studioUrl: STUDIO_URL,
        runtimeWsUrl: RUNTIME_WS_URL,
        maxTurns: MAX_TURNS,
        timeoutMs: TIMEOUT_MS,
        shareToken: '[REDACTED]',
        apiKey: '[REDACTED]',
      },
      null,
      2,
    ),
    'utf-8',
  );

  // Save scenarios
  await fs.writeFile(
    path.join(outputDir, 'scenarios.json'),
    JSON.stringify(scenarios, null, 2),
    'utf-8',
  );

  // Save individual transcripts
  for (const t of transcripts) {
    const filename = `s${String(t.scenarioIndex + 1).padStart(2, '0')}.json`;
    await fs.writeFile(
      path.join(outputDir, 'transcripts', filename),
      JSON.stringify(t, null, 2),
      'utf-8',
    );
  }

  log.info('Transcripts saved', { outputDir });
}

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  preflight();

  const llm = pickLLMFromEnv();

  const shareToken = await resolveShareToken();

  let agents: AgentSummary[] | undefined;
  let totalRuns = RUNS;
  if (ALL_AGENTS) {
    log.info('All-agents mode: fetching bot topology', { projectId: PROJECT_ID });
    const accessToken = await getAccessToken();
    const topology = await fetchTopology(PROJECT_ID!, accessToken);
    agents = topology.agents;
    // If RUNS was explicitly set, it caps the total (distributed round-robin across agents).
    // Otherwise total = RUNS_PER_AGENT × agents.
    totalRuns = RUNS_EXPLICIT ? Math.max(1, RUNS) : agents.length * RUNS_PER_AGENT;
    log.info('Agents discovered', {
      count: agents.length,
      totalSessions: totalRuns,
      runsSource: RUNS_EXPLICIT
        ? 'RUNS (explicit)'
        : `RUNS_PER_AGENT × agents = ${RUNS_PER_AGENT} × ${agents.length}`,
      names: agents.map((a) => a.name),
    });
  }

  log.info('Exchanging share token for domain discovery');
  const { projectName, welcomeMessage } = await exchangeShareToken(shareToken);
  log.info('Domain discovered', { projectName, welcomePreview: welcomeMessage.slice(0, 80) });

  const scenarios = await generateScenarios(llm, {
    runs: totalRuns,
    preset: PRESET,
    instructions: INSTRUCTIONS || undefined,
    domain: {
      projectName,
      welcomeMessage,
      hint: DOMAIN_HINT || undefined,
    },
    agents,
    runsPerAgent: agents ? RUNS_PER_AGENT : undefined,
  });

  log.info('Running conversations', {
    count: scenarios.length,
    concurrency: CONCURRENCY,
    maxTurns: MAX_TURNS,
    preset: PRESET,
    mode: ALL_AGENTS ? 'all-agents' : 'default',
  });

  const limit = makeLimit(CONCURRENCY);
  const results = await Promise.all(
    scenarios.map((scenario, i) =>
      limit(async () => {
        try {
          const fresh = await exchangeShareToken(shareToken);
          return await runConversation(fresh.sdkToken, scenario, llm, {
            scenarioIndex: i,
            runtimeWsUrl: RUNTIME_WS_URL,
            maxTurns: MAX_TURNS,
            timeoutMs: TIMEOUT_MS,
            debugPrompts: DEBUG_PROMPTS,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(`Conversation s${String(i + 1).padStart(2, '0')} failed`, { error: msg });
          return {
            scenarioIndex: i,
            scenario,
            messages: [],
            startedAt: new Date().toISOString(),
            endedAt: new Date().toISOString(),
            outcome: 'failed' as const,
            error: msg,
          };
        }
      }),
    ),
  );

  if (SAVE_TRANSCRIPTS) {
    await saveTranscripts(results, scenarios);
  }

  const succeeded = results.filter((r) => r.outcome === 'success').length;
  const failed = results.length - succeeded;

  log.info(`Done. Success: ${succeeded}/${results.length}, Failed: ${failed}`);

  if (succeeded === 0) {
    log.error('All conversations failed');
    process.exit(1);
  }
}

main().catch((err) => {
  log.error('Fatal error', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
