/**
 * Semver descending comparator for Studio UI version lists.
 *
 * Re-exports the canonical `compareSemverDesc` from
 * `@agent-platform/shared-kernel` under the existing
 * `compareSemverDescLocal` name, so Studio UI code stays in lockstep with
 * runtime/engine resolution (GAP-007). The shared-kernel implementation is
 * zero-dep, handles pre-release identifiers per semver spec §11, and orders
 * invalid strings between valid semvers and the literal `'draft'` sentinel.
 *
 * The `Local` suffix is kept for import-compatibility with existing call
 * sites (`WorkflowDetailPage`, `WorkflowConfigForm`); new code should prefer
 * `compareSemverDesc` from shared-kernel directly.
 */

import { compareSemverDesc } from '@agent-platform/shared-kernel';

export { compareSemverDesc as compareSemverDescLocal };
