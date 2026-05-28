# RFC: Knowledge Graph LLM Configuration Flow (v2 - Workspace-Aware)

**Status:** Draft v2
**Created:** 2026-03-05
**Author:** Platform Team
**Supersedes:** RFC-KG-LLM-CONFIGURATION-FLOW.md v1

---

## Changes from v1

**v1 Issues:**

- ❌ Only checked tenant-level models
- ❌ Didn't check project workspace context
- ❌ Didn't inherit from other indexes in the same project
- ❌ No awareness of existing KG configurations

**v2 Improvements:**

- ✅ Workspace-aware configuration check
- ✅ Inherits from sibling indexes in same project
- ✅ Three-level fallback: Project → Tenant → Configure
- ✅ Shows what's already working in the workspace

---

## Platform Hierarchy

```
Tenant (Organization)
  └── Project (Workspace) ← SCOPE FOR INHERITANCE
      └── KnowledgeBase
          └── SearchIndex (1:1 link)
              └── llmConfig.useCases.knowledgeGraph
```

**Key Relationships:**

- `KnowledgeBase.projectId` - KB belongs to project
- `KnowledgeBase.searchIndexId` - Links to SearchIndex
- `SearchIndex.projectId` - Index belongs to project
- `SearchIndex.llmConfig.useCases.knowledgeGraph` - Per-index KG config

---

## Configuration Resolution Strategy

### **Level 1: Workspace Inheritance** ⭐ NEW

Check if **any other index in the same project** has KG configured:

```sql
-- Pseudo-query
SELECT searchIndexId, llmConfig.useCases.knowledgeGraph
FROM search_indexes
WHERE tenantId = ?
  AND projectId = ?  -- Same workspace
  AND llmConfig.useCases.knowledgeGraph.enabled = true
  AND _id != currentIndexId
LIMIT 1
```

**If found:**

```
✅ "Knowledge Graph is already configured in this workspace using Claude Sonnet 4.5"
   [Use same model] [Choose different model]
```

### **Level 2: Tenant Models**

If no workspace config, check tenant-level models:

```sql
SELECT * FROM tenant_models
WHERE tenantId = ?
  AND isActive = true
```

**If found:**

```
✅ "Select a model for Knowledge Graph"
   • Claude Sonnet 4.5 (Recommended)
   • GPT-4o (Fast and reliable)
```

### **Level 3: Configuration Needed**

If no models at all:

```
⚠️ "No LLM models configured"
   [Configure Models] → Navigate to /settings/models
```

---

## Updated API Design

### **GET /api/search-ai/indexes/:indexId/kg-configuration-status**

**New endpoint that checks all three levels:**

```typescript
Response:
{
  "configurationLevel": "workspace" | "tenant" | "none",

  // Level 1: Workspace inheritance (if available)
  "workspace": {
    "hasKGConfigured": true,
    "configuredIndexes": [
      {
        "indexId": "019abc...",
        "knowledgeBaseName": "Product Documentation",
        "model": {
          "id": "019def...",
          "displayName": "Claude Sonnet 4.5",
          "provider": "anthropic",
          "tier": "balanced"
        },
        "configuredAt": "2026-03-01T10:30:00Z"
      }
    ],
    "recommendation": {
      "action": "inherit",
      "message": "Use the same model as 'Product Documentation' for consistency"
    }
  },

  // Level 2: Tenant models (fallback)
  "tenant": {
    "models": [
      {
        "id": "019def...",
        "displayName": "Claude Sonnet 4.5",
        "provider": "anthropic",
        "tier": "balanced",
        "capabilities": {
          "knowledgeGraph": {
            "score": 1.0,
            "reasoning": "Best for KG workloads"
          }
        }
      },
      {
        "id": "019ghi...",
        "displayName": "GPT-4o",
        "provider": "openai",
        "tier": "powerful",
        "capabilities": {
          "knowledgeGraph": {
            "score": 0.95,
            "reasoning": "Fast and reliable"
          }
        }
      }
    ],
    "recommendation": {
      "modelId": "019def...",
      "reason": "Claude Sonnet 4.5 best for KG workloads"
    }
  },

  // Level 3: Configuration needed
  "requiresConfiguration": false
}
```

**Backend Implementation:**

