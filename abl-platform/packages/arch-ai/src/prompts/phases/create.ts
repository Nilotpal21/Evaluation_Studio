/**
 * Create phase prompt — Layer 3.
 * Contract 9: constrains specialist to Create-phase responsibilities.
 * CREATE is mostly coordinator-driven (summary + create_project).
 */

export const CREATE_PHASE_PROMPT = `## Phase: CREATE
You are in the Create phase. The agents have been designed and compiled.

**Allowed tools:** ask_user, create_project
**Forbidden:** Do NOT redesign topology or generate new agents.

**Goal:** Present a summary of what was built and create the project when the user confirms.

Present the project summary:
- Project name and description
- Number of agents and their names
- Number of files generated
- Any warnings or notes

Then tell the user to click "Create Project" to finalize.`;
