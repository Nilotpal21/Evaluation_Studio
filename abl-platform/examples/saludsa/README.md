# Saludsa Health Insurance

Spanish-language healthcare customer service system for Saludsa Ecuador. Features a supervisor routing to 7 specialist agents handling user validation, payments, refunds, human agent transfers, and WhatsApp channel support.

## Architecture

```
Saludsa_Supervisor
  |-- User_Validator        (web/app identity verification)
  |-- Whatsapp_User_Check   (WhatsApp identity verification)
  |-- Pending_Payments      (balance, history, payment methods)
  |-- Refund_Guidance       (refund status, claims, reimbursement)
  |-- Transfer_To_SAC       (human agent handoff)
  |-- Fallback_Handler      (unrecognized intent clarification)
  |-- Farewell_Agent        (conversation closure)
```

## Agents

### Saludsa_Supervisor

Orchestrates customer service routing. Validates users first (via web or WhatsApp channel), then routes to payment, refund, transfer, fallback, or farewell agents based on intent.

### User_Validator

Collects consent and verifies identity via cedula (national ID) or passport. Used for non-WhatsApp channels.

### Whatsapp_User_Check

Phone-based identity verification for WhatsApp channel. Can link phone numbers to accounts.

### Pending_Payments

Handles balance inquiries, payment history, and payment method information. Cannot process payments directly.

### Refund_Guidance

Provides refund information, claim status checks, and reimbursement guidance. Supports medical, pharmacy, and laboratory refund types.

### Transfer_To_SAC

Manages handoff to human agents (SAC). Checks queue status, prepares context, and handles off-hours scheduling.

### Fallback_Handler

Presents clarification options when user intent is unclear. Routes to the correct specialist.

### Farewell_Agent

Ends conversations gracefully with Saludsa branding.

## Language

All user-facing strings are in Spanish (es-EC). English translations are provided in `locales/en/`. The DSL uses formal Spanish (usted).

## Business Hours

Monday to Friday, 8:00 AM to 6:00 PM (America/Guayaquil timezone). Human agent transfers are restricted to business hours.

## Import

```bash
abl import ./examples/saludsa
```