```typescript
// apps/search-ai/src/routes/kg-taxonomy.ts

router.get('/:indexId/kg-configuration-status', async (req: Request, res: Response) => {
  const { indexId } = req.params;
  const tenantId = req.tenantContext!.tenantId;

  // Get current index to find projectId
  const SearchIndex = getModel('SearchIndex');
  const currentIndex = await SearchIndex.findOne({ _id: indexId, tenantId }).lean();
  if (!currentIndex) {
    res.status(404).json({ error: 'Index not found' });
    return;
  }

  const projectId = currentIndex.projectId;

  // ─── LEVEL 1: Check workspace (same project) ─────────────────────────

  const siblingIndexes = await SearchIndex.find({
    tenantId,
    projectId, // Same workspace
    _id: { $ne: indexId }, // Exclude current
    'llmConfig.useCases.knowledgeGraph.enabled': true,
  })
    .select('_id llmConfig.useCases.knowledgeGraph')
    .lean();

  let workspaceConfig = null;
  if (siblingIndexes.length > 0) {
    // Found existing KG config in workspace - get KB names
    const KnowledgeBase = getModel('KnowledgeBase');
    const configuredIndexes = await Promise.all(
      siblingIndexes.map(async (idx) => {
        const kb = await KnowledgeBase.findOne({
          searchIndexId: idx._id,
        }).select('name');

        const kgConfig = idx.llmConfig?.useCases?.knowledgeGraph;
        const modelId = kgConfig?.modelId;

        // Resolve model details
        let model = null;
        if (modelId) {
          const TenantModel = getModel('TenantModel');
          const tenantModel = await TenantModel.findOne({
            _id: modelId,
            tenantId,
          }).lean();
          if (tenantModel) {
            model = {
              id: tenantModel._id,
              displayName: tenantModel.displayName,
              provider: tenantModel.provider,
              tier: tenantModel.tier,
            };
          }
        }

        return {
          indexId: idx._id,
          knowledgeBaseName: kb?.name || 'Unknown',
          model,
          configuredAt: idx.updatedAt,
        };
      }),
    );

    workspaceConfig = {
      hasKGConfigured: true,
      configuredIndexes,
      recommendation: {
        action: 'inherit',
        message: `Use the same model as '${configuredIndexes[0].knowledgeBaseName}' for consistency`,
      },
    };

    // Early return with workspace inheritance option
    return res.json({
      configurationLevel: 'workspace',
      workspace: workspaceConfig,
      tenant: null,
      requiresConfiguration: false,
    });
  }

  // ─── LEVEL 2: Check tenant models ────────────────────────────────────

  const TenantModel = getModel('TenantModel');
  const tenantModels = await TenantModel.find({
    tenantId,
    isActive: true,
  }).lean();

  if (tenantModels.length === 0) {
    // No models configured anywhere
    return res.json({
      configurationLevel: 'none',
      workspace: { hasKGConfigured: false, configuredIndexes: [] },
      tenant: { models: [], recommendation: null },
      requiresConfiguration: true,
    });
  }

  // Assess tenant models for KG capabilities
  const assessedModels = tenantModels.map((model) => ({
    id: model._id,
    displayName: model.displayName,
    provider: model.provider,
    tier: model.tier,
    capabilities: assessKGCapabilities(model),
  }));

  const recommendation = recommendModelForKG(assessedModels);

  res.json({
    configurationLevel: 'tenant',
    workspace: { hasKGConfigured: false, configuredIndexes: [] },
    tenant: {
      models: assessedModels,
      recommendation,
    },
    requiresConfiguration: false,
  });
});
```

---

## Updated UI Flow

### **Component: KGConfigurationWizard**

