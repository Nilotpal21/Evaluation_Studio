# Unified Travel Assistant

Lightweight multi-agent travel assistant demonstrating a simple supervisor pattern with five specialist agents for flights, hotels, deals, support, and farewell.

## Agent Architecture

- **Supervisor** -- Routes user requests to the appropriate specialist
  - **Flight_Search** -- Searches for available flights
  - **Hotel_Search** -- Searches for available hotels with multi-channel display
  - **Deals_Advisor** -- Finds the best travel deals and discounts
  - **Support_Agent** -- Handles issues and creates support tickets
  - **Farewell_Agent** -- Ends conversations gracefully with context-aware goodbyes

## Required Environment Variables

None.

## How to Import

```bash
abl import ./examples/unified
```

Or upload the `project.json` manifest via the Studio import UI.
