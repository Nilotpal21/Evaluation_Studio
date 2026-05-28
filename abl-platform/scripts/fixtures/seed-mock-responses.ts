/**
 * Mock responses for seeding project tools.
 * Shared by the database seed helpers when inline agent tools are materialized
 * into project_tools records.
 */
export const SEED_MOCK_RESPONSES: Record<string, unknown> = {
  // ── BankNexus ──
  get_accounts: {
    accounts: [
      { id: 'ACC-001', type: 'checking', name: 'Primary Checking' },
      { id: 'ACC-002', type: 'savings', name: 'High Yield Savings' },
    ],
    status: 'active',
  },
  get_balance: {
    available: 12450.75,
    current: 12850.75,
    pending: 400.0,
    as_of: '2026-02-26T10:00:00Z',
    currency: 'USD',
  },
  get_transactions: {
    transactions: [
      {
        id: 'TXN-001',
        date: '2026-02-25',
        description: 'Coffee Shop',
        amount: -4.5,
        type: 'debit',
        category: 'dining',
      },
      {
        id: 'TXN-002',
        date: '2026-02-24',
        description: 'Direct Deposit',
        amount: 3200.0,
        type: 'credit',
        category: 'income',
      },
    ],
    total_count: 2,
    status: 'ok',
  },
  get_transaction_detail: {
    id: 'TXN-001',
    date: '2026-02-25',
    description: 'Coffee Shop',
    amount: -4.5,
    type: 'debit',
    category: 'dining',
    merchant: 'Blue Bottle Coffee',
    reference: 'REF-20260225-001',
    balance_after: 12846.25,
    status: 'posted',
  },
  validate_recipient: { status: 'valid', bank_name: 'Chase Bank', account_holder: 'Jane Smith' },
  check_transfer_limits: {
    status: 'within_limits',
    daily_limit: 10000,
    daily_used: 1500,
    single_limit: 5000,
    remaining: 8500,
  },
  calculate_fee: { fee: 2.5, fee_waived: false, waiver_reason: '' },
  execute_transfer: {
    status: 'completed',
    confirmation_number: 'TRF-20260226-0042',
    estimated_arrival: '2026-02-27T09:00:00Z',
    new_balance: 10450.75,
  },

  // ── Flow-Test ──
  search_hotels: {
    hotels: [
      { id: 'HTL-001', name: 'Grand Hotel', rating: 4.5, price: 189, currency: 'USD' },
      { id: 'HTL-002', name: 'City Suites', rating: 4.2, price: 149, currency: 'USD' },
    ],
  },
  check_availability: {
    available: true,
    rooms: [
      { type: 'deluxe', price: 189, available: 3 },
      { type: 'standard', price: 149, available: 7 },
    ],
  },
  create_booking: { booking_id: 'BKG-20260226-001', confirmation: 'CONF-ABC123' },
  get_weather: { forecast: 'Partly cloudy', temp: 22, conditions: 'mild' },
  apply_promo_code: { valid: true, discount: 15 },
  greet_user: { greeting: 'Hello! Welcome back.' },

  // ── TravelDesk ──
  search_flights: {
    flights: [
      {
        id: 'FL-001',
        airline: 'Delta',
        departure: '08:30',
        arrival: '11:45',
        price: 320,
        currency: 'USD',
      },
    ],
    search_id: 'SRC-FL-001',
    expires_at: '2026-02-26T12:00:00Z',
  },
  search_packages: {
    packages: [
      {
        id: 'PKG-001',
        name: 'Paris Getaway',
        price: 899,
        currency: 'USD',
        includes: ['flight', 'hotel'],
      },
    ],
    search_id: 'SRC-PK-001',
    expires_at: '2026-02-26T12:00:00Z',
  },
  create_quote: {
    quote_id: 'QT-001',
    total: 899,
    currency: 'USD',
    valid_until: '2026-02-27T12:00:00Z',
    breakdown: [
      { item: 'Flight', amount: 320 },
      { item: 'Hotel', amount: 579 },
    ],
  },
  start_payment: {
    payment_session_id: 'PS-001',
    payment_url: 'https://pay.example.com/session/PS-001',
    expires_in: 1800,
  },
  check_flight_departure: { departure_time: '2026-02-28T08:30:00Z', hours_until_departure: 46 },
  check_returning_user: {
    is_returning: true,
    last_visit: '2026-02-20T14:30:00Z',
    name: 'Alex',
    verified_within_30_days: true,
  },
  get_user_context: {
    has_recent_booking: true,
    booking_status: 'confirmed',
    upcoming_trips: 1,
    preferred_language: 'en',
  },
  check_recent_verification: {
    verified_recently: true,
    last_verified_at: '2026-02-20T14:30:00Z',
    days_since: 6,
  },
  verify_email: { valid: true, account_exists: true },
  send_verification_code: { sent: true, expires_in: 300 },
  verify_code: { valid: true, user_id: 'USR-001', token: 'tok_abc123' },
  lookup_booking: {
    found: true,
    user_id: 'USR-001',
    token: 'tok_abc123',
    booking: { id: 'BKG-001', status: 'confirmed' },
  },
  lock_account: { locked: true, unlock_instructions: 'Contact support at 1-800-555-0123' },
  list_user_bookings: {
    bookings: [
      { id: 'BKG-001', destination: 'Paris', status: 'confirmed', departure: '2026-03-01' },
    ],
    total: 1,
  },
  get_booking_details: {
    booking: { id: 'BKG-001', destination: 'Paris', hotel: 'Grand Hotel' },
    status: 'confirmed',
    can_modify: true,
    fare_type: 'flexible',
    departure_datetime: '2026-03-01T08:30:00Z',
  },
  check_trip_status: {
    status: 'upcoming',
    is_completed: false,
    departure_in_hours: 72,
    is_modifiable_fare: true,
  },
  check_change_eligibility: {
    eligible: true,
    fee: 50,
    fee_breakdown: [{ item: 'Change fee', amount: 50 }],
    deadline: '2026-02-28T06:30:00Z',
    reason: '',
  },
  get_change_options: {
    options: [{ date: '2026-03-02', available: true, price_diff: 30 }],
    price_differences: [{ original: 320, new_price: 350 }],
  },
  modify_booking: {
    success: true,
    new_booking: { id: 'BKG-001-MOD', departure: '2026-03-02' },
    fee_charged: 50,
    confirmation_number: 'MOD-ABC123',
  },
  cancel_booking: {
    success: true,
    refund_amount: 270,
    refund_method: 'original_payment',
    processing_days: 5,
  },
  get_upgrade_options: {
    upgrades: [
      { type: 'business_class', price_diff: 450 },
      { type: 'suite', price_diff: 200 },
    ],
    price_differences: [],
  },
  get_modification_fee: { base_fee: 50, currency: 'USD', fee_policy: 'standard' },
  calculate_price_difference: {
    price_diff: 30,
    currency: 'USD',
    breakdown: { original: 320, new_price: 350 },
  },
  get_upgrade_pricing: {
    upgrade_cost: 200,
    currency: 'USD',
    includes: ['suite room', 'breakfast'],
  },
  check_fee_waivers: { eligible: false, waiver_type: '', reason: 'Not a loyalty member' },
  calculate_refund: {
    refund_amount: 270,
    currency: 'USD',
    original_payment_method: 'visa_4242',
    processing_days: 5,
    deductions: [{ reason: 'cancellation_fee', amount: 50 }],
  },
  process_refund: {
    success: true,
    transaction_id: 'RFN-001',
    estimated_arrival: '2026-03-03T00:00:00Z',
  },
  request_manager_approval: {
    approval_id: 'APR-001',
    status: 'pending',
    approved: false,
    approved_by: '',
  },
  get_refund_policy: {
    policy: 'Flexible fare: full refund minus cancellation fee',
    refundable_percentage: 85,
    non_refundable_items: ['insurance'],
  },
  analyze_message: {
    possible_intents: ['booking_inquiry', 'general_question'],
    confidence: 0.72,
    entities: { destination: 'Paris' },
  },
  get_common_queries: {
    queries: ['How do I cancel?', 'Where is my refund?'],
    solutions: { cancellation: 'Go to My Bookings > Cancel' },
  },
  check_agent_availability: { available: true, wait_time: 3, queue_position: 2 },
  get_business_hours: {
    is_open: true,
    hours: '9:00 AM - 9:00 PM EST',
    next_open: '2026-02-27T09:00:00-05:00',
    timezone: 'America/New_York',
  },
  create_transfer_ticket: { ticket_id: 'TKT-001', queue_position: 2 },
  initiate_transfer: { success: true, agent_name: 'Sarah', estimated_wait: 3 },
  schedule_callback: { callback_id: 'CB-001', confirmed_time: '2026-02-27T10:00:00-05:00' },
  submit_feedback: { submitted: true, ticket_id: 'FB-001', feedback_id: 'FB-001' },
  validate_quote: {
    valid: true,
    expired: false,
    total: 899,
    currency: 'USD',
    items: [{ name: 'Paris Package' }],
    valid_until: '2026-02-27T12:00:00Z',
  },
  check_payment_status: {
    status: 'completed',
    confirmed: true,
    transaction_id: 'TXN-PAY-001',
    booking_reference: 'BKG-001',
  },
  send_confirmation: { sent: true },

  // ── Unified ──
  search_deals: [{ id: 'DEAL-001', name: 'Last-Minute Caribbean', price: 599, type: 'package' }],
  get_deal_details: {
    id: 'DEAL-001',
    name: 'Last-Minute Caribbean',
    price: 599,
    includes: ['flight', 'hotel', 'transfers'],
    valid_until: '2026-03-01',
  },
  get_hotel_details: {
    id: 'HTL-001',
    name: 'Grand Hotel Paris',
    rating: 4.5,
    amenities: ['pool', 'spa', 'restaurant'],
  },
  search_flights_unified: [{ id: 'FL-001', airline: 'Air France', price: 320 }],
  get_flight_details: {
    id: 'FL-001',
    airline: 'Air France',
    departure: '08:30',
    arrival: '11:45',
    duration: '3h15m',
  },
  create_ticket: { ticket_id: 'SUP-001', status: 'open' },

  // ── Guardrails ──
  check_content_policy: true,
  get_content_alternatives: [
    'Here is a safer phrasing option.',
    'Consider using this alternative.',
  ],
  lookup_account: { id: 'ACC-001', name: 'John Doe', status: 'active', created: '2025-01-15' },
  anonymize_data: 'User [REDACTED] at [REDACTED]@email.com',

  // ── Saludsa ──
  verify_identity: { verified: true, document_type: 'cedula', user_id: 'USR-EC-001' },
  check_user_exists: { exists: true, user_id: 'USR-EC-001', contract_active: true },
  get_account_balance: { balance: 1250.0, currency: 'USD', due_date: '2026-03-01' },
  get_payment_history: {
    payments: [
      { date: '2026-01-15', amount: 125, status: 'paid' },
      { date: '2026-02-15', amount: 125, status: 'paid' },
    ],
  },
  get_payment_methods: { methods: ['bank_transfer', 'credit_card', 'debit_card'] },
  get_refund_status: { status: 'processing', estimated_date: '2026-03-05', amount: 75.0 },
  get_pending_refunds: { refunds: [{ id: 'RFN-EC-001', amount: 75.0, status: 'processing' }] },
  get_refund_requirements: {
    requirements: ['Original receipt', 'Claim form', 'Medical report'],
    processing_time: '10 business days',
  },
  submit_refund_request: {
    request_id: 'REQ-EC-001',
    status: 'submitted',
    estimated_processing: '10 business days',
  },
  get_queue_status: { available_agents: 3, estimated_wait: 5, queue_length: 8 },
  prepare_handoff_context: { context_id: 'CTX-001', summary: 'User inquired about refund status' },
  verify_by_phone: { verified: true, phone_linked: true, user_id: 'USR-EC-001' },
  link_phone_to_account: { linked: true, phone: '+593-99-XXX-XXXX' },

  // ── DisputeTransaction (non-HTTP tools) ──
  get_session_summary: {
    summary: 'Customer disputed transaction TXN-4521',
    agent_names: ['dispute_agent'],
    resolution: 'escalated_to_review',
  },

  // ── Tool Bindings ──
  process_document: {
    summary: 'The document discusses quarterly revenue growth of 12%.',
    entities: [{ name: 'Revenue', type: 'metric', value: '12%' }],
  },
  classify_document: { category: 'financial_report', confidence: 0.94 },
  calculate_risk: {
    score: 0.35,
    factors: ['low_credit_utilization', 'stable_income', 'short_credit_history'],
  },
  analyze_sentiment: { sentiment: 'positive', confidence: 0.87 },
  format_results:
    'Found 2 hotels matching your criteria:\n1. Grand Hotel - $189/night (4.5 stars)\n2. City Suites - $149/night (4.2 stars)',

  // ── Airlines ──
  vocabulary_resolve: {
    resolvedTerms: [{ term: 'economy', field: 'cabin_class', value: 'Y' }],
    unresolvedSegments: [],
    structuredFilters: [{ field: 'cabin_class', op: 'eq', value: 'Y' }],
    aggregationSpec: {},
  },
  search_aggregate: { results: [{ group: 'JFK', count: 142, avg_price: 345.5 }], totalCount: 142 },
  search_hybrid: {
    results: [
      {
        id: 'DOC-001',
        title: 'Baggage Policy',
        score: 0.92,
        snippet: 'Each passenger is allowed one carry-on...',
      },
    ],
    totalCount: 1,
    latencyMs: 45,
  },
  search_vector: {
    results: [
      {
        id: 'DOC-002',
        title: 'Cancellation Policy',
        score: 0.88,
        snippet: 'Refunds are processed within 7 days...',
      },
    ],
    totalCount: 1,
    latencyMs: 32,
  },
  search_structured: {
    results: [{ id: 'FL-AA-101', origin: 'JFK', destination: 'LAX', price: 289 }],
    totalCount: 1,
    latencyMs: 12,
  },
  search_list: {
    results: [{ id: 'FL-AA-101', origin: 'JFK', destination: 'LAX', price: 289 }],
    totalCount: 1,
    latencyMs: 15,
  },
  validate_aggregation: { valid: true, warnings: [], row_count: 142 },

  // ── Saludsa-Imported (MCP tools) ──
  saludsa_mcp_server_contract_status: {
    status: 'active',
    contract_id: 'CTR-001',
    holder: 'Maria Garcia',
  },
  saludsa_mcp_server_get_security_questions: {
    questions: [
      { id: 'Q1', text: 'What is your date of birth?' },
      { id: 'Q2', text: 'What is your contract number?' },
    ],
  },
  saludsa_mcp_server_update_zendesk_ticket: {
    ticket_id: 'ZD-001',
    status: 'updated',
    updated_at: '2026-02-26T10:00:00Z',
  },
  saludsa_mcp_server_sending_contracts: {
    sent: true,
    delivery_method: 'email',
    tracking_id: 'TRK-001',
  },
  saludsa_mcp_server_validar_elegibilidad_tarea: {
    eligible: true,
    task_code: 'TSK-001',
    message: 'Tarea elegible',
  },
  saludsa_mcp_server_validate_task_eligibility: { eligible: true, task_code: 'TSK-001' },
  saludsa_mcp_server_validateoutofhours: {
    is_out_of_hours: false,
    current_time: '10:30',
    office_hours: '08:00-17:00',
  },
  saludsa_mcp_server_send_email_template: {
    sent: true,
    template: 'refund_notification',
    recipient: 'user@example.com',
  },
  saludsa_mcp_server_validate_otp: { valid: true, remaining_attempts: 2 },
  saludsa_mcp_server_password_reset: {
    success: true,
    reset_type: 'email',
    message: 'Password reset link sent',
  },
  saludsa_mcp_server_pending_payments: {
    payments: [{ amount: 125.0, due_date: '2026-03-01', contract_id: 'CTR-001' }],
    total_pending: 125.0,
  },
  saludsa_mcp_server_check_refund_status: {
    status: 'in_process',
    envelope: 'ENV-001',
    amount: 75.0,
    estimated_date: '2026-03-05',
  },
  saludsa_mcp_server_resend_refund_settlement: { sent: true, envelope: 'ENV-001', method: 'email' },
  saludsa_mcp_server_prioritize_refund_zendesk: {
    prioritized: true,
    ticket_id: 'ZD-RFN-001',
    new_priority: 'high',
  },
  saludsa_mcp_server_steps_for_refund: {
    steps: ['Submit claim form', 'Attach receipts', 'Wait for approval'],
    estimated_time: '10 business days',
  },
  saludsa_mcp_server_check_coverage_eligibility: {
    eligible: true,
    coverage_type: 'travel',
    valid_until: '2026-12-31',
  },
  saludsa_mcp_server_get_coverage_certificate: {
    certificate_id: 'CERT-001',
    status: 'generated',
    download_url: 'https://example.com/cert/CERT-001',
  },
};