```tsx
/**
 * KGConfigurationWizard Component
 *
 * Smart wizard that checks workspace context before showing model selection.
 * Three modes:
 * 1. Workspace Inheritance (best UX)
 * 2. Tenant Model Selection
 * 3. Configuration Guide
 */

export function KGConfigurationWizard({ indexId }: Props) {
  const [status, setStatus] = useState<KGConfigStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadConfigurationStatus();
  }, [indexId]);

  const loadConfigurationStatus = async () => {
    const response = await fetch(`/api/search-ai/indexes/${indexId}/kg-configuration-status`);
    const data = await response.json();
    setStatus(data);
    setIsLoading(false);
  };

  if (isLoading) return <LoadingSpinner />;

  // ─── MODE 1: Workspace Inheritance ────────────────────────────────────
  if (status.configurationLevel === 'workspace') {
    const existingConfig = status.workspace.configuredIndexes[0];

    return (
      <Card className="p-6">
        <div className="flex items-center gap-2 mb-4">
          <CheckCircle className="w-5 h-5 text-success" />
          <h3 className="text-lg font-semibold">Knowledge Graph Already Configured in Workspace</h3>
        </div>

        <p className="text-sm text-muted mb-4">
          Another knowledge base in this workspace is using Knowledge Graph.
        </p>

        {/* Show existing config */}
        <div className="bg-background-muted rounded-lg p-4 mb-6">
          <div className="flex items-start justify-between mb-2">
            <div>
              <p className="text-sm font-medium">{existingConfig.knowledgeBaseName}</p>
              <p className="text-xs text-muted">
                Configured {formatDate(existingConfig.configuredAt)}
              </p>
            </div>
            <Badge variant="success">Active</Badge>
          </div>

          {existingConfig.model && (
            <div className="flex items-center gap-2 mt-3 pt-3 border-t border-default">
              <Sparkles className="w-4 h-4 text-accent" />
              <span className="text-sm font-medium">{existingConfig.model.displayName}</span>
              <Badge variant="default" className="text-xs">
                {existingConfig.model.provider}
              </Badge>
            </div>
          )}
        </div>

        {/* Recommendation */}
        <div className="bg-accent/10 border border-accent rounded-lg p-4 mb-6">
          <p className="text-sm font-medium mb-1">💡 Recommended</p>
          <p className="text-xs text-muted">{status.workspace.recommendation.message}</p>
        </div>

        {/* Actions */}
        <div className="flex gap-3">
          <button
            onClick={() => inheritConfiguration(existingConfig.model.id)}
            className="flex-1 px-4 py-3 text-sm font-medium rounded-lg bg-accent text-accent-foreground hover:opacity-90"
          >
            Use Same Model
          </button>
          <button
            onClick={() => setMode('tenant-selection')}
            className="px-4 py-3 text-sm font-medium rounded-lg border border-default hover:bg-background-muted"
          >
            Choose Different
          </button>
        </div>
      </Card>
    );
  }

  // ─── MODE 2: Tenant Model Selection ───────────────────────────────────
  if (status.configurationLevel === 'tenant') {
    return (
      <KGModelSelectionCard
        models={status.tenant.models}
        recommendation={status.tenant.recommendation}
        onSelect={handleModelSelect}
      />
    );
  }

  // ─── MODE 3: Configuration Guide ──────────────────────────────────────
  if (status.requiresConfiguration) {
    return <KGConfigureModelsCard />;
  }
}
```

---

## User Experience Comparison

### **Scenario 1: New KB in Existing Workspace with KG**

**v1 (Old):**

```
User: Enable KG
  ↓
Show: "Select a model" (no context)
  ↓
User: "Which model should I use?" 🤔
```

**v2 (New):**

```
User: Enable KG
  ↓
Show: "✅ Product Docs is using Claude Sonnet 4.5"
      "💡 Use same model for consistency"
      [Use Same Model] [Choose Different]
  ↓
User: Clicks "Use Same Model" ✨ (1 click, no thinking)
```

**Benefit:** Workspace consistency + faster setup

---

### **Scenario 2: First KB in Workspace, Tenant Has Models**

**v1 (Old):**

```
User: Enable KG
  ↓
Show: All tenant models (no context which is best)
```

**v2 (New):**

```
User: Enable KG
  ↓
Show: "💡 Recommended: Claude Sonnet 4.5"
      "Best balance of cost and quality for KG"
      ✅ Custom domains
      ✅ Entity extraction
      [Configure & Enable]
```

**Benefit:** Clear guidance on best choice

---

### **Scenario 3: No Models Configured**

**Both versions show:**

```
⚠️ "No models configured"
   [Configure Models] → /settings/models
```

---

## Database Queries

### **Query 1: Check Workspace KG Config**

```mongodb
db.search_indexes.find({
  tenantId: "tenant-dev-001",
  projectId: "019abc...",  // Same workspace
  "llmConfig.useCases.knowledgeGraph.enabled": true
})
```

**Index:** `{ tenantId: 1, projectId: 1, "llmConfig.useCases.knowledgeGraph.enabled": 1 }`

### **Query 2: Get KB Name for Index**

```mongodb
db.knowledge_bases.findOne({
  searchIndexId: "019def..."
}, {
  name: 1
})
```

