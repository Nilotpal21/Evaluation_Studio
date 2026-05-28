/**
 * Workflow Runtime
 *
 * Long-running workflow runtime with Human-in-the-Loop (HITL) support.
 * Key characteristics:
 * - Durable execution (survives restarts)
 * - Human task assignment and tracking
 * - Pause/resume workflows
 * - Timeout handling for human tasks
 * - State machine execution
 * - ConstructExecutor integration for consistent DSL construct execution
 *
 * Extends BaseRuntime for shared store, agent registration, and context building.
 */

import { randomUUID } from 'crypto';
import type { AgentIR } from '../ir/schema.js';
import type { ConversationStore } from '../stores/conversation-store.js';
import type { MessageStore } from '../stores/message-store.js';
import type { TraceProvider, TraceContextManager } from '../stores/trace-store.js';
import type { AuditStore } from '../stores/audit-store.js';
import type { FactStore } from '../stores/fact-store.js';
import {
  createInitialState,
  type ExecutionContext,
  type AgentState,
  type LLMClient as ConstructLLMClient,
  type ToolExecutor,
  type ConstructAction,
} from '../constructs/types.js';
import { BaseRuntime, type BaseRuntimeConfig, type BaseRuntimeOptions } from './base-runtime.js';
import type { RuntimeType } from '../constructs/index.js';
import { evaluateConditionDual as evaluateConditionShared } from '../constructs/dual-evaluator.js';
import { createLogger } from '../logger.js';

// =============================================================================
// INTERFACES
// =============================================================================

export interface WorkflowRuntimeConfig extends BaseRuntimeConfig {
  /** Default timeout for human tasks (ms) */
  humanTaskTimeoutMs: number;

  /** Polling interval for human task completion (ms) */
  pollIntervalMs: number;

  /** Max pending workflows per customer */
  maxPendingPerCustomer: number;
}

export type WorkflowStatus =
  | 'pending' // Waiting to start
  | 'running' // Actively executing
  | 'awaiting_human' // Paused for human input
  | 'awaiting_agent' // Paused for agent decision
  | 'completed' // Successfully finished
  | 'failed' // Failed with error
  | 'cancelled' // Cancelled by user/admin
  | 'timeout'; // Timed out waiting for human

export type HumanTaskStatus =
  | 'pending'
  | 'assigned'
  | 'in_progress'
  | 'completed'
  | 'escalated'
  | 'timeout';

export interface Workflow {
  id: string;
  sessionId: string;
  customerId?: string;
  agentName: string;
  agentVersion: string;
  status: WorkflowStatus;
  currentStep: string;
  state: WorkflowState;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  error?: string;
  pendingHumanTask?: HumanTask;
  history: WorkflowHistoryEntry[];
}

export interface WorkflowState {
  context: Record<string, unknown>;
  stepResults: Record<string, unknown>;
  humanResponses: Record<string, HumanResponse>;
}

export interface WorkflowHistoryEntry {
  timestamp: Date;
  step: string;
  action: string;
  details: Record<string, unknown>;
}

export interface HumanTask {
  id: string;
  workflowId: string;
  type: HumanTaskType;
  title: string;
  description: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  status: HumanTaskStatus;
  assignedTo?: string;
  assignedAt?: Date;
  createdAt: Date;
  dueAt: Date;
  completedAt?: Date;
  context: Record<string, unknown>;
  requiredFields: HumanTaskField[];
  response?: HumanResponse;
  escalationChain: string[];
  currentEscalationLevel: number;
}

export type HumanTaskType =
  | 'approval' // Yes/No decision
  | 'data_entry' // Fill in form
  | 'review' // Review and comment
  | 'decision' // Multiple choice
  | 'escalation'; // Escalated issue

export interface HumanTaskField {
  name: string;
  type: 'text' | 'number' | 'boolean' | 'select' | 'textarea';
  label: string;
  required: boolean;
  options?: string[];
  validation?: string;
}

