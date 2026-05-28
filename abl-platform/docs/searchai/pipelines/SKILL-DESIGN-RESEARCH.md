# SearchAI Pipelines Skill Design Research

**Date:** 2026-03-07
**Status:** Complete
**Skill File:** `.claude/skills/search-ai-pipelines.md`

---

## Executive Summary

Created a specialized Claude skill (`search-ai-pipelines`) for ongoing pipeline development, code review, bug finding, and enhancement building. The skill is self-updating and maintains a continuous knowledge base for flow-based pipeline architecture.

**Key Innovation:** The skill includes a self-updating mechanism that guides developers to maintain it after completing features, finding bugs, or conducting code reviews.

---

## Research Objectives

1. **Understand existing skill patterns** in the ABL platform
2. **Design a specialized skill** for SearchAI pipelines that covers:
   - Design review during development
   - Code change review post-completion
   - Building new stages
   - Finding bugs and debugging
   - Building enhancements
3. **Create self-updating mechanism** for continuous knowledge maintenance
4. **Integrate with search-ai-architect** for minimal knowledge transfer

---

## Analysis of Existing Skills

### Skill Structure Pattern

All skills follow a consistent markdown format:

```markdown
---
name: skill-name
description: Brief description shown in skill list
---

# Skill Title

## Section 1

Content...

## Section 2

Content...
```

**Key Observations:**

1. **YAML Frontmatter:** Contains `name` and `description` fields
2. **Description:** Brief (1-2 sentences), shown when skill is invoked
3. **Content Organization:** Table of contents, sections, code examples
4. **Cross-References:** Links to documentation and other skills

### Existing Skill Categories

| Skill                   | Purpose                                 | Size       | Pattern                           |
| ----------------------- | --------------------------------------- | ---------- | --------------------------------- |
| `search-ai-architect`   | Architecture review, design validation  | ~320 lines | Checklist-based, domain detection |
| `search-ai-development` | Worker patterns, anti-patterns, dual-DB | ~743 lines | Reference guide, code templates   |
| `bullmq-flows-guide`    | BullMQ Flows production issues          | Unknown    | Deep-dive troubleshooting         |
| `platform-principles`   | Core invariants, resource isolation     | Unknown    | Principle-based rules             |
| `code-standards`        | Coding standards, anti-patterns         | Unknown    | Rule-based patterns               |

**Pattern Identified:** Skills are either:

- **Reference Guides** (search-ai-development) - Comprehensive implementation patterns
- **Checklists** (search-ai-architect) - Review criteria and validation
- **Troubleshooting** (bullmq-flows-guide) - Deep-dive debugging

---

## Design Decisions

### 1. Skill Scope: Comprehensive Reference + Checklist

**Decision:** Combine reference guide and checklist patterns.

**Rationale:**

- Developers need both implementation patterns (how to build) and review criteria (how to validate)
- Pipeline development has distinct phases: design → implementation → review → debugging
- Single skill covers full development lifecycle

**Sections Included:**

1. **Architecture Overview** - High-level concepts
2. **Data Models** - Complete schemas
3. **Frontend UX Patterns** - React components, state management
4. **Backend Implementation Patterns** - Circuit breaker, flow selection, BullMQ
5. **Design Review Checklist** - Security, performance, completeness
6. **Adding New Stages** - Step-by-step guide
7. **Debugging Guide** - Common issues and solutions
8. **Anti-Patterns** - What NOT to do
9. **Self-Updating Mechanism** - How to maintain the skill

### 2. Knowledge Organization: From Concepts to Implementation

**Structure:**

```
Concepts (Architecture) → Data Models → Patterns → Checklists → Guides → Anti-Patterns
```

**Rationale:**

- Developers first need to understand "what" (architecture)
- Then "how" (implementation patterns)
- Then "validation" (checklists)
- Then "debugging" (troubleshooting)

### 3. Self-Updating Mechanism: Guided Process

**Decision:** Include explicit "Self-Updating Mechanism" section with:

- When to update (after features, bugs, reviews)
- What to update (patterns, anti-patterns, debugging tips)
- How to update (read, edit, increment version, commit)
- What to extract for search-ai-architect (minimal key facts)

