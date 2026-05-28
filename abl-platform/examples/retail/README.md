# Retail Commerce Assistant

Multi-agent retail commerce assistant demonstrating product discovery, cart management, order tracking, returns/refunds, loyalty rewards, and live agent escalation.

## Agent Architecture

- **Retail_Supervisor** -- Top-level orchestrator routing by shopping intent
  - **Product_Advisor** -- Product search, recommendations, comparisons, availability checks
  - **Sales_Agent** -- Cart management, promo codes, checkout, and payment
  - **Order_Tracking** -- Order lookup, shipping tracking, delivery preferences, reorder
  - **Returns_And_Refunds** -- Return eligibility checks, return initiation, refunds, exchanges
  - **Loyalty** -- Points balance, rewards catalog, reward redemption
  - **Live_Agent** -- Human agent transfer with full conversation context

## Required Environment Variables

None.

## How to Import

```bash
abl import ./examples/retail
```

Or upload the `project.json` manifest via the Studio import UI.