export interface HumanResponse {
  taskId: string;
  respondedBy: string;
  respondedAt: Date;
  fields: Record<string, unknown>;
  notes?: string;
  approved?: boolean;
}

export interface WorkflowStore {
  create(workflow: Workflow): Promise<void>;
  get(workflowId: string): Promise<Workflow | null>;
  update(workflowId: string, updates: Partial<Workflow>): Promise<void>;
  listByCustomer(customerId: string, status?: WorkflowStatus): Promise<Workflow[]>;
  listByStatus(status: WorkflowStatus, limit?: number): Promise<Workflow[]>;
  listAwaitingHuman(): Promise<Workflow[]>;
}

export interface HumanTaskStore {
  create(task: HumanTask): Promise<void>;
  get(taskId: string): Promise<HumanTask | null>;
  update(taskId: string, updates: Partial<HumanTask>): Promise<void>;
  assign(taskId: string, assignedTo: string): Promise<void>;
  complete(taskId: string, response: HumanResponse): Promise<void>;
  listPending(assignedTo?: string): Promise<HumanTask[]>;
  listByWorkflow(workflowId: string): Promise<HumanTask[]>;
}

export interface LLMClient {
  chat(
    systemPrompt: string,
    messages: Array<{ role: string; content: string }>,
    options: { model: string; timeoutMs: number },
  ): Promise<string>;
}

// =============================================================================
// WORKFLOW RUNTIME
// =============================================================================

export class WorkflowRuntime extends BaseRuntime {
  private readonly log = createLogger('workflow-runtime');
  private workflowStore: WorkflowStore;
  private humanTaskStore: HumanTaskStore;
  private llmClient: LLMClient;
  private toolExecutor: ToolExecutor;
  private checkInterval?: NodeJS.Timeout;

  /** Workflow states keyed by workflow ID */
  private workflowStates: Map<string, AgentState> = new Map();

  constructor(
    config: WorkflowRuntimeConfig,
    conversationStore: ConversationStore,
    messageStore: MessageStore,
    traceStore: TraceProvider,
    auditStore: AuditStore,
    factStore: FactStore,
    workflowStore: WorkflowStore,
    humanTaskStore: HumanTaskStore,
    llmClient: LLMClient,
    toolExecutor: ToolExecutor,
    options?: Omit<BaseRuntimeOptions, 'constructExecutor'>,
  ) {
    super(config, conversationStore, messageStore, traceStore, auditStore, factStore, options);
    this.workflowStore = workflowStore;
    this.humanTaskStore = humanTaskStore;
    this.llmClient = llmClient;
    this.toolExecutor = toolExecutor;
  }

  get runtimeType(): RuntimeType {
    return 'workflow';
  }

  // ===========================================================================
  // ADAPTER HOOKS
  // ===========================================================================

  /**
   * Adapt the workflow's chat-only LLMClient to the ConstructExecutor interface.
   * The workflow LLMClient only provides `chat` — no extractJson or streamChat.
   * We wrap it to provide extractJson by prompting for JSON and parsing.
   */
  protected adaptLLMClient(): ConstructLLMClient {
    return {
      chat: this.llmClient.chat.bind(this.llmClient),
      chatWithTools: async (systemPrompt, messages, tools, options) => {
        const text = await this.llmClient.chat(
          systemPrompt,
          messages.map((m) => ({
            role: typeof m.content === 'string' ? m.role : m.role,
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          })),
          options,
        );
        return { text, toolCalls: [], stopReason: 'end_turn' as const };
      },
      extractJson: async (systemPrompt, messages, schema, options) => {
        // Use chat to extract JSON, then parse
        const prompt = `${systemPrompt}\n\nExtract the following JSON schema:\n${schema}\n\nRespond ONLY with valid JSON.`;
        const response = await this.llmClient.chat(prompt, messages, options);
        try {
          return JSON.parse(response);
        } catch {
          this.log.warn(
            'extractJson: failed to parse LLM response as JSON, returning empty object',
            { responseSnippet: response.slice(0, 200) },
          );
          return {};
        }
      },
    };
  }

