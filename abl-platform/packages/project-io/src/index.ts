/**
 * @agent-platform/project-io
 *
 * Project export/import, dependency management, ownership, and git integration.
 */

export * from './types.js';
export * from './agent-companion-metadata.js';
export * from './diff/index.js';
export * from './dependencies/index.js';
export * from './export/index.js';
export * from './import/index.js';
export * from './behavior-profile-files.js';
export * from './behavior-profile-documents.js';
export * from './behavior-profile-validation.js';
export * from './locale-files.js';
export * from './prompt-library-io.js';
export * from './ownership/index.js';
export * from './git/index.js';
export * from './module-release/index.js';
export * from './project-agent-export-readiness.js';
export * from './project-agent-draft-metadata.js';
export {
  rewriteProjectAgentDraftDeclaredName,
  validateProjectAgentDraftDeclaredName,
} from './project-agent-draft-metadata.js';
