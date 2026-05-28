/**
 * Compiler types
 */

import type {
  CompilationOutput as IRCompilationOutput,
  AgentIR,
  SupervisorIR,
  VoiceConfigIR,
  RichContentIR,
  ActionSetIR,
  ActionElementIR,
  ActionHandlerIR,
  ActionHandlerActionIR,
  CarouselIR,
  CarouselCardIR,
} from './platform/ir/schema.js';

/**
 * Re-export IR types for external use
 */
export type {
  IRCompilationOutput,
  AgentIR,
  SupervisorIR,
  VoiceConfigIR,
  RichContentIR,
  ActionSetIR,
  ActionElementIR,
  ActionHandlerIR,
  ActionHandlerActionIR,
  CarouselIR,
  CarouselCardIR,
};
