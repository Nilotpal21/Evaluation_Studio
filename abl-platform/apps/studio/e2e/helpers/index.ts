/**
 * Shared E2E test helpers -- barrel export.
 *
 * @e2e-real -- This entire helpers/ directory is for real E2E tests.
 * No vi.mock, no jest.mock, no stubbed servers. Everything hits real endpoints.
 *
 * To verify: `grep -r "vi\.mock\|jest\.mock" e2e/helpers/` should return 0 results.
 */

export { env } from './env';
export type { E2EEnv } from './env';
export {
  loginAndNavigateToProject,
  loginViaDevApi,
  getToken,
  getDevAccessToken,
  extractProjectId,
  isIsolatedTestLoginEmail,
} from './auth';
export type { AuthContext } from './auth';
export type { ArchE2EPrerequisites } from './arch';
export { checkArchConversationPrerequisites } from './arch';
export {
  apiPost,
  apiGet,
  apiPut,
  apiPatch,
  apiDelete,
  uploadFile,
  detectFeatureState,
} from './api';
export { screenshot, waitForIdle, waitForRendered, navigateToSection, pollUntil } from './ui';
export type { TestState } from './state';
export { saveState, loadState, clearState } from './state';
export type { Bug } from './bug-report';
export { logBug, getBugReport, writeBugReport, getBugCount } from './bug-report';
export type { SeededWorkflow, SeedWorkflowOptions } from './workflow-seed';
export {
  seedWorkflowWithWebhook,
  seedCronOnlyWorkflow,
  deleteSeededWorkflow,
} from './workflow-seed';
