/**
 * Azure Document Intelligence — PieceAuth.CustomAuth definition.
 *
 * Tenant-resource binding only: endpoint + apiKey + apiVersion. The prebuilt
 * model is selected per-action (`extract_document.props.model`) — each step
 * picks what fits the document, the auth profile presumes nothing.
 *
 * The `validate` hook performs a live `info` GET against the supplied
 * endpoint via `safeFetch` (DNS-pinned — the endpoint hostname is
 * tenant-supplied, so SSRF + DNS-rebinding protections must apply per
 * LLD §1 D-8).
 */

import { PieceAuth, Property } from '@activepieces/pieces-framework';
import { safeFetch } from './safe-fetch';

const DEFAULT_API_VERSION = '2024-11-30';

export const azureDocumentIntelligenceAuth = PieceAuth.CustomAuth({
  description: 'Azure Document Intelligence resource credentials',
  required: true,
  props: {
    endpoint: Property.ShortText({
      displayName: 'Endpoint',
      description:
        'Azure DI endpoint, e.g. https://<resource>.cognitiveservices.azure.com (no trailing slash).',
      required: true,
    }),
    apiKey: PieceAuth.SecretText({
      displayName: 'API Key',
      description: 'Subscription key for the Azure DI resource.',
      required: true,
    }),
    apiVersion: Property.ShortText({
      displayName: 'API Version',
      description: `Azure DI REST API version. Defaults to ${DEFAULT_API_VERSION}.`,
      required: false,
      defaultValue: DEFAULT_API_VERSION,
    }),
  },
  validate: async ({ auth }) => {
    const endpoint = (auth as { endpoint?: string }).endpoint;
    const apiKey = (auth as { apiKey?: string }).apiKey;
    const apiVersion = (auth as { apiVersion?: string }).apiVersion ?? DEFAULT_API_VERSION;
    if (!endpoint || !apiKey) {
      return { valid: false, error: 'Endpoint and API key are required.' };
    }
    let trimmed: string;
    try {
      // Reject obviously malformed endpoints up-front (e.g. missing scheme,
      // free text) so the user sees a clear message instead of a generic
      // "Invalid URL" from fetch.
      const parsed = new URL(endpoint);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return {
          valid: false,
          error: `Endpoint must use http:// or https:// (got ${parsed.protocol}).`,
        };
      }
      trimmed = endpoint.replace(/\/+$/, '');
    } catch {
      return {
        valid: false,
        error:
          'Endpoint is not a valid URL. Expected https://<resource>.cognitiveservices.azure.com (no trailing slash).',
      };
    }

    // Explicit timeout so a hanging endpoint doesn't pin the save handler
    // until the request layer's default fires (typically 30s+).
    const PROBE_TIMEOUT_MS = 10_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const resp = await safeFetch(
        `${trimmed}/documentintelligence/info?api-version=${encodeURIComponent(apiVersion)}`,
        {
          method: 'GET',
          headers: { 'Ocp-Apim-Subscription-Key': apiKey },
          signal: controller.signal,
        },
      );
      if (!resp.ok) {
        // Pull a short snippet of the response so the user sees Azure's own
        // explanation alongside the status code (e.g. "Access denied due to
        // invalid subscription key"). Bound the snippet so a chatty 5xx
        // doesn't blow up the audit log.
        let detail = '';
        try {
          const text = await resp.text();
          detail = text.length > 500 ? `${text.slice(0, 500)}…` : text;
        } catch {
          // Body read failed — fall back to status alone.
        }
        const summary =
          resp.status === 401 || resp.status === 403
            ? `Azure DI rejected the credentials (HTTP ${resp.status}). Check that the subscription key matches the endpoint region.`
            : resp.status === 404
              ? `Azure DI endpoint ${trimmed} did not resolve to a Document Intelligence resource (HTTP 404). Verify the endpoint URL.`
              : resp.status >= 500
                ? `Azure DI service error (HTTP ${resp.status}) — transient outage upstream. Retry in a moment.`
                : `Azure DI returned HTTP ${resp.status}. Check endpoint + apiKey.`;
        return {
          valid: false,
          error: detail ? `${summary} — ${detail}` : summary,
        };
      }
      return { valid: true };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return {
          valid: false,
          error: `Azure DI probe timed out after ${PROBE_TIMEOUT_MS / 1000}s. Endpoint may be unreachable or the region is offline.`,
        };
      }
      if (err instanceof Error && err.name === 'SSRFError') {
        return {
          valid: false,
          error: `Endpoint blocked by SSRF policy: ${err.message}. Endpoints must be public Azure Cognitive Services hosts.`,
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      // Common low-level codes we can render specifically.
      if (/ENOTFOUND|EAI_AGAIN/.test(message)) {
        return {
          valid: false,
          error: `Endpoint DNS lookup failed (${message}). Verify the hostname.`,
        };
      }
      if (/ECONNREFUSED/.test(message)) {
        return {
          valid: false,
          error: `Endpoint refused the connection (${message}). The host is up but the port is closed.`,
        };
      }
      if (/ECONNRESET|EPIPE/.test(message)) {
        return {
          valid: false,
          error: `Connection to Azure DI was reset (${message}). Likely transient; retry.`,
        };
      }
      return { valid: false, error: `Azure DI auth probe failed: ${message}` };
    } finally {
      clearTimeout(timer);
    }
  },
});
