# Connector Action Output Types

Reference for what each AP connector's `run()` method actually returns.
Used to understand what `sanitizeConnectorOutput` in `step-context-schema.ts` needs to handle.

## AP HttpResponse Shape

`@activepieces/pieces-common` `httpClient.sendRequest()` returns:

```typescript
type HttpResponse<T> = {
  status: number;
  headers?: HttpHeaders;
  body: T; // body, NOT data
};
```

This is **not** an axios response. Axios returns `{ data, status, statusText, headers, config, request }`.
AP's httpClient wraps axios but normalises the shape — the payload is in `.body`, not `.data`.

---

## Category A — Full HttpResponse returned as-is

These actions return the raw `{ status, headers?, body }` envelope.
`headers` may contain upstream `set-cookie`, rate-limit tokens, or other response headers.

| Connector           | Which actions                                                                                                                                                        | How it happens                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **github**          | Most actions: `create-issue`, `create-branch`, `raw-graphql-query`, `create-pull-request-review-comment`, `create-discussion-comment`, `create-commit-comment`, etc. | `githubApiCall()` returns full `HttpResponse`; actions return it directly                                    |
| **salesforce**      | `create-new-object`, `update-object-by-id`, `upsert-by-external-id`, `run-sf-query`                                                                                  | `callSalesforceApi()` / `querySalesforceApi()` return full `HttpResponse`; actions return without extracting |
| **twilio**          | `send-sms`                                                                                                                                                           | `callTwilioApi()` returns full `HttpResponse`; `send-sms` returns it as-is                                   |
| **google-calendar** | `get-events`, `create-quick-event`                                                                                                                                   | Calls `httpClient.sendRequest()` directly and returns the result                                             |
| **discord**         | `send-message-webhook`                                                                                                                                               | Calls `httpClient.sendRequest()` directly and returns the result                                             |
| **hubspot**         | `add-contact-to-workflow`                                                                                                                                            | Returns full httpClient response without extracting `.body`                                                  |

---

## Category B — Body only (`response.body` or `response.data`)

No HTTP envelope. Only the parsed API response body is returned.

| Connector           | Pattern                                        | Notes                                                    |
| ------------------- | ---------------------------------------------- | -------------------------------------------------------- |
| **clickup**         | All actions return `response.body`             | Via `callClickUpApi` helper which extracts body          |
| **pipedrive**       | Most actions                                   | `pipedriveApiCall()` extracts `.body` before returning   |
| **salesforce**      | `create-contact`, `find-record`, `create-lead` | These extract `.body`; contrast with Cat A actions above |
| **twilio**          | `get-message`, `make-call`                     | Extract `.body` unlike `send-sms`                        |
| **airtable**        | Normal (200) path                              | Returns `response.body`; Cat A on non-200 fallback       |
| **asana**           | All actions                                    | Returns `response.body['data']`                          |
| **google-calendar** | Google SDK actions                             | Returns `response.data` (Google SDK shape)               |
| **google-sheets**   | httpClient actions                             | `response.body`; SDK actions return `response.data`      |
| **stripe**          | httpClient actions                             | Returns `response.body`                                  |

---

## Category C — Plain value (string, constructed object, SDK response)

No HTTP envelope at all. Fully safe to store as-is.

| Connector                                             | What it returns                                                                     |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **claude** _(custom `@abl/piece-claude`)_             | Plain `string` — Claude's text response                                             |
| **openai** _(custom `@abl/piece-openai`)_             | Plain `string` — model's text response                                              |
| **jira-cloud** _(custom `@abl/piece-jira-cloud`)_     | `result.body` — attachment array from Jira                                          |
| **google-drive** _(custom `@abl/piece-google-drive`)_ | `result.body` — file metadata from Drive API                                        |
| **slack**                                             | Slack SDK `{ ok, channel, ts, ... }`                                                |
| **notion**                                            | Notion SDK response objects                                                         |
| **microsoft-teams**                                   | Microsoft Graph SDK plain JSON objects                                              |
| **linear**                                            | Constructed `{ success, lastSyncId, issue }`                                        |
| **sendgrid**                                          | Always `{ success: true }` — fire and forget                                        |
| **servicenow**                                        | Zod-parsed `response.body.result` — only the `result` sub-field                     |
| **zendesk**                                           | Constructed `{ success, message, data: response.body }`                             |
| **postgres**                                          | `results.rows` — plain array of row objects                                         |
| **gmail**                                             | Parsed `{ id, subject, attachments, ... }`                                          |
| **amazon-s3**                                         | AWS SDK objects or `{ fileName, url }`                                              |
| **discord**                                           | Most actions: constructed `{ success, ... }` (only `send-message-webhook` is Cat A) |
| **hubspot**                                           | SDK actions: `SimplePublicObjectWithAssociations` and similar SDK objects           |

---

## Implications for `sanitizeConnectorOutput`

The original sanitizer in `step-context-schema.ts` (introduced in PR #797) assumed all connector
outputs are objects and looked for `{ data, status, statusText }` — the axios shape.
This was wrong on two counts:

1. **AP's own HttpResponse uses `.body`, not `.data`** — so Cat A outputs were sanitized
   to `{ status: 200 }` with `data: undefined`, silently dropping the actual payload.
2. **Scalar returns (strings from Claude/OpenAI) were dropped entirely** —
   `if (!raw || typeof raw !== 'object') return undefined` treated every string as empty output.

### Safe detection rule

The only field that is sensitive AND present in both AP HttpResponse and axios responses,
AND absent from all business objects, is `headers` (an object).

```
if output has headers (object field)  → HTTP envelope → sanitize, strip headers
otherwise                             → pass through as-is
```

Business objects with a numeric `status` field (e.g. `{ status: 1, name: "Active" }`) never
also carry a `headers` object — so checking for both prevents false positives.

---

## Custom Pieces — Our URL-Native Overrides

These are actions we replaced in our `@abl/piece-*` packages to accept URL strings
instead of AP's `Property.File` (which expects `{ data: Buffer, filename, extension, base64 }`).

| Connector                 | Action replaced           | Original AP behavior                                              | Our behavior                                                                      |
| ------------------------- | ------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `@abl/piece-claude`       | `ask_claude`              | `Property.File` → download → base64 → Anthropic SDK               | `Property.ShortText` URL → Anthropic `source: { type: 'url', url }` — no download |
| `@abl/piece-claude`       | `extract-structured-data` | `Property.File` → download → base64 → tool call                   | `Property.ShortText` URL → Anthropic URL source                                   |
| `@abl/piece-openai`       | `vision_prompt`           | `Property.File` → download → base64 → OpenAI                      | `Property.ShortText` URL → `image_url: { url }` — native OpenAI URL support       |
| `@abl/piece-jira-cloud`   | `add_issue_attachment`    | `Property.File` → `Buffer.from(base64)` → FormData (2.33× memory) | `Property.ShortText` URL → `fetch` → Buffer → FormData (1× memory)                |
| `@abl/piece-google-drive` | `upload_gdrive_file`      | `Property.File` → `Buffer.from(base64)` → FormData (2.33× memory) | `Property.ShortText` URL → `fetch` → Buffer → FormData (1× memory)                |

All other actions in each piece pass through from the original AP package unchanged.
