# cURL Import Feature

## Overview

The cURL import feature allows you to quickly create HTTP tools by pasting a `curl` command. The parser automatically extracts:

- **HTTP Method** (GET, POST, PUT, PATCH, DELETE, etc.)
- **Endpoint URL** and query parameters
- **Headers** (Content-Type, Accept, custom headers)
- **Authentication** (Bearer tokens, API keys, Basic auth)
- **Request Body** and body type (JSON, form data, XML, text)

## Usage

1. **Navigate to Tool Creation**
   - Go to Tools → Create Tool → HTTP

2. **Access cURL Import**
   - On the "Configuration" step, click the **"Import from cURL"** button

3. **Paste cURL Command**
   - Paste your curl command into the text area
   - Click **"Parse cURL Command"** to extract configuration

4. **Review & Import**
   - Preview the extracted configuration
   - Click **"Import Configuration"** to populate the form

## Supported cURL Flags

| Flag                 | Description                     | Example                               |
| -------------------- | ------------------------------- | ------------------------------------- |
| `-X`, `--request`    | HTTP method                     | `-X POST`                             |
| `-H`, `--header`     | Headers                         | `-H "Content-Type: application/json"` |
| `-d`, `--data`       | Request body                    | `-d '{"key": "value"}'`               |
| `--data-raw`         | Raw data                        | `--data-raw '...'`                    |
| `--data-urlencode`   | URL-encoded data                | `--data-urlencode "key=value"`        |
| `--json`             | JSON data                       | `--json '{"key": "value"}'`           |
| `-u`, `--user`       | Basic auth                      | `-u username:password`                |
| `--bearer`           | Bearer token                    | `--bearer sk-123`                     |
| `--url`              | Explicit URL                    | `--url https://api.example.com`       |
| `-A`, `--user-agent` | User agent (ignored)            | `-A "MyApp/1.0"`                      |
| `-L`, `--location`   | Follow redirects (ignored)      | `-L`                                  |
| `-s`, `--silent`     | Silent mode (ignored)           | `-s`                                  |
| `-k`, `--insecure`   | Skip SSL verification (ignored) | `-k`                                  |
| `--compressed`       | Compression (ignored)           | `--compressed`                        |

## Examples

### Simple GET with Bearer Token

```bash
curl https://api.github.com/user \
  -H "Authorization: Bearer ghp_xxxxxxxxxxxx"
```

**Extracted:**

- Endpoint: `https://api.github.com/user`
- Method: `GET`
- Auth Type: `bearer`
- Auth Config: `{ token: "ghp_xxxxxxxxxxxx" }`

### POST with JSON Body

```bash
curl -X POST https://api.stripe.com/v1/charges \
  -H "Authorization: Bearer sk_test_xxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 2000,
    "currency": "usd",
    "source": "tok_visa"
  }'
```

**Extracted:**

- Endpoint: `https://api.stripe.com/v1/charges`
- Method: `POST`
- Auth Type: `bearer`
- Headers: `Content-Type: application/json`
- Body Type: `json`
- Body: `{ "amount": 2000, ... }`

### API Key Authentication

```bash
curl https://api.example.com/data \
  -H "X-API-Key: abc123456789"
```

**Extracted:**

- Endpoint: `https://api.example.com/data`
- Method: `GET`
- Auth Type: `api_key`
- Auth Config: `{ headerName: "X-API-Key", apiKey: "abc123456789" }`

### Query Parameters

```bash
curl "https://api.example.com/search?q=test&limit=10&sort=desc"
```

**Extracted:**

- Endpoint: `https://api.example.com/search`
- Method: `GET`
- Query Params:
  - `q = test`
  - `limit = 10`
  - `sort = desc`

### Basic Authentication

```bash
curl -u username:password https://api.example.com/protected
```

**Extracted:**

- Endpoint: `https://api.example.com/protected`
- Method: `GET`
- Auth Type: `custom`
- Headers: `Authorization: Basic dXNlcm5hbWU6cGFzc3dvcmQ=`

## Variable Substitution

After importing, you can replace hardcoded values with template variables:

- **Input parameters**: `{{input.paramName}}`
- **Secrets**: `{{secrets.API_KEY}}`
- **Session memory**: `{{memory.variable}}`
- **Context**: `{{context.userId}}`

### Example

Original curl:

```bash
curl -H "Authorization: Bearer sk-live-123456" \
  https://api.example.com/charge
```

After import and variable substitution:

```
Authorization: Bearer {{secrets.STRIPE_KEY}}
```

## Limitations

- Does not support file uploads (`-F`, `--form`)
- OAuth2 flows must be configured manually after import
- Complex multi-part forms may need manual adjustment
- Cookie handling (`-b`, `-c`) is not imported

## Tips

1. **Copy from DevTools**: Use browser DevTools Network tab → Right-click → Copy as cURL
2. **Use Secrets**: Replace API keys with `{{secrets.KEY_NAME}}` after import
3. **Test First**: Always test the imported configuration before deploying
4. **Adjust Variables**: Convert static values to `{{input.param}}` for dynamic tools

## Architecture

The cURL import feature consists of three main components:

1. **curl-parser.ts** - Tokenizes and parses curl commands
2. **CurlImportDialog.tsx** - UI component for import workflow
3. **HttpToolWizard.tsx** - Integration point in the tool creation flow

For implementation details, see the source code in:

- `/apps/studio/src/lib/curl-parser.ts`
- `/apps/studio/src/components/tools/CurlImportDialog.tsx`
- `/apps/studio/src/components/tools/wizard/HttpToolWizard.tsx`