  /**
   * Adapt the workflow's tool executor to the ConstructExecutor interface.
   * The workflow uses ToolExecutor from constructs/types.js directly.
   */
  protected adaptToolExecutor(): ToolExecutor {
    return this.toolExecutor;
  }

  // ===========================================================================
  // PUBLIC METHODS
  // ===========================================================================

  /**
   * Start the background task checker
   */
  start(): void {
    this.checkInterval = setInterval(
      () => this.checkPendingTasks(),
      (this.config as WorkflowRuntimeConfig).pollIntervalMs,
    );
    this.emit('runtime:started');
  }

  /**
   * Stop the runtime
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }
    this.emit('runtime:stopped');
  }

  /**
   * Start a new workflow
   */
  async startWorkflow(
    sessionId: string,
    agentName: string,
    initialContext: Record<string, unknown> = {},
    customerId?: string,
  ): Promise<Workflow> {
    const agentIR = this.agentIRs.get(agentName);
    if (!agentIR) {
      throw new Error(`Agent ${agentName} not found`);
    }

    // Check max pending workflows
    if (customerId) {
      const pending = await this.workflowStore.listByCustomer(customerId, 'running');
      if (pending.length >= (this.config as WorkflowRuntimeConfig).maxPendingPerCustomer) {
        throw new Error('Maximum pending workflows reached');
      }
    }

    const workflow: Workflow = {
      id: randomUUID(),
      sessionId,
      customerId,
      agentName,
      agentVersion: agentIR.metadata.version,
      status: 'pending',
      currentStep: agentIR.flow?.entry_point || 'start',
      state: {
        context: initialContext,
        stepResults: {},
        humanResponses: {},
      },
      createdAt: new Date(),
      updatedAt: new Date(),
      history: [
        {
          timestamp: new Date(),
          step: 'start',
          action: 'workflow_created',
          details: { initialContext },
        },
      ],
    };

    await this.workflowStore.create(workflow);

    this.emit('workflow:created', { workflowId: workflow.id, agentName });

    // Start execution
    return this.executeWorkflow(workflow.id);
  }

  /**
   * Execute workflow until completion or human task
   */
  async executeWorkflow(workflowId: string): Promise<Workflow> {
    const workflow = await this.workflowStore.get(workflowId);
    if (!workflow) {
      throw new Error(`Workflow ${workflowId} not found`);
    }

    const agentIR = this.agentIRs.get(workflow.agentName);
    if (!agentIR) {
      throw new Error(`Agent ${workflow.agentName} not found`);
    }

    // Start trace
    const trace = this.traceStore.startTrace({
      sessionId: workflow.sessionId,
      agentName: workflow.agentName,
      agentVersion: workflow.agentVersion,
      environment: this.config.environment,
    });

    try {
      // Update status to running
      await this.updateWorkflow(workflowId, { status: 'running' });
      workflow.status = 'running';

      // Execute steps until we hit a human task or completion
      while (workflow.status === 'running') {
        const stepResult = await this.executeStep(workflow, agentIR, trace);

        // Update workflow state
        workflow.state.stepResults[workflow.currentStep] = stepResult;
        workflow.history.push({
          timestamp: new Date(),
          step: workflow.currentStep,
          action: 'step_executed',
          details: stepResult,
        });

        if (stepResult.requiresHuman) {
          // Create human task and pause
          const humanTask = await this.createHumanTask(workflow, stepResult);
          workflow.pendingHumanTask = humanTask;
          workflow.status = 'awaiting_human';

          await this.updateWorkflow(workflowId, {
            status: 'awaiting_human',
            pendingHumanTask: humanTask,
            state: workflow.state,
            history: workflow.history,
          });

          await trace.emitDecision({
            decisionKind: 'escalation',
            decision: 'Awaiting human input',
            reasoning: stepResult.humanTaskReason || 'Human review required',
            contextSnapshot: workflow.state.context,
          });

          this.emit('workflow:awaiting_human', {
            workflowId,
            taskId: humanTask.id,
            taskType: humanTask.type,
          });

          break;
        }

        if (stepResult.complete) {
          workflow.status = 'completed';
          workflow.completedAt = new Date();

          await this.updateWorkflow(workflowId, {
            status: 'completed',
            completedAt: workflow.completedAt,
            state: workflow.state,
            history: workflow.history,
          });

          this.emit('workflow:completed', { workflowId });
          break;
        }

        if (stepResult.nextStep) {
          workflow.currentStep = stepResult.nextStep;
        } else {
          // No next step and not complete - error
          workflow.status = 'failed';
          workflow.error = 'No next step defined';

          await this.updateWorkflow(workflowId, {
            status: 'failed',
            error: workflow.error,
            history: workflow.history,
          });

          this.emit('workflow:failed', { workflowId, error: workflow.error });
          break;
        }
      }

      return workflow;
    } catch (error) {
      workflow.status = 'failed';
      workflow.error = error instanceof Error ? error.message : 'Unknown error';

      await this.updateWorkflow(workflowId, {
        status: 'failed',
        error: workflow.error,
      });

      await trace.logError(
        'workflow_error',
        workflow.error,
        error instanceof Error ? error.stack : undefined,
      );

      this.emit('workflow:failed', { workflowId, error: workflow.error });

      return workflow;
    } finally {
      await trace.end();
    }
  }

