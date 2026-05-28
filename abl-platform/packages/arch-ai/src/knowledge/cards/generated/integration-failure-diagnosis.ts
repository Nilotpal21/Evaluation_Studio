// L2 knowledge card — Integration Failure Diagnosis.
// Loaded when the user reports a failing agent or tool, or surfaces an
// HTTP error status (401/403/429/5xx). Walks the AI through the standard
// trace → list → revalidate → fix → test chain.
// Token estimate: ~600 (~4 chars/token, content length ~2400 chars).

export const INTEGRATION_FAILURE_DIAGNOSIS_CARD = `## Integration Failure Diagnosis

When the user reports a failing agent or tool, follow this chain:

### 1. Pull recent traces
\`query_traces({ projectId, limit: 20, sinceMinutesAgo: 60 })\`

### 2. Identify the failing tool
Look at tool_call entries with non-2xx status. Note toolId and error class.

### 3. List active integrations
\`integration_ops:list({ projectId, includeStatuses: ['complete', 'failed'] })\`

### 4. Revalidate
\`integration_ops:revalidate({ draftId })\` — returns \`changes[]\` with \`change: 'unchanged' | 'updated_externally' | 'deleted_externally' | 'newly_invalid'\`.

### 5. Propose fix
- 'newly_invalid' on oauth2_token → re-run OAuthLaunch
- 'deleted_externally' on tool/profile → ask user to recreate
- 'updated_externally' → usually fine, inform user

### 6. Test after fix
\`tools_ops:test({ toolId, sampleInput })\`. Sanitize errors.

### Avoid
- Don't manually refresh tokens (refresh is reactive at runtime).
- Don't delete the draft on transient 5xx — wait for user input.
- Don't recreate from scratch when revalidation shows unchanged — likely a provider outage.`;
