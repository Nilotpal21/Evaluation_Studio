/**
 * Event schema registry - imports all event schemas.
 *
 * Importing this file registers all event types with the EventRegistry.
 * The side-effect of importing each *-events.ts file is that it calls
 * eventRegistry.register() for each event type.
 */

// Import order doesn't matter - each file registers its own events
import './session-events.js';
import './billing-events.js';
import './llm-events.js';
import './tool-events.js';
import './agent-events.js';
import './gather-events.js';
import './flow-events.js';
import './channel-events.js';
import './attachment-events.js';
import './deployment-events.js';
import './search-events.js';
import './voice-events.js';
import './auth-events.js';
import './evaluation-events.js';
import './message-events.js';
import './feedback-events.js';
import './system-events.js';

// Re-export all types for consumers
export type * from './session-events.js';
export type * from './billing-events.js';
export type * from './llm-events.js';
export type * from './tool-events.js';
export type * from './agent-events.js';
export type * from './gather-events.js';
export type * from './flow-events.js';
export type * from './channel-events.js';
export type * from './attachment-events.js';
export type * from './deployment-events.js';
export type * from './search-events.js';
export type * from './voice-events.js';
export type * from './auth-events.js';
export type * from './evaluation-events.js';
export type * from './message-events.js';
export type * from './feedback-events.js';
export type * from './system-events.js';

// Workflow + human-task events use explicit-registration (not side-effect) —
// export both schemas and the register fns so runtime can wire them.
export {
  WorkflowExecutionEventSchema,
  WorkflowExecutionEventTypeSchema,
  type WorkflowExecutionEvent,
  type WorkflowExecutionEventType,
  registerWorkflowExecutionEvents,
} from './workflow-execution-events.js';
export {
  HumanTaskEventSchema,
  HumanTaskEventTypeSchema,
  type HumanTaskEvent,
  type HumanTaskEventType,
  registerHumanTaskEvents,
} from './human-task-events.js';