  /**
   * Resume workflow after human response
   */
  async resumeAfterHuman(workflowId: string, response: HumanResponse): Promise<Workflow> {
    const workflow = await this.workflowStore.get(workflowId);
    if (!workflow) {
      throw new Error(`Workflow ${workflowId} not found`);
    }

    if (workflow.status !== 'awaiting_human') {
      throw new Error(`Workflow ${workflowId} is not awaiting human input`);
    }

    // Store human response
    workflow.state.humanResponses[response.taskId] = response;

    // Merge response fields into context
    this.log.info('Merging human response fields into workflow context', {
      workflowId,
      fields: Object.keys(response.fields),
    });
    Object.assign(workflow.state.context, response.fields);

    // Add to history
    workflow.history.push({
      timestamp: new Date(),
      step: workflow.currentStep,
      action: 'human_responded',
      details: {
        taskId: response.taskId,
        respondedBy: response.respondedBy,
        approved: response.approved,
      },
    });

    // Mark human task as complete
    await this.humanTaskStore.complete(response.taskId, response);

    // Clear pending task
    workflow.pendingHumanTask = undefined;

    // Audit log
    await this.auditStore.log({
      eventType: 'human.completed',
      actor: response.respondedBy,
      actorType: 'admin',
      resourceType: 'session',
      resourceId: workflow.sessionId,
      environment: this.config.environment,
      action: `Human task completed: ${response.approved ? 'approved' : 'other'}`,
      metadata: { workflowId, taskId: response.taskId },
    });

    // Update workflow
    await this.updateWorkflow(workflowId, {
      status: 'running',
      pendingHumanTask: undefined,
      state: workflow.state,
      history: workflow.history,
    });

    // Continue execution
    return this.executeWorkflow(workflowId);
  }

  /**
   * Cancel a workflow
   */
  async cancelWorkflow(workflowId: string, reason: string, cancelledBy: string): Promise<void> {
    const workflow = await this.workflowStore.get(workflowId);
    if (!workflow) {
      throw new Error(`Workflow ${workflowId} not found`);
    }

    // Cancel any pending human tasks
    if (workflow.pendingHumanTask) {
      await this.humanTaskStore.update(workflow.pendingHumanTask.id, {
        status: 'escalated',
      });
    }

    workflow.status = 'cancelled';
    workflow.error = reason;
    workflow.history.push({
      timestamp: new Date(),
      step: workflow.currentStep,
      action: 'workflow_cancelled',
      details: { reason, cancelledBy },
    });

    await this.updateWorkflow(workflowId, {
      status: 'cancelled',
      error: reason,
      history: workflow.history,
    });

    this.emit('workflow:cancelled', { workflowId, reason });
  }

