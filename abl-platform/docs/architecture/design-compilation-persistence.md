# Design: Versioning, Deployment & Development Experience

**Date**: Feb 10, 2026
**Review Issues**: #1 (Per-session compilation, no versioning) and #2 (Session persistence exists but unwired)
**Status**: Design v3 — Compile-at-version-time + Git integration + UI/UX
**Phase 1 Status**: ✅ Implemented — VersionService + REST API + 56 tests

---

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Current Architecture (Before)](#current-architecture-before)
3. [Design Decisions](#design-decisions)
4. [Proposed Architecture (After)](#proposed-architecture-after)
5. [Phase 1: Version Service (Compile at Version Time)](#phase-1-version-service-compile-at-version-time)
6. [Phase 2: Deployment Service](#phase-2-deployment-service)
7. [Phase 3: Deployment-Aware Session Creation](#phase-3-deployment-aware-session-creation)
8. [Phase 4: Session Persistence Wiring](#phase-4-session-persistence-wiring)
9. [Phase 5: Git Integration](#phase-5-git-integration)
10. [Phase 6: Studio UI/UX](#phase-6-studio-uiux)
11. [Prisma Schema (No Migration Needed)](#prisma-schema-no-migration-needed)
12. [Implementation Order](#implementation-order)
13. [Verification](#verification)

---

## Problem Statement

### Issue 1: Per-Session Compilation

Every `createSession()` call parses DSL and compiles to IR:

```
createSession(dsl) → parseAgentBasedABL(dsl) → compileABLtoIR([doc]) → session
```

This means:

- **Same agent compiled N times** for N sessions (wasted CPU, ~50-200ms each)
- **No version pinning** — a DSL edit mid-session can't be correlated back
- **No deployment boundary** — can't promote "tested version X" to production
- **No environment separation** — dev and prod run the same unversioned code

### Issue 2: Session Persistence Exists But Unwired

| Component                                          | Status   | Used?                                                            |
| -------------------------------------------------- | -------- | ---------------------------------------------------------------- |
| `SessionService` (L1/L2 caching, hash-based IR)    | Complete | Partially — `persistSessionToService()` writes but nothing reads |
| `SessionStore` interface (Memory + Redis)          | Complete | Only via SessionService                                          |
| `PrismaAgentRegistry` (version control, promotion) | Complete | Never used by runtime                                            |
| `PrismaConversationStore` (session metadata)       | Complete | Partially — SDK handler creates DB sessions                      |
| `Checkpointer` (Memory + Redis snapshots)          | Complete | Not used                                                         |
| `RuntimeExecutor.sessions` (in-memory Map)         | Active   | **Primary store**                                                |
| Prisma `Deployment` model                          | Complete | Never used                                                       |
| Prisma `Session.deploymentId`                      | Complete | Never populated                                                  |
| `ProjectAgent.activeVersions` JSON field           | Complete | Never used                                                       |

The in-memory `Map<string, RuntimeSession>` is the only source of truth. Sessions vanish on pod restart.

---

## Current Architecture (Before)

```
  SDK/HTTP connect                    Studio save
  with projectId                      agent DSL
       │                                  │
       ▼                                  ▼
  ┌─────────────────────────┐     ProjectAgent.dslContent
  │ sdk-handler / chat.ts   │     (single mutable field,
  │                         │      no versioning)
  │ load ProjectAgent rows  │
  │ collect dslContent[]    │
  │         │               │
  │         ▼               │
  │ executor.createSession  │
  │   FromMultipleDSLs()    │
  │         │               │
  │   parse(dsl) ──────────►│──── 50-200ms per session
  │   compile(ir)           │
  │         │               │
  │         ▼               │
  │   sessions Map          │     (in-memory, only store)
  │   agentRegistry Map     │     (in-memory, no persistence)
  └─────────────────────────┘

  ┌──────────────────────────────────────────────────────┐
  │                  UNUSED INFRASTRUCTURE                │
  │                                                      │
  │  Deployment table       { environment, manifest,     │
  │                           compilationHash, status }  │
  │  AgentVersion table     { dslContent, irContent,     │
  │                           status, sourceHash }       │
  │  ProjectAgent.activeVersions  { dev: "1.0", ... }    │
  │  Session.deploymentId   (never populated)            │
  │  SDKChannel.deploymentId (never populated)           │
  │  SessionService         (writes, never reads)        │
  │  PrismaAgentRegistry    (full impl, never called)    │
  └──────────────────────────────────────────────────────┘
```

---

## Design Decisions

### Decision 1: When to Compile — Compile at Version Time (Option A)

Three options were evaluated:

| Option              | Compile When         | Version Time | Deploy Time           | Session Time     | Risk                |
| ------------------- | -------------------- | ------------ | --------------------- | ---------------- | ------------------- |
| **A: Version time** | `createVersion()`    | ~50-200ms    | ~50ms (manifest only) | ~5ms (cache hit) | Errors caught early |
| B: Deploy time      | `createDeployment()` | ~5ms         | ~200-1000ms           | ~5ms             | Errors at deploy    |
| C: Lazy / never     | First session        | ~5ms         | ~50ms                 | ~200ms (cold)    | Errors at user time |

**Chosen: Option A.** Rationale:

- Errors are caught at authoring time, not deploy or session time
- Deploy becomes a fast manifest resolution + validation (~50ms)
- Sessions always get pre-compiled IR (~5ms)
- `AgentRegistry.register()` already implements this pattern — compiles DSL at version creation
- IR is NOT context-dependent: `compileABLtoIR()` compiles each agent independently. Cross-agent references are name strings resolved at runtime. Compiling `[A, B, C]` together produces identical IR for A as compiling `[A]` alone.

### Decision 2: Version Creation Strategy — Mutable Drafts + Explicit Versions (Approach 2)

| Approach              | Saves Create Versions?      | Deploy Creates Versions?       | Version Explosion Risk                |
| --------------------- | --------------------------- | ------------------------------ | ------------------------------------- |
| 1: Dedup by hash      | Yes (skips if hash matches) | No                             | Medium — many near-identical versions |
| **2: Mutable drafts** | No (updates working copy)   | No (explicit "Create Version") | None — user controls versioning       |
| 3: Auto on deploy     | No                          | Yes                            | Low but unpredictable                 |

**Chosen: Approach 2.** Rationale:

- `ProjectAgent.dslContent` remains the mutable working copy (as it is today)
- Studio saves update the working copy — fast, no version noise
- "Create Version" is an explicit action: snapshot `dslContent` → `AgentVersion` with compile + validation
- Versions are immutable, meaningful milestones (not every keystroke)
- Deployments reference specific versions — full auditability

### Decision 3: Git Integration — Hybrid (Platform-First + Git Sync)

Three git integration models:

| Model             | Source of Truth      | Edit In           | Pros            | Cons              |
| ----------------- | -------------------- | ----------------- | --------------- | ----------------- |
| A: GitOps-only    | Git repo             | IDE/CLI only      | Standard DevOps | No Studio editing |
| B: Platform-first | Platform DB          | Studio only       | Best UX         | No git workflows  |
| **C: Hybrid**     | Both (bidirectional) | Studio or IDE/CLI | Best of both    | Sync complexity   |

**Chosen: Hybrid.** Rationale:

- Studio is the primary editing experience for most users
- Power users and CI/CD pipelines need git workflows
- Sync is scoped to version creation (not live editing), which limits complexity
- Two integration points: `git push → platform import` and `platform version → git commit`

---

## Proposed Architecture (After)

```
                    AUTHORING                        VERSIONING                    DEPLOYMENT
               ─────────────────                 ─────────────────            ─────────────────

  Studio / CLI / Git                    "Create Version" action             "Deploy" action
  edit & save                           (explicit user action)              (environment + manifest)
       │                                         │                                 │
       ▼                                         ▼                                 ▼
  ┌──────────────────┐                  ┌──────────────────┐             ┌──────────────────────┐
  │ Working Copy     │                  │ Version Service  │             │  Deployment Service  │
  │                  │                  │                  │             │                      │
  │ ProjectAgent     │  ──  snapshot ─► │ 1. Validate DSL  │             │ 1. Resolve manifest  │
  │   .dslContent    │                  │ 2. Compile to IR │             │    (agent→version)   │
  │   (mutable)      │                  │ 3. Save immutable│             │                      │
  │                  │                  │    AgentVersion   │             │ 2. Validate all IRs  │
  │ Auto-save on     │                  │    {dsl, ir, hash}│            │    exist and compile  │
  │ every edit       │                  │ 4. Dedup by hash │             │                      │
  │ (~fast, no IR)   │                  │                  │             │ 3. Create Deployment │
  └──────────────────┘                  └──────────────────┘             │    row (immutable)   │
                                                                        │                      │
         ┌──────────────────────────────────────────────────┐           │ 4. Cache compiled IR │
         │               GIT INTEGRATION                     │           │    in SessionService │
         │                                                   │           │                      │
         │  Git Push (webhook)  ──► Import DSL → Version     │           │ 5. Retire previous   │
         │  Version Create ──► Git Commit (optional sync)    │           │    deployment        │
         └──────────────────────────────────────────────────┘           └──────────┬───────────┘
                                                                                   │
           ┌───────────────────────────────────────────────────────────────────────┤
           │                                                                       │
  SDK/HTTP connect                                                        ┌────────▼────────┐
  with projectId                                                          │  SessionService  │
  (+ optional env)                                                        │                  │
       │                                                                  │  L1: Pod LRU     │
       ▼                                                                  │  L2: Redis/Mem   │
  ┌──────────────────────┐                                                │  L3: DB (IR from │
  │ sdk-handler/chat.ts  │                                                │      AgentVersion)│
  │                      │                                                └────────┬─────────┘
  │ 1. Resolve active    │                                                         │
  │    deployment for    │ ◄───────────────────────────────────────────────────────┘
  │    project + env     │      load pre-compiled IR
  │                      │
  │ 2. Load manifest     │
  │    from Deployment   │
  │                      │
  │ 3. Load compiled IR  │     NO parse, NO compile
  │    from cache/DB     │     just hydrate from stored IR
  │                      │
  │ 4. Create session    │
  │    with deploymentId │
  └──────────┬───────────┘
             │
             ▼
  ┌──────────────────────┐
  │  RuntimeExecutor     │
  │                      │
  │  sessions Map (L0)   │──── hot cache, reconstructible
  │                      │
  │  executeMessage()    │
  │    │                 │
  │    └──► saveSession  │──── SessionService (sync after each message)
  └──────────────────────┘
```

---

## Phase 1: Version Service (Compile at Version Time)

**Goal**: Explicit "Create Version" compiles DSL → IR and stores an immutable `AgentVersion`. Studio saves only update the mutable `ProjectAgent.dslContent` working copy.

### 1.1 `VersionService`

```typescript
// apps/runtime/src/services/version-service.ts

import { createHash } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import type { AgentIR, CompilationOutput } from '@abl/compiler';
import { parseAgentBasedABL, compileABLtoIR } from '@abl/compiler';
import { getSessionService } from './session/session-service.js';

export class VersionService {
  constructor(private prisma: PrismaClient) {}

  /**
   * Create an immutable version from the current working copy.
   * This is the COMPILATION entry point. Compiles DSL → IR at version time.
   *
   * Called from: Studio "Create Version" button, CLI `abl version create`, Git import
   */
  async createVersion(params: {
    projectId: string;
    agentName: string;
    dslContent: string; // Current working copy content
    version: string; // e.g., "1.2.0" — caller determines this
    createdBy: string;
    changelog?: string;
  }): Promise<{ versionId: string; sourceHash: string; compileErrors?: string[] }> {
    // 1. Compute source hash for dedup
    const sourceHash = createHash('sha256').update(params.dslContent).digest('hex').slice(0, 16);

    // 2. Dedup: if sourceHash matches latest version, skip
    const agent = await this.prisma.projectAgent.findFirst({
      where: { projectId: params.projectId, name: params.agentName },
    });
    if (!agent) throw new Error(`Agent ${params.agentName} not found in project`);

    const latestVersion = await this.prisma.agentVersion.findFirst({
      where: { agentId: agent.id },
      orderBy: { createdAt: 'desc' },
    });
    if (latestVersion && latestVersion.sourceHash === sourceHash) {
      return { versionId: latestVersion.version, sourceHash };
    }

    // 3. Compile DSL → IR (this is where compilation happens)
    const parseResult = parseAgentBasedABL(params.dslContent);
    if (parseResult.errors.length > 0) {
      return {
        versionId: '',
        sourceHash,
        compileErrors: parseResult.errors.map((e) => e.message),
      };
    }

    const compilationOutput = compileABLtoIR([parseResult.document]);
    const entryAgent = Object.values(compilationOutput.agents)[0];
    const irContent = entryAgent ? JSON.stringify(entryAgent) : '';

    // 4. Cache IR in SessionService for fast session creation
    const sessionService = getSessionService();
    if (entryAgent) {
      await sessionService.cacheAgentIR(entryAgent);
    }

    // 5. Save immutable AgentVersion
    await this.prisma.agentVersion.create({
      data: {
        agentId: agent.id,
        version: params.version,
        status: 'draft',
        dslContent: params.dslContent,
        irContent,
        sourceHash,
        createdBy: params.createdBy,
        changelog: params.changelog || '',
      },
    });

    return { versionId: params.version, sourceHash };
  }

  /**
   * List versions for an agent.
   */
  async listVersions(projectId: string, agentName: string) {
    const agent = await this.prisma.projectAgent.findFirst({
      where: { projectId, name: agentName },
    });
    if (!agent) return [];

    return this.prisma.agentVersion.findMany({
      where: { agentId: agent.id },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Get a specific version.
   */
  async getVersion(projectId: string, agentName: string, version: string) {
    const agent = await this.prisma.projectAgent.findFirst({
      where: { projectId, name: agentName },
    });
    if (!agent) return null;

    return this.prisma.agentVersion.findUnique({
      where: { agentId_version: { agentId: agent.id, version } },
    });
  }

  /**
   * Auto-increment version string (semver patch bump).
   */
  async nextVersion(projectId: string, agentName: string): Promise<string> {
    const agent = await this.prisma.projectAgent.findFirst({
      where: { projectId, name: agentName },
    });
    if (!agent) return '0.1.0';

    const latest = await this.prisma.agentVersion.findFirst({
      where: { agentId: agent.id },
      orderBy: { createdAt: 'desc' },
    });
    if (!latest) return '0.1.0';

    const parts = latest.version.split('.').map(Number);
    parts[2] = (parts[2] || 0) + 1;
    return parts.join('.');
  }

  /**
   * Promote a version to a new status.
   * draft → testing → staged → active
   */
  async promoteVersion(params: {
    projectId: string;
    agentName: string;
    version: string;
    targetStatus: 'testing' | 'staged' | 'active';
    promotedBy: string;
  }): Promise<void> {
    const agent = await this.prisma.projectAgent.findFirst({
      where: { projectId: params.projectId, name: params.agentName },
    });
    if (!agent) throw new Error(`Agent ${params.agentName} not found`);

    await this.prisma.agentVersion.update({
      where: { agentId_version: { agentId: agent.id, version: params.version } },
      data: {
        status: params.targetStatus,
        promotedAt: new Date(),
        promotedBy: params.promotedBy,
      },
    });
  }

  /**
   * Diff two versions of an agent (returns DSL content for each).
   */
  async diffVersions(
    projectId: string,
    agentName: string,
    versionA: string,
    versionB: string,
  ): Promise<{ a: { version: string; dsl: string }; b: { version: string; dsl: string } } | null> {
    const [a, b] = await Promise.all([
      this.getVersion(projectId, agentName, versionA),
      this.getVersion(projectId, agentName, versionB),
    ]);
    if (!a || !b) return null;
    return {
      a: { version: versionA, dsl: a.dslContent },
      b: { version: versionB, dsl: b.dslContent },
    };
  }
}
```

### 1.2 Version REST API

```typescript
// apps/runtime/src/routes/versions.ts

// POST /api/projects/:projectId/agents/:agentName/versions
// Create an immutable version (triggers compilation)
router.post('/', async (req, res) => {
  const { changelog } = req.body;
  const versionService = getVersionService();

  // Load working copy from ProjectAgent
  const agent = await prisma.projectAgent.findFirst({
    where: { projectId: req.params.projectId, name: req.params.agentName },
  });
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const nextVersion = await versionService.nextVersion(req.params.projectId, req.params.agentName);

  const result = await versionService.createVersion({
    projectId: req.params.projectId,
    agentName: req.params.agentName,
    dslContent: agent.dslContent,
    version: nextVersion,
    createdBy: req.user?.id || 'system',
    changelog,
  });

  if (result.compileErrors) {
    return res.status(422).json({ success: false, errors: result.compileErrors });
  }

  res.json({ success: true, ...result });
});

// GET /api/projects/:projectId/agents/:agentName/versions
router.get('/', async (req, res) => {
  const versions = await getVersionService().listVersions(
    req.params.projectId,
    req.params.agentName,
  );
  res.json({ success: true, versions });
});

// GET /api/projects/:projectId/agents/:agentName/versions/:version/diff/:otherVersion
router.get('/:version/diff/:otherVersion', async (req, res) => {
  const diff = await getVersionService().diffVersions(
    req.params.projectId,
    req.params.agentName,
    req.params.version,
    req.params.otherVersion,
  );
  res.json({ success: true, diff });
});
```

---

## Phase 2: Deployment Service

**Goal**: A deployment is a fast manifest resolution + validation. Since IR was compiled at version time, deploy just resolves which versions to use and caches them.

### 2.1 `DeploymentService`

```typescript
// apps/runtime/src/services/deployment-service.ts

export class DeploymentService {
  constructor(
    private prisma: PrismaClient,
    private sessionService: SessionService,
  ) {}

  /**
   * Create a deployment: resolve versions → validate IR exists → cache → activate.
   *
   * NO compilation here — IR was already compiled at version creation time.
   * Deploy is fast (~50ms): manifest resolution + cache warming.
   */
  async createDeployment(params: {
    projectId: string;
    tenantId: string;
    environment: Environment;
    manifest?: Record<string, string>; // { agentName: version }
    entryAgentName: string;
    label?: string;
    description?: string;
    createdBy: string;
  }): Promise<DeploymentResult> {
    // 1. Resolve version manifest
    const resolvedManifest = await this.resolveManifest(params);

    // 2. Validate all versions have compiled IR
    await this.validateManifest(params.projectId, resolvedManifest);

    // 3. Warm SessionService caches with pre-compiled IR
    const compilationHash = await this.warmCaches(params.projectId, resolvedManifest);

    // 4. Retire previous active deployment
    const previousId = await this.retirePrevious(params.projectId, params.environment);

    // 5. Create immutable Deployment row
    const endpointSlug = this.generateSlug(params.projectId, params.environment);

    const deployment = await this.prisma.deployment.create({
      data: {
        projectId: params.projectId,
        tenantId: params.tenantId,
        environment: params.environment,
        agentVersionManifest: JSON.stringify(resolvedManifest),
        entryAgentName: params.entryAgentName,
        compilationHash,
        status: 'active',
        endpointSlug,
        previousDeploymentId: previousId,
        label: params.label,
        description: params.description,
        createdBy: params.createdBy,
      },
    });

    // 6. Update activeVersions on each ProjectAgent
    await this.updateActiveVersions(params.projectId, resolvedManifest, params.environment);

    return {
      deploymentId: deployment.id,
      environment: params.environment,
      endpointSlug,
      compilationHash,
      manifest: resolvedManifest,
      agentCount: Object.keys(resolvedManifest).length,
    };
  }

  /**
   * Resolve the active deployment for a project + environment.
   */
  async getActiveDeployment(projectId: string, environment: Environment) {
    return this.prisma.deployment.findFirst({
      where: { projectId, environment, status: 'active' },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Load all compiled agent IRs for a deployment.
   * Resolution: L1 (pod LRU) → L2 (Redis) → L3 (DB AgentVersion.irContent)
   */
  async loadDeploymentAgents(deploymentId: string): Promise<{
    agents: Record<string, AgentIR>;
    compilationOutput: CompilationOutput | null;
    entryAgentName: string;
    manifest: Record<string, string>;
  }> {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
    });
    if (!deployment) throw new Error(`Deployment ${deploymentId} not found`);

    const manifest = JSON.parse(deployment.agentVersionManifest) as Record<string, string>;

    // Try compilation cache first
    if (deployment.compilationHash) {
      const cached = await this.sessionService.resolveCompilationOutput?.(
        deployment.compilationHash,
      );
      if (cached) {
        return {
          agents: cached.agents,
          compilationOutput: cached,
          entryAgentName: deployment.entryAgentName,
          manifest,
        };
      }
    }

    // Cache miss — load each agent's IR from DB
    const agents: Record<string, AgentIR> = {};
    for (const [agentName, version] of Object.entries(manifest)) {
      const agent = await this.prisma.projectAgent.findFirst({
        where: { projectId: deployment.projectId, name: agentName },
      });
      if (!agent) throw new Error(`Agent ${agentName} not found`);

      const agentVersion = await this.prisma.agentVersion.findUnique({
        where: { agentId_version: { agentId: agent.id, version } },
      });
      if (!agentVersion?.irContent) {
        throw new Error(`Missing compiled IR for ${agentName}@${version}. Re-create the version.`);
      }
      agents[agentName] = JSON.parse(agentVersion.irContent);
    }

    // Warm caches for next time
    for (const ir of Object.values(agents)) {
      await this.sessionService.cacheAgentIR(ir);
    }

    return {
      agents,
      compilationOutput: null,
      entryAgentName: deployment.entryAgentName,
      manifest,
    };
  }

  /**
   * Rollback: reactivate the previous deployment.
   */
  async rollback(projectId: string, environment: Environment) {
    const current = await this.getActiveDeployment(projectId, environment);
    if (!current?.previousDeploymentId) {
      throw new Error('No previous deployment to rollback to');
    }
    await this.prisma.deployment.update({
      where: { id: current.id },
      data: { status: 'retired', retiredAt: new Date() },
    });
    return this.prisma.deployment.update({
      where: { id: current.previousDeploymentId },
      data: { status: 'active', retiredAt: null },
    });
  }

  /**
   * List deployment history for a project + environment.
   */
  async listDeployments(projectId: string, environment?: Environment) {
    return this.prisma.deployment.findMany({
      where: {
        projectId,
        ...(environment ? { environment } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  // ===========================================================================
  // PRIVATE
  // ===========================================================================

  private async resolveManifest(params: {
    projectId: string;
    environment: Environment;
    manifest?: Record<string, string>;
  }): Promise<Record<string, string>> {
    if (params.manifest && Object.keys(params.manifest).length > 0) {
      return params.manifest;
    }

    // Auto-resolve: for each agent, find latest version
    const agents = await this.prisma.projectAgent.findMany({
      where: { projectId: params.projectId },
    });

    const resolved: Record<string, string> = {};
    for (const agent of agents) {
      // Check activeVersions for this environment first
      const activeVersions = JSON.parse(agent.activeVersions || '{}') as Record<string, string>;
      if (activeVersions[params.environment]) {
        resolved[agent.name] = activeVersions[params.environment];
        continue;
      }
      // Fallback: latest version
      const latest = await this.prisma.agentVersion.findFirst({
        where: { agentId: agent.id },
        orderBy: { createdAt: 'desc' },
      });
      if (latest) {
        resolved[agent.name] = latest.version;
      }
    }

    return resolved;
  }

  private async validateManifest(
    projectId: string,
    manifest: Record<string, string>,
  ): Promise<void> {
    for (const [agentName, version] of Object.entries(manifest)) {
      const agent = await this.prisma.projectAgent.findFirst({
        where: { projectId, name: agentName },
      });
      if (!agent) throw new Error(`Agent ${agentName} not found in project`);

      const agentVersion = await this.prisma.agentVersion.findUnique({
        where: { agentId_version: { agentId: agent.id, version } },
      });
      if (!agentVersion) {
        throw new Error(`Version ${version} not found for agent ${agentName}`);
      }
      if (!agentVersion.irContent) {
        throw new Error(
          `Version ${version} of ${agentName} has no compiled IR. Re-create the version.`,
        );
      }
    }
  }

  private async warmCaches(projectId: string, manifest: Record<string, string>): Promise<string> {
    const agents: Record<string, AgentIR> = {};

    for (const [agentName, version] of Object.entries(manifest)) {
      const agent = await this.prisma.projectAgent.findFirst({
        where: { projectId, name: agentName },
      });
      if (!agent) continue;

      const agentVersion = await this.prisma.agentVersion.findUnique({
        where: { agentId_version: { agentId: agent.id, version } },
      });
      if (agentVersion?.irContent) {
        const ir = JSON.parse(agentVersion.irContent) as AgentIR;
        agents[agentName] = ir;
        await this.sessionService.cacheAgentIR(ir);
      }
    }

    // Compute compilation hash for the full set
    const hash = createHash('sha256').update(JSON.stringify(manifest)).digest('hex').slice(0, 16);

    return hash;
  }

  private async retirePrevious(projectId: string, environment: string): Promise<string | null> {
    const current = await this.prisma.deployment.findFirst({
      where: { projectId, environment, status: 'active' },
    });
    if (current) {
      await this.prisma.deployment.update({
        where: { id: current.id },
        data: { status: 'retired', retiredAt: new Date() },
      });
      return current.id;
    }
    return null;
  }

  private async updateActiveVersions(
    projectId: string,
    manifest: Record<string, string>,
    environment: Environment,
  ): Promise<void> {
    for (const [agentName, version] of Object.entries(manifest)) {
      const agent = await this.prisma.projectAgent.findFirst({
        where: { projectId, name: agentName },
      });
      if (!agent) continue;

      const activeVersions = JSON.parse(agent.activeVersions || '{}');
      activeVersions[environment] = version;

      await this.prisma.projectAgent.update({
        where: { id: agent.id },
        data: { activeVersions: JSON.stringify(activeVersions) },
      });
    }
  }

  private generateSlug(projectId: string, environment: string): string {
    const hash = createHash('sha256')
      .update(`${projectId}:${environment}:${Date.now()}`)
      .digest('hex')
      .slice(0, 8);
    return `${environment}-${hash}`;
  }
}
```

### 2.2 Deployment REST API

```typescript
// apps/runtime/src/routes/deployments.ts

// POST /api/projects/:projectId/deployments
router.post('/', async (req, res) => {
  const { environment, manifest, entryAgentName, label, description } = req.body;
  const result = await getDeploymentService().createDeployment({
    projectId: req.params.projectId,
    tenantId: req.tenant.id,
    environment,
    manifest,
    entryAgentName,
    label,
    description,
    createdBy: req.user.id,
  });
  res.json({ success: true, ...result });
});

// GET /api/projects/:projectId/deployments
router.get('/', async (req, res) => {
  const { environment } = req.query;
  const deployments = await getDeploymentService().listDeployments(
    req.params.projectId,
    environment as Environment | undefined,
  );
  res.json({ success: true, deployments });
});

// GET /api/projects/:projectId/deployments/:environment/active
router.get('/:environment/active', async (req, res) => {
  const deployment = await getDeploymentService().getActiveDeployment(
    req.params.projectId,
    req.params.environment as Environment,
  );
  res.json({ success: true, deployment });
});

// POST /api/projects/:projectId/deployments/:environment/rollback
router.post('/:environment/rollback', async (req, res) => {
  const deployment = await getDeploymentService().rollback(
    req.params.projectId,
    req.params.environment as Environment,
  );
  res.json({ success: true, deployment });
});
```

---

## Phase 3: Deployment-Aware Session Creation

**Goal**: Sessions are created against a deployment, not raw DSL. SDK handler resolves the active deployment, loads pre-compiled IR, creates sessions with `deploymentId`.

### 3.1 Rewrite `initializeProjectAgent()` in SDK Handler

```typescript
// apps/runtime/src/websocket/sdk-handler.ts — initializeProjectAgent()

async function initializeProjectAgent(ws: WebSocket, state: SDKClientState): Promise<void> {
  const prisma = isDatabaseAvailable() ? requirePrisma() : null;
  if (!prisma) {
    // Dev fallback: inline compile from default DSL
    await initializeWithFallbackDSL(ws, state);
    return;
  }

  const deploymentService = getDeploymentService();
  const environment = resolveEnvironment(state);

  // 1. Find active deployment for this project + environment
  const deployment = await deploymentService.getActiveDeployment(state.projectId, environment);

  if (!deployment) {
    send(ws, { type: 'error', message: `No active deployment for "${environment}"` });
    return;
  }

  // 2. Load pre-compiled agents (NO compilation)
  const { agents, compilationOutput, entryAgentName, manifest } =
    await deploymentService.loadDeploymentAgents(deployment.id);

  // 3. Create session with deployment reference
  const executor = getRuntimeExecutor();
  const runtimeSession = executor.createSessionFromDeployment({
    agents,
    compilationOutput,
    entryAgentName,
    deploymentId: deployment.id,
    environment,
    manifest,
    tenantId: state.tenantId,
    authToken: state.authToken,
    userId: state.userId,
    projectId: state.projectId,
  });

  state.runtimeSession = runtimeSession;
  state.runtimeSessionId = runtimeSession.id;

  // 4. Create DB session with deployment link
  const dbSession = await getConversationStore().createSession({
    channel: 'web_chat',
    agentName: entryAgentName,
    agentVersion: manifest[entryAgentName] || '1.0',
    environment,
    projectId: state.projectId,
    tenantId: state.tenantId,
    deploymentId: deployment.id,
  });
  state.dbSessionId = dbSession.id;
}
```

### 3.2 New RuntimeExecutor Method: `createSessionFromDeployment()`

```typescript
// apps/runtime/src/services/runtime-executor.ts

createSessionFromDeployment(params: {
  agents: Record<string, AgentIR>;
  compilationOutput: CompilationOutput | null;
  entryAgentName: string;
  deploymentId: string;
  environment: string;
  manifest: Record<string, string>;
  tenantId?: string;
  authToken?: string;
  userId?: string;
  projectId?: string;
}): RuntimeSession {
  const entryIR = params.agents[params.entryAgentName];
  if (!entryIR) throw new Error(`Entry agent "${params.entryAgentName}" not found`);

  const session: RuntimeSession = {
    id: uuidv4(),
    agentName: params.entryAgentName,
    agentIR: entryIR,
    compilationOutput: params.compilationOutput,
    conversationHistory: [],
    data: { values: {}, gatheredKeys: new Set() },
    state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
    isComplete: false,
    isEscalated: false,
    handoffStack: [params.entryAgentName],
    deploymentId: params.deploymentId,
    environment: params.environment,
    tenantId: params.tenantId,
    authToken: params.authToken,
    userId: params.userId,
    persistenceVersion: 0,
  };

  // Register all agents from deployment (for handoff/delegation)
  for (const [name, ir] of Object.entries(params.agents)) {
    this.agentRegistry.set(name, ir);
  }

  this.sessions.set(session.id, session);

  // Persist async
  this.syncSessionToService(session).catch(err =>
    console.error('[RuntimeExecutor] Failed to persist new session:', err)
  );

  return session;
}
```

---

## Phase 4: Session Persistence Wiring

**Goal**: SessionService becomes the durable store. In-memory Map is L0 hot cache only.

### 4.1 Sync After Every Message

```typescript
// RuntimeExecutor.executeMessage() — add at the end
async executeMessage(sessionId: string, message: string, ...): Promise<ExecutionResult> {
  const session = await this.getOrRehydrate(sessionId);
  // ... existing execution logic ...
  await this.syncSessionToService(session);
  return result;
}
```

### 4.2 Session Loading Cascade

```typescript
private async getOrRehydrate(sessionId: string): Promise<RuntimeSession> {
  // L0: in-memory Map
  let session = this.sessions.get(sessionId);
  if (session) return session;

  // L1/L2: SessionService
  const svc = getSessionService();
  const hydrated = await svc.loadSession(sessionId);
  if (!hydrated) throw new Error(`Session ${sessionId} not found`);

  session = this.hydratedToRuntime(hydrated);

  // Restore agent registry from deployment
  if (hydrated.deploymentId) {
    const deploymentService = getDeploymentService();
    const { agents } = await deploymentService.loadDeploymentAgents(hydrated.deploymentId);
    for (const [name, ir] of Object.entries(agents)) {
      this.agentRegistry.set(name, ir);
    }
  }

  this.sessions.set(sessionId, session);
  return session;
}
```

### 4.3 `syncSessionToService()` — Bidirectional Bridge

```typescript
private async syncSessionToService(session: RuntimeSession): Promise<void> {
  const svc = getSessionService();
  const sessionData = this.toSessionData(session);
  const saved = await svc.saveSession(sessionData);
  if (saved) session.persistenceVersion++;
}
```

---

## Phase 5: Git Integration

### 5.1 Git Integration Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     GIT INTEGRATION LAYER                       │
│                                                                 │
│  ┌──────────────────┐     ┌──────────────────────────────┐     │
│  │  GitSyncService   │     │  Webhook Handler              │     │
│  │                   │     │  POST /api/git/webhook         │     │
│  │  pushToRepo()     │     │                                │     │
│  │  pullFromRepo()   │     │  on push → for each .agent.abl│     │
│  │  cloneProject()   │     │    1. Parse DSL                │     │
│  │  diffWithRemote() │     │    2. Create version           │     │
│  └────────┬──────────┘     │    3. Auto-deploy to dev       │     │
│           │                └──────────────────────────────┘     │
│           │                                                     │
│  ┌────────▼──────────────────────────────────────────────┐     │
│  │               GitProvider Interface                    │     │
│  │                                                        │     │
│  │  clone(repoUrl, branch) → localPath                    │     │
│  │  push(localPath, message, branch)                      │     │
│  │  pull(localPath, branch) → files[]                     │     │
│  │  diff(localPath, branch) → changes[]                   │     │
│  │  listBranches(localPath) → branches[]                  │     │
│  │  createBranch(localPath, name, from?)                   │     │
│  │                                                        │     │
│  │  Implementations:                                      │     │
│  │  ├─ GitHubProvider (API-based, no local git needed)    │     │
│  │  ├─ GitLabProvider (API-based)                         │     │
│  │  └─ LocalGitProvider (shell-based, for self-hosted)    │     │
│  └────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
```

### 5.2 Project Git Configuration

```typescript
// Stored in Project model (add to Prisma schema)
interface ProjectGitConfig {
  repoUrl: string; // e.g., "https://github.com/org/agents.git"
  provider: 'github' | 'gitlab' | 'bitbucket' | 'local';
  branch: string; // default branch, e.g., "main"
  agentDirectory: string; // path within repo, e.g., "agents/" or "."
  syncMode: 'push' | 'pull' | 'bidirectional';
  autoVersionOnPush: boolean; // Create version when git push detected
  autoDeployBranch?: Record<string, Environment>; // branch → env mapping
  // e.g., { "main": "prod", "develop": "staging", "*": "dev" }
  webhookSecret?: string; // For validating incoming webhooks
  accessToken?: string; // Encrypted, for API access
}
```

### 5.3 Branch-to-Environment Mapping

```
Git Branch              Environment         Auto-Deploy
────────────           ───────────          ───────────
main / master    ───►  prod                 Manual (requires approval)
staging          ───►  staging              Auto on merge
develop          ───►  dev                  Auto on push
feature/*        ───►  dev (preview)        Auto on push (ephemeral deployment)
```

### 5.4 Sync Flows

**Flow A: Studio → Git (push)**

```
1. User edits agent in Studio
2. User clicks "Create Version" (v1.3.0)
3. If git sync enabled:
   a. Write agent DSL to local working tree
   b. Git commit with message: "v1.3.0: <changelog>"
   c. Push to configured branch
```

**Flow B: Git → Platform (pull / webhook)**

```
1. Developer pushes to git repo (e.g., via CLI, IDE)
2. Webhook fires to POST /api/git/webhook
3. For each changed .agent.abl file:
   a. Parse and validate DSL
   b. Update ProjectAgent.dslContent (working copy)
   c. Create version (compile at version time)
   d. If autoDeployBranch matches: auto-deploy to mapped environment
```

**Flow C: CLI → Git (direct)**

```
1. Developer runs: abl push --repo github.com/org/agents
2. CLI reads local .agent.abl files
3. Calls POST /api/projects/:id/agents/:name/versions for each
4. Optionally commits to git
```

### 5.5 `GitSyncService`

```typescript
// apps/runtime/src/services/git-sync-service.ts

export class GitSyncService {
  constructor(
    private prisma: PrismaClient,
    private versionService: VersionService,
    private deploymentService: DeploymentService,
  ) {}

  /**
   * Import agents from a git repo into a project.
   * Scans for .agent.abl files and creates/updates ProjectAgents + versions.
   */
  async importFromRepo(params: {
    projectId: string;
    repoUrl: string;
    branch: string;
    directory?: string;
    createdBy: string;
  }): Promise<ImportResult> {
    const provider = this.getGitProvider(params.repoUrl);
    const files = await provider.listFiles(params.repoUrl, params.branch, {
      directory: params.directory,
      pattern: '**/*.agent.abl',
    });

    const results: ImportedAgent[] = [];
    for (const file of files) {
      const content = await provider.getFileContent(params.repoUrl, params.branch, file.path);
      const agentName = file.name.replace('.agent.abl', '');

      // Upsert ProjectAgent
      let agent = await this.prisma.projectAgent.findFirst({
        where: { projectId: params.projectId, name: agentName },
      });
      if (!agent) {
        agent = await this.prisma.projectAgent.create({
          data: {
            projectId: params.projectId,
            name: agentName,
            agentPath: file.path,
            dslContent: content,
          },
        });
      } else {
        await this.prisma.projectAgent.update({
          where: { id: agent.id },
          data: { dslContent: content },
        });
      }

      // Create version
      const version = await this.versionService.nextVersion(params.projectId, agentName);
      const result = await this.versionService.createVersion({
        projectId: params.projectId,
        agentName,
        dslContent: content,
        version,
        createdBy: params.createdBy,
        changelog: `Imported from ${params.branch}@${file.sha?.slice(0, 7) || 'HEAD'}`,
      });

      results.push({
        agentName,
        version,
        sourceHash: result.sourceHash,
        errors: result.compileErrors,
      });
    }

    return { agents: results, fileCount: files.length };
  }

  /**
   * Export project agents to a git repo.
   * Writes latest version DSL for each agent.
   */
  async exportToRepo(params: {
    projectId: string;
    repoUrl: string;
    branch: string;
    directory?: string;
    commitMessage: string;
    createdBy: string;
  }): Promise<void> {
    const agents = await this.prisma.projectAgent.findMany({
      where: { projectId: params.projectId },
    });

    const provider = this.getGitProvider(params.repoUrl);
    const files: Array<{ path: string; content: string }> = [];

    for (const agent of agents) {
      const dir = params.directory ? `${params.directory}/` : '';
      files.push({
        path: `${dir}${agent.name}.agent.abl`,
        content: agent.dslContent,
      });
    }

    await provider.commitFiles(params.repoUrl, params.branch, files, params.commitMessage);
  }

  /**
   * Handle incoming git webhook (push event).
   */
  async handleWebhook(params: {
    projectId: string;
    branch: string;
    commits: Array<{ added: string[]; modified: string[]; removed: string[] }>;
    repoUrl: string;
    createdBy: string;
  }): Promise<WebhookResult> {
    const project = await this.prisma.project.findUnique({
      where: { id: params.projectId },
    });
    if (!project) throw new Error('Project not found');

    const gitConfig = JSON.parse(project.gitConfig || '{}') as ProjectGitConfig;

    // Collect all changed .agent.abl files
    const changedFiles = new Set<string>();
    for (const commit of params.commits) {
      for (const file of [...commit.added, ...commit.modified]) {
        if (file.endsWith('.agent.abl')) changedFiles.add(file);
      }
    }

    // Import each changed file
    const provider = this.getGitProvider(params.repoUrl);
    const results: ImportedAgent[] = [];

    for (const filePath of changedFiles) {
      const content = await provider.getFileContent(params.repoUrl, params.branch, filePath);
      const agentName = filePath.split('/').pop()!.replace('.agent.abl', '');

      // Update working copy
      await this.prisma.projectAgent.updateMany({
        where: { projectId: params.projectId, name: agentName },
        data: { dslContent: content },
      });

      // Auto-version if configured
      if (gitConfig.autoVersionOnPush) {
        const version = await this.versionService.nextVersion(params.projectId, agentName);
        const result = await this.versionService.createVersion({
          projectId: params.projectId,
          agentName,
          dslContent: content,
          version,
          createdBy: params.createdBy,
          changelog: `Git push from ${params.branch}`,
        });
        results.push({
          agentName,
          version,
          sourceHash: result.sourceHash,
          errors: result.compileErrors,
        });
      }
    }

    // Auto-deploy if branch mapping matches
    if (gitConfig.autoDeployBranch) {
      const environment =
        gitConfig.autoDeployBranch[params.branch] || gitConfig.autoDeployBranch['*'];

      if (environment && environment !== 'prod') {
        // Never auto-deploy to prod
        const entryAgent = await this.resolveEntryAgent(params.projectId);
        await this.deploymentService.createDeployment({
          projectId: params.projectId,
          tenantId: project.organizationId || 'default',
          environment,
          entryAgentName: entryAgent,
          createdBy: 'git-webhook',
          label: `Auto-deploy from ${params.branch}`,
        });
      }
    }

    return {
      importedAgents: results,
      deployTriggered: !!gitConfig.autoDeployBranch?.[params.branch],
    };
  }

  private getGitProvider(repoUrl: string): GitProvider {
    if (repoUrl.includes('github.com')) return new GitHubProvider();
    if (repoUrl.includes('gitlab.com')) return new GitLabProvider();
    return new LocalGitProvider();
  }

  private async resolveEntryAgent(projectId: string): Promise<string> {
    const agents = await this.prisma.projectAgent.findMany({
      where: { projectId },
    });
    // Prefer supervisor, then first agent
    const supervisor = agents.find((a) => a.isSupervisor);
    return supervisor?.name || agents[0]?.name || 'main';
  }
}
```

### 5.6 Git REST API

```typescript
// apps/runtime/src/routes/git.ts

// POST /api/projects/:projectId/git/connect
// Connect a git repo to a project
router.post('/connect', async (req, res) => {
  const { repoUrl, branch, directory, syncMode, autoDeployBranch } = req.body;
  // Validate repo access, store config, set up webhook
});

// POST /api/projects/:projectId/git/import
// One-time import from git repo
router.post('/import', async (req, res) => {
  const { branch, directory } = req.body;
  const result = await getGitSyncService().importFromRepo({ ... });
  res.json({ success: true, ...result });
});

// POST /api/projects/:projectId/git/export
// Export current agents to git repo
router.post('/export', async (req, res) => {
  const { branch, commitMessage } = req.body;
  await getGitSyncService().exportToRepo({ ... });
  res.json({ success: true });
});

// POST /api/git/webhook
// Incoming webhook from GitHub/GitLab
router.post('/webhook', async (req, res) => {
  // Validate signature, parse payload, call handleWebhook
});

// GET /api/projects/:projectId/git/status
// Get sync status
router.get('/status', async (req, res) => {
  // Compare local versions with remote, report drift
});
```

---

## Phase 6: Studio UI/UX

### 6.1 UI Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                            STUDIO LAYOUT                                  │
│                                                                          │
│  ┌─ Left Panel ──────┐  ┌─ Center ────────────────┐  ┌─ Right Panel ──┐ │
│  │                    │  │                          │  │                │ │
│  │  ┌─ Sidebar ─────┐│  │  ┌─ Editor Area ───────┐│  │ ┌─ Inspector ┐│ │
│  │  │ Agents  │ Git  ││  │  │                     ││  │ │ Trace      ││ │
│  │  │ tree    │ tree ││  │  │  Monaco Editor      ││  │ │ State      ││ │
│  │  │         │      ││  │  │  (ABL DSL)          ││  │ │ Observatory││ │
│  │  │         │      ││  │  │                     ││  │ │ Versions   ││ │
│  │  └─────────┴──────┘│  │  └─────────────────────┘│  │ └────────────┘│ │
│  │                    │  │                          │  │                │ │
│  │  ┌─ Actions ──────┐│  │  ┌─ Bottom Bar ────────┐│  │                │ │
│  │  │ Save           ││  │  │ Parse errors │ IR    ││  │                │ │
│  │  │ Create Version ││  │  │ Warnings     │ view  ││  │                │ │
│  │  │ Deploy         ││  │  └─────────────────────┘│  │                │ │
│  │  │ Git Sync       ││  │                          │  │                │ │
│  │  └────────────────┘│  │  ┌─ Chat Panel ────────┐│  │                │ │
│  │                    │  │  │ (dev preview)        ││  │                │ │
│  └────────────────────┘  │  └─────────────────────┘│  │                │ │
│                          └──────────────────────────┘  └────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
```

### 6.2 New UI Views

The current `CurrentView` type is `'chat' | 'sessions' | 'session-detail'`. Extend to:

```typescript
type CurrentView =
  | 'chat' // Existing: live chat with agent (dev preview)
  | 'sessions' // Existing: session list
  | 'session-detail' // Existing: session trace inspector
  | 'versions' // NEW: version history for an agent
  | 'deployments' // NEW: deployment dashboard
  | 'git' // NEW: git integration panel
  | 'diff'; // NEW: version diff viewer
```

### 6.3 Feature: Version Management Panel

**Location**: Right panel tab or dedicated view

```
┌─ Version History ──────────────────────────────────────────┐
│                                                             │
│  booking_agent                                    [Create]  │
│                                                             │
│  ┌─ v1.3.0 ──────────────────────────────────────────────┐ │
│  │  ● Active (dev)    Created by @alice   2 hours ago    │ │
│  │  "Added flight booking GATHER fields"                 │ │
│  │  [View DSL]  [View IR]  [Diff v1.2.0]  [Deploy →]   │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                             │
│  ┌─ v1.2.0 ──────────────────────────────────────────────┐ │
│  │  ● Active (staging)  Created by @bob   1 day ago      │ │
│  │  "Fixed hotel date validation constraint"             │ │
│  │  [View DSL]  [View IR]  [Diff v1.1.0]  [Promote →]  │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                             │
│  ┌─ v1.1.0 ──────────────────────────────────────────────┐ │
│  │  ● Active (prod)   Created by @bob    1 week ago      │ │
│  │  "Initial hotel booking agent"                        │ │
│  │  [View DSL]  [View IR]  [Diff v1.0.0]               │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                             │
│  Environment Status:                                        │
│  dev: v1.3.0  │  staging: v1.2.0  │  prod: v1.1.0        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Zustand Store Addition**:

```typescript
// store/version-store.ts
interface VersionState {
  versions: AgentVersion[];
  selectedVersion: string | null;
  isCreatingVersion: boolean;
  createVersionError: string | null;
  activeVersionsByEnv: Record<string, string>;

  fetchVersions: (projectId: string, agentName: string) => Promise<void>;
  createVersion: (projectId: string, agentName: string, changelog: string) => Promise<void>;
  promoteVersion: (
    projectId: string,
    agentName: string,
    version: string,
    env: Environment,
  ) => Promise<void>;
}
```

### 6.4 Feature: Deployment Dashboard

**Location**: Dedicated view or tab within deploy panel

```
┌─ Deployments ──────────────────────────────────────────────┐
│                                                             │
│  ┌─ Environment Tabs ─────────────────────────────────────┐│
│  │  [dev ●]    [staging ○]    [prod ○]    [+ New Deploy] ││
│  └────────────────────────────────────────────────────────┘│
│                                                             │
│  Active Deployment: dev-a3f8c021                           │
│  Created: 2 hours ago by @alice                            │
│  Entry: booking_supervisor                                 │
│                                                             │
│  ┌─ Manifest ────────────────────────────────────────────┐ │
│  │  Agent                    Version    Status            │ │
│  │  booking_agent            v1.3.0     ● compiled        │ │
│  │  booking_supervisor       v2.0.0     ● compiled        │ │
│  │  flight_search            v0.8.0     ● compiled        │ │
│  │  hotel_search             v1.1.0     ● compiled        │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                             │
│  Sessions: 147 active  │  [Rollback]  [Drain]             │
│                                                             │
│  ┌─ History ─────────────────────────────────────────────┐ │
│  │  dev-a3f8c021  active   2h ago   @alice   "v1.3.0"   │ │
│  │  dev-b2e1f9a3  retired  1d ago   @bob     "v1.2.0"   │ │
│  │  dev-c7d4e6b8  retired  3d ago   @alice   "v1.1.0"   │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

**Zustand Store Addition**:

```typescript
// store/deployment-store.ts
interface DeploymentState {
  deployments: Deployment[];
  activeDeployments: Record<Environment, Deployment | null>;
  selectedEnvironment: Environment;
  isDeploying: boolean;
  deployError: string | null;

  fetchDeployments: (projectId: string) => Promise<void>;
  createDeployment: (params: CreateDeploymentParams) => Promise<void>;
  rollback: (projectId: string, environment: Environment) => Promise<void>;
}
```

### 6.5 Feature: Diff Viewer

**Location**: Modal or dedicated view, triggered from version history

```
┌─ Diff: booking_agent v1.2.0 → v1.3.0 ─────────────────────┐
│                                                               │
│  ┌─ Left (v1.2.0) ─────────┐  ┌─ Right (v1.3.0) ──────────┐│
│  │  AGENT booking_agent     │  │  AGENT booking_agent       ││
│  │  ROLE: "Travel assistant"│  │  ROLE: "Travel assistant"  ││
│  │                          │  │                            ││
│  │  GATHER:                 │  │  GATHER:                   ││
│  │    destination:          │  │    destination:            ││
│  │      TYPE: string        │  │      TYPE: string          ││
│  │ -  check_in:             │  │ +  check_in:               ││
│  │ -    TYPE: string        │  │ +    TYPE: date             ││
│  │                          │  │ +  flight_class:            ││
│  │                          │  │ +    TYPE: enum             ││
│  │                          │  │ +    VALUES: [econ, bus]    ││
│  └──────────────────────────┘  └─────────────────────────────┘│
│                                                               │
│  +3 lines added  -1 line removed  2 files changed            │
│                                                               │
│  [Close]                                         [Revert →]  │
└───────────────────────────────────────────────────────────────┘
```

**Implementation**: Use Monaco Editor's built-in diff mode (`monaco.editor.createDiffEditor`).

### 6.6 Feature: Git Integration Panel

**Location**: Left sidebar tab or dedicated view

```
┌─ Git ──────────────────────────────────────────────────────┐
│                                                             │
│  ┌─ Repository ──────────────────────────────────────────┐ │
│  │  github.com/acme/travel-agents  [Disconnect]          │ │
│  │  Branch: develop  │  Sync: bidirectional              │ │
│  │  Last sync: 5 minutes ago  ● In sync                  │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                             │
│  ┌─ Branch Mapping ──────────────────────────────────────┐ │
│  │  main      → prod      (manual deploy)                │ │
│  │  staging   → staging   (auto-deploy on merge)         │ │
│  │  develop   → dev       (auto-deploy on push)          │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                             │
│  ┌─ Recent Syncs ────────────────────────────────────────┐ │
│  │  ↓ Pull  develop  3 files  5 min ago   ● Success      │ │
│  │  ↑ Push  develop  1 file   2h ago      ● Success      │ │
│  │  ↓ Pull  develop  2 files  1d ago      ● 1 error      │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                             │
│  [Pull Now]  [Push All]  [Import from Repo]                │
│                                                             │
│  ┌─ File Tree (from repo) ───────────────────────────────┐ │
│  │  📁 agents/                                            │ │
│  │    📄 booking_agent.agent.abl      ● synced            │ │
│  │    📄 supervisor.agent.abl         ● synced            │ │
│  │    📄 flight_search.agent.abl      ⚠ local changes    │ │
│  │  📁 tests/                                             │ │
│  │    📄 booking_agent.test.yaml                          │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

**Setup Flow (First Time)**:

```
┌─ Connect Repository ────────────────────────────────────────┐
│                                                               │
│  Step 1: Choose Provider                                      │
│  ┌────────┐  ┌────────┐  ┌──────────┐  ┌────────────┐      │
│  │ GitHub │  │ GitLab │  │Bitbucket │  │ Custom URL │      │
│  └────────┘  └────────┘  └──────────┘  └────────────┘      │
│                                                               │
│  Step 2: Repository URL                                       │
│  [https://github.com/org/repo                           ]    │
│                                                               │
│  Step 3: Authentication                                       │
│  ○ OAuth (recommended)    ○ Personal Access Token             │
│  [Authorize with GitHub]                                      │
│                                                               │
│  Step 4: Configure                                            │
│  Default branch:  [main        ▼]                            │
│  Agent directory: [agents/         ]                          │
│  Sync mode:       [Bidirectional ▼]                          │
│                                                               │
│  [Cancel]                                  [Connect & Import] │
└───────────────────────────────────────────────────────────────┘
```

### 6.7 Feature: Editor Toolbar Enhancement

The current editor has Save. Add version/deploy actions:

```
┌─ Editor Toolbar ──────────────────────────────────────────┐
│                                                            │
│  [Save ⌘S]  │  [Create Version]  │  [Deploy to dev ▼]   │
│              │                    │  ├─ dev               │
│  Auto-saved  │  Last: v1.3.0     │  ├─ staging           │
│  2s ago      │  2 hours ago       │  └─ prod (requires    │
│              │                    │       approval)       │
│              │                    │                        │
│  Parse: ✓    │  Compile: ✓       │  Deployed: dev ✓      │
│  0 errors    │  0 errors          │  v1.3.0               │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

### 6.8 Feature: "Quick Deploy" Flow (Studio Save → Dev Preview)

For the seamless development loop, Studio save can auto-deploy to dev:

```
User edits ABL in Monaco
         │
         ▼
  Auto-save (updates ProjectAgent.dslContent)
  Parse errors shown inline (red squiggles)
         │
         ▼
  Click "Create Version" button
    │  ─── Shows: compile result, changelog input
    │  ─── On success: version badge updates
         │
         ▼
  Click "Deploy to dev" (or auto-deploy checkbox)
    │  ─── Creates deployment with latest versions
    │  ─── Chat panel reconnects with new deployment
    │  ─── "Deployed ✓" indicator appears
         │
         ▼
  Chat panel shows live preview against new deployment
  Debug panel shows traces from new deployment
```

**Auto-deploy to dev option**: A toggle in editor toolbar. When enabled:

1. "Create Version" automatically triggers "Deploy to dev"
2. Chat panel auto-reconnects
3. Zero extra clicks for the edit→test loop

### 6.9 Feature: Environment Status Bar

Always visible at the bottom of Studio:

```
┌─ Status Bar ─────────────────────────────────────────────────────────┐
│  Project: travel-booking  │  dev: v1.3.0 ●  │  staging: v1.2.0 ●  │  prod: v1.1.0 ●  │  Git: ● synced  │
└──────────────────────────────────────────────────────────────────────┘
```

### 6.10 Sidebar Tabs Update

Current: `'agents' | 'sessions'`

New: `'agents' | 'sessions' | 'versions' | 'git'`

```typescript
// store/ui-store.ts
type SidebarTab = 'agents' | 'sessions' | 'versions' | 'git';
```

### 6.11 New Zustand Stores Summary

| Store                 | Purpose                  | Key State                                                                       |
| --------------------- | ------------------------ | ------------------------------------------------------------------------------- |
| `version-store.ts`    | Agent version management | `versions`, `activeVersionsByEnv`, `createVersion()`                            |
| `deployment-store.ts` | Deployment management    | `deployments`, `activeDeployments`, `createDeployment()`, `rollback()`          |
| `git-store.ts`        | Git integration state    | `repoConfig`, `syncStatus`, `recentSyncs`, `fileTree`, `pullNow()`, `pushAll()` |

### 6.12 New Components Summary

| Component               | Location               | Purpose                                             |
| ----------------------- | ---------------------- | --------------------------------------------------- |
| `VersionHistoryPanel`   | `components/versions/` | Version list, create, promote, diff links           |
| `CreateVersionModal`    | `components/versions/` | Changelog input, compile validation, create         |
| `VersionDiffViewer`     | `components/versions/` | Monaco diff editor for version comparison           |
| `DeploymentDashboard`   | `components/deploy/`   | Environment tabs, manifest view, history, rollback  |
| `CreateDeploymentModal` | `components/deploy/`   | Environment picker, manifest editor, deploy         |
| `GitPanel`              | `components/git/`      | Repo config, sync status, file tree, branch mapping |
| `GitConnectWizard`      | `components/git/`      | Multi-step repo connection setup                    |
| `EnvironmentStatusBar`  | `components/layout/`   | Always-visible env status + git sync indicator      |
| `EditorToolbar`         | `components/abl/`      | Save + Create Version + Deploy actions              |

---

## Prisma Schema (No Migration Needed)

All required fields already exist:

| Model          | Field                  | Purpose                                | Status |
| -------------- | ---------------------- | -------------------------------------- | ------ |
| `ProjectAgent` | `activeVersions`       | `{ dev: "1.0", prod: "0.9" }`          | Ready  |
| `AgentVersion` | `dslContent`           | Source DSL per version                 | Ready  |
| `AgentVersion` | `irContent`            | Compiled IR (at version time)          | Ready  |
| `AgentVersion` | `status`               | draft/testing/staged/active/deprecated | Ready  |
| `AgentVersion` | `sourceHash`           | Dedup key                              | Ready  |
| `Deployment`   | `agentVersionManifest` | Immutable `{ agent: version }`         | Ready  |
| `Deployment`   | `environment`          | dev/staging/prod/test                  | Ready  |
| `Deployment`   | `compilationHash`      | Cached hash of compiled output         | Ready  |
| `Deployment`   | `status`               | active/draining/retired                | Ready  |
| `Deployment`   | `endpointSlug`         | `/d/{slug}/chat`                       | Ready  |
| `Deployment`   | `previousDeploymentId` | Rollback chain                         | Ready  |
| `Session`      | `deploymentId`         | FK to Deployment                       | Ready  |
| `Session`      | `environment`          | Denormalized from Deployment           | Ready  |
| `SDKChannel`   | `deploymentId`         | Optional deployment pinning            | Ready  |

**One new field needed** for git integration:

```prisma
model Project {
  // ... existing fields ...
  gitConfig  String?  // JSON: ProjectGitConfig
}
```

---

## Implementation Order

```
Phase 1    VersionService + version API + compile at version time           ✅ IMPLEMENTED
Phase 2    DeploymentService + deployment API                               ⬜ Not started
Phase 3    SDK handler + chat.ts → deployment-aware sessions                ⬜ Not started
Phase 4    Session persistence wiring (getOrRehydrate, syncSessionToService)⬜ Not started
Phase 5    Git integration (GitSyncService, webhook, CLI support)           ⬜ Not started
Phase 6    Studio UI (versions panel, deployment dashboard, git panel)      ⬜ Not started
```

### Phase 1 Implementation Notes

Implemented in `066d4d2`. Key differences from the design pseudocode above:

- **Tenant isolation**: All methods require `tenantId`; uses `findAgentWithTenantGuard()` joining through `Project.tenantId` (since `ProjectAgent`/`AgentVersion` are non-RLS models)
- **RBAC**: Route handlers enforce `OWNER`/`ADMIN`/`OPERATOR` write roles via `requireWriteAccess()`
- **Middleware chain**: `authMiddleware → requireProjectScope() → tenantRateLimit('request')` on all routes
- **Audit logging**: Fire-and-forget helpers for `version.created`, `version.promoted`, `agent.dsl_updated`
- **Race condition handling**: P2002 unique constraint collision retried with fresh `nextVersion()`
- **Input validation**: DSL max 512KB, changelog max 10KB, status enum validated
- **Pagination**: `listVersions()` supports `limit`/`offset` (default 50, max 200)
- **Dedup UX**: Returns HTTP 200 + `deduplicated: true` when sourceHash matches latest
- **56 tests** covering all methods, tenant isolation, all valid/invalid transitions, race conditions

**Dependencies**:

- Phase 1 → 2 → 3 is strictly sequential
- Phase 4 is independent (can parallel with 1-3)
- Phase 5 depends on Phase 1 (version service)
- Phase 6 depends on Phase 1 + 2 (API endpoints must exist)

**Suggested implementation tranches**:

| Tranche           | Phases             | Outcome                               |
| ----------------- | ------------------ | ------------------------------------- |
| T1 (Backend Core) | 1, 2, 3            | Deployment pipeline works end-to-end  |
| T2 (Persistence)  | 4                  | Sessions survive pod restart          |
| T3 (Studio MVP)   | 6.3, 6.4, 6.7, 6.8 | Version + deploy from Studio          |
| T4 (Git)          | 5, 6.6             | Git sync working with UI              |
| T5 (Polish)       | 6.5, 6.9, 6.10     | Diff viewer, status bar, full sidebar |

---

## Verification

```bash
# 1. Type-check
pnpm tsc --noEmit -p apps/runtime/tsconfig.json

# 2. Unit tests — new services
pnpm vitest run apps/runtime/src/__tests__/version-service.test.ts
pnpm vitest run apps/runtime/src/__tests__/deployment-service.test.ts

# 3. Integration test — full lifecycle
#    create version → create deployment → SDK connect → session → verify deploymentId
pnpm vitest run apps/runtime/src/__tests__/deployment-lifecycle.test.ts

# 4. Existing tests still pass
pnpm vitest run apps/runtime/src/__tests__/

# 5. Verify no inline compilation in production path
grep -n "parseAgentBasedABL\|compileABLtoIR" apps/runtime/src/websocket/sdk-handler.ts
# Should find zero matches

# 6. Verify deploymentId is populated
grep -n "deploymentId" apps/runtime/src/websocket/sdk-handler.ts
# Should find it being set on session creation

# 7. Verify compilation only happens in VersionService
grep -rn "compileABLtoIR" apps/runtime/src/ --include="*.ts" | grep -v __tests__ | grep -v node_modules
# Should only appear in version-service.ts
```

---

## Performance Summary

| Operation                                       | Time       | Where                  |
| ----------------------------------------------- | ---------- | ---------------------- |
| Studio save (update working copy)               | ~5ms       | DB write               |
| Create Version (parse + compile + save)         | ~50-200ms  | VersionService         |
| Create Deployment (manifest + validate + cache) | ~50ms      | DeploymentService      |
| Session creation (load cached IR)               | ~5ms       | SessionService L1 hit  |
| Session creation (L2 Redis hit)                 | ~10ms      | SessionService L2      |
| Session creation (L3 DB fallback)               | ~50ms      | AgentVersion.irContent |
| Git import (per agent)                          | ~100-300ms | Parse + compile + save |
| Git webhook (full push)                         | ~500ms-2s  | Import + auto-deploy   |
