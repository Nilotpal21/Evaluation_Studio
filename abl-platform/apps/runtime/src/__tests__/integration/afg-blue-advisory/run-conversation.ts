#!/usr/bin/env npx tsx
/**
 * AFG Blue Advisory — Live Conversation Runner
 *
 * Streams tokens to stdout in real-time so you can see the chat experience
 * exactly as a user would. Measures perceived latency at every stage.
 *
 * Usage:
 *   AFG_API_KEY=kg-... npx tsx src/__tests__/e2e/afg-blue-advisory/run-conversation.ts
 *   AFG_API_KEY=kg-... npx tsx src/__tests__/e2e/afg-blue-advisory/run-conversation.ts --scenario 2
 */

// =============================================================================
// CONFIG
// =============================================================================

const AFG_API_KEY = process.env.AFG_API_KEY ?? '';
const AFG_APP_ID = process.env.AFG_APP_ID ?? 'aa-9b7008f2-e862-4800-bdfa-aed70b2e82c1';
const AFG_BASE_URL = process.env.AFG_BASE_URL ?? 'https://agent-platform.kore.ai';
const EXECUTE_URL = `${AFG_BASE_URL}/api/v2/apps/${AFG_APP_ID}/environments/dev/runs/execute`;

if (!AFG_API_KEY) {
  console.error('❌ AFG_API_KEY not set');
  process.exit(1);
}

// =============================================================================
// ANSI HELPERS
// =============================================================================

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
  white: '\x1b[37m',
  bgBlue: '\x1b[44m',
  bgGreen: '\x1b[42m',
  bgMagenta: '\x1b[45m',
};

function line(ch = '━', len = 90): string {
  return ch.repeat(len);
}

