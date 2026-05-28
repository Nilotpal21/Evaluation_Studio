# agents.md — packages / i18n

Agent learning journal for this package. Append-only log of architectural decisions, patterns, gotchas, and insights discovered during SDLC work.

Agents MUST read this file before modifying code in this package. Agents MUST append learnings after completing work.

---

<!-- Append new entries below this line. Format:
## <DATE> — <Feature/Context>
**Category**: architecture | testing | pattern | gotcha | process
**Learning**: <what was learned — specific and actionable>
**Files**: <key files involved>
**Impact**: <how this affects future work in this package>
-->

## 2026-04-25 — Agent Assist gets its own i18n namespace (ABLP-390)

**Category**: architecture
**Learning**: When a new feature is a standalone settings page (not nested under another), it gets its own top-level i18n namespace under `settings.<feature>`. Agent Assist was first wired with its strings under `settings.agent_transfer.agent_assist_*` because it shipped as a section inside the Agent Transfer page. When Agent Assist became its own top-level sidebar item, all its keys moved to `settings.agent_assist`. The mechanical work was easy (`Edit` to relocate the block in `locales/en/studio.json`); the lesson is the planning one — don't pile a new feature's strings under an unrelated existing namespace just because the UI temporarily nests it. When the UI surface eventually moves up a level (which it usually does), you own the migration cost across every supported locale.

**Files**: `locales/en/studio.json` (`settings.agent_assist` namespace, plus `settings.tabs.agent_assist` label and `nav.settings.agent_assist` sidebar label)

**Impact**: For any new project-level integration / setting that may eventually need a top-level UI page, allocate `settings.<slug>` from day one in `studio.json`, even if the initial UI nests it. Adding the namespace alongside an existing one early is free; renaming references across components + locales after the fact is not.
