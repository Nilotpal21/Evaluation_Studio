/**
 * Core type exports for Agent ABL
 */

// Base types
export type {
  ElementId,
  Version,
  DocumentKind,
  DocumentMeta,
  PrimitiveType,
  ComplexType,
  TypeDefinition,
  VariableSource,
  VariableDefinition,
} from './base.js';

export { isPrimitiveType, isComplexType, parseVersion, createDocumentMeta } from './base.js';

// Expression types
export type {
  ComparisonOperator,
  LogicalOperator,
  StringLiteral,
  NumberLiteral,
  BooleanLiteral,
  NullLiteral,
  ArrayLiteral,
  LiteralValue,
  VariableRef,
  FunctionCall,
  BinaryExpression,
  UnaryExpression,
  TemplateString,
  WildcardExpression,
  Expression,
  Condition,
} from './expressions.js';

export {
  varRef,
  str,
  num,
  bool,
  eq,
  and,
  or,
  not,
  exists,
  isWildcard,
  expressionToString,
} from './expressions.js';

// Supervisor types
export type {
  StateSchema,
  AgentRef,
  RouteToAgent,
  RouteToUser,
  RouteToVariable,
  AgentHandoff,
  EndConversation,
  IntentMatchRouting,
  SystemAction,
  RoutingAction,
  IntentMapping,
  RoutingFlag,
  RoutingRule,
  Policy,
  Formality,
  PronounSettings,
  VocabularySettings,
  CommunicationSettings,
  SupervisorBehavior,
  SupervisorDocument,
} from './supervisor.js';

export {
  createSupervisorDocument,
  createRoutingRule,
  routeToAgent,
  intentMatch,
} from './supervisor.js';

// Agent-based types (tool bindings + voice config + behavior profiles)
export type {
  ToolType,
  ToolAuthType,
  HttpBindingAST,
  McpBindingAST,
  LambdaBindingAST,
  SandboxBindingAST,
  ToolImport,
  VoiceConfigAST,
  ConversationBehaviorAST,
  ConversationSpeakingAST,
  ConversationListeningAST,
  ConversationInteractionAST,
  BehaviorProfileAST,
  BehaviorProfileResponseAST,
  BehaviorProfileGatherAST,
  BehaviorProfileFlowAST,
  RichContentAST,
  QuickReplyAST,
  ListTemplateAST,
  ListItemAST,
  MediaContentAST,
  FileContentAST,
  KPITemplateAST,
  TableTemplateAST,
  TableColumnAST,
  ChartTemplateAST,
  ChartDataPointAST,
  FormTemplateAST,
  ProgressTemplateAST,
  FeedbackTemplateAST,
} from './agent-based.js';

// Tool file types
export type { ToolFileDefaults, ToolFileDocument } from './tool-file.js';

// Agent types
export type {
  AgentIdentity,
  AgentContract,
  ToolParameter,
  FailureStrategy,
  ToolErrorHandling,
  ToolDefinition,
  CallToolAction,
  RespondAction,
  WaitInputAction,
  GotoAction,
  ConditionAction,
  SignalType,
  SignalAction,
  SetStateAction,
  ClassifyIntentAction,
  MultiStepAction,
  StepAction,
  Step,
  Flow,
  GuardrailType,
  GuardrailAction,
  Guardrail,
  KnowledgeSettings,
  ReasoningStrategy,
  ReasoningConfig,
  TestCase,
  AgentDocument,
} from './agent.js';

export {
  createAgentDocument,
  createStep,
  respond,
  callTool,
  signal,
  waitInput,
  goto,
  setState,
  classify,
} from './agent.js';
