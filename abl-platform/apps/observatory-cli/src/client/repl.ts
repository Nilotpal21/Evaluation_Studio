/**
 * Interactive REPL for Debug CLI
 */

import * as readline from 'readline';
import chalk from 'chalk';
import { DebugClient } from './debug-client.js';
import {
  DebugSession,
  Breakpoint,
  BreakpointContext,
  AgentStackFrame,
  ExtendedTraceEvent,
  parseBreakpointSpec,
  formatBreakpoint,
} from '@agent-platform/observatory';

/**
 * Interactive REPL for debugging
 */
export class DebugRepl {
  private client: DebugClient;
  private rl: readline.Interface;
  private running = false;
  private attachedSession: DebugSession | null = null;
  private isPaused = false;

  constructor(client: DebugClient) {
    this.client = client;
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: chalk.cyan('debug> '),
    });

    this.setupEventHandlers();
  }

  /**
   * Start the REPL
   */
  async start(): Promise<void> {
    this.running = true;

    console.log(chalk.green('Agent Debug REPL'));
    console.log(chalk.gray('Type "help" for available commands'));
    console.log();

    this.rl.prompt();

    this.rl.on('line', async (line) => {
      const trimmed = line.trim();
      if (trimmed) {
        await this.handleCommand(trimmed);
      }
      if (this.running) {
        this.updatePrompt();
        this.rl.prompt();
      }
    });

    this.rl.on('close', () => {
      this.running = false;
      console.log(chalk.gray('\nGoodbye!'));
      process.exit(0);
    });
  }

  /**
   * Stop the REPL
   */
  stop(): void {
    this.running = false;
    this.rl.close();
  }

  private updatePrompt(): void {
    if (this.attachedSession) {
      const status = this.isPaused ? chalk.red('paused') : chalk.green('running');
      this.rl.setPrompt(chalk.cyan(`[${this.attachedSession.currentAgent}:${status}]> `));
    } else {
      this.rl.setPrompt(chalk.cyan('debug> '));
    }
  }

  private setupEventHandlers(): void {
    this.client.on('sessions', (sessions: DebugSession[]) => {
      this.printSessions(sessions);
    });

    this.client.on('attached', (session: DebugSession) => {
      this.attachedSession = session;
      this.isPaused = session.state === 'paused';
      console.log(chalk.green(`\nAttached to session: ${session.id}`));
      console.log(chalk.gray(`  Agent: ${session.currentAgent}`));
      console.log(chalk.gray(`  State: ${session.state}`));
      console.log(chalk.gray(`  Turns: ${session.turnCount}`));
    });

    this.client.on('detached', () => {
      console.log(chalk.yellow('\nDetached from session'));
      this.attachedSession = null;
      this.isPaused = false;
    });

    this.client.on('session_created', (session: DebugSession) => {
      console.log(chalk.blue(`\nNew session: ${session.id} (${session.currentAgent})`));
    });

    this.client.on('session_ended', (sessionId: string, reason: string) => {
      console.log(chalk.yellow(`\nSession ended: ${sessionId} (${reason})`));
      if (this.attachedSession?.id === sessionId) {
        this.attachedSession = null;
        this.isPaused = false;
      }
    });

    this.client.on('breakpoint_hit', (bp: Breakpoint, context: BreakpointContext) => {
      this.isPaused = true;
      console.log(chalk.red(`\n*** Breakpoint hit: ${formatBreakpoint(bp)} ***`));
      console.log(chalk.gray(`  Agent: ${context.agentName}`));
      if (context.stepName) {
        console.log(chalk.gray(`  Step: ${context.stepName}`));
      }
      this.printStack(context.callStack);
    });

    this.client.on('paused', (reason: string, context: BreakpointContext) => {
      this.isPaused = true;
      console.log(chalk.yellow(`\n*** Paused: ${reason} ***`));
      console.log(chalk.gray(`  Agent: ${context.agentName}`));
    });

    this.client.on('resumed', () => {
      this.isPaused = false;
      console.log(chalk.green('\n*** Resumed ***'));
    });

    this.client.on('trace', (event: ExtendedTraceEvent) => {
      this.printTraceEvent(event);
    });

    this.client.on('state', (data: Record<string, unknown>, sessionState: string) => {
      console.log(chalk.cyan('\nState:'));
      console.log(JSON.stringify(data, null, 2));
    });

    this.client.on('stack', (frames: AgentStackFrame[]) => {
      console.log(chalk.cyan('\nCall Stack:'));
      this.printStack(frames);
    });

    this.client.on('breaks', (breakpoints: Breakpoint[]) => {
      console.log(chalk.cyan('\nBreakpoints:'));
      if (breakpoints.length === 0) {
        console.log(chalk.gray('  No breakpoints'));
      } else {
        for (const bp of breakpoints) {
          const status = bp.enabled ? chalk.green('enabled') : chalk.gray('disabled');
          console.log(`  ${bp.id}: ${formatBreakpoint(bp)} [${status}] hits: ${bp.hitCount}`);
        }
      }
    });

    this.client.on('evaluate_result', (expr: string, result: unknown, error?: string) => {
      if (error) {
        console.log(chalk.red(`Error: ${error}`));
      } else {
        console.log(chalk.cyan(`${expr} =`), JSON.stringify(result, null, 2));
      }
    });

    this.client.on('error', (message: string) => {
      console.log(chalk.red(`Error: ${message}`));
    });

    this.client.on('disconnected', () => {
      console.log(chalk.red('\nDisconnected from server'));
      this.running = false;
      this.rl.close();
    });
  }

  private async handleCommand(input: string): Promise<void> {
    const [cmd, ...args] = input.split(/\s+/);

    switch (cmd.toLowerCase()) {
      case 'help':
      case 'h':
      case '?':
        this.printHelp();
        break;

      case 'sessions':
      case 'ls':
        this.client.sessions();
        break;

      case 'attach':
      case 'a':
        if (args.length === 0) {
          console.log(chalk.red('Usage: attach <session-id>'));
        } else {
          this.client.attach(args[0]);
        }
        break;

      case 'detach':
      case 'd':
        this.client.detach();
        break;

      case 'break':
      case 'b':
        if (args.length === 0) {
          console.log(chalk.red('Usage: break <spec>'));
          console.log(chalk.gray('  Examples:'));
          console.log(chalk.gray('    break agent:Sales_Chat'));
          console.log(chalk.gray('    break step:Welcome:Greet'));
          console.log(chalk.gray('    break event:handoff'));
          console.log(chalk.gray('    break cond:"budget>5000"'));
        } else {
          const spec = parseBreakpointSpec(args.join(' '));
          if (spec) {
            this.client.addBreakpoint(spec);
          } else {
            console.log(chalk.red('Invalid breakpoint spec'));
          }
        }
        break;

      case 'unbreak':
      case 'ub':
        if (args.length === 0) {
          console.log(chalk.red('Usage: unbreak <id>'));
        } else {
          this.client.removeBreakpoint(args[0]);
        }
        break;

      case 'breaks':
      case 'bl':
        this.client.listBreakpoints();
        break;

      case 'pause':
      case 'p':
        this.client.pause();
        break;

      case 'resume':
      case 'r':
      case 'continue':
      case 'c':
        this.client.resume();
        break;

      case 'step':
      case 's':
        this.client.step('over');
        break;

      case 'stepin':
      case 'si':
        this.client.step('into');
        break;

      case 'stepout':
      case 'so':
        this.client.step('out');
        break;

      case 'state':
      case 'st':
        this.client.getState(args[0]);
        break;

      case 'stack':
      case 'bt':
        this.client.getStack();
        break;

      case 'trace':
      case 't':
        const limit = args[0] ? parseInt(args[0], 10) : 20;
        this.client.getTrace(limit);
        break;

      case 'follow':
      case 'f':
        const enabled = args[0] !== 'off' && args[0] !== 'false' && args[0] !== '0';
        this.client.follow(enabled);
        console.log(chalk.gray(`Follow mode ${enabled ? 'enabled' : 'disabled'}`));
        break;

      case 'eval':
      case 'e':
        if (args.length === 0) {
          console.log(chalk.red('Usage: eval <expression>'));
        } else {
          this.client.evaluate(args.join(' '));
        }
        break;

      case 'explain':
      case 'x':
        this.client.explain(args[0]);
        break;

      case 'quit':
      case 'q':
      case 'exit':
        this.stop();
        break;

      default:
        console.log(chalk.red(`Unknown command: ${cmd}`));
        console.log(chalk.gray('Type "help" for available commands'));
    }
  }

  private printHelp(): void {
    console.log(chalk.cyan('\nAvailable Commands:'));
    console.log();
    console.log(chalk.white('Session Management:'));
    console.log('  sessions, ls        List active debug sessions');
    console.log('  attach, a <id>      Attach to a session');
    console.log('  detach, d           Detach from current session');
    console.log('  follow, f [on|off]  Auto-attach to new sessions');
    console.log();
    console.log(chalk.white('Breakpoints:'));
    console.log('  break, b <spec>     Add a breakpoint');
    console.log('  unbreak, ub <id>    Remove a breakpoint');
    console.log('  breaks, bl          List all breakpoints');
    console.log();
    console.log(chalk.white('Flow Control:'));
    console.log('  pause, p            Pause execution');
    console.log('  resume, r, c        Resume execution');
    console.log('  step, s             Step over');
    console.log('  stepin, si          Step into handoff/delegate');
    console.log('  stepout, so         Step out of current agent');
    console.log();
    console.log(chalk.white('Inspection:'));
    console.log('  state, st [path]    Show current state');
    console.log('  stack, bt           Show agent call stack');
    console.log('  trace, t [n]        Show last n trace events');
    console.log('  eval, e <expr>      Evaluate expression');
    console.log('  explain, x [id]     Explain a decision');
    console.log();
    console.log(chalk.white('Other:'));
    console.log('  help, h, ?          Show this help');
    console.log('  quit, q, exit       Exit the debugger');
    console.log();
    console.log(chalk.gray('Breakpoint spec examples:'));
    console.log(chalk.gray('  agent:Sales_Chat          Break on agent entry/exit'));
    console.log(chalk.gray('  agent:Sales_Chat:entry    Break only on entry'));
    console.log(chalk.gray('  step:Welcome:Greet        Break on flow step'));
    console.log(chalk.gray('  event:handoff             Break on event type'));
    console.log(chalk.gray('  cond:"budget>5000"        Conditional break'));
  }

  private printSessions(sessions: DebugSession[]): void {
    console.log(chalk.cyan('\nActive Sessions:'));
    if (sessions.length === 0) {
      console.log(chalk.gray('  No active sessions'));
      return;
    }

    for (const s of sessions) {
      const attached = s.debuggerAttached ? chalk.yellow(' [attached]') : '';
      const state = this.formatState(s.state);
      console.log(
        `  ${s.id.substring(0, 8)}  ${s.currentAgent}  ${state}  turns:${s.turnCount}${attached}`,
      );
    }
  }

  private formatState(state: string): string {
    switch (state) {
      case 'running':
        return chalk.green('running');
      case 'paused':
        return chalk.red('paused');
      case 'waiting':
        return chalk.yellow('waiting');
      case 'completed':
        return chalk.gray('completed');
      case 'error':
        return chalk.red('error');
      default:
        return state;
    }
  }

  private printStack(frames: AgentStackFrame[]): void {
    if (frames.length === 0) {
      console.log(chalk.gray('  (empty stack)'));
      return;
    }

    for (let i = frames.length - 1; i >= 0; i--) {
      const frame = frames[i];
      const prefix = i === frames.length - 1 ? chalk.cyan('→') : ' ';
      const step = frame.currentStep ? `:${frame.currentStep}` : '';
      console.log(`  ${prefix} #${i} ${frame.agentName}${step} (${frame.mode}) [${frame.trigger}]`);
    }
  }

  private printTraceEvent(event: ExtendedTraceEvent): void {
    const time = new Date(event.timestamp).toISOString().substring(11, 23);
    const type = this.formatEventType(event.type);
    console.log(`  ${chalk.gray(time)} ${type} ${event.agentName}`);
  }

  private formatEventType(type: string): string {
    switch (type) {
      case 'llm_call':
        return chalk.blue('LLM');
      case 'tool_call':
        return chalk.yellow('TOOL');
      case 'decision':
        return chalk.magenta('DEC');
      case 'handoff':
        return chalk.cyan('HANDOFF');
      case 'escalation':
        return chalk.red('ESC');
      case 'error':
        return chalk.red('ERR');
      case 'agent_enter':
        return chalk.green('→AGT');
      case 'agent_exit':
        return chalk.green('←AGT');
      case 'flow_step_enter':
        return chalk.gray('→STP');
      case 'flow_step_exit':
        return chalk.gray('←STP');
      case 'flow_transition':
        return chalk.gray('TRANS');
      default:
        return type.substring(0, 6).toUpperCase().padEnd(6);
    }
  }
}
