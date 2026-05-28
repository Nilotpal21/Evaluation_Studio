/**
 * Remote Risk Analysis Agent — A2A Protocol Server
 *
 * A standalone A2A-compatible agent that demonstrates:
 * 1. Synchronous mode: Immediate response (fast contracts)
 * 2. Streaming mode: SSE with incremental artifact events (message/stream)
 * 3. Asynchronous mode: Push notification callback (complex contracts)
 *
 * Run: npx ts-node --esm server.ts
 * Port: 4002 (configurable via RISK_AGENT_PORT)
 *
 * Agent Card: GET http://localhost:4002/.well-known/agent-card.json
 * A2A Endpoint: POST http://localhost:4002/a2a (JSON-RPC)
 */

import express from 'express';

const PORT = parseInt(process.env.RISK_AGENT_PORT || '4002', 10);
const SIMULATE_ASYNC_DELAY_MS = parseInt(process.env.RISK_ANALYSIS_DELAY_MS || '10000', 10);

const app = express();
app.use(express.json());

// =============================================================================
// AGENT CARD
// =============================================================================

const agentCard = {
  name: 'Risk Analysis Agent',
  description:
    'Analyzes contract risks asynchronously and returns detailed risk scores with amendment recommendations',
  url: `http://localhost:${PORT}/a2a`,
  version: '1.0.0',
  protocolVersion: '0.3.0',
  capabilities: {
    streaming: true,
    pushNotifications: true,
    stateTransitionHistory: true,
  },
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
  skills: [
    {
      id: 'analyze_risk',
      name: 'Contract Risk Analysis',
      description:
        'Deep risk analysis with amendment recommendations. May take 10-30 seconds for complex contracts.',
      tags: ['risk', 'contract', 'async'],
    },
  ],
};

app.get('/.well-known/agent-card.json', (_req, res) => {
  res.json(agentCard);
});

// =============================================================================
// IN-MEMORY TASK STORE
// =============================================================================

interface TaskRecord {
  id: string;
  contextId: string;
  state: 'submitted' | 'working' | 'completed' | 'failed';
  message?: string;
  pushNotificationConfig?: { url: string; token?: string };
  createdAt: number;
}

const tasks = new Map<string, TaskRecord>();

// =============================================================================
// A2A JSON-RPC ENDPOINT
// =============================================================================