function fmt(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function timestamp(startMs: number): string {
  return `${C.dim}T+${fmt(Date.now() - startMs)}${C.reset}`;
}

// =============================================================================
// SSE JSON EXTRACTOR
// =============================================================================

function extractJSONObjects(line: string): string[] {
  const stripped = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
  if (!stripped) return [];
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < stripped.length; i++) {
    if (stripped[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (stripped[i] === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        objects.push(stripped.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return objects;
}

// =============================================================================
// STREAMING API CLIENT
// =============================================================================

interface SessionIdentity {
  userReference: string;
  sessionReference: string;
}

interface TurnStats {
  ttfb: number;
  ttft: number;
  total: number;
  tokenCount: number;
  charCount: number;
  eventCount: number;
  sessionId: string | null;
  agentName: string | null;
}

async function streamTurn(
  text: string,
  identity: SessionIdentity,
  metadata: Record<string, string> = {},
): Promise<TurnStats> {
  const startMs = Date.now();

  const body = {
    sessionIdentity: [
      { type: 'userReference', value: identity.userReference },
      { type: 'sessionReference', value: identity.sessionReference },
    ],
    input: [{ type: 'text', content: text }],
    metadata: {
      user: metadata.user ?? 'e2e_test_user',
      gender: metadata.gender ?? 'male',
      location: metadata.location ?? 'Dubai',
      previousUnhandledRequest: metadata.previousUnhandledRequest ?? '',
      conversationSummary: metadata.conversationSummary ?? '',
    },
    stream: { enable: true, streamMode: 'tokens' },
    debug: { enable: false },
  };

  const response = await fetch(EXECUTE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': AFG_API_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`API error: ${response.status} ${response.statusText}\n${errText}`);
  }

  if (!response.body) {
    throw new Error('No response body');
  }

  const stats: TurnStats = {
    ttfb: 0,
    ttft: 0,
    total: 0,
    tokenCount: 0,
    charCount: 0,
    eventCount: 0,
    sessionId: null,
    agentName: null,
  };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let isFirstChunk = true;
  let isFirstToken = true;

  // Print the "agent typing" header
  process.stdout.write(`\n  ${C.green}${C.bold}🤖 Agent${C.reset} ${C.dim}│${C.reset} `);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const now = Date.now();

    if (isFirstChunk) {
      stats.ttfb = now - startMs;
      isFirstChunk = false;
      process.stdout.write(`${C.dim}[TTFB ${fmt(stats.ttfb)}]${C.reset} `);
    }

    const chunk = decoder.decode(value, { stream: true });
    buffer += chunk;

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (
        !trimmed ||
        trimmed.startsWith('event:') ||
        trimmed.startsWith('id:') ||
        trimmed.startsWith('retry:')
      )
        continue;

      const jsonStrings = extractJSONObjects(trimmed);
      for (const jsonStr of jsonStrings) {
        let data: any;
        try {
          data = JSON.parse(jsonStr);
        } catch {
          continue;
        }

        stats.eventCount++;

        // Session info
        if (data.sessionInfo?.sessionId) {
          stats.sessionId = data.sessionInfo.sessionId;
        }

        // Agent identity
        if (data.agent?.displayName) {
          stats.agentName = data.agent.displayName;
        }

        // Text tokens — stream to stdout in real-time
        let tokenText = '';
        if (data.output) {
          for (const item of data.output) {
            if (item.type === 'text' && item.content) {
              tokenText += item.content;
            }
          }
        }
        if (data.token) {
          tokenText += data.token;
        }

        if (tokenText) {
          if (isFirstToken) {
            stats.ttft = Date.now() - startMs;
            isFirstToken = false;
            process.stdout.write(
              `${C.dim}[TTFT ${fmt(stats.ttft)}]${C.reset}\n         ${C.dim}│${C.reset} `,
            );
          }

          // Print the token — this is the live streaming experience
          // Replace literal \n with actual newlines (indented to align)
          const display = tokenText.replace(/\\n/g, `\n         ${C.dim}│${C.reset} `);
          process.stdout.write(`${C.white}${display}${C.reset}`);
          stats.tokenCount++;
          stats.charCount += tokenText.length;
        }
      }
    }
  }

  // Process remaining buffer
  if (buffer.trim()) {
    const jsonStrings = extractJSONObjects(buffer);
    for (const jsonStr of jsonStrings) {
      try {
        const data = JSON.parse(jsonStr);
        stats.eventCount++;
        let tokenText = '';
        if (data.output) {
          for (const item of data.output) {
            if (item.type === 'text' && item.content) tokenText += item.content;
          }
        }
        if (data.token) tokenText += data.token;
        if (tokenText) {
          process.stdout.write(`${C.white}${tokenText}${C.reset}`);
          stats.tokenCount++;
          stats.charCount += tokenText.length;
        }
      } catch {
        // ignore
      }
    }
  }

  stats.total = Date.now() - startMs;
  process.stdout.write('\n');

  return stats;
}

function printStats(stats: TurnStats): void {
  const tokensPerSec = stats.total > 0 ? ((stats.tokenCount / stats.total) * 1000).toFixed(1) : '0';
  const charsPerSec = stats.total > 0 ? ((stats.charCount / stats.total) * 1000).toFixed(0) : '0';

  console.log(`         ${C.dim}│${C.reset}`);
  console.log(
    `         ${C.dim}├─ TTFB: ${C.cyan}${fmt(stats.ttfb)}${C.dim}  │  TTFT: ${C.yellow}${fmt(stats.ttft)}${C.dim}  │  Total: ${C.magenta}${fmt(stats.total)}${C.reset}`,
  );
  console.log(
    `         ${C.dim}├─ Tokens: ${stats.tokenCount}  │  Chars: ${stats.charCount}  │  Events: ${stats.eventCount}${C.reset}`,
  );
  console.log(
    `         ${C.dim}├─ Throughput: ${tokensPerSec} tok/s  │  ${charsPerSec} char/s${C.reset}`,
  );
  if (stats.sessionId) {
    console.log(`         ${C.dim}├─ Session: ${stats.sessionId}${C.reset}`);
  }
  if (stats.agentName) {
    console.log(`         ${C.dim}└─ Agent: ${stats.agentName}${C.reset}`);
  } else {
    console.log(`         ${C.dim}└─${C.reset}`);
  }
}

function printUserMessage(text: string): void {
  console.log(
    `\n  ${C.blue}${C.bold}👤 User${C.reset}  ${C.dim}│${C.reset} ${C.bold}${text}${C.reset}`,
  );
}

// =============================================================================
// CONVERSATION SCENARIOS
// =============================================================================

interface Turn {
  user: string;
  metadata?: Record<string, string>;
}

interface Scenario {
  name: string;
  description: string;
  turns: Turn[];
  /** true = fresh session per scenario (default), false = shares with previous */
  freshSession?: boolean;
}

const SCENARIOS: Scenario[] = [
  {
    name: 'Product Search Multi-Turn',
    description: 'Greeting → product search → follow-up refinement',
    turns: [
      { user: 'Hi' },
      { user: 'Show me red sneakers under 500 AED for men' },
      { user: 'What about Nike ones? Show me Nike options' },
    ],
  },
  {
    name: 'Cross-Agent Delegation',
    description: 'Product + policy query triggers AdvisorAgent → StorePolicyAgent delegation',
    turns: [
      {
        user: 'I want to buy red sneakers and what is the return policy for clothing?',
      },
    ],
  },
  {
    name: 'Guard Rail — Out of Scope',
    description: 'Flight booking request is declined with alternatives',
    turns: [{ user: 'Book me a flight from Dubai to London for next week' }],
  },
  {
    name: 'Conversation Summary Continuity',
    description: 'Greeting with prior conversation summary injected via metadata',
    turns: [
      {
        user: 'Hey there',
        metadata: {
          conversationSummary:
            'Customer was looking at Nike running shoes in size 42 and asked about the 30% discount offer. They were comparing Nike Air Max 90 and Adidas Ultra Boost.',
        },
      },
    ],
  },
  {
    name: 'Automobile Domain',
    description: 'Automobile query routes to product_tool with afg_automobiles namespace',
    turns: [{ user: 'Show me a Toyota SUV under 200000 AED' }],
  },
];

// =============================================================================
// MAIN
// =============================================================================

async function runScenario(scenario: Scenario, index: number): Promise<TurnStats[]> {
  const ts = Date.now();
  const identity: SessionIdentity = {
    userReference: `e2e_user_${ts}_${index}`,
    sessionReference: `e2e_session_${ts}_${index}`,
  };

  console.log(
    `\n${C.bgBlue}${C.bold} SCENARIO ${index + 1} ${C.reset} ${C.bold}${scenario.name}${C.reset}`,
  );
  console.log(`${C.dim}${scenario.description}${C.reset}`);
  console.log(`${C.dim}${line('─')}${C.reset}`);

  const allStats: TurnStats[] = [];

  for (let t = 0; t < scenario.turns.length; t++) {
    const turn = scenario.turns[t];
    printUserMessage(turn.user);
    const stats = await streamTurn(turn.user, identity, turn.metadata);
    printStats(stats);
    allStats.push(stats);
  }

  return allStats;
}

async function main(): Promise<void> {
  // Parse --scenario N flag
  const scenarioArg = process.argv.find((a) => a === '--scenario');
  const scenarioIdx = scenarioArg
    ? parseInt(process.argv[process.argv.indexOf(scenarioArg) + 1], 10) - 1
    : -1;

  console.log(`\n${C.bold}${line('━')}${C.reset}`);
  console.log(`${C.bold}  AFG Blue Advisory — Live Conversation Transcript${C.reset}`);
  console.log(`${C.dim}  Endpoint: ${EXECUTE_URL}${C.reset}`);
  console.log(`${C.dim}  Time:     ${new Date().toISOString()}${C.reset}`);
  console.log(`${C.bold}${line('━')}${C.reset}`);

  const scenariosToRun =
    scenarioIdx >= 0 && scenarioIdx < SCENARIOS.length
      ? [{ scenario: SCENARIOS[scenarioIdx], index: scenarioIdx }]
      : SCENARIOS.map((s, i) => ({ scenario: s, index: i }));

  const allResults: { name: string; stats: TurnStats[] }[] = [];

  for (const { scenario, index } of scenariosToRun) {
    const stats = await runScenario(scenario, index);
    allResults.push({ name: scenario.name, stats });
  }

  // Print summary table
  console.log(`\n${C.bold}${line('━')}${C.reset}`);
  console.log(`${C.bold}  PERFORMANCE SUMMARY${C.reset}`);
  console.log(`${C.bold}${line('━')}${C.reset}`);
  console.log(
    `  ${C.dim}${'Scenario'.padEnd(42)} ${'TTFB'.padStart(8)} ${'TTFT'.padStart(8)} ${'Total'.padStart(8)} ${'Tokens'.padStart(8)} ${'Events'.padStart(8)}${C.reset}`,
  );
  console.log(`  ${C.dim}${line('─')}${C.reset}`);

  let grandTotalMs = 0;

  for (const result of allResults) {
    for (let i = 0; i < result.stats.length; i++) {
      const s = result.stats[i];
      const label = result.stats.length > 1 ? `${result.name} (Turn ${i + 1})` : result.name;
      console.log(
        `  ${label.padEnd(42)} ${fmt(s.ttfb).padStart(8)} ${fmt(s.ttft).padStart(8)} ${fmt(s.total).padStart(8)} ${String(s.tokenCount).padStart(8)} ${String(s.eventCount).padStart(8)}`,
      );
      grandTotalMs += s.total;
    }
  }

  console.log(`  ${C.dim}${line('─')}${C.reset}`);
  console.log(`  ${C.bold}Total wall time: ${fmt(grandTotalMs)}${C.reset}`);
  console.log();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