  /**
   * Get workflow status
   */
  async getWorkflowStatus(workflowId: string): Promise<{
    workflow: Workflow;
    pendingTask?: HumanTask;
  }> {
    const workflow = await this.workflowStore.get(workflowId);
    if (!workflow) {
      throw new Error(`Workflow ${workflowId} not found`);
    }

    let pendingTask: HumanTask | undefined;
    if (workflow.pendingHumanTask) {
      const task = await this.humanTaskStore.get(workflow.pendingHumanTask.id);
      pendingTask = task ?? undefined;
    }

    return { workflow, pendingTask };
  }

  // ==========================================================================
  // PRIVATE METHODS
  // ==========================================================================

  /**
   * Build execution context for ConstructExecutor, with workflow-specific
   * state management (workflowStates map) and context syncing.
   */
  private buildWorkflowExecutionContext(
    workflow: Workflow,
    agentIR: AgentIR,
    trace: TraceContextManager,
    userInput?: string,
  ): ExecutionContext {
    // Get or create agent state for this workflow
    let agentState = this.workflowStates.get(workflow.id);
    if (!agentState) {
      agentState = createInitialState(workflow.state.context);
      this.workflowStates.set(workflow.id, agentState);
    }

    // Sync workflow state context to agent state
    agentState.context = { ...agentState.context, ...workflow.state.context };

    // Delegate to base class for building the standard ExecutionContext
    return super.buildExecutionContext({
      sessionId: workflow.sessionId,
      agentIR,
      state: agentState,
      runtimeType: 'workflow',
      trace,
      userInput,
      extraConfig: {},
    });
  }

  /**
   * Handle ConstructAction result and convert to StepResult
   */
  private handleConstructAction(
    action: ConstructAction,
    workflow: Workflow,
    agentState: AgentState,
  ): StepResult {
    switch (action.type) {
      case 'continue':
        // Merge any data into context
        if (action.data) {
          this.log.info('Merging action data into workflow context (continue)', {
            workflowId: workflow.id,
            keys: Object.keys(action.data),
          });
          Object.assign(workflow.state.context, action.data);
        }
        return { nextStep: workflow.currentStep };

      case 'respond':
        return { message: action.message };

      case 'complete':
        return {
          complete: true,
          message: action.message,
        };

      case 'escalate':
        return {
          requiresHuman: true,
          humanTaskType: 'escalation',
          humanTaskReason: action.reason,
          humanTaskPriority: action.priority,
        };

      case 'handoff':
        // For workflow, handoff creates a human task for target agent coordination
        return {
          requiresHuman: true,
          humanTaskType: 'review',
          humanTaskReason: `Handoff to ${action.target}: ${action.summary || 'Agent coordination required'}`,
          humanTaskPriority: 'medium',
        };

      case 'delegate':
        // For workflow, delegate to sub-agent
        // Store delegate info in context for processing
        this.log.info('Storing delegate info in workflow context', {
          workflowId: workflow.id,
          agent: action.agent,
        });
        Object.assign(workflow.state.context, {
          _pendingDelegate: {
            agent: action.agent,
            input: action.input,
            useResult: action.useResult,
          },
        });
        return { nextStep: workflow.currentStep };

      case 'block':
        return {
          requiresHuman: true,
          humanTaskType: 'review',
          humanTaskReason: `Blocked: ${action.reason}`,
          humanTaskPriority: 'high',
        };

      case 'collect':
        return {
          requiresHuman: true,
          humanTaskType: 'data_entry',
          humanTaskReason: `Need to collect: ${action.fields.join(', ')}`,
          humanTaskFields: action.fields.map((field) => ({
            name: field,
            type: 'text' as const,
            label: action.prompts[field] || field,
            required: true,
          })),
        };

      case 'retry':
        // For workflow, retry means re-execute after delay
        return { nextStep: workflow.currentStep };

      default:
        return {};
    }
  }

