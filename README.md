# cloudagle.ai Integration Prototype

This repository contains a Next.js prototype for the `Integrations` and `Mode hub` experience.

## What is included

- Project -> App -> Connector navigation
- App-level connector listing
- `Add connection` wizard for:
  - `Start from scratch`
  - `Use existing template`
- `Mode hub` for model/provider configuration used by the integration wizard
- Login and shell prototype screens

## Main routes

- `/login`
- `/projects`
- `/projects/[projectId]`
- `/projects/[projectId]/apps/[appId]`
- `/integrations/new`
- `/mode-hub`

## Local development

Install dependencies and run the app:

```bash
npm install
npm run dev
```

Then open:

```text
http://127.0.0.1:3000
```

## Notes

- This is a UI/data prototype.
- Most connector, model, and lifecycle behavior is driven by local mock data and client-side state.
- `Mode hub` selections are used by the connector creation wizard for parsing and generation model choices.

## Key files

- `app/mode-hub/page.tsx`
- `components/integrations/ConnectorCreationWizard.tsx`
- `app/projects/[projectId]/apps/[appId]/page.tsx`
- `lib/mode-hub.ts`
- `lib/mock-data/project-connectors.ts`
