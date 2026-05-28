export const BATCH_PROJECTS = [
  {
    id: '01-bakery-faq',
    complexity: 'easy',
    email: 'arch-batch-01@e2e-smoke.test',
    name: 'Arch Batch 01 Bakery FAQ',
    description:
      'Build a simple bakery FAQ assistant for cake flavors, pricing, store hours, and custom-order lead capture.',
    prompt:
      'Build a simple bakery FAQ assistant for cake flavors, pricing, store hours, and custom-order lead capture. Keep it light and low-complexity with a minimal agent setup. Defer tool library setup for now. Name it Arch Batch 01 Bakery FAQ.',
  },
  {
    id: '02-salon-booking',
    complexity: 'easy',
    email: 'arch-batch-02@e2e-smoke.test',
    name: 'Arch Batch 02 Salon Booking',
    description:
      'Create a salon booking assistant for appointments, stylist matching, and basic service questions.',
    prompt:
      'Create a salon booking assistant for appointments, stylist matching, and basic service questions. Keep it simple but production-minded, with clear conversation flow and no external tool setup for now. Name it Arch Batch 02 Salon Booking.',
  },
  {
    id: '03-dental-scheduler',
    complexity: 'medium',
    email: 'arch-batch-03@e2e-smoke.test',
    name: 'Arch Batch 03 Dental Scheduler',
    description:
      'Design a dental clinic assistant for appointment booking, rescheduling, cancellations, and treatment FAQs.',
    prompt:
      'Design a dental clinic assistant for appointment booking, rescheduling, cancellations, and treatment FAQs. Use a moderate multi-agent design with clear handoffs and good completion behavior. Ignore tool setup for now. Name it Arch Batch 03 Dental Scheduler.',
  },
  {
    id: '04-ecommerce-returns',
    complexity: 'medium',
    email: 'arch-batch-04@e2e-smoke.test',
    name: 'Arch Batch 04 Ecommerce Returns',
    description:
      'Build an e-commerce support system for returns, refund policies, exchange guidance, and order-status help.',
    prompt:
      'Build an e-commerce support system for returns, refund policies, exchange guidance, and order-status help. Use a moderate multi-agent design with strong routing and clean return behavior. Defer tool generation for now. Name it Arch Batch 04 Ecommerce Returns.',
  },
  {
    id: '05-hotel-concierge',
    complexity: 'medium',
    email: 'arch-batch-05@e2e-smoke.test',
    name: 'Arch Batch 05 Hotel Concierge',
    description:
      'Create a hotel concierge assistant for room inquiries, room-service requests, spa bookings, and local recommendations.',
    prompt:
      'Create a hotel concierge assistant for room inquiries, room-service requests, spa bookings, and local recommendations. Make the topology thoughtful, with clear shared context and follow-up behavior, but skip tool setup for now. Name it Arch Batch 05 Hotel Concierge.',
  },
  {
    id: '06-real-estate-leads',
    complexity: 'medium',
    email: 'arch-batch-06@e2e-smoke.test',
    name: 'Arch Batch 06 Real Estate Leads',
    description:
      'Build a real-estate lead qualification assistant for buyer discovery, property matching, and showing scheduling.',
    prompt:
      'Build a real-estate lead qualification assistant for buyer discovery, property matching, and showing scheduling. Use multiple agents with explicit handoffs and a solid return path to the coordinator. Ignore tool setup for now. Name it Arch Batch 06 Real Estate Leads.',
  },
  {
    id: '07-insurance-claims',
    complexity: 'complex',
    email: 'arch-batch-07@e2e-smoke.test',
    name: 'Arch Batch 07 Insurance Claims',
    description:
      'Design an insurance claims intake assistant for first notice of loss, status questions, missing-info follow-up, and escalation.',
    prompt:
      'Design an insurance claims intake assistant for first notice of loss, status questions, missing-info follow-up, and escalation. Make the orchestration more complex, with careful gather, memory, and handoff design. Do not spend effort on tools yet. Name it Arch Batch 07 Insurance Claims.',
  },
  {
    id: '08-care-coordination',
    complexity: 'complex',
    email: 'arch-batch-08@e2e-smoke.test',
    name: 'Arch Batch 08 Care Coordination',
    description:
      'Create a healthcare care-coordination assistant for intake, scheduling, reminders, medication follow-up, and escalation to specialists.',
    prompt:
      'Create a healthcare care-coordination assistant for intake, scheduling, reminders, medication follow-up, and escalation to specialists. This should be a complex but coherent multi-agent system with strong continuity and completion logic. Skip tool setup for now. Name it Arch Batch 08 Care Coordination.',
  },
  {
    id: '09-fintech-support',
    complexity: 'complex',
    email: 'arch-batch-09@e2e-smoke.test',
    name: 'Arch Batch 09 Fintech Support',
    description:
      'Build a fintech support assistant for onboarding, billing disputes, fraud triage, account recovery, and escalation.',
    prompt:
      'Build a fintech support assistant for onboarding, billing disputes, fraud triage, account recovery, and escalation. Use a high-quality multi-agent design with careful context passing, explicit return contracts, and good completion logic. Ignore tool generation for now. Name it Arch Batch 09 Fintech Support.',
  },
  {
    id: '10-travel-operations',
    complexity: 'complex',
    email: 'arch-batch-10@e2e-smoke.test',
    name: 'Arch Batch 10 Travel Operations',
    description:
      'Design a travel operations assistant for itinerary planning, booking changes, policy checks, reimbursements, disruptions, and approvals.',
    prompt:
      'Design a travel operations assistant for itinerary planning, booking changes, policy checks, reimbursements, disruptions, and approvals. Make it the most complex of the batch with robust topology, explicit cross-agent context, and strong completion/handoff logic. Defer tool library work for now. Name it Arch Batch 10 Travel Operations.',
  },
];
