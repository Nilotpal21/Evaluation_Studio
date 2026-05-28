/**
 * Architect Module
 *
 * Re-exports all architect functionality for use case analysis,
 * ABL generation, and project scaffolding.
 */

export * from './types.js';
export * from './gaps.js';
export { analyzeUseCase } from './analyze.js';
export { generateABL, generateSingleAgentABL } from './generate.js';
export { scaffoldProject, scaffoldDocs } from './scaffold.js';