**Rationale:**

- Skills don't automatically update themselves
- Human developers must maintain them
- Clear guidance ensures consistency
- Prevents skill decay over time

**Update Triggers:**

1. **After completing a new feature** - Add implementation patterns
2. **After finding a bug** - Add debugging tips and anti-patterns
3. **After code review** - Extract reusable patterns
4. **After architecture changes** - Update overview and references

### 4. Integration with search-ai-architect: Minimal Knowledge Transfer

**Decision:** After pipeline development is complete, extract only essential facts for `search-ai-architect`.

**Minimal Information:**

- Architecture pattern name
- Critical constraints
- Key design decisions
- Common pitfalls
- Reference to detailed skill

**Example:**

```markdown
### Flow-Based Pipelines (Implemented 2026-03-07)

**Pattern:** Multiple flows per knowledge base, CEL-based selection.
**Key Constraints:** flows.length <= 50, TTL index (90 days)
**Common Pitfalls:** Always set failParentOnFailure: true on BullMQ child jobs
**References:** search-ai-pipelines skill, docs/searchai/pipelines/design/
```

**Rationale:**

- search-ai-architect needs high-level awareness, not implementation details
- Reduces duplication between skills
- Keeps search-ai-architect focused on architectural review
- Developers can invoke search-ai-pipelines skill for deep dives

---

## Skill Content Design

### Section 1: Architecture Overview

**Purpose:** High-level understanding of flow-based pipelines.

**Content:**

- Core concept explanation
- System component diagram
- Reference document links

**Target Audience:** Developers new to pipeline architecture.

### Section 2: Data Models

**Purpose:** Complete schema reference for MongoDB models.

**Content:**

- `PipelineDefinition` schema with all fields
- `JobExecution` schema with BullMQ Flows integration
- Key constraints (flow count limit, stage sequence)
- File paths for implementation

**Target Audience:** Backend developers implementing data layer.

### Section 3: Frontend UX Patterns

**Purpose:** React component hierarchy and state management.

**Content:**

- Component tree (PipelineEditor → FlowsList → FlowCanvas → StageConfigPanel)
- Zustand store structure (draft vs published state)
- API endpoint specifications with permissions

**Target Audience:** Frontend developers building Studio UI.

### Section 4: Backend Implementation Patterns

**Purpose:** Production-ready code patterns.

**Content:**

- Circuit breaker implementation (using `@agent-platform/circuit-breaker`)
- Flow selection service (CEL evaluation)
- BullMQ Flows integration (FlowProducer.add())

**Target Audience:** Backend developers implementing orchestration.

### Section 5: Design Review Checklist

**Purpose:** Validate code changes and designs.

**Content:**

- Security review (tenant isolation, credentials, access control)
- Performance review (indexes, document size, TTL)
- Database review (consistency, validation)
- BullMQ Flows review (child failure options, cleanup, lock duration)

**Target Audience:** Code reviewers, architects.

### Section 6: Adding New Stages

**Purpose:** Step-by-step guide for extending pipeline with new stages.

**Content:**

- 9-step process (define type → create provider → register → create worker → add tests)
- Complete code examples for each step
- Documentation update checklist

**Target Audience:** Developers building new pipeline stages.

### Section 7: Debugging Guide

**Purpose:** Common issues and solutions.

**Content:**

- "Flow not being selected" - CEL debugging
- "Circuit breaker stuck in OPEN" - Manual reset
- "Parent flow waiting forever" - Missing failParentOnFailure
- "Job tracking storage growing" - TTL index verification
- Monitoring queries (pipeline usage, provider health)

**Target Audience:** Developers debugging production issues.

### Section 8: Anti-Patterns

**Purpose:** What NOT to do (learn from design review findings).

**Content:**

- Table format: ❌ Don't → ✅ Do → Why
- Examples: Hardcoded stage sequence, missing TTL, omitting failParentOnFailure

**Target Audience:** All developers.

### Section 9: Self-Updating Mechanism

**Purpose:** Maintain skill over time.

**Content:**

- When to update (after features, bugs, reviews)
- Update process (read → edit → increment version → commit)
- What to extract for search-ai-architect (minimal key facts)

