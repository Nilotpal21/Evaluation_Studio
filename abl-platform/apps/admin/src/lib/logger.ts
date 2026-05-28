// Import from the dedicated logger subpath rather than the platform barrel
// (`@abl/compiler/platform`). The barrel re-exports the entire compiler tree,
// which forces webpack to bundle `http-tool-executor.js` and chase its
// `@agent-platform/shared-kernel/security/safe-fetch` import — that subpath
// fails to resolve through pnpm workspace symlinks during admin's webpack
// build. Importing the logger module directly keeps webpack's traversal
// scoped to logger.js + its primitives.
export { createLogger } from '@abl/compiler/platform/logger.js';
export type { Logger } from '@abl/compiler/platform/logger.js';
