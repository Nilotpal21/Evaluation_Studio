/**
 * Pipeline run-error interpreter.
 *
 * Maps known server-side error strings produced by Restate activity handlers
 * into a plain-English diagnosis and an optional remediation action.
 *
 * Usage: call `interpretRunError(errorString)` in StepsList to surface a
 * human-readable diagnosis + "Open in editor" / "Re-drive" buttons.
 */

export type RunErrorAction = 'open-in-editor' | 'redrive';

export interface RunErrorInterpretation {
  /** One-sentence plain-English explanation of what went wrong. */
  diagnosis: string;
  /** Primary remediation action to offer as a button. */
  action?: RunErrorAction;
  /** Optional short label for the action button. Defaults to a sensible string if omitted. */
  actionLabel?: string;
}

interface CatalogEntry {
  match: RegExp;
  diagnosis: (m: RegExpExecArray) => string;
  action?: RunErrorAction;
  actionLabel?: string;
}

/**
 * Ordered catalog of known error patterns.
 * Entries are matched top-to-bottom; the first match wins.
 */
const CATALOG: CatalogEntry[] = [
  // read-message-window used with a trigger that doesn't provide payload
  {
    match: /ReadMessageWindow requires payload in pipelineInput/i,
    diagnosis: () =>
      'This node requires a per-message trigger (user-message or agent-message) but the pipeline is using a session-level trigger (e.g. session-ended) that does not emit a message payload. Change the first node to read-conversation, or change the trigger.',
    action: 'open-in-editor',
    actionLabel: 'Fix in editor',
  },

  // read-conversation / read-message-window missing sessionId
  {
    match:
      /(ReadConversation|ReadMessageWindow|read-conversation|read-message-window) requires sessionId/i,
    diagnosis: (m) =>
      `${m[1]} could not find a sessionId in the pipeline input. Ensure the trigger provides sessionId (all Kafka triggers do), or check the trigger configuration.`,
    action: 'open-in-editor',
  },

  // ClickHouse table name format
  {
    match: /Invalid table name: (.+)/i,
    diagnosis: (m) =>
      `"${m[1]}" is not a valid ClickHouse table name — it must use the format database.table (e.g. abl_platform.my_table). Update the store-results destination field.`,
    action: 'open-in-editor',
    actionLabel: 'Fix destination',
  },

  // MongoDB collection missing
  {
    match: /MongoDB destination requires ['"]?(collection|table)['"]?/i,
    diagnosis: () =>
      'The store-results node is set to MongoDB destination but has no collection name. Set the table field to a valid MongoDB collection name.',
    action: 'open-in-editor',
  },

  // Callback URL missing
  {
    match: /[Cc]allback destination requires callbackUrl/i,
    diagnosis: () =>
      'The store-results node is set to Callback destination but has no callback URL configured.',
    action: 'open-in-editor',
  },

  // LLM / model credential errors
  {
    match: /credential[s]? (not found|missing|invalid|expired)/i,
    diagnosis: () =>
      "A required LLM or API credential is missing or invalid. Check the project's LLM provider settings.",
    action: 'open-in-editor',
  },

  // Rate-limit from LLM provider
  {
    match: /rate.?limit|quota exceeded|429/i,
    diagnosis: () =>
      'The LLM provider returned a rate-limit error. The pipeline will retry automatically; if the issue persists, check your provider quota.',
    action: 'redrive',
    actionLabel: 'Re-drive',
  },

  // Timeout
  {
    match: /timed? ?out|timeout/i,
    diagnosis: () =>
      'The step exceeded its configured timeout. Consider increasing the node timeout in the editor, or reduce the size of the input.',
    action: 'open-in-editor',
  },

  // ClickHouse connection
  {
    match: /ClickHouse|clickhouse.*(connect|unavailable|refused)/i,
    diagnosis: () =>
      'Could not connect to ClickHouse. Check the ClickHouse service health and credentials.',
  },

  // filter/aggregate/transform input missing
  {
    match: /requires ['"]?(source|expression|operations)['"]?/i,
    diagnosis: (m) =>
      `This node requires a "${m[1]}" config field that is not set. Open the node in the editor to configure it.`,
    action: 'open-in-editor',
  },
];

/**
 * Try to interpret a run-step error string.
 * Returns a structured interpretation if a known pattern matches,
 * or `null` if the error does not match anything in the catalog.
 */
export function interpretRunError(error: string): RunErrorInterpretation | null {
  for (const entry of CATALOG) {
    const m = entry.match.exec(error);
    if (m) {
      return {
        diagnosis: entry.diagnosis(m),
        action: entry.action,
        actionLabel: entry.actionLabel,
      };
    }
  }
  return null;
}
