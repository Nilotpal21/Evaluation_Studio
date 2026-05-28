# Travel Assistant — Virtual Travel Booking

## What It Is

A chat-based travel service that lets customers book new trips, manage existing reservations, and reach human support — all in one conversation.

## Capabilities

### Book New Travel

Customers describe where and when they want to travel. The system searches flights, hotels, and bundled packages, presents options within budget, and generates a price quote valid for 24 hours. When the customer is ready, they're directed to a secure payment flow. Complex or custom itineraries are routed to a human travel specialist.

### Manage Existing Bookings

Customers can view their booking details, change dates or passengers, upgrade rooms, or cancel — all without calling in. Applicable fees are shown upfront and confirmation is required before any changes go through. Refund amounts and processing timelines are communicated at the point of cancellation.

### Reach Human Support

At any point, a customer can ask to speak to a real person. The system checks staff availability, shares the full conversation context so the customer doesn't repeat themselves, and connects them. Outside business hours, the customer can schedule a callback at a preferred time and phone number.

## Customer Journeys

**New customer looking to book:** Greeted and asked about destination, dates, travelers, and budget. Shown flight, hotel, and package options. Quote created. Directed to payment.

**Returning customer managing a booking:** Greeted and verified via email code or booking reference + last name. Shown their bookings. Makes changes or cancels. Receives confirmation.

**Customer who is confused or stuck:** Offered clear choices — book new travel, manage a booking, speak to someone, or start over. Once clarified, directed to the right flow.

**Frustrated customer or complaint:** A human staff member is brought in immediately with the full conversation history and booking details.

## Business Rules

### Identity Verification

- Customers must verify their identity before accessing any booking information.
- Two verification methods: email code (6-digit, sent to registered email) or booking reference + last name.
- After 3 failed attempts, the account is locked and a staff member is notified.
- Customers who verified within the last 30 days are not asked to verify again.

### Booking Changes

- Modifications are only allowed more than 24 hours before departure.
- Change fees are calculated and displayed before the customer confirms.
- Non-modifiable fare types cannot be changed online — the customer is directed to phone support.
- Completed trips cannot be cancelled.

### Refunds

- Refund amounts and processing timelines are communicated at the point of cancellation.
- Refunds over $1,000 require manager approval.
- Refunds go back to the original payment method only.

### Sales

- Prices are based on real-time availability and not guaranteed after the search session expires.
- Flights within 2 hours of departure cannot be booked.
- Origin and destination must be different cities.

## When a Human Steps In

A human staff member is brought into the conversation when:

- The customer asks to speak to someone.
- The customer is frustrated or filing a complaint.
- A requested booking change cannot be fulfilled but the customer insists.
- A refund exceeds $1,000.
- The system encounters repeated errors it cannot recover from.

The full conversation history and all relevant booking details are passed along so the customer never has to start over. Once resolved, the human can close the conversation or direct the customer back into self-service.

## Returning Customer Experience

Returning visitors are recognized. Their preferences, language, and previously verified bookings are recalled. Customers who recently verified their identity skip re-verification. The experience gets smoother with repeat use.

## Feedback

At the end of every conversation, the customer is offered the chance to rate their experience on a 1–5 scale.
