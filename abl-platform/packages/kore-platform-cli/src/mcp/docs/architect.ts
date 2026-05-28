/**
 * Architect Documentation
 *
 * Embedded documentation for the architect and import tools.
 */

export const ARCHITECT_DOCS = `# Architect & Import Tools

## Overview

The architect tools let you design ABL agent architectures from scratch or import from existing Kore.ai platforms. All architect/import tools are **local-only** and don't require platform authentication.

## Architecture Patterns

| Pattern | Description | When to Use |
|---|---|---|
| **Single Agent** | One agent handles everything | Simple use cases, single domain, <3 intents |
| **Multi-Agent Supervisor** | Supervisor routes to specialist agents | Complex multi-domain, centralized orchestration |
| **Adaptive Agent Network** | Peer-to-peer agent handoff | Organic workflows, no single orchestration point |

## Workflow

### Scenario 1: New Project from Use Case

1. \`kore_architect_analyze\` - Describe your use case + existing APIs → get architecture spec
2. Review the spec (topology, agents, tools, gaps)
3. \`kore_architect_generate\` - Generate complete ABL project
4. \`kore_architect_validate\` - Verify generated files parse correctly
5. Iterate: \`kore_architect_generate_agent\` to regenerate individual agents

### Scenario 2: Import from Kore.ai Agent Platform (v12)

1. \`kore_import_analyze\` - Provide JSON export → get conversion plan with gaps
2. Review mappings and gap report
3. \`kore_import_convert\` - Convert to ABL project
4. \`kore_architect_validate\` - Verify generated files

### Scenario 3: Import from Kore.ai XO11

1. \`kore_import_analyze\` - Provide JSON export → auto-detects XO11 format
2. Review mappings (dialog flows → agents, nodes → tools/gather)
3. \`kore_import_convert\` - Convert to ABL project
4. \`kore_architect_validate\` - Verify generated files

## Tool Reference

### kore_architect_analyze
Analyzes a use case description and optional existing API specs to produce an architecture specification. Calls Claude API (requires ANTHROPIC_API_KEY).

**Input:**
- \`useCase\` (string, required): Natural language description of the system
- \`existingApis\` (array, optional): Existing backend services/APIs
- \`constraints\` (string, optional): Design constraints

**Output:** Architecture spec with topology, agent definitions, tool mappings, and gap report.

### kore_architect_generate
Generates a complete ABL project from an architecture specification.

**Input:**
- \`spec\` (object, required): Architecture spec from analyze
- \`outputDir\` (string, required): Directory to create project in

**Output:** Project directory with ABL files, README, and documentation.

### kore_architect_generate_agent
Generates a single .agent.abl file from an agent specification.

**Input:**
- \`agent\` (object, required): Single agent spec

**Output:** ABL file content as text.

### kore_architect_generate_docs
Generates only documentation files for an architecture spec (no ABL files).

**Input:**
- \`spec\` (object, required): Architecture spec
- \`outputDir\` (string, required): Directory to create docs in

**Output:** Documentation files (README, architecture, best-practices, limitations, deployment).

### kore_import_analyze
Analyzes a Kore.ai export (Agent Platform v12 or XO11) and produces a conversion plan.

**Input:**
- \`sourceJson\` (object, required): The full JSON export

**Output:** Import analysis with format detection, entity mappings, gap report, and suggested topology.

### kore_import_convert
Converts an analyzed import to a complete ABL project.

**Input:**
- \`analysis\` (object, required): Analysis from kore_import_analyze
- \`sourceJson\` (object, required): Original JSON export
- \`outputDir\` (string, required): Directory to create project in

**Output:** Project directory with ABL files and documentation.

### kore_architect_validate
Validates .agent.abl files for syntax errors.

**Input:**
- \`path\` (string, required): Path to a file or directory containing .agent.abl files

**Output:** Validation results with errors and warnings.

## Example Output

\`\`\`
AGENT Hotel_Booking_Agent
  MODE scripted
  GOAL "Help users book hotel rooms"

  TOOLS
    search_hotels: "Search available hotels"
      PARAMS: city (string, required), dates (string, required)
      RETURNS: object
    create_booking: "Create a hotel reservation"
      PARAMS: hotel_id (string, required), guest_name (string, required)
      RETURNS: object

  GATHER
    destination: "Which city?" (string, required)
    check_in: "Check-in date?" (date, required)

  FLOW
    collect_info -> search -> confirm -> complete
\`\`\`

## ABL Gap Detection

The architect automatically identifies ABL limitations and suggests alternatives:

### Known Gaps
- No native HTTP/API calls → use TOOLS
- No loops/iteration → use recursive FLOW or reasoning mode
- No timers/scheduling → use external cron + ON_START
- No database queries → use TOOLS wrapping DB access
- No conditional GATHER → use scripted FLOW with branching
- No file upload handling → use TOOLS with file handler
- No real-time streaming → use TOOLS with polling
- No arithmetic in conditions → use TOOLS for calculations

### Agent Platform v12 Gaps
- JavaScript processors → reimplemented as TOOLS
- Voice/VAD config → platform-level, not in ABL
- PII masking → GUARDRAILS with input checks
- Per-agent model config → deployment-level configuration
- Content variables → MEMORY persistent paths

### XO11 Gaps
- Script nodes → reimplemented as TOOLS
- Rich cards/carousels → text-based RESPOND
`;
