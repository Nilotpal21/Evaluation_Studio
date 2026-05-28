# Sandbox Runner Architecture

Sandbox tools execute user-authored code (JavaScript/Python) in an isolated environment.
The platform supports two backends — **gVisor** (shared Kubernetes pods) and **Lambda** (per-tenant AWS Lambda functions) — selectable via a single environment variable.

**Key distinction:** The Lambda _service_ (`LambdaDeploymentService`) is a single shared service running on the runtime pod — same as any other platform service. What's per-tenant is the deployed _Lambda function_ (`abl-runner-{tenantId}-{runtime}`). The service manages the lifecycle (deploy, health-check, delete) of these per-tenant functions, and their deployment state is tracked in Redis for now.

---

## Design Diagram

```
                          ┌──────────────┐
                          │  Studio UI   │
                          │  (tool CRUD) │
                          └──────┬───────┘
                                 │ POST /api/projects/:id/tools
                                 │ (saves tool + code_content to DB)
                                 │
              ┌──────────────────┼───────────────────────────────┐
              │                  │                                │
              │   if SANDBOX_BACKEND=lambda                       │
              │                  │                                │
              │                  ▼                                │
              │   ┌──────────────────────────┐                   │
              │   │ lambda-deploy-trigger     │                   │
              │   │ (fire & forget)           │                   │
              │   └──────────┬───────────────┘                   │
              │              │ POST /api/internal/                │
              │              │   lambda/ensure-deployed           │
              │              ▼                                    │
              │   ┌──────────────────────────────────────────┐   │
              │   │ LambdaDeploymentService                  │   │
              │   │ (shared singleton on runtime pod)        │   │
              │   │                                          │   │
              │   │  ┌────────────────┐                      │   │
              │   │  │ CodePackager   │  builds ZIP           │   │
              │   │  └───────┬────────┘                      │   │
              │   │          ▼                                │   │
              │   │   AWS CreateFunction                     │   │
              │   │   (creates per-tenant Lambda function)   │   │
              │   └──────────────────┬───────────────────────┘   │
              │                      │                           │
              │                      ▼                           │
              │   ┌──────────────────────────────────────────┐   │
              │   │ Redis (deployment state, per tenant)     │   │
              │   │ key: lambda:runner:{tenantId}:{runtime}  │   │
              │   │ val: { status, functionName, region, … } │   │
              │   └──────────────────────────────────────────┘   │
              │                                                  │
              └──────────────────────────────────────────────────┘

                      ═══════════════════════════
                          Runtime (per message)
                      ═══════════════════════════

    ┌──────────────────────────────────────────────────────────────┐
    │                      _wireExecutor()                         │
    │                                                              │
    │  allTools.filter(t => t.tool_type === 'sandbox')             │
    │         │                                                    │
    │         ▼                                                    │
    │  _buildSandboxRunner(session, tenantId, projectId)           │
    │         │                                                    │
    │         │  reads SANDBOX_BACKEND env                          │
    │         │                                                    │
    │         ├──── 'gvisor' ─────┐     ┌───── 'lambda' ──────┐   │
    │         │                   │     │                      │   │
    │         │                   ▼     ▼                      │   │
    │         │        ┌────────────────────────────┐          │   │
    │         │        │  createSandboxRunner()     │          │   │
    │         │        │  (factory)                 │          │   │
    │         │        └────────────┬───────────────┘          │   │
    │         │                     │                          │   │
    │     ┌───┴───┐           ┌────┴────┐                     │   │
    │     │gvisor │           │ lambda  │                     │   │
    │     ▼       │           ▼         │                     │   │
    │  ┌──────────────┐  ┌───────────────────┐                │   │
    │  │ GvisorSandbox│  │ LambdaSandbox     │                │   │
    │  │ Runner       │  │ Runner            │                │   │
    │  └──────┬───────┘  └────────┬──────────┘                │   │
    │         │                   │                            │   │
    └─────────┼───────────────────┼────────────────────────────┘   │
              │                   │                                │
              ▼                   ▼
    ┌──────────────┐    ┌───────────────────────────────────┐
    │ K8s gVisor   │    │ AWS Lambda (per-tenant functions) │
    │ Pods         │    │                                   │
    │ (shared)     │    │  abl-runner-tenantA-js            │
    │              │    │  abl-runner-tenantA-py            │
    │ HTTP POST    │    │  abl-runner-tenantB-js            │
    │ /execute-    │    │  ...                              │
    │  script      │    │                                   │
    └──────────────┘    │  InvokeCommand targets the        │
                        │  function for the session's       │
                        │  tenantId + runtime                │
                        └───────────────────────────────────┘
```