  /**
   * Execute a single workflow step using ConstructExecutor
   */
  private async executeStep(
    workflow: Workflow,
    agentIR: AgentIR,
    trace: TraceContextManager,
  ): Promise<StepResult> {
    // Build execution context
    const context = this.buildWorkflowExecutionContext(workflow, agentIR, trace);

    // Get step definition from flow
    const stepDef = agentIR.flow?.definitions[workflow.currentStep];

    if (!stepDef) {
      // No step definition - use ConstructExecutor for completion/escalation checks
      const executionResult = await this.constructExecutor.execute(context, {
        only: ['completion', 'escalation', 'handoffs'],
        stopOnAction: true,
      });

      // Update workflow state from construct execution
      this.workflowStates.set(workflow.id, executionResult.state);
      this.log.info('Syncing construct execution state into workflow context', {
        workflowId: workflow.id,
        keys: Object.keys(executionResult.state.context),
      });
      Object.assign(workflow.state.context, executionResult.state.context);

      // Convert ConstructAction to StepResult
      if (executionResult.action.type !== 'continue') {
        return this.handleConstructAction(executionResult.action, workflow, executionResult.state);
      }

      // No step definition and no completion - use default logic
      return { complete: true };
    }

    // Execute step actions
    const result: StepResult = {};

    // GATHER - Check for missing fields that require human input
    if (stepDef.gather?.fields && stepDef.gather.fields.length > 0) {
      for (const field of stepDef.gather.fields) {
        const isRequired = field.required !== false;
        if (
          isRequired &&
          (workflow.state.context[field.name] === undefined ||
            workflow.state.context[field.name] === null)
        ) {
          result.requiresHuman = true;
          result.humanTaskType = 'data_entry';
          result.humanTaskReason = `Need to collect: ${field.name}`;
          result.humanTaskFields = [
            {
              name: field.name,
              type: 'text',
              label: field.prompt || `Please provide ${field.name}`,
              required: true,
            },
          ];
          return result;
        }
      }
    }

    // CALL (tool execution with approval for side effects)
    if (stepDef.call) {
      // For workflow runtime, tool calls that affect state might need approval
      const toolResult = await this.executeToolWithApproval(stepDef.call, workflow, agentIR, trace);

      if (toolResult.requiresApproval) {
        result.requiresHuman = true;
        result.humanTaskType = 'approval';
        result.humanTaskReason = `Approve action: ${stepDef.call}`;
        return result;
      }

      result.toolResult = toolResult.result;
      this.log.info('Storing tool call result in workflow context', {
        workflowId: workflow.id,
        tool: stepDef.call,
      });
      Object.assign(workflow.state.context, { [stepDef.call]: toolResult.result });
    }

    // CHECK (condition)
    if (stepDef.check) {
      const checkPassed = this.evaluateCondition(stepDef.check, workflow.state.context);
      if (!checkPassed && stepDef.on_fail) {
        result.nextStep = stepDef.on_fail;
        return result;
      }
    }

    // Run constraints check via ConstructExecutor (if available)
    if (!this.constructExecutor.executeConstraints) {
      return result;
    }
    const constraintResult = await this.constructExecutor.executeConstraints(context);
    if (constraintResult.action.type !== 'continue') {
      // Constraint violation - handle appropriately
      this.workflowStates.set(workflow.id, { ...context.state, ...constraintResult.stateUpdates });
      return this.handleConstructAction(constraintResult.action, workflow, context.state);
    }

    // THEN (next step)
    if (stepDef.then) {
      if (stepDef.then.toUpperCase() === 'COMPLETE') {
        result.complete = true;
        result.message = stepDef.respond;
      } else {
        result.nextStep = stepDef.then;
      }
    }

    // Update agent state
    this.workflowStates.set(workflow.id, context.state);

    return result;
  }

