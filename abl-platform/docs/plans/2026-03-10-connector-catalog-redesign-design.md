# Connector Catalog Redesign — Design Document

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Date**: 2026-03-10
**Status**: Approved
**Goal**: Replace flaky dynamic connector loading with a static catalog, enrich with Nango OAuth metadata, and split the connections page into connected-list + catalog-grid.

## Problem

1. `loadConnectors` dynamically imports 24 AP pieces at Studio boot — flaky under Turbopack (only HTTP shows)
2. Nango `providers.json` is empty — OAuth provider metadata not generated
3. Catalog and connected list are mixed in the same grid — users can't see "art of the possible"

## Architecture

Studio never imports AP piece code. A static `connector-catalog.json` generated at build time provides all display metadata. The Runtime remains the only service that dynamically loads AP pieces for execution. Nango's `providers.yaml` enriches the catalog with OAuth provider configs.

### Data Flow

```
Build time:
  AP pieces + Nango YAML → generate-catalog script → connector-catalog.json (committed)

Studio (read-only):
  connector-catalog.json → /api/projects/:id/connectors (serves static JSON)
  MongoDB connections → /api/projects/:id/connections (existing)

Runtime (execution):
  loadConnectors() → ConnectorRegistry → ConnectorToolExecutor (unchanged)
```

## Page Layout

Single page, top-to-bottom:

1. **Status bar** (top) — "8 connected · 1 expiring · 25 available" + search input filtering both sections
2. **My Connections** (upper) — Compact cards with health dots, agent usage, last activity. Inline expand panel for test/edit/disconnect. Collapses to "No connections yet — browse the catalog below" when empty.
3. **Connector Catalog** (lower) — Full grid of 25 implemented connectors grouped by category. Each card has logo, name, action/trigger counts, and "Connect" button. Already-connected connectors show checkmark badge instead.

## Static Catalog Generation

- Build script: `pnpm connectors:generate-catalog`
- Imports each AP piece in Node (not Turbopack) to read metadata
- Merges with Nango OAuth provider configs (auth URLs, scopes, PKCE)
- Outputs `packages/connectors/src/generated/connector-catalog.json`
- Checked into repo — deterministic, zero runtime flake
- CI validation: `generate-catalog --check` exits non-zero if output would differ

### Catalog Entry Schema

```typescript
interface CatalogEntry {
  name: string; // e.g. "slack"
  displayName: string; // e.g. "Slack"
  version: string;
  category: 'communication' | 'productivity' | 'storage' | 'crm' | 'ai_dev' | 'custom';
  authType: 'oauth2' | 'api_key' | 'bearer' | 'basic' | 'custom' | 'none';
  actions: { name: string; displayName: string; description: string }[];
  triggers: { name: string; displayName: string; description: string }[];
  // Nango-enriched OAuth fields (optional)
  oauth2?: {
    authorizationUrl: string;
    tokenUrl: string;
    refreshUrl?: string;
    defaultScopes: string[];
    scopeSeparator: string;
    pkce: boolean;
  };
}
```

## Catalog Card Design

```
┌─────────────────────────────────┐
│  [Logo]  Slack                  │
│          6 actions · 2 triggers │
│                                 │
│          [ Connect ]            │
└─────────────────────────────────┘
```

- ~200×120px, `rounded-xl`, `border border-default`
- Logo: 32×32, full color
- Already connected: checkmark badge replaces "Connect", links to connection above
- Hover: `translateY(-2px)`, border → accent (150ms ease-out)

## Connected Card (unchanged)

```
┌─────────────────────────────────┐
│  [Logo]  Slack               ●  │  ← health dot
│          slack.com              │
│                                 │
│  3 agents · 2m ago              │
└─────────────────────────────────┘
```

## Error Handling

- **Catalog staleness**: CI validates `connector-catalog.json` matches installed AP pieces
- **Orphaned connections**: Connection for removed connector shows warning badge: "Connector unavailable"
- **Search**: Single input filters both sections. Client-side (25 + 15 entries is trivial)

## Empty States

- No connections: "My Connections" collapses to one line: "No connections yet — browse the catalog below to get started."
- Search no results: "No connectors match '{query}'"

## What Changes, What Stays

| Component                                                       | Change                                                                  |
| --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `packages/connectors/src/loader.ts`                             | Stays for Runtime. Studio stops calling it.                             |
| `apps/studio/src/lib/connection-service.ts`                     | Remove `loadConnectors` call. Catalog from static JSON.                 |
| `apps/studio/src/app/api/projects/[id]/connectors/route.ts`     | Read from `connector-catalog.json` instead of `ConnectorListingService` |
| `useAvailableConnectors` hook                                   | Unchanged (still fetches `/connectors`)                                 |
| `ConnectionsPage.tsx`                                           | Rewrite: top/bottom split layout                                        |
| `ConnectionCard.tsx`                                            | Minimal changes (stays in My Connections)                               |
| New: `CatalogCard.tsx`                                          | Catalog card with "Connect" button                                      |
| New: `scripts/generate-connector-catalog.ts`                    | Build script                                                            |
| New: `packages/connectors/src/generated/connector-catalog.json` | Static metadata                                                         |
| `providers.json`                                                | Actually populated via `import-providers`                               |
| `ProviderConfigRegistry`                                        | Read from enriched catalog                                              |

## Out of Scope

- Unimplemented connector request flow
- Nango as runtime OAuth service
- Bulk connect/disconnect
- Webhook/trigger management UI