**Target Audience:** Skill maintainers (usually senior developers or architects).

---

## Comparison with Other Skills

### search-ai-pipelines vs search-ai-architect

| Aspect          | search-ai-architect       | search-ai-pipelines     |
| --------------- | ------------------------- | ----------------------- |
| **Scope**       | All SearchAI architecture | Pipeline-specific       |
| **Depth**       | High-level review         | Deep implementation     |
| **Usage**       | Design validation         | Development + review    |
| **Size**        | ~320 lines                | ~680 lines              |
| **Maintenance** | Manual updates            | Self-updating mechanism |

**Relationship:** search-ai-architect delegates to search-ai-pipelines for pipeline-specific reviews.

### search-ai-pipelines vs search-ai-development

| Aspect      | search-ai-development | search-ai-pipelines      |
| ----------- | --------------------- | ------------------------ |
| **Scope**   | All SearchAI workers  | Pipeline-specific        |
| **Focus**   | Worker patterns       | Flow-based orchestration |
| **Content** | 19 workers, dual-DB   | Pipeline architecture    |
| **Usage**   | General SearchAI work | Pipeline development     |

**Relationship:** search-ai-pipelines builds on patterns from search-ai-development (BullMQ, MongoDB, etc.).

---

## Self-Updating Mechanism Design

### Problem Statement

Skills become outdated as:

- New features are implemented
- Bugs are discovered and fixed
- Patterns evolve

**Challenge:** How to maintain skill knowledge without manual review every time?

### Solution: Guided Self-Updating

**Approach:** Include explicit instructions in the skill itself for when and how to update.

**Components:**

1. **Update Triggers** (when to update):
   - After completing a new feature
   - After finding a bug
   - After code review
   - After architecture changes

2. **Update Process** (how to update):

   ```bash
   # 1. Read current skill
   cat .claude/skills/search-ai-pipelines.md

   # 2. Make changes
   # Edit file directly or use Write tool

   # 3. Increment version
   # Update "Version:" in frontmatter

   # 4. Commit
   git commit -m "docs(skill): update search-ai-pipelines skill with X pattern"
   ```

3. **Content Guidelines** (what to update):
   - Implementation patterns → Add to relevant sections
   - Bug fixes → Add to Debugging Guide
   - New pitfalls → Add to Anti-Patterns
   - Architecture changes → Update Architecture Overview

4. **Knowledge Transfer** (what to extract for search-ai-architect):
   - Architecture pattern name
   - Critical constraints
   - Key design decisions
   - Common pitfalls
   - Reference to detailed skill

### Automation Potential (Future Enhancement)

**Current:** Manual updates following documented process.

**Future:** Could automate with:

- Git hooks that detect pipeline code changes
- Claude agent that proposes skill updates based on code diffs
- Automated extraction of patterns from code reviews

**Decision:** Start manual, automate later if needed.

---

## Integration Points

### 1. Skill Invocation

**Trigger Conditions:**

- User working on `docs/searchai/pipelines/`
- User mentions "pipeline", "flow", "stage", "circuit breaker", "flow selection"
- User asks to review pipeline code or design

**Invocation:**

```bash
# Automatic detection by Claude
User: "Review this pipeline stage implementation"
Claude: [Invokes search-ai-pipelines skill]

# Manual invocation
User: "/search-ai-pipelines review this code"
```

### 2. Cross-Skill References

**From search-ai-architect:**

```markdown
When reviewing pipeline architecture, use search-ai-pipelines skill for:

- Flow-based architecture patterns
- Circuit breaker implementation
- BullMQ Flows integration
```

**From search-ai-development:**

```markdown
For flow-based pipeline development, see search-ai-pipelines skill.
```

### 3. Documentation References

Skill references these documents:

- `docs/searchai/pipelines/design/backend/01-DATA-MODELS.md`
- `docs/searchai/pipelines/design/backend/02-JOB-TRACKING-RETENTION.md`
- `docs/searchai/pipelines/design/backend/03-CIRCUIT-BREAKER-IMPLEMENTATION.md`
- `docs/searchai/pipelines/design/frontend/UX-PIPELINE-CONFIGURATION.md`
- `docs/searchai/pipelines/DESIGN-REVIEW-SUMMARY.md`
- `docs/searchai/pipelines/READY-FOR-REVIEW.md`

