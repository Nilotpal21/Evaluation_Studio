#!/usr/bin/env node
/**
 * Agent Debug CLI
 *
 * Remote debugging tool for Agent ABL Observatory
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { DebugClient } from './client/debug-client.js';
import { DebugRepl } from './client/repl.js';
import {
  parseBreakpointSpec,
  formatBreakpoint,
  DebugSession,
  Breakpoint,
  BreakpointContext,
  AgentStackFrame,
} from '@agent-platform/observatory';

const program = new Command();

program.name('agent-debug').description('Remote debugging CLI for Agent ABL').version('1.0.0');

// Global options
program
  .option('-h, --host <host>', 'Debug server host', 'localhost')
  .option('-p, --port <port>', 'Debug server port', '9229')
  .option('-t, --token <token>', 'Auth token');

/**
 * Create a connected debug client
 */
async function createClient(options: any): Promise<DebugClient> {
  const client = new DebugClient({
    host: options.host || 'localhost',
    port: parseInt(options.port || '9229', 10),
    token: options.token,
  });

  try {
    await client.connect();
    return client;
  } catch (err) {
    console.error(chalk.red(`Failed to connect: ${err}`));
    process.exit(1);
  }
}

// ============================================
// Commands
// ============================================

/**
 * Connect and start REPL
 */
program
  .command('connect')
  .alias('repl')
  .description('Connect to debug server and start interactive REPL')
  .action(async (_, cmd) => {
    const opts = cmd.optsWithGlobals();
    const client = await createClient(opts);
    console.log(chalk.green(`Connected to ${opts.host}:${opts.port}`));

    const repl = new DebugRepl(client);
    await repl.start();
  });

/**
 * List sessions
 */
program
  .command('sessions')
  .alias('ls')
  .description('List active debug sessions')
  .action(async (_, cmd) => {
    const opts = cmd.optsWithGlobals();
    const client = await createClient(opts);

    client.on('sessions', (sessions: DebugSession[]) => {
      if (sessions.length === 0) {
        console.log(chalk.gray('No active sessions'));
      } else {
        console.log(chalk.cyan('Active Sessions:'));
        for (const s of sessions) {
          const attached = s.debuggerAttached ? chalk.yellow(' [attached]') : '';
          console.log(`  ${s.id}  ${s.currentAgent}  ${s.state}  turns:${s.turnCount}${attached}`);
        }
      }
      client.disconnect();
    });

    client.sessions();
  });

/**
 * Attach to session
 */
program
  .command('attach <sessionId>')
  .description('Attach to a session and start REPL')
  .action(async (sessionId, _, cmd) => {
    const opts = cmd.optsWithGlobals();
    const client = await createClient(opts);

    client.on('attached', async (session: DebugSession) => {
      console.log(chalk.green(`Attached to session: ${session.id}`));
      console.log(chalk.gray(`  Agent: ${session.currentAgent}`));
      console.log(chalk.gray(`  State: ${session.state}`));

      const repl = new DebugRepl(client);
      await repl.start();
    });

    client.on('error', (err: string) => {
      console.error(chalk.red(`Error: ${err}`));
      client.disconnect();
      process.exit(1);
    });

    client.attach(sessionId);
  });

/**
 * Add breakpoint
 */
program
  .command('break <spec>')
  .alias('b')
  .description('Add a breakpoint')
  .action(async (spec, _, cmd) => {
    const opts = cmd.optsWithGlobals();
    const parsedSpec = parseBreakpointSpec(spec);

    if (!parsedSpec) {
      console.error(chalk.red('Invalid breakpoint spec'));
      console.log(chalk.gray('Examples:'));
      console.log(chalk.gray('  agent:Sales_Chat'));
      console.log(chalk.gray('  step:Welcome:Greet'));
      console.log(chalk.gray('  event:handoff'));
      console.log(chalk.gray('  cond:"budget>5000"'));
      process.exit(1);
    }

    const client = await createClient(opts);

    client.on('breaks', (breakpoints: Breakpoint[]) => {
      const added = breakpoints[breakpoints.length - 1];
      console.log(chalk.green(`Breakpoint added: ${added.id}`));
      console.log(chalk.gray(`  ${formatBreakpoint(added)}`));
      client.disconnect();
    });

    client.addBreakpoint(parsedSpec);
  });

/**
 * Remove breakpoint
 */
program
  .command('unbreak <id>')
  .alias('ub')
  .description('Remove a breakpoint')
  .action(async (id, _, cmd) => {
    const opts = cmd.optsWithGlobals();
    const client = await createClient(opts);

    client.on('breaks', () => {
      console.log(chalk.green(`Breakpoint removed: ${id}`));
      client.disconnect();
    });

    client.removeBreakpoint(id);
  });

/**
 * List breakpoints
 */
program
  .command('breaks')
  .alias('bl')
  .description('List all breakpoints')
  .action(async (_, cmd) => {
    const opts = cmd.optsWithGlobals();
    const client = await createClient(opts);

    client.on('breaks', (breakpoints: Breakpoint[]) => {
      if (breakpoints.length === 0) {
        console.log(chalk.gray('No breakpoints'));
      } else {
        console.log(chalk.cyan('Breakpoints:'));
        for (const bp of breakpoints) {
          const status = bp.enabled ? chalk.green('enabled') : chalk.gray('disabled');
          console.log(`  ${bp.id}: ${formatBreakpoint(bp)} [${status}] hits: ${bp.hitCount}`);
        }
      }
      client.disconnect();
    });

    client.listBreakpoints();
  });

