---
description: Convert analysis documents to Jira tickets with intelligent extraction and preview
user-invocable: true
---

# Analysis to Jira Skill

Convert freeform analysis documents (bug reports, architectural reviews, feature proposals) into structured Jira tickets.

## Usage

```bash
# From a local analysis file (recommended - gitignored folder)
/analysis-to-jira .local-analysis/nlu-sidecar-config-issue.md

# From docs/analysis/ (use for formal analysis that should be committed)
/analysis-to-jira docs/analysis/search-ai-performance-review.md

# From conversation context (recent analysis)
/analysis-to-jira
```

**Tip:** Use `.local-analysis/` for exploratory work - it's gitignored so your notes stay local until you convert them to Jira tickets.

## Workflow

### Step 1: Read the Analysis

- If file path provided: read the file
- If no path: extract analysis from recent conversation context (last 5-10 messages)
- Support any markdown format - no rigid structure required

### Step 2: Extract Key Information

Parse the document to identify:

1. **Problem Statement** - What issue/opportunity is being described?
2. **Analysis** - Key findings, root causes, context
3. **Proposed Solution** (if present) - Recommended approach
4. **Severity Indicators** - Words like "broken", "blocking", "security", "data loss" suggest priority

Generate a concise summary line (under 70 characters) for the ticket title.

### Step 3: Ask Clarifying Questions

Present the extracted information and ask:

```
I extracted the following for the Jira ticket:

Summary: [generated summary]

Description:
[formatted description with Problem/Analysis/Solution sections]

Please confirm or adjust:
1. Summary line (enter to keep, or provide new)
2. Labels (comma-separated, or enter to skip)
3. Priority (High/Medium/Low, or enter to skip)
4. Assignee email (or enter to skip)
5. Project key (enter for ABLP, or provide different)
```

### Step 4: Preview the Ticket

Show the final ticket structure:

```
Project: ABLP
Type: Story
Summary: [final summary]
Labels: [labels if any]
Priority: [priority if any]
Assignee: [assignee if any]

Description:
[formatted ADF-compatible markdown]

Create this ticket? (y/n)
```

### Step 5: Create the Ticket

If confirmed:

- Call `scripts/create-jira-ticket.ts` with the structured arguments
- Print the created ticket key and URL
- Optionally add the ticket key to clipboard or suggest commit format

## Extraction Heuristics

### Identifying Summary

Look for:

1. First heading (`# ...` or `## ...`)
2. First sentence if it's a clear problem statement
3. "Summary" or "Problem" section first line
4. Synthesize from content if none of above work

**Good summaries:**

- "NLU sidecar URL should be platform-level config"
- "SearchAI ingestion fails on large PDFs"
- "Add bulk delete API for tenant cleanup"

**Bad summaries (too long/vague):**

- "There is an issue with the configuration..." (vague)
- "Detailed analysis of architectural inconsistency in the NLU sidecar configuration..." (too long)

### Identifying Problem/Analysis/Solution

Common section headers:

- Problem: `## Problem`, `## Issue`, `## Background`, `## Context`
- Analysis: `## Analysis`, `## Root Cause`, `## Findings`, `## Investigation`
- Solution: `## Proposed Solution`, `## Solution`, `## Recommendation`, `## Approach`

If sections aren't explicitly marked, use content structure:

- First paragraphs/bullets → Problem
- Middle content with "because", "due to", "caused by" → Analysis
- Final content with "should", "recommend", "proposed" → Solution

### Detecting Priority

**High priority indicators:**

- "broken", "blocking", "production", "security", "data loss", "crash", "urgent"

**Medium priority indicators:**

- "inconsistent", "confusing", "technical debt", "refactor"

**Low priority indicators:**

- "nice to have", "future", "enhancement", "quality of life"

## Output Format

The description should be formatted for Jira's Atlassian Document Format (ADF):

```markdown
## Problem

[problem description]

## Analysis

[key findings]

## Proposed Solution

[recommended approach]
```

Bullet lists, code blocks, and headings are preserved.

## Error Handling

- **No analysis found**: Ask user to provide file path or clarify what to convert
- **File not found**: Print error and ask for correct path
- **Jira credentials missing**: Print error with setup instructions
- **Ticket creation fails**: Show error message, save ticket content to temp file for manual creation

## Example

**Input file** (`.local-analysis/nlu-sidecar-issue.md`):

```markdown
# NLU Sidecar Configuration Issue

The NLU sidecar URL is configured per-project, but the sidecar is a stateless
platform-level service. This creates several issues:

- Configuration drift across projects
- No actual isolation benefit (no auth, single container)
- Inconsistent with how we configure other platform services

Should move this to a platform-level NLU_SIDECAR_URL environment variable.
```

**Extracted:**

- Summary: "NLU sidecar URL should be platform-level config"
- Priority: Medium (detected from "issue", "inconsistent")
- Labels: (asks user)

**Created ticket:** ABLP-294 with structured description.

## Integration with Workflow

After creating the ticket:

1. Print ticket key and URL
2. If analysis document was in `.local-analysis/`, remind user it's gitignored and can be deleted or kept for local reference
3. If analysis document was in `docs/analysis/`, suggest moving to `docs/analysis/archive/` or updating with ticket reference
4. If in an active branch, suggest commit format: `[ABLP-XXX] fix: ...`
