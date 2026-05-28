---
description: Pull your Jira tickets, pick one, create a branch, and start working
user-invocable: true
---

# Jira Start Workflow Skill

Help developers pull their Jira tickets, pick one to work on, create a branch, and optionally update the ticket status.

## Usage

```bash
# Show tickets assigned to you
/jira-start

# Show tickets created by you
/jira-start --created

# Show all tickets in a specific project
/jira-start --project ABLP

# Show tickets with specific status
/jira-start --status "To Do"
```

## Workflow

### Step 1: Fetch Tickets

**Default project:** ABLP (unless --project flag is specified)

Run the appropriate command based on flags:

```bash
# Default: assigned to you in ABLP
pnpm jira:assigned -- --project ABLP

# Created by you in ABLP
pnpm jira:list -- --project ABLP

# Specific project (overrides ABLP default)
pnpm jira:assigned -- --project <KEY>
```

Parse the output and present tickets in a numbered list with:

- Ticket key
- Summary
- Status

Example:

```
Your assigned tickets in ABLP:

1. [ABLP-123] Fix authentication bug in runtime
   Status: To Do

2. [ABLP-124] Add bulk delete API for tenant cleanup
   Status: In Progress

3. [ABLP-125] Enhance SearchAI query pipeline performance
   Status: To Do

Which ticket would you like to work on? (1-3, or 'q' to quit)
```

### Step 2: User Selection

Wait for user to pick a ticket number. Validate the selection.

If user picks 'q', exit gracefully.

### Step 3: Show Ticket Details

For the selected ticket, fetch full details using:

```bash
# Use JiraClient.getTicket() or gh api equivalent
```

Show:

- Key
- Summary
- Description (first 200 chars)
- Current status
- Assignee
- Labels (if any)

Ask:

```
Selected: [ABLP-123] Fix authentication bug in runtime

Current status: To Do
Description: Authentication middleware fails to validate tokens...

Actions:
1. Create new branch and start work
2. Work on current branch (no branch creation)
3. View full ticket in browser
4. Pick a different ticket
5. Quit

What would you like to do? (1-5)
```

### Step 4: Branch Creation (Optional)

**If user selects option 1 (Create new branch):**

Based on ticket key and type, suggest a branch name using the convention:

**Pattern:** `<type>/<ticket-key>-<slug>`

**Type mapping:**

- Bug / Issue → `fix/`
- Story / Feature → `feat/`
- Task / Improvement → `chore/`
- Tech Debt / Refactor → `refactor/`

**Slug generation:**

- Take first 3-5 words from summary
- Convert to kebab-case
- Max 50 chars total for branch name

Example:

- `[ABLP-123] Fix authentication bug in runtime` → `fix/ABLP-123-authentication-bug-runtime`
- `[ABLP-124] Add bulk delete API` → `feat/ABLP-124-bulk-delete-api`

**Workflow:**

```
Suggested branch: fix/ABLP-123-authentication-bug-runtime

Create this branch? (y/n/edit)
```

If 'edit', prompt for custom name.
If 'y', create branch:

```bash
git switch -c <branch-name>
```

**If user selects option 2 (Work on current branch):**

Show current branch name and confirm:

```
Current branch: util/quality-of-dev-life

Work on ABLP-123 in this branch? (y/n)
```

If 'n', return to the actions menu.
If 'y', skip branch creation and proceed to Step 5.

### Step 5: Update Ticket Status (Optional)

If ticket status is "To Do" or "Backlog", ask:

```
Update ticket status to "In Progress"? (y/n)
```

If yes, use `pnpm jira:update` to transition the ticket:

```bash
pnpm jira:update -- <TICKET-KEY> --transition "In Progress"
```

### Step 6: Summary

Show final state:

**If branch was created:**

```
✅ Ready to work on ABLP-123

  Branch: fix/ABLP-123-authentication-bug-runtime
  Status: In Progress
  View: https://koreteam.atlassian.net/browse/ABLP-123

Next steps:
  1. Review the ticket description and acceptance criteria
  2. Make your changes
  3. Commit with: [ABLP-123] <type>(<scope>): <description>
  4. Run /commit when ready (or manually: pnpm jira:update -- ABLP-123 --comment "...")

Happy coding! 🚀
```

**If working on existing branch:**

```
✅ Ready to work on ABLP-123

  Branch: util/quality-of-dev-life (existing)
  Status: In Progress
  View: https://koreteam.atlassian.net/browse/ABLP-123

Next steps:
  1. Review the ticket description and acceptance criteria
  2. Make your changes
  3. Commit with: [ABLP-123] <type>(<scope>): <description>
  4. Consider creating a dedicated branch if this work diverges from current branch scope

Happy coding! 🚀
```