app.post('/a2a', async (req, res) => {
  const { method, params, id: rpcId } = req.body;

  console.log(`[A2A] ${method} received`, { taskId: params?.id, rpcId });

  switch (method) {
    case 'message/send': {
      return handleSendMessage(params, rpcId, res);
    }
    case 'message/stream': {
      return handleSendMessageStream(params, rpcId, res);
    }
    case 'tasks/get': {
      return handleGetTask(params, rpcId, res);
    }
    case 'tasks/cancel': {
      return handleCancelTask(params, rpcId, res);
    }
    default: {
      return res.json({
        jsonrpc: '2.0',
        id: rpcId,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
    }
  }
});

// =============================================================================
// HANDLERS
// =============================================================================

function handleSendMessage(params: any, rpcId: string, res: express.Response) {
  const message = params?.message;
  const configuration = params?.configuration;
  const isNonBlocking = configuration?.blocking === false;
  const pushConfig = configuration?.pushNotificationConfig;

  // Extract text from message parts
  const text = message?.parts?.find((p: any) => p.kind === 'text')?.text || '';
  const contextId = message?.contextId || `ctx-${Date.now()}`;
  const taskId = `risk-task-${Date.now()}`;

  // Parse contract info from text
  let contractInfo: any = {};
  try {
    contractInfo = JSON.parse(text);
  } catch {
    contractInfo = { contract_id: text || 'unknown', contract_type: 'general' };
  }

  console.log(`[A2A] Processing contract: ${contractInfo.contract_id}, async=${isNonBlocking}`);

  // Create task record
  const task: TaskRecord = {
    id: taskId,
    contextId,
    state: 'working',
    pushNotificationConfig: pushConfig,
    createdAt: Date.now(),
  };
  tasks.set(taskId, task);

  if (isNonBlocking && pushConfig) {
    // ----- ASYNC MODE: Return immediately, push notification later -----
    console.log(
      `[A2A] Async mode — will push to ${pushConfig.url} in ${SIMULATE_ASYNC_DELAY_MS}ms`,
    );

    // Return task in 'working' state immediately
    res.json({
      jsonrpc: '2.0',
      id: rpcId,
      result: {
        kind: 'task',
        id: taskId,
        contextId,
        status: { state: 'working' },
      },
    });

    // Simulate async processing, then push notification
    setTimeout(async () => {
      const analysis = performRiskAnalysis(contractInfo);
      task.state = 'completed';
      task.message = JSON.stringify(analysis);

      console.log(
        `[A2A] Risk analysis complete for ${contractInfo.contract_id}, pushing notification...`,
      );

      // Send push notification to caller
      try {
        const pushPayload = {
          jsonrpc: '2.0',
          method: 'tasks/pushNotification',
          params: {
            id: taskId,
            status: { state: 'completed' },
            message: {
              kind: 'message',
              messageId: `resp-${taskId}`,
              role: 'agent',
              parts: [
                {
                  kind: 'text',
                  text: formatAnalysisResponse(contractInfo.contract_id, analysis),
                },
              ],
            },
          },
        };

        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (pushConfig.token) {
          headers['Authorization'] = `Bearer ${pushConfig.token}`;
        }

        const pushResponse = await fetch(pushConfig.url, {
          method: 'POST',
          headers,
          body: JSON.stringify(pushPayload),
        });

        console.log(`[A2A] Push notification sent, status=${pushResponse.status}`);
      } catch (err) {
        console.error(`[A2A] Push notification failed:`, err);
      }
    }, SIMULATE_ASYNC_DELAY_MS);
  } else {
    // ----- SYNC MODE: Process and return immediately -----
    console.log(`[A2A] Sync mode — processing inline`);

    const analysis = performRiskAnalysis(contractInfo);
    task.state = 'completed';
    task.message = JSON.stringify(analysis);

    res.json({
      jsonrpc: '2.0',
      id: rpcId,
      result: {
        kind: 'message',
        messageId: `resp-${taskId}`,
        role: 'agent',
        parts: [
          {
            kind: 'text',
            text: formatAnalysisResponse(contractInfo.contract_id, analysis),
          },
        ],
      },
    });
  }
}

// =============================================================================
// STREAMING HANDLER (SSE)
// =============================================================================

function handleSendMessageStream(params: any, rpcId: string, res: express.Response) {
  const message = params?.message;
  const text = message?.parts?.find((p: any) => p.kind === 'text')?.text || '';
  const contextId = message?.contextId || `ctx-${Date.now()}`;
  const taskId = `risk-task-stream-${Date.now()}`;

  let contractInfo: any = {};
  try {
    contractInfo = JSON.parse(text);
  } catch {
    contractInfo = { contract_id: text || 'unknown', contract_type: 'general' };
  }

  console.log(`[A2A] Streaming mode — ${contractInfo.contract_id}`);

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // SDK's A2AClient expects JSON-RPC response envelope around each SSE event
  const sendSSE = (data: unknown) => {
    const rpcResponse = { jsonrpc: '2.0', id: rpcId, result: data };
    res.write(`id: ${Date.now()}\n`);
    res.write(`data: ${JSON.stringify(rpcResponse)}\n\n`);
  };

  // 1. Emit working status
  sendSSE({
    kind: 'status-update',
    taskId,
    contextId,
    status: { state: 'working' },
    final: false,
  });

  // 2. Generate analysis and stream it as artifact chunks
  const analysis = performRiskAnalysis(contractInfo);
  const fullText = formatAnalysisResponse(contractInfo.contract_id, analysis);
  const artifactId = `artifact-${taskId}`;

  // Split response into lines to simulate incremental streaming
  const lines = fullText.split('\n');
  let chunkIndex = 0;

  const streamNextChunk = () => {
    if (chunkIndex < lines.length) {
      const chunkText = lines[chunkIndex] + (chunkIndex < lines.length - 1 ? '\n' : '');
      sendSSE({
        kind: 'artifact-update',
        taskId,
        contextId,
        artifact: {
          artifactId,
          name: 'risk-analysis',
          parts: [{ kind: 'text', text: chunkText }],
        },
        append: chunkIndex > 0,
        lastChunk: false,
      });
      chunkIndex++;
      // Stagger chunks by 50ms to simulate real streaming
      setTimeout(streamNextChunk, 50);
    } else {
      // 3. Emit last-chunk marker
      sendSSE({
        kind: 'artifact-update',
        taskId,
        contextId,
        artifact: {
          artifactId,
          name: 'risk-analysis',
          parts: [{ kind: 'text', text: '' }],
        },
        append: true,
        lastChunk: true,
      });

      // 4. Emit final completed status (terminates the SSE stream)
      sendSSE({
        kind: 'status-update',
        taskId,
        contextId,
        status: { state: 'completed' },
        final: true,
      });

      // Update task store
      const task: TaskRecord = {
        id: taskId,
        contextId,
        state: 'completed',
        message: fullText,
        createdAt: Date.now(),
      };
      tasks.set(taskId, task);

      console.log(`[A2A] Streaming complete — ${lines.length} chunks sent`);
      res.end();
    }
  };

  streamNextChunk();
}

function handleGetTask(params: any, rpcId: string, res: express.Response) {
  const taskId = params?.id;
  const task = tasks.get(taskId);

  if (!task) {
    return res.json({
      jsonrpc: '2.0',
      id: rpcId,
      error: { code: -32602, message: `Task not found: ${taskId}` },
    });
  }

  res.json({
    jsonrpc: '2.0',
    id: rpcId,
    result: {
      kind: 'task',
      id: task.id,
      contextId: task.contextId,
      status: { state: task.state },
    },
  });
}

function handleCancelTask(params: any, rpcId: string, res: express.Response) {
  const taskId = params?.id;
  const task = tasks.get(taskId);

  if (task) {
    task.state = 'failed';
    console.log(`[A2A] Task cancelled: ${taskId}`);
  }

  res.json({
    jsonrpc: '2.0',
    id: rpcId,
    result: { kind: 'task', id: taskId, contextId: task?.contextId, status: { state: 'canceled' } },
  });
}

// =============================================================================
// RISK ANALYSIS LOGIC
// =============================================================================

interface RiskAnalysis {
  overall_score: number;
  risk_level: 'low' | 'medium' | 'high' | 'critical';
  categories: {
    termination_risk: number;
    liability_risk: number;
    compliance_risk: number;
    financial_risk: number;
  };
  findings: string[];
  amendments_recommended: boolean;
  amendments?: string[];
}

function performRiskAnalysis(contractInfo: any): RiskAnalysis {
  // Simulate meaningful risk analysis based on contract type
  const contractType = (contractInfo.contract_type || 'general').toLowerCase();

  const baseScores: Record<string, number> = {
    saas: 0.35,
    consulting: 0.45,
    licensing: 0.55,
    partnership: 0.65,
    general: 0.4,
  };

  const baseScore = baseScores[contractType] ?? 0.4;
  const jitter = (Math.random() - 0.5) * 0.2;
  const overallScore = Math.max(0.05, Math.min(0.95, baseScore + jitter));

  const riskLevel: RiskAnalysis['risk_level'] =
    overallScore < 0.3
      ? 'low'
      : overallScore < 0.5
        ? 'medium'
        : overallScore < 0.7
          ? 'high'
          : 'critical';

  const findings: string[] = [];
  const amendments: string[] = [];

  if (overallScore > 0.4) {
    findings.push('Termination clause lacks adequate notice period');
    amendments.push('Add 90-day mutual termination notice clause');
  }
  if (overallScore > 0.5) {
    findings.push('Liability cap is below industry standard');
    amendments.push('Increase liability cap to 2x annual contract value');
  }
  if (overallScore > 0.6) {
    findings.push('Missing data breach notification requirements');
    amendments.push('Add 72-hour data breach notification clause per GDPR');
  }
  if (overallScore > 0.7) {
    findings.push('No force majeure clause detected');
    amendments.push('Add comprehensive force majeure clause');
  }
  if (findings.length === 0) {
    findings.push('Contract meets all standard compliance requirements');
  }

  return {
    overall_score: Math.round(overallScore * 100) / 100,
    risk_level: riskLevel,
    categories: {
      termination_risk: Math.round((overallScore + (Math.random() - 0.5) * 0.2) * 100) / 100,
      liability_risk: Math.round((overallScore + (Math.random() - 0.5) * 0.15) * 100) / 100,
      compliance_risk: Math.round(overallScore * 0.8 * 100) / 100,
      financial_risk: Math.round(overallScore * 1.1 * 100) / 100,
    },
    findings,
    amendments_recommended: overallScore > 0.4,
    amendments: overallScore > 0.4 ? amendments : undefined,
  };
}

function formatAnalysisResponse(contractId: string, analysis: RiskAnalysis): string {
  const lines = [
    `Risk Analysis Complete for Contract: ${contractId}`,
    ``,
    `Overall Risk Score: ${analysis.overall_score} (${analysis.risk_level.toUpperCase()})`,
    ``,
    `Category Scores:`,
    `  Termination Risk: ${analysis.categories.termination_risk}`,
    `  Liability Risk:   ${analysis.categories.liability_risk}`,
    `  Compliance Risk:  ${analysis.categories.compliance_risk}`,
    `  Financial Risk:   ${analysis.categories.financial_risk}`,
    ``,
    `Findings:`,
    ...analysis.findings.map((f) => `  - ${f}`),
  ];

  if (analysis.amendments_recommended && analysis.amendments) {
    lines.push(``, `Recommended Amendments:`);
    lines.push(...analysis.amendments.map((a) => `  - ${a}`));
  } else {
    lines.push(``, `No amendments required.`);
  }

  return lines.join('\n');
}

// =============================================================================
// START SERVER
// =============================================================================

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Risk Analysis Agent (A2A Protocol)                        ║
║                                                            ║
║  Agent Card:  http://localhost:${PORT}/.well-known/agent-card.json   ║
║  A2A RPC:     http://localhost:${PORT}/a2a                      ║
║                                                            ║
║  Capabilities:                                             ║
║    - Streaming (SSE):     ENABLED                          ║
║    - Push Notifications:  ENABLED                          ║
║    - Async Delay: ${String(SIMULATE_ASYNC_DELAY_MS).padEnd(6)}ms                              ║
║                                                            ║
║  Modes:                                                    ║
║    - Sync:      message/send  (blocking=true)              ║
║    - Streaming: message/stream (SSE artifact chunks)       ║
║    - Async:     message/send  (blocking=false + push)      ║
╚══════════════════════════════════════════════════════════════╝
  `);
});