**Index:** `{ searchIndexId: 1 }` (already exists)

### **Query 3: Resolve Model Details**

```mongodb
db.tenant_models.findOne({
  _id: "019ghi...",
  tenantId: "tenant-dev-001"
})
```

**Index:** `{ _id: 1, tenantId: 1 }` (primary key + tenant isolation)

---

## Configuration Storage

### **Option A: Copy Model Reference** ⭐ Recommended

```typescript
// When user clicks "Use Same Model"
await SearchIndex.findOneAndUpdate(
  { _id: indexId, tenantId },
  {
    $set: {
      'llmConfig.useCases.knowledgeGraph': {
        enabled: true,
        modelId: inheritedModelId, // ← Copy from sibling
        modelTier: 'balanced',
        maxTokens: 4096,
        temperature: 0.2,
        inheritedFrom: siblingIndexId, // ← Track source (optional)
      },
    },
  },
);
```

**Benefits:**

- ✅ Each index has explicit configuration
- ✅ No dependency on sibling index
- ✅ Can customize per-index later
- ✅ Clear audit trail

### **Option B: Workspace-Level Config** (Future Enhancement)

```typescript
// Store at project level (future)
interface ProjectLLMConfig {
  projectId: string;
  knowledgeGraph: {
    defaultModelId: string;
    // All KBs in project inherit unless overridden
  };
}
```

**Benefits:**

- ✅ Single source of truth for workspace
- ✅ Easier to change all KBs at once
- ⚠️ Requires schema changes

**Recommendation:** Start with Option A, consider Option B for v3

---

## API Endpoints Summary

### **New Endpoints**

```
GET  /api/search-ai/indexes/:indexId/kg-configuration-status
  → Returns: workspace config, tenant models, or configuration needed

POST /api/search-ai/indexes/:indexId/kg-configure-model
  Body: { modelId, inheritedFrom? }
  → Stores model selection in SearchIndex.llmConfig
```

### **Modified Endpoints**

```
None - backward compatible
```

---

## Implementation Checklist

### **Phase 1: Backend API (Week 1)**

- [ ] Add `GET /kg-configuration-status` endpoint
- [ ] Implement workspace sibling index check
- [ ] Add KB name resolution
- [ ] Add model capability assessment
- [ ] Write tests for all three levels

### **Phase 2: Frontend UI (Week 1)**

- [ ] Create `KGConfigurationWizard` component
- [ ] Add workspace inheritance card
- [ ] Add tenant model selection card
- [ ] Add configuration guide card
- [ ] Add transitions between modes

### **Phase 3: Integration (Week 1)**

- [ ] Integrate with `KnowledgeGraphTab`
- [ ] Update credential resolution to use configured model
- [ ] Add telemetry (inheritance usage, model selection)
- [ ] Test with multiple workspaces

---

## Success Metrics

1. **Workspace Inheritance Usage:**
   - Target: 70% of new KG enablements use "Use Same Model"
   - Metric: `kg_model_source: 'workspace' | 'tenant' | 'configured'`

2. **Setup Time Reduction:**
   - v1: 3-5 minutes (browse models, decide)
   - v2: 30 seconds (one click inherit)
   - Target: 5x faster for workspace scenarios

3. **Configuration Errors:**
   - Reduce "LLM unavailable" errors by 90%
   - Track: `kg_enablement_success_rate`

---

## FAQ

**Q: What if the sibling index's model is deleted?**
A: The config check validates model still exists before showing inheritance option.

**Q: Can users override workspace model later?**
A: Yes - they can reconfigure any index independently.

**Q: What if workspace has multiple different models?**
A: Show the most recently configured one as the recommendation.

**Q: Should we show ALL sibling configs or just one?**
A: v2: Show most recent. v3: Let user browse all.

---

## Conclusion

**v2 Improvements:**

- ✅ Workspace-aware (checks same project)
- ✅ Inherits from sibling indexes (better UX)
- ✅ Three-level fallback strategy
- ✅ Consistent workspace configuration
- ✅ Faster setup (1 click vs 5 decisions)

**Next Steps:**

1. Review with team
2. Implement Phase 1 (backend API)
3. Test with multiple workspace scenarios
4. Deploy to dev

---

**Status:** Ready for Implementation
**Estimated Effort:** 3 weeks (all phases)
**Priority:** HIGH
