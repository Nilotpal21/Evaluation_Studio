# TravelDesk Travel Assistant

Multi-agent travel booking assistant demonstrating a full-featured supervisor architecture with 11 agents covering authentication, booking management, sales, payments, live agent transfer, and feedback collection.

## Agent Architecture

- **TravelDesk_Supervisor** -- Top-level orchestrator that routes customers by intent priority
  - **Welcome_Agent** -- Greets customers and detects returning visitors
  - **Authentication_Agent** -- Verifies identity via email code or booking reference (30-day skip)
  - **Booking_Manager** -- View, modify, upgrade, or cancel existing bookings
    - **Fee_Calculator** (delegate) -- Calculates change fees and price differences
    - **Refund_Processor** (delegate) -- Processes refunds with manager approval for high-value refunds
  - **Sales_Agent** -- Search and book flights, hotels, and packages
    - **Payment_Agent** -- Secure payment flow with quote validation
  - **Fallback_Handler** -- Clarifies unclear intents with numbered options
  - **Live_Agent_Transfer** -- Transfers to human agents with full context or schedules callbacks
  - **Farewell_Agent** -- Collects feedback and ends conversations gracefully

## Required Environment Variables

| Variable         | Description                              |
| ---------------- | ---------------------------------------- |
| `SEARCH_API_URL` | Base URL for the flight/hotel search API |

## How to Import

```bash
abl import ./examples/travel
```

Or upload the `project.json` manifest via the Studio import UI.