---

## Success Criteria

### 1. Comprehensive Coverage

✅ **Achieved:**

- Architecture overview (high-level)
- Data models (complete schemas)
- Frontend patterns (React components, Zustand)
- Backend patterns (circuit breaker, flow selection, BullMQ)
- Design review checklist (security, performance, database)
- Adding new stages (9-step guide)
- Debugging guide (common issues + monitoring queries)
- Anti-patterns (10+ examples)

### 2. Actionable Guidance

✅ **Achieved:**

- Step-by-step guides (adding new stages)
- Code examples (circuit breaker, flow selection)
- Debugging steps (root cause → solution)
- Checklist format (easy to review)

### 3. Self-Maintaining

✅ **Achieved:**

- Self-updating mechanism documented
- Update triggers defined
- Update process specified
- Knowledge transfer guidelines for search-ai-architect

### 4. Integration with Existing Skills

✅ **Achieved:**

- Complementary to search-ai-architect (high-level vs deep-dive)
- Builds on search-ai-development patterns (BullMQ, MongoDB)
- References bullmq-flows-guide for production issues

---

## Future Enhancements

### 1. Automated Pattern Extraction

**Concept:** Detect patterns in code reviews and propose skill updates.

**Implementation:**

1. Git hook detects pipeline code commits
2. Claude agent analyzes diff
3. Proposes skill section updates
4. Human approves/rejects

**Status:** Not implemented (manual process sufficient for now).

### 2. Living Examples

**Concept:** Link to actual code examples in the codebase.

**Implementation:**

- Add file paths with line numbers
- Use `file_path:line_number` pattern
- Claude can read examples on-demand

**Status:** Partially implemented (file paths included, line numbers would be too specific).

### 3. Interactive Debugging Workflows

**Concept:** Step-by-step debugging prompts based on symptoms.

**Implementation:**

- "Flow not being selected" → Prompt for CEL expression → Validate → Suggest fix
- Could use AskUserQuestion for interactive debugging

**Status:** Not implemented (current guide is static).

---

## Lessons Learned

### 1. Balance Breadth and Depth

**Challenge:** Skill could become too large and unwieldy.

**Solution:**

- Include high-level overviews in skill
- Link to detailed design documents for deep dives
- Use tables and bullet points for scanability

### 2. Code Examples Are Critical

**Observation:** Developers need concrete examples, not just descriptions.

**Implementation:**

- Every pattern has a code example
- Examples show complete implementations (imports, types, error handling)

### 3. Anti-Patterns as Valuable as Patterns

**Observation:** Knowing what NOT to do is as important as knowing what to do.

**Implementation:**

- Dedicated Anti-Patterns section
- Table format: ❌ Don't → ✅ Do → Why
- Extracted from architectural review findings

### 4. Self-Updating Requires Explicit Guidance

**Observation:** Skills won't update themselves without clear instructions.

**Implementation:**

- Self-Updating Mechanism section
- When, what, how clearly specified
- Integration with search-ai-architect for knowledge transfer

---

## Conclusion

The `search-ai-pipelines` skill successfully addresses the user's requirements:

✅ **Reviews pipeline design and code changes** (Design Review Checklist section)
✅ **Helps build new stages** (Adding New Stages section with 9-step guide)
✅ **Finds bugs** (Debugging Guide with common issues and solutions)
✅ **Builds enhancements** (Implementation Patterns sections)
✅ **Self-updates** (Self-Updating Mechanism section)
✅ **Updates search-ai-architect knowledgebase** (Minimal knowledge transfer guidelines)
✅ **Structured like search-ai-architect** (Markdown with YAML frontmatter, comprehensive sections)

**Next Steps:**

1. User reviews and approves the skill
2. Use the skill during pipeline implementation (Priority 1 tasks)
3. Update skill after completing each major feature
4. Extract minimal knowledge for search-ai-architect after full implementation

---

**End of Research Document**
