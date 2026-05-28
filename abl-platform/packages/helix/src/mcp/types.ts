import type { SessionState } from '../types.js';

export const SESSION_STATES: [SessionState, ...SessionState[]] = [
  'initializing',
  'scanning',
  'analyzing',
  'planning',
  'awaiting-approval',
  'executing',
  'reviewing',
  'awaiting-input',
  'committing',
  'completed',
  'failed',
  'paused',
];