  /**
   * Execute tool with potential approval requirement
   */
  private async executeToolWithApproval(
    toolCall: string,
    workflow: Workflow,
    agentIR: AgentIR,
    trace: TraceContextManager,
  ): Promise<{ result?: unknown; requiresApproval?: boolean }> {
    // Parse tool call
    const match = toolCall.match(/(\w+)\(([^)]*)\)/);
    if (!match) {
      return { result: { error: 'Invalid tool call format' } };
    }

    const [, toolName, paramsStr] = match;

    // Find tool definition
    const toolDef = agentIR.tools.find((t) => t.name === toolName);
    if (!toolDef) {
      return { result: { error: `Tool ${toolName} not found` } };
    }

    // Check if tool has side effects - require approval for workflow
    if (toolDef.hints.side_effects) {
      return { requiresApproval: true };
    }

    // Execute tool (simplified - would need actual tool executor)
    await trace.logToolCall({
      toolName,
      input: { raw: paramsStr },
      output: { status: 'executed' },
      latencyMs: 0,
      success: true,
    });

    return { result: { status: 'executed' } };
  }

  /**
   * Create a human task
   */
  private async createHumanTask(workflow: Workflow, stepResult: StepResult): Promise<HumanTask> {
    const task: HumanTask = {
      id: randomUUID(),
      workflowId: workflow.id,
      type: stepResult.humanTaskType || 'review',
      title: `${workflow.agentName} - ${workflow.currentStep}`,
      description: stepResult.humanTaskReason || 'Review required',
      priority: stepResult.humanTaskPriority || 'medium',
      status: 'pending',
      createdAt: new Date(),
      dueAt: new Date(Date.now() + (this.config as WorkflowRuntimeConfig).humanTaskTimeoutMs),
      context: workflow.state.context,
      requiredFields: stepResult.humanTaskFields || [],
      escalationChain: ['default'],
      currentEscalationLevel: 0,
    };

    await this.humanTaskStore.create(task);

    // Audit log
    await this.auditStore.log({
      eventType: 'human.intervention',
      actor: workflow.agentName,
      actorType: 'agent',
      resourceType: 'session',
      resourceId: workflow.sessionId,
      environment: this.config.environment,
      action: `Human task created: ${task.type}`,
      metadata: { workflowId: workflow.id, taskId: task.id },
    });

    return task;
  }

  /**
   * Check for timed out human tasks
   */
  private async checkPendingTasks(): Promise<void> {
    try {
      const pendingWorkflows = await this.workflowStore.listAwaitingHuman();

      for (const workflow of pendingWorkflows) {
        if (!workflow.pendingHumanTask) continue;

        const task = await this.humanTaskStore.get(workflow.pendingHumanTask.id);
        if (!task) continue;

        // Check timeout
        if (new Date() > task.dueAt) {
          // Escalate or timeout
          if (task.currentEscalationLevel < task.escalationChain.length - 1) {
            // Escalate to next level
            task.currentEscalationLevel++;
            task.dueAt = new Date(
              Date.now() + (this.config as WorkflowRuntimeConfig).humanTaskTimeoutMs,
            );
            task.priority = 'high';

            await this.humanTaskStore.update(task.id, {
              currentEscalationLevel: task.currentEscalationLevel,
              dueAt: task.dueAt,
              priority: task.priority,
              status: 'escalated',
            });

            this.emit('task:escalated', {
              taskId: task.id,
              workflowId: workflow.id,
              level: task.currentEscalationLevel,
            });
          } else {
            // Final timeout
            await this.humanTaskStore.update(task.id, { status: 'timeout' });

            await this.updateWorkflow(workflow.id, {
              status: 'timeout',
              error: 'Human task timed out',
            });

            this.emit('workflow:timeout', {
              workflowId: workflow.id,
              taskId: task.id,
            });
          }
        }
      }
    } catch (error) {
      this.log.error('Error checking pending tasks', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async updateWorkflow(workflowId: string, updates: Partial<Workflow>): Promise<void> {
    await this.workflowStore.update(workflowId, {
      ...updates,
      updatedAt: new Date(),
    });
  }

  private evaluateCondition(condition: string, context: Record<string, unknown>): boolean {
    return evaluateConditionShared(condition, context);
  }
}

interface StepResult {
  complete?: boolean;
  message?: string;
  nextStep?: string;
  toolResult?: unknown;
  requiresHuman?: boolean;
  humanTaskType?: HumanTaskType;
  humanTaskReason?: string;
  humanTaskPriority?: 'low' | 'medium' | 'high' | 'critical';
  humanTaskFields?: HumanTaskField[];
  // Index signature for compatibility with Record<string, unknown>
  [key: string]: unknown;
}

// =============================================================================
// IN-MEMORY STORES (for development)
// =============================================================================

export class InMemoryWorkflowStore implements WorkflowStore {
  private workflows: Map<string, Workflow> = new Map();

  async create(workflow: Workflow): Promise<void> {
    this.workflows.set(workflow.id, workflow);
  }

  async get(workflowId: string): Promise<Workflow | null> {
    return this.workflows.get(workflowId) || null;
  }

  async update(workflowId: string, updates: Partial<Workflow>): Promise<void> {
    const workflow = this.workflows.get(workflowId);
    if (workflow) {
      Object.assign(workflow, updates);
    }
  }

  async listByCustomer(customerId: string, status?: WorkflowStatus): Promise<Workflow[]> {
    return Array.from(this.workflows.values()).filter(
      (w) => w.customerId === customerId && (!status || w.status === status),
    );
  }

  async listByStatus(status: WorkflowStatus, limit = 100): Promise<Workflow[]> {
    return Array.from(this.workflows.values())
      .filter((w) => w.status === status)
      .slice(0, limit);
  }

  async listAwaitingHuman(): Promise<Workflow[]> {
    return Array.from(this.workflows.values()).filter((w) => w.status === 'awaiting_human');
  }
}

export class InMemoryHumanTaskStore implements HumanTaskStore {
  private tasks: Map<string, HumanTask> = new Map();

  async create(task: HumanTask): Promise<void> {
    this.tasks.set(task.id, task);
  }

  async get(taskId: string): Promise<HumanTask | null> {
    return this.tasks.get(taskId) || null;
  }

  async update(taskId: string, updates: Partial<HumanTask>): Promise<void> {
    const task = this.tasks.get(taskId);
    if (task) {
      Object.assign(task, updates);
    }
  }

  async assign(taskId: string, assignedTo: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (task) {
      task.assignedTo = assignedTo;
      task.assignedAt = new Date();
      task.status = 'assigned';
    }
  }

  async complete(taskId: string, response: HumanResponse): Promise<void> {
    const task = this.tasks.get(taskId);
    if (task) {
      task.response = response;
      task.completedAt = new Date();
      task.status = 'completed';
    }
  }

  async listPending(assignedTo?: string): Promise<HumanTask[]> {
    return Array.from(this.tasks.values()).filter(
      (t) => t.status === 'pending' && (!assignedTo || t.assignedTo === assignedTo),
    );
  }

  async listByWorkflow(workflowId: string): Promise<HumanTask[]> {
    return Array.from(this.tasks.values()).filter((t) => t.workflowId === workflowId);
  }
}

// =============================================================================
// FACTORY
// =============================================================================

export function createWorkflowRuntime(
  config: WorkflowRuntimeConfig,
  conversationStore: ConversationStore,
  messageStore: MessageStore,
  traceStore: TraceProvider,
  auditStore: AuditStore,
  factStore: FactStore,
  workflowStore: WorkflowStore,
  humanTaskStore: HumanTaskStore,
  llmClient: LLMClient,
  toolExecutor: ToolExecutor,
): WorkflowRuntime {
  return new WorkflowRuntime(
    config,
    conversationStore,
    messageStore,
    traceStore,
    auditStore,
    factStore,
    workflowStore,
    humanTaskStore,
    llmClient,
    toolExecutor,
  );
}