### Execution flow (both backends)

```
ToolBindingExecutor
  └─► SandboxToolExecutor.execute(toolName, params)
        │
        ├─ Validates code_content (no null bytes, no path traversal)
        ├─ Extracts runtime, timeout, memory from sandbox_binding
        │
        └─► SandboxRunner.run({ functionName, runtime, codeContent, params, limits })
              │
              ├─ Preprocesses params (JS: $ prefix, Python: passthrough)
              ├─ Signs JWT for memory API auth
              ├─ Invokes backend (HTTP pod / AWS Lambda)
              └─ Returns { response, logs, error }
```

---

## Environment Variables

### Backend Selection

| Variable          | Default  | Description          |
| ----------------- | -------- | -------------------- |
| `SANDBOX_BACKEND` | `gvisor` | `gvisor` or `lambda` |

### gVisor Backend

| Variable                     | Default           | Required           | Description                                              |
| ---------------------------- | ----------------- | ------------------ | -------------------------------------------------------- |
| `SANDBOX_PYTHON_POD_URL`     | —                 | Yes (at least one) | Python pod URL, e.g. `http://kr-python-svc:8080`         |
| `SANDBOX_JAVASCRIPT_POD_URL` | —                 | Yes (at least one) | JavaScript pod URL, e.g. `http://kr-javascript-svc:8080` |
| `SANDBOX_POD_PATH`           | `/execute-script` | No                 | HTTP endpoint path on the pod                            |
| `SANDBOX_CODE_BASE_PATH`     | `./sandbox-tools` | No                 | Legacy disk path (unused when code comes from IR)        |

If neither pod URL is set, sandbox tools are disabled with a `toolWarning` on the session.

### Lambda Backend

| Variable                          | Default     | Required                     | Description                                       |
| --------------------------------- | ----------- | ---------------------------- | ------------------------------------------------- |
| `LAMBDA_RUNNER_REGION`            | `us-east-1` | No                           | AWS region for Lambda functions                   |
| `LAMBDA_RUNNER_ROLE_ARN`          | —           | Yes                          | IAM execution role ARN for `CreateFunction`       |
| `LAMBDA_RUNNER_MEMORY_MB`         | `256`       | No                           | Memory allocation per Lambda                      |
| `LAMBDA_RUNNER_TIMEOUT_SEC`       | `120`       | No                           | Max execution seconds per invocation              |
| `LAMBDA_RUNNER_MEMORY_API_URL`    | —           | Yes (if using MemoryManager) | Base URL the Lambda calls to access memory stores |
| `LAMBDA_RUNNER_HEALTH_TTL_MS`     | `300000`    | No                           | Health check cache TTL (5 min)                    |
| `LAMBDA_RUNNER_DEPLOY_TIMEOUT_MS` | `60000`     | No                           | Max wait for function to become Active            |
| `LAMBDA_RUNNER_NODE_LAYER_ARN`    | —           | No                           | Lambda layer ARN for Node.js dependencies         |
| `LAMBDA_RUNNER_PYTHON_LAYER_ARN`  | —           | No                           | Lambda layer ARN for Python dependencies          |
| `REDIS_URL`                       | —           | Yes                          | Redis connection (stores deployment state)        |

### Shared (both backends)

| Variable                     | Default | Required | Description                                              |
| ---------------------------- | ------- | -------- | -------------------------------------------------------- |
| `SANDBOX_JWT_SECRET`         | —       | No       | Secret for signing per-invocation JWTs (memory API auth) |
| `SANDBOX_JWT_EXPIRY_SECONDS` | `300`   | No       | JWT lifetime in seconds                                  |

### Studio → Runtime (Lambda only)

| Variable               | Default | Required | Description                                     |
| ---------------------- | ------- | -------- | ----------------------------------------------- |
| `RUNTIME_INTERNAL_URL` | —       | Yes      | Internal URL Studio uses to trigger deployments |