/**
 * Pause execution
 */
program
  .command('pause')
  .alias('p')
  .description('Pause execution of attached session')
  .action(async (_, cmd) => {
    const opts = cmd.optsWithGlobals();
    const client = await createClient(opts);

    client.on('paused', (reason: string) => {
      console.log(chalk.yellow(`Paused: ${reason}`));
      client.disconnect();
    });

    client.pause();
  });

/**
 * Resume execution
 */
program
  .command('resume')
  .alias('r')
  .description('Resume execution of attached session')
  .action(async (_, cmd) => {
    const opts = cmd.optsWithGlobals();
    const client = await createClient(opts);

    client.on('resumed', () => {
      console.log(chalk.green('Resumed'));
      client.disconnect();
    });

    client.resume();
  });

/**
 * Step execution
 */
program
  .command('step')
  .alias('s')
  .option('--into', 'Step into handoff/delegate')
  .option('--out', 'Step out of current agent')
  .description('Step execution')
  .action(async (options, cmd) => {
    const opts = cmd.optsWithGlobals();
    const client = await createClient(opts);

    const stepType = options.into ? 'into' : options.out ? 'out' : 'over';

    client.on('paused', () => {
      console.log(chalk.yellow('Stepped'));
      client.disconnect();
    });

    client.step(stepType);
  });

/**
 * Get state
 */
program
  .command('state [path]')
  .alias('st')
  .description('Show current session state')
  .action(async (path, _, cmd) => {
    const opts = cmd.optsWithGlobals();
    const client = await createClient(opts);

    client.on('state', (data: Record<string, unknown>) => {
      console.log(chalk.cyan('State:'));
      console.log(JSON.stringify(data, null, 2));
      client.disconnect();
    });

    client.getState(path);
  });

/**
 * Get stack
 */
program
  .command('stack')
  .alias('bt')
  .description('Show agent call stack')
  .action(async (_, cmd) => {
    const opts = cmd.optsWithGlobals();
    const client = await createClient(opts);

    client.on('stack', (frames: AgentStackFrame[]) => {
      console.log(chalk.cyan('Call Stack:'));
      if (frames.length === 0) {
        console.log(chalk.gray('  (empty)'));
      } else {
        for (let i = frames.length - 1; i >= 0; i--) {
          const frame = frames[i];
          const step = frame.currentStep ? `:${frame.currentStep}` : '';
          console.log(`  #${i} ${frame.agentName}${step} (${frame.mode}) [${frame.trigger}]`);
        }
      }
      client.disconnect();
    });

    client.getStack();
  });

/**
 * Follow mode - stream events from new sessions
 */
program
  .command('follow')
  .alias('f')
  .description('Stream trace events from all sessions')
  .action(async (_, cmd) => {
    const opts = cmd.optsWithGlobals();
    const client = await createClient(opts);

    console.log(chalk.cyan('Following all sessions... (Ctrl+C to stop)'));

    client.on('session_created', (session: DebugSession) => {
      console.log(chalk.blue(`\n[NEW] ${session.id} - ${session.currentAgent}`));
    });

    client.on('trace', (event: any) => {
      const time = new Date(event.timestamp).toISOString().substring(11, 23);
      console.log(`${chalk.gray(time)} ${formatEventType(event.type)} ${event.agentName}`);
    });

    client.on('session_ended', (sessionId: string, reason: string) => {
      console.log(chalk.yellow(`\n[END] ${sessionId} - ${reason}`));
    });

    client.follow(true);

    // Keep running until Ctrl+C
    process.on('SIGINT', () => {
      console.log(chalk.gray('\nStopping...'));
      client.disconnect();
      process.exit(0);
    });
  });

/**
 * Evaluate expression
 */
program
  .command('eval <expr>')
  .alias('e')
  .description('Evaluate an expression against session state')
  .action(async (expr, _, cmd) => {
    const opts = cmd.optsWithGlobals();
    const client = await createClient(opts);

    client.on('evaluate_result', (expression: string, result: unknown, error?: string) => {
      if (error) {
        console.error(chalk.red(`Error: ${error}`));
      } else {
        console.log(chalk.cyan(`${expression} =`));
        console.log(JSON.stringify(result, null, 2));
      }
      client.disconnect();
    });

    client.evaluate(expr);
  });

// Helper function
function formatEventType(type: string): string {
  switch (type) {
    case 'llm_call':
      return chalk.blue('[LLM]');
    case 'tool_call':
      return chalk.yellow('[TOOL]');
    case 'decision':
      return chalk.magenta('[DEC]');
    case 'handoff':
      return chalk.cyan('[HANDOFF]');
    case 'escalation':
      return chalk.red('[ESC]');
    case 'error':
      return chalk.red('[ERR]');
    case 'agent_enter':
      return chalk.green('[→AGT]');
    case 'agent_exit':
      return chalk.green('[←AGT]');
    default:
      return `[${type.toUpperCase()}]`;
  }
}

// Parse and run
program.parse();
