# Git Worktrees with Claude Code

## The Problem

When running multiple Claude Code terminals on the same repo, switching branches in one terminal affects all others — causing conflicts, stale file states, and lost context.

## The Solution: Git Worktrees

Git worktrees let you check out multiple branches **simultaneously** in separate directories. Each directory has its own working tree but shares the same `.git` history. Each Claude Code terminal operates independently — no branch collisions.

```
~/projects/agent-dsl/          ← main branch (Terminal 1)
~/projects/agent-dsl-auth/     ← feature-auth branch (Terminal 2)
~/projects/agent-dsl-refactor/ ← refactor branch (Terminal 3)
```

All three share the same Git history. Commits in one are visible from the others.

## Commands

### Create a worktree (existing branch)

```bash
git worktree add ../agent-dsl-auth feature-auth
```

### Create a worktree (new branch)

```bash
git worktree add -b feature-new ../agent-dsl-feature-new
```

### List all worktrees

```bash
git worktree list
```

### Remove a worktree

```bash
git worktree remove ../agent-dsl-auth
```

### Prune stale references

```bash
git worktree prune
```

## Setup for This Project

Since this is a pnpm monorepo, each worktree needs its own dependency install:

```bash
# 1. Create the worktree
git worktree add -b feature-xyz ../agent-dsl-xyz

# 2. Install dependencies
cd ../agent-dsl-xyz
pnpm install

# 3. Copy environment files (not tracked by git)
cp ../agent-dsl/.env .env
# Copy any other .env files in sub-packages as needed

# 4. Start Claude Code
claude
```

## Workflow with Claude Code

1. **Terminal 1**: `cd ~/projects/agent-dsl` → `claude` (working on `main`)
2. **Terminal 2**: `cd ~/projects/agent-dsl-xyz` → `claude` (working on `feature-xyz`)

Each Claude Code instance:

- Has its own branch checked out
- Has its own `node_modules`
- Can build, test, and commit independently
- Will not interfere with the other terminal

## Things to Know

| Aspect           | Behavior                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| **Branches**     | Each worktree must have a **unique branch** — you cannot check out the same branch in two worktrees        |
| **Git history**  | Shared — commits in one worktree are visible from others (after refresh)                                   |
| **node_modules** | Not shared — run `pnpm install` in each worktree                                                           |
| **.env files**   | Not shared — copy or symlink them                                                                          |
| **Disk space**   | Only source files are duplicated; `.git` objects are shared                                                |
| **CLAUDE.md**    | Each worktree gets its own copy (it's a tracked file), so Claude Code reads the right context per worktree |

## Cleanup

When you're done with a feature branch:

```bash
# From any worktree
git worktree remove ../agent-dsl-xyz

# If the directory was already deleted manually
git worktree prune
```

## Quick Reference

```bash
# Create
git worktree add -b <branch> <path>

# List
git worktree list

# Remove
git worktree remove <path>

# Prune
git worktree prune
```