---

## Tool Onboarding

### 1. Define a sandbox tool in ABL DSL

````abl
tool calculate_risk {
  type sandbox
  runtime javascript           // or python
  description "Calculates risk score from income and credit history"

  parameter income {
    type number
    description "Annual income"
    required true
  }

  parameter credit_score {
    type number
    description "Credit score (300-850)"
    required true
  }

  returns {
    type object
    description "Risk assessment result"
  }

  code ```
    const riskScore = $income > 50000 && $credit_score > 700 ? 'low' : 'high';
    return { risk: riskScore, income: $income, credit_score: $credit_score };
````

}

```

**Key points:**
- JavaScript params are accessed with `$` prefix (`$income`, `$credit_score`)
- Python params are accessed as-is (`income`, `credit_score`)
- The `code` block is baked into the IR at compile time as `sandbox_binding.code_content`
- `memory` global is available for MemoryManager access (requires JWT secret configured)

### 2. Compile and deploy

The compiler bakes the code into the IR:

```

DSL → compileABLtoIR() → AgentIR.tools[].sandbox_binding.code_content

````

When the tool is saved in Studio (`POST /api/projects/:id/tools`):
- The tool definition and code are persisted
- If `SANDBOX_BACKEND=lambda`, Studio fires an async deployment trigger to the runtime

### 3. Backend-specific setup

#### gVisor (default)

1. Deploy gVisor sandbox pods to your Kubernetes cluster (one per runtime)
2. Set environment variables on the runtime pod:
   ```env
   SANDBOX_BACKEND=gvisor
   SANDBOX_PYTHON_POD_URL=http://kr-python-svc:8080
   SANDBOX_JAVASCRIPT_POD_URL=http://kr-javascript-svc:8080
````

3. (Optional) Set JWT secret for memory API auth:
   ```env
   SANDBOX_JWT_SECRET=your-secret-here
   ```

No deployment step needed — gVisor pods receive code in the HTTP request body at invocation time.

#### Lambda (per-tenant isolation)

The Lambda backend has two parts:

- **LambdaDeploymentService** — a shared singleton on the runtime pod (same as any platform service). It manages the lifecycle of per-tenant Lambda functions: deploy, health-check, delete. One instance serves all tenants.
- **Per-tenant Lambda functions** — each tenant gets its own AWS Lambda function (`abl-runner-{tenantId}-{runtime}`). This is the isolation boundary. Deployment state is tracked in Redis (key: `lambda:runner:{tenantId}:{runtime}`).

Setup:

1. Create an IAM execution role with `lambda:*` permissions and trust policy for Lambda service
2. Set environment variables on the runtime pod:
   ```env
   SANDBOX_BACKEND=lambda
   LAMBDA_RUNNER_REGION=us-east-1
   LAMBDA_RUNNER_ROLE_ARN=arn:aws:iam::123456789:role/abl-sandbox-runner
   LAMBDA_RUNNER_MEMORY_API_URL=https://runtime.internal/api/memory
   REDIS_URL=redis://redis:6379
   SANDBOX_JWT_SECRET=your-secret-here
   ```
3. Set the Studio → Runtime trigger URL:
   ```env
   RUNTIME_INTERNAL_URL=http://runtime-svc:3112
   ```
4. Lambda functions are created automatically per tenant on first sandbox tool save. The shared `LambdaDeploymentService` handles this — no per-tenant service setup needed.

**Function naming:** `abl-runner-{sanitized-tenantId}-{js|py}` (max 64 chars)

### 4. Runtime behavior

At session creation, `_wireExecutor` builds the sandbox runner:

| Scenario                        | What happens                                         |
| ------------------------------- | ---------------------------------------------------- |
| No sandbox tools in IR          | Runner not created (no overhead)                     |
| gVisor + no pod URLs            | `toolWarning` logged, sandbox tools unavailable      |
| Lambda + no Redis               | `toolWarning` logged, sandbox tools unavailable      |
| Lambda + no deployment record   | `TOOL_SANDBOX_NOT_DEPLOYED` error on first tool call |
| Lambda + deployment `deploying` | `TOOL_SANDBOX_DEPLOYING` (retryable)                 |
| Lambda + deployment `failed`    | `TOOL_SANDBOX_DEPLOY_FAILED` with reason             |
| Lambda + deployment `active`    | Invokes Lambda, health-checks if stale (>5 min)      |

### 5. Verify sandbox tools work

```bash
# Check runtime logs for wiring confirmation:
# "ToolBindingExecutor wired for session" with sandboxTools > 0

# For Lambda, check deployment state in Redis:
redis-cli GET "lambda:runner:{tenantId}:javascript"
# → {"status":"active","functionName":"abl-runner-tenant123-js",...}

# Trigger a test message through the agent that uses the sandbox tool
# and verify the trace includes tool execution with duration
```

---

## Dev Environment Setup

### gVisor Backend (default — recommended for local dev)

The gVisor backend sends code inline to shared Kubernetes pods via HTTP. No pre-deployment step is needed — the pods receive code in the request body at invocation time.

#### Prerequisites

- The gVisor sandbox pods (`kr-javascript-svc`, `kr-python-svc`) must be running and reachable from your runtime process.
- These pods are **external infrastructure** — they are not started by `pnpm dev`. You need either:
  - Access to a K8s cluster where they're deployed (use `kubectl port-forward`)
  - Local Docker containers running the pod images

#### Step 1 — Start the sandbox pods

**Option A: Port-forward from a K8s cluster**

```bash
# JavaScript pod
kubectl port-forward svc/kr-javascript-svc 8081:8080 &

# Python pod
kubectl port-forward svc/kr-python-svc 8082:8080 &
```

**Option B: Run pod images locally with Docker**

```bash
# Replace with actual image names from your container registry
docker run -d -p 8081:8080 --name sandbox-js <registry>/kr-javascript-svc:latest
docker run -d -p 8082:8080 --name sandbox-py <registry>/kr-python-svc:latest
```

#### Step 2 — Configure runtime environment

Add to `apps/runtime/.env`:

```env
# Backend selection (gvisor is the default, this line is optional)
SANDBOX_BACKEND=gvisor

# Point to your local sandbox pods
SANDBOX_JAVASCRIPT_POD_URL=http://localhost:8081
SANDBOX_PYTHON_POD_URL=http://localhost:8082

# Endpoint path (default, usually no need to change)
SANDBOX_POD_PATH=/execute-script

# Execution timeout in ms (default: 60000)
SANDBOX_TIMEOUT_MS=60000

# Optional: JWT secret for memory API auth from sandbox code
# SANDBOX_JWT_SECRET=your-dev-secret
```

#### Step 3 — Verify the pods are reachable

```bash
# Test JavaScript pod
curl -s -X POST http://localhost:8081/execute-script \
  -H "Content-Type: application/json" \
  -d '{"script":"return 1+1","args":{},"envParams":"{}","executionMode":"execute","codeType":"javascript"}'

# Expected: {"response":2,"logs":[],"error":""}

# Test Python pod
curl -s -X POST http://localhost:8082/execute-script \
  -H "Content-Type: application/json" \
  -d '{"script":"result = 1+1","args":{},"envParams":"{}","executionMode":"execute","codeType":"python"}'

# Expected: {"response":2,"logs":[],"error":""}
```

#### Step 4 — Start the platform

```bash
pnpm dev   # starts studio (5173) + runtime (3002)
```

#### Step 5 — Test end-to-end

1. Open Studio at `http://localhost:5173`
2. Create/open a project and add a sandbox tool with JavaScript or Python code
3. Start a conversation with an agent that uses the tool
4. Check runtime logs — look for `ToolBindingExecutor wired for session` with `sandboxTools > 0`

### Lambda Backend (alternative — requires AWS + Redis)

Use this if you need per-tenant Lambda isolation or don't have access to gVisor pods.

#### Prerequisites

- AWS credentials configured (`~/.aws/credentials` or env vars `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`)
- An IAM role with `lambda:*` permissions
- Redis running locally (`redis-server` or Docker)

#### Configure runtime environment

Add to `apps/runtime/.env`:

```env
SANDBOX_BACKEND=lambda

# AWS
LAMBDA_RUNNER_REGION=us-east-1
LAMBDA_RUNNER_ROLE_ARN=arn:aws:iam::123456789:role/abl-sandbox-runner
LAMBDA_RUNNER_MEMORY_MB=256
LAMBDA_RUNNER_TIMEOUT_SEC=120

# Memory API (the runtime's own URL, reachable from Lambda)
LAMBDA_RUNNER_MEMORY_API_URL=http://localhost:3112/api/memory

# Redis (for deployment state tracking)
REDIS_URL=redis://localhost:6379

# Optional JWT secret
SANDBOX_JWT_SECRET=your-dev-secret
```

Add to `apps/studio/.env`:

```env
# Studio → Runtime internal trigger URL
RUNTIME_INTERNAL_URL=http://localhost:3112
```

#### Verify

```bash
# Check Redis for deployment state after saving a sandbox tool in Studio
redis-cli GET "lambda:runner:{tenantId}:javascript"
# → {"status":"active","functionName":"abl-runner-tenant123-js",...}
```

### Request/Response Format (both backends)

The sandbox pods and Lambda handlers use the same protocol:

**Request:**

```json
{
  "script": "const risk = $income > 50000 ? 'low' : 'high'; return { risk };",
  "args": { "$income": 75000 },
  "envParams": "{}",
  "executionMode": "execute",
  "codeType": "javascript"
}
```

**Response:**

```json
{
  "response": { "risk": "low" },
  "logs": ["console output captured here"],
  "error": ""
}
```

**Parameter naming:**

| Runtime    | Access pattern | Example                    |
| ---------- | -------------- | -------------------------- |
| JavaScript | `$` prefix     | `$income`, `$credit_score` |
| Python     | As-is          | `income`, `credit_score`   |

### Troubleshooting

| Symptom                                             | Cause                                                                    | Fix                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `toolWarning` on session, sandbox tools unavailable | Neither `SANDBOX_JAVASCRIPT_POD_URL` nor `SANDBOX_PYTHON_POD_URL` is set | Set at least one pod URL in `apps/runtime/.env`                             |
| `ECONNREFUSED` on tool execution                    | Sandbox pod not running or wrong URL/port                                | Verify pod is up: `curl http://localhost:8081/execute-script`               |
| `TOOL_SANDBOX_NOT_DEPLOYED` (Lambda)                | No Lambda function created for this tenant                               | Save a sandbox tool in Studio — it triggers deployment                      |
| `TOOL_SANDBOX_DEPLOYING` (Lambda)                   | Lambda function still being created                                      | Wait ~30s and retry; check Redis state                                      |
| `TOOL_SANDBOX_DEPLOY_FAILED` (Lambda)               | IAM role missing or wrong region                                         | Check `LAMBDA_RUNNER_ROLE_ARN` and AWS credentials                          |
| Tool executes but returns empty                     | Code doesn't `return` a value (JS) or set `result` (Python)              | Ensure code has explicit `return { ... }` (JS) or assigns `result` (Python) |

---

## Key Files

| File                                                                              | Purpose                                                                |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `apps/runtime/src/services/execution/llm-wiring.ts`                               | Wires sandbox runner into executor via `_buildSandboxRunner()`         |
| `packages/compiler/src/platform/constructs/executors/sandbox-runner-factory.ts`   | Factory: `createSandboxRunner(backend, config, ctx, jwt)`              |
| `packages/compiler/src/platform/constructs/executors/gvisor-sandbox-runner.ts`    | gVisor pod execution via HTTP                                          |
| `packages/compiler/src/platform/constructs/executors/lambda-sandbox-runner.ts`    | Per-tenant Lambda execution via AWS SDK                                |
| `packages/compiler/src/platform/constructs/executors/sandbox-tool-executor.ts`    | Validates code, delegates to runner                                    |
| `packages/compiler/src/platform/constructs/executors/lambda-handler-templates.ts` | JS/Python Lambda handler templates                                     |
| `apps/runtime/src/services/lambda/lambda-deployment-store.ts`                     | Per-tenant deployment state interface + Redis impl                     |
| `apps/runtime/src/services/lambda/lambda-deployment-service.ts`                   | Shared service: deploy/health-check/delete per-tenant Lambda functions |
| `apps/runtime/src/services/lambda/lambda-code-packager.ts`                        | ZIP packaging for Lambda deployment                                    |
| `apps/studio/src/services/lambda-deploy-trigger.ts`                               | Studio → Runtime deployment trigger                                    |