## Branch Name Validation

Before creating, validate:

- Branch name matches allowed patterns (fix/, feat/, chore/, refactor/, docs/, test/)
- Not on a protected branch (main, develop, release/\*)
- No uncommitted changes (or stash them first)
- Branch doesn't already exist locally or remotely

If validation fails, show error and ask if they want to:

1. Stash changes and continue
2. Commit current work first
3. Use a different branch name
4. Abort

## Error Handling

**No tickets found:**

```
No tickets found assigned to you in ABLP.

Try:
  - /jira-start --created (show tickets you created)
  - /jira-start --project <KEY> (different project)
  - Create a ticket: /analysis-to-jira
```

**Jira credentials not configured:**

```
Jira credentials not configured.

Add to .env:
  JIRA_BASE_URL=https://yourcompany.atlassian.net
  JIRA_EMAIL=your.email@company.com
  JIRA_API_TOKEN=your-token
  JIRA_PROJECT_KEY=ABLP  # optional
```

**Git state issues:**

```
❌ Cannot create branch: uncommitted changes detected

Options:
  1. Stash changes: git stash
  2. Commit current work first
  3. Abort

What would you like to do? (1-3)
```

**Ticket already in progress (different assignee):**

```
⚠️  Warning: ABLP-123 is assigned to John Doe and marked "In Progress"

This might indicate someone else is working on it.

Continue anyway? (y/n)
```

## Integration with Other Workflows

**After finishing work:**

- Suggest: `/commit` to commit with proper format
- Suggest: `pnpm jira:update -- <TICKET> --transition "Done"` after PR merge

**If ticket is blocked:**

- Suggest: `pnpm jira:update -- <TICKET> --transition "Blocked" --comment "Blocked by: ..."`

**For long-running work:**

- Suggest: Adding periodic comments via `pnpm jira:update -- <TICKET> --comment "Progress update: ..."`

## Customization Flags

- `--no-branch` - Don't create branch, just show ticket info
- `--status <name>` - Filter by status ("To Do", "In Progress", etc.)
- `--project <KEY>` - Specific project key
- `--created` - Show tickets created by you instead of assigned
- `--all` - Include Done tickets (normally excluded)

## Example Session

**Example 1: Create new branch**

```
> /jira-start

Fetching your assigned tickets in ABLP...

Your assigned tickets:

1. [ABLP-123] Fix authentication bug in runtime
   Status: To Do

2. [ABLP-125] Enhance SearchAI query pipeline
   Status: To Do

Which ticket? (1-2, q to quit): 1

Selected: [ABLP-123] Fix authentication bug in runtime
Status: To Do
Description: Authentication middleware fails to validate JWT tokens when...

Actions:
1. Create new branch and start work
2. Work on current branch (no branch creation)
3. View full ticket in browser
4. Pick a different ticket
5. Quit

What would you like to do? (1-5): 1

Suggested branch: fix/ABLP-123-authentication-bug-runtime
Create this branch? (y/n/edit): y

✓ Created branch: fix/ABLP-123-authentication-bug-runtime

Update ticket to "In Progress"? (y/n): y

✓ Updated ABLP-123 → In Progress

✅ Ready to work on ABLP-123
  Branch: fix/ABLP-123-authentication-bug-runtime
  View: https://koreteam.atlassian.net/browse/ABLP-123

Happy coding! 🚀
```

**Example 2: Work on existing branch**

```
> /jira-start

Fetching your assigned tickets in ABLP...

Your assigned tickets:

1. [ABLP-124] Add /jira-start workflow skill
   Status: To Do

Which ticket? (1, q to quit): 1

Selected: [ABLP-124] Add /jira-start workflow skill
Status: To Do

Actions:
1. Create new branch and start work
2. Work on current branch (no branch creation)
3. View full ticket in browser
4. Pick a different ticket
5. Quit

What would you like to do? (1-5): 2

Current branch: util/quality-of-dev-life
Work on ABLP-124 in this branch? (y/n): y

Update ticket to "In Progress"? (y/n): y

✓ Updated ABLP-124 → In Progress

✅ Ready to work on ABLP-124
  Branch: util/quality-of-dev-life (existing)
  View: https://koreteam.atlassian.net/browse/ABLP-124

Happy coding! 🚀
```

## State Cleanup

If the workflow is interrupted (Ctrl+C, error, user quits):

- Don't leave partial state
- If branch was created but status not updated, that's OK (branch exists, ticket unchanged)
- If status was updated but branch failed, warn user to either create branch manually or revert ticket status
