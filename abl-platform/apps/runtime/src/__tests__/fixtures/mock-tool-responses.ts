/**
 * Function-based mock tool responses for testing.
 * Moved from apps/runtime/src/services/adapters/tool-executor-adapter.ts
 */
import crypto from 'crypto';

export const MOCK_TOOL_RESPONSES: Record<string, (params: Record<string, unknown>) => unknown> = {
  // Generic greeting tool for testing
  greet_user: (params) => ({
    greeting: `Hello, ${params.name || 'there'}! Nice to meet you!`,
    timestamp: new Date().toISOString(),
  }),

  // Hotel/Travel tools
  search_hotels: (params) => ({
    hotels: [
      {
        id: 'hotel-1',
        name: 'Grand Hotel Paris',
        price: 180,
        rating: 5,
        amenities: ['spa', 'pool', 'breakfast'],
        location: 'City Center',
      },
      {
        id: 'hotel-2',
        name: 'City Inn',
        price: 95,
        rating: 4,
        amenities: ['wifi', 'gym'],
        location: 'Near Metro',
      },
      {
        id: 'hotel-3',
        name: 'Comfort Suites',
        price: 120,
        rating: 4,
        amenities: ['pool', 'kitchenette'],
        location: 'Business District',
      },
    ],
    total: 3,
    destination: params.destination,
    checkin: params.checkin,
    checkout: params.checkout,
  }),

  get_hotel_details: (params) => ({
    id: params.hotel_id,
    name: 'Grand Hotel Paris',
    description: 'A luxurious 5-star hotel in the heart of Paris',
    address: '123 Champs-Élysées, Paris, France',
    amenities: ['spa', 'pool', 'breakfast', 'wifi', 'gym', 'restaurant', 'bar'],
    rooms: [
      { type: 'Standard', price: 180, available: true },
      { type: 'Deluxe', price: 250, available: true },
      { type: 'Suite', price: 400, available: false },
    ],
    rating: 4.8,
    reviews: 1247,
  }),

  check_availability: (params) => ({
    hotel_id: params.hotel_id,
    available: true,
    price: 180,
    checkin: params.checkin,
    checkout: params.checkout,
    rooms_left: 5,
  }),

  search_flights: (params) => ({
    flights: [
      {
        id: 'fl-1',
        airline: 'United',
        price: 320,
        departure: '8:00 AM',
        arrival: '2:30 PM',
        stops: 1,
      },
      {
        id: 'fl-2',
        airline: 'Delta',
        price: 285,
        departure: '11:00 AM',
        arrival: '7:15 PM',
        stops: 0,
      },
      {
        id: 'fl-3',
        airline: 'American',
        price: 299,
        departure: '3:00 PM',
        arrival: '9:45 PM',
        stops: 0,
      },
    ],
    total: 3,
    origin: params.origin,
    destination: params.destination,
  }),

  book_hotel: (params) => ({
    confirmation: `HTL-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    hotel: params.hotel,
    checkIn: params.checkin || params.checkIn,
    checkOut: params.checkout || params.checkOut,
    status: 'confirmed',
    total: '$540.00',
  }),

  create_booking: (params) => ({
    booking_id: `BK-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    hotel_id: params.hotel_id,
    guest_name: params.guest_name,
    status: 'confirmed',
  }),

  book_flight: (params) => ({
    confirmation: `FLT-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    flight: params.flight,
    date: params.date,
    passengers: params.passengers || 1,
    status: 'confirmed',
  }),

  get_deals: () => ({
    deals: [
      {
        id: 'deal-1',
        name: 'Weekend Getaway',
        discount: '30%',
        description: 'Flight + 2 nights from $399',
      },
      {
        id: 'deal-2',
        name: 'Last-Minute Flights',
        discount: '40%',
        description: 'Selected routes this week',
      },
      { id: 'deal-3', name: 'Extended Stay', discount: '25%', description: 'Book 5+ nights' },
    ],
  }),

  // ===========================================================================
  // TRAVELDESK AUTHENTICATION TOOLS (6)
  // ===========================================================================

  check_recent_verification: (params) => ({
    verified_recently: false,
    last_verified_at: null,
    days_since: 999,
  }),

  verify_email: (params) => ({
    valid: typeof params.email === 'string' && (params.email as string).includes('@'),
    account_exists: true,
  }),

  send_verification_code: (params) => ({
    sent: true,
    expires_in: 10,
  }),

  verify_code: (params) => ({
    valid: params.code === '123456' || params.code === '000000',
    user_id: `USR-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    token: `tok-${crypto.randomUUID().slice(0, 12)}`,
  }),

  lookup_booking: (params) => ({
    found: true,
    user_id: `USR-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    token: `tok-${crypto.randomUUID().slice(0, 12)}`,
    booking: {
      reference: params.booking_reference || params.reference || params.bookingRef,
      status: 'confirmed',
      type: 'flight',
      date: 'March 15, 2026',
      route: 'NYC → LAX',
      passenger: params.last_name ? `${params.last_name}` : 'John Doe',
    },
  }),

  lock_account: (params) => ({
    locked: true,
    unlock_instructions:
      'Please call 1-800-TRAVELDESK or email support@traveldesk.example.com to unlock your account.',
  }),

  // ===========================================================================
  // TRAVELDESK WELCOME AGENT TOOLS (2)
  // ===========================================================================

  check_returning_user: (params) => ({
    is_returning: true,
    last_visit: '2026-01-15T10:30:00Z',
    name: 'John',
    verified_within_30_days: false,
  }),

  get_user_context: (params) => ({
    has_recent_booking: true,
    booking_status: 'confirmed',
    upcoming_trips: 1,
    preferred_language: 'en',
  }),

  // ===========================================================================
  // TRAVELDESK BOOKING MANAGER TOOLS (8)
  // ===========================================================================

  list_user_bookings: (params) => ({
    bookings: [
      {
        booking_id: 'BK-LM-12345',
        type: 'flight',
        route: 'NYC → LAX',
        date: '2026-03-15',
        status: params.status === 'upcoming' ? 'confirmed' : 'confirmed',
        fare_type: 'flex',
        passenger: 'John Doe',
      },
      {
        booking_id: 'BK-LM-67890',
        type: 'hotel',
        name: 'Grand Hotel LA',
        checkin: '2026-03-15',
        checkout: '2026-03-18',
        status: 'confirmed',
      },
    ],
    total: 2,
  }),

  get_booking_details: (params) => ({
    booking: {
      booking_id: params.booking_id || 'BK-LM-12345',
      type: 'flight',
      route: 'NYC → LAX',
      departure_datetime: '2026-03-15T08:00:00Z',
      arrival_datetime: '2026-03-15T11:30:00Z',
      airline: 'United Airlines',
      flight_number: 'UA 234',
      passenger: 'John Doe',
      fare_type: 'flex',
      class: 'economy',
      price: { total: 320, currency: 'USD' },
    },
    status: 'confirmed',
    can_modify: true,
    fare_type: 'flex',
    departure_datetime: '2026-03-15T08:00:00Z',
  }),

  check_trip_status: (params) => ({
    status: 'confirmed',
    is_completed: false,
    departure_in_hours: 792,
    is_modifiable_fare: true,
  }),

  check_change_eligibility: (params) => ({
    eligible: true,
    fee: params.change_type === 'date' ? 50 : params.change_type === 'cancel' ? 75 : 25,
    fee_breakdown: [{ item: 'Change fee', amount: params.change_type === 'date' ? 50 : 25 }],
    deadline: '2026-03-14T08:00:00Z',
    reason: 'Flex fare allows changes with fee',
  }),

  get_change_options: (params) => ({
    options: [
      { option_id: 'opt-1', date: '2026-03-20', time: '08:00', price: 310, price_diff: -10 },
      { option_id: 'opt-2', date: '2026-03-21', time: '11:00', price: 285, price_diff: -35 },
      { option_id: 'opt-3', date: '2026-03-22', time: '15:30', price: 340, price_diff: 20 },
    ],
    price_differences: [
      { option_id: 'opt-1', diff: -10 },
      { option_id: 'opt-2', diff: -35 },
      { option_id: 'opt-3', diff: 20 },
    ],
  }),

  modify_booking: (params) => ({
    success: true,
    new_booking: {
      booking_id: params.booking_id || 'BK-LM-12345',
      status: 'modified',
      changes: params.changes,
    },
    fee_charged: 50,
    confirmation_number: `MOD-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
  }),

  cancel_booking: (params) => ({
    success: true,
    refund_amount: 245,
    refund_method: 'Original payment method',
    processing_days: 5,
  }),

  get_upgrade_options: (params) => ({
    upgrades: [
      { type: 'Premium Economy', price_diff: 120, available: true },
      { type: 'Business', price_diff: 450, available: true },
      { type: 'First', price_diff: 850, available: false },
    ],
    price_differences: [
      { type: 'Premium Economy', diff: 120 },
      { type: 'Business', diff: 450 },
    ],
  }),

  // ===========================================================================
  // TRAVELDESK FEE CALCULATOR TOOLS (4)
  // ===========================================================================

  get_modification_fee: (params) => ({
    base_fee: params.change_type === 'date' ? 50 : params.change_type === 'route' ? 75 : 25,
    currency: 'USD',
    fee_policy: 'Flex fare: standard modification fee applies',
  }),

  calculate_price_difference: (params) => ({
    price_diff: -15,
    currency: 'USD',
    breakdown: { original_price: 320, new_price: 305, difference: -15 },
  }),

  get_upgrade_pricing: (params) => ({
    upgrade_cost: params.upgrade_type === 'business' ? 450 : 120,
    currency: 'USD',
    includes:
      params.upgrade_type === 'business'
        ? ['Priority boarding', 'Lounge access', 'Extra legroom', 'Meal included']
        : ['Extra legroom', 'Priority boarding'],
  }),

  check_fee_waivers: (params) => ({
    eligible: false,
    waiver_type: 'none',
    reason: 'No active waiver programs apply to this booking',
  }),

  // ===========================================================================
  // TRAVELDESK SALES AGENT TOOLS (7)
  // ===========================================================================

  search_packages: (params) => ({
    packages: [
      {
        package_id: 'PKG-001',
        name: 'NYC to LA Getaway',
        flight: 'UA 234',
        hotel: 'Grand Hotel LA',
        price: 899,
        savings: 120,
        duration_nights: 3,
      },
      {
        package_id: 'PKG-002',
        name: 'NYC to LA Business',
        flight: 'DL 456',
        hotel: 'Downtown Suites',
        price: 1250,
        savings: 200,
        duration_nights: 3,
      },
    ],
    search_id: `SRCH-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    expires_at: new Date(Date.now() + 30 * 60000).toISOString(),
  }),

  create_quote: (params) => ({
    quote_id: `QT-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    total: 899,
    currency: 'USD',
    valid_until: new Date(Date.now() + 24 * 3600000).toISOString(),
    breakdown: [
      { item: 'Flight', amount: 320 },
      { item: 'Hotel (3 nights)', amount: 540 },
      { item: 'Package discount', amount: -61 },
      { item: 'Taxes & fees', amount: 100 },
    ],
  }),

  start_payment: (params) => ({
    payment_session_id: `PAY-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    payment_url: 'https://pay.traveldesk.example.com/checkout/mock',
    expires_in: 900,
  }),

  check_flight_departure: (params) => ({
    departure_time: '2026-03-15T08:00:00Z',
    hours_until_departure: 792,
  }),

  // ===========================================================================
  // TRAVELDESK PAYMENT AGENT TOOLS (4)
  // ===========================================================================

  validate_quote: (params) => ({
    valid: true,
    expired: false,
    total: 899,
    currency: 'USD',
    items: [
      { type: 'flight', description: 'NYC → LAX, UA 234', price: 320 },
      { type: 'hotel', description: 'Grand Hotel LA, 3 nights', price: 540 },
    ],
    valid_until: new Date(Date.now() + 24 * 3600000).toISOString(),
  }),

  check_payment_status: (params) => ({
    status: 'completed',
    confirmed: true,
    transaction_id: `TXN-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    booking_reference: `BK-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
  }),

  send_confirmation: (params) => ({
    sent: true,
  }),

  // ===========================================================================
  // TRAVELDESK REFUND PROCESSOR TOOLS (4)
  // ===========================================================================

  calculate_refund: (params) => ({
    refund_amount: 245,
    currency: 'USD',
    original_payment_method: 'Visa ending in 4242',
    processing_days: 5,
    deductions: [{ type: 'Cancellation fee', amount: 75 }],
  }),

  process_refund: (params) => ({
    success: true,
    transaction_id: `REF-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    estimated_arrival: new Date(Date.now() + 5 * 86400000).toISOString(),
  }),

  request_manager_approval: (params) => ({
    approval_id: `APR-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    status: 'approved',
    approved: true,
    approved_by: 'Manager Auto-Approve',
  }),

  get_refund_policy: (params) => ({
    policy:
      'Standard refund policy: full refund minus cancellation fee for flex fares. Non-refundable fares receive travel credit.',
    refundable_percentage: params.booking_type === 'flex' ? 100 : 0,
    non_refundable_items: ['Booking fee', 'Insurance premium'],
  }),

  // ===========================================================================
  // TRAVELDESK LIVE AGENT TRANSFER TOOLS (5)
  // ===========================================================================

  check_agent_availability: (params) => ({
    available: true,
    estimated_wait: 3,
    queue_position: 2,
  }),

  get_business_hours: (params) => ({
    is_open: true,
    hours: '24/7',
    next_open: null,
    timezone: 'UTC',
  }),

  create_transfer_ticket: (params) => ({
    ticket_id: `TKT-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    queue_position: 2,
  }),

  initiate_transfer: (params) => ({
    success: true,
    agent_name: 'Sarah M.',
    estimated_wait: 2,
  }),

  schedule_callback: (params) => ({
    callback_id: `CB-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    confirmed_time: params.preferred_time || new Date(Date.now() + 3600000).toISOString(),
  }),

  // ===========================================================================
  // TRAVELDESK FAREWELL AGENT TOOLS (1)
  // ===========================================================================

  submit_feedback: (params) => ({
    submitted: true,
    ticket_id: `FB-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
  }),

  // ===========================================================================
  // TRAVELDESK FALLBACK HANDLER TOOLS (2)
  // ===========================================================================

  analyze_message: (params) => ({
    possible_intents: ['booking_inquiry', 'general_help'],
    confidence: 0.65,
    entities: {},
  }),

  get_common_queries: () => ({
    queries: [
      'How do I change my flight?',
      'What is your cancellation policy?',
      'How do I get a refund?',
      'Can I upgrade my seat?',
      'Where is my booking confirmation?',
    ],
    solutions: {
      change_flight: 'You can change your flight through the Booking Manager.',
      cancellation: 'Check our refund policy through the Refund Processor.',
      refund: 'Refunds are processed within 5-7 business days.',
    },
  }),

  // ===========================================================================
  // ENV-DEMO: STOCK LOOKUP TOOLS (3)
  // ===========================================================================

  get_stock_quote: (params) => ({
    symbol: ((params.symbol as string) || 'AAPL').toUpperCase(),
    price:
      params.symbol === 'TSLA'
        ? 248.42
        : params.symbol === 'GOOGL'
          ? 178.35
          : params.symbol === 'MSFT'
            ? 432.18
            : 198.5,
    change: params.symbol === 'TSLA' ? -3.21 : 2.15,
    change_pct: params.symbol === 'TSLA' ? -1.28 : 1.09,
    volume: 52_340_000,
    currency: 'USD',
    exchange: 'NASDAQ',
    timestamp: new Date().toISOString(),
    source:
      'mock — env vars not configured (set STOCK_API_URL and STOCK_API_KEY in deployment environment variables)',
  }),

  get_market_news: (params) => ({
    articles: [
      {
        title: `${params.topic || 'Market'} Rally Continues Amid Fed Signals`,
        source: 'Reuters',
        published: new Date().toISOString(),
        url: 'https://example.com/news/1',
      },
      {
        title: `Tech Stocks Lead ${params.topic || 'Market'} Gains`,
        source: 'Bloomberg',
        published: new Date(Date.now() - 3600000).toISOString(),
        url: 'https://example.com/news/2',
      },
      {
        title: `Analysts Upgrade ${params.topic || 'Sector'} Outlook`,
        source: 'CNBC',
        published: new Date(Date.now() - 7200000).toISOString(),
        url: 'https://example.com/news/3',
      },
    ],
    total: 3,
    topic: params.topic,
    source:
      'mock — env vars not configured (set NEWS_API_URL and NEWS_API_KEY in deployment environment variables)',
  }),

  get_market_summary: () => ({
    indices: [
      { name: 'S&P 500', value: 5_842.31, change: 28.45, change_pct: 0.49 },
      { name: 'NASDAQ', value: 18_932.07, change: 112.33, change_pct: 0.6 },
      { name: 'DOW', value: 43_118.55, change: 156.22, change_pct: 0.36 },
    ],
    trending: ['NVDA', 'AAPL', 'TSLA', 'AMZN', 'META'],
    market_status: 'open',
    timestamp: new Date().toISOString(),
    source:
      'mock — env vars not configured (set STOCK_API_URL and STOCK_API_KEY in deployment environment variables)',
  }),

  // Healthcare tools
  check_symptoms: (params) => ({
    symptoms: params.symptoms,
    possibleConditions: ['Common Cold', 'Allergies', 'Viral Infection'],
    urgency: 'low',
    recommendation: 'Monitor symptoms. If they persist for more than 7 days, consult a doctor.',
  }),

  schedule_appointment: (params) => ({
    appointmentId: `APT-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    doctor: params.doctor || 'Dr. Smith',
    date: params.date || 'Next available',
    time: params.time || '10:00 AM',
    status: 'scheduled',
  }),

  get_medication_info: (params) => ({
    medication: params.medication,
    dosage: '500mg',
    frequency: 'Every 8 hours',
    sideEffects: ['Drowsiness', 'Nausea'],
    interactions: ['Avoid alcohol'],
  }),

  // Generic tools
  web_search: (params) => ({
    query: params.query,
    results: [
      { title: `Result 1 for "${params.query}"`, url: 'https://example.com/1' },
      { title: `Result 2 for "${params.query}"`, url: 'https://example.com/2' },
    ],
  }),

  send_email: (params) => ({
    sent: true,
    to: params.to,
    subject: params.subject,
    messageId: `MSG-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
  }),

  get_weather: (params) => ({
    location: params.location,
    temperature: 72,
    condition: 'Sunny',
    humidity: 45,
    forecast: 'Clear skies expected for the next 3 days',
  }),

  // ===========================================================================
  // TELCO NOC TOOLS (30 tools)
  // ===========================================================================

  // --- Network / Alarm (5) ---
  get_active_alarms: (params) => ({
    alarms: [
      {
        alarm_id: 'ALM-20260208-0847',
        severity: 'critical',
        category: 'link_degradation',
        site_code: 'MUM-BKC-042',
        site_name: 'Bandra-Kurla Complex Tower',
        technology: '5G SA',
        vendor: 'Nokia AirScale',
        raised_at: '2026-02-08T14:23:11Z',
        description: 'RSRP degradation on cells 1-3, DL throughput below 50Mbps threshold',
        ack: false,
      },
      {
        alarm_id: 'ALM-20260208-0848',
        severity: 'major',
        category: 'capacity_threshold',
        site_code: 'DEL-CP-017',
        site_name: 'Connaught Place Micro',
        technology: '5G NSA',
        vendor: 'Ericsson RBS',
        raised_at: '2026-02-08T14:25:33Z',
        description: 'PRB utilization at 87% on carrier 2, approaching congestion',
        ack: false,
      },
      {
        alarm_id: 'ALM-20260208-0849',
        severity: 'minor',
        category: 'hardware_warning',
        site_code: 'BLR-WF-103',
        site_name: 'Whitefield IT Park',
        technology: '4G LTE-A',
        vendor: 'Samsung',
        raised_at: '2026-02-08T14:30:00Z',
        description: 'RRU temperature warning on sector 2, fan speed increased',
        ack: true,
      },
      {
        alarm_id: 'ALM-20260208-0850',
        severity: 'critical',
        category: 'fiber_cut',
        site_code: 'HYD-HT-088',
        site_name: 'HITEC City Hub',
        technology: '5G SA',
        vendor: 'Nokia',
        raised_at: '2026-02-08T14:31:45Z',
        description: 'Complete fiber loss on primary transport link, traffic on backup',
        ack: false,
      },
      {
        alarm_id: 'ALM-20260208-0851',
        severity: 'major',
        category: 'interference',
        site_code: 'CHN-OMR-055',
        site_name: 'OMR Tech Corridor',
        technology: '5G NSA',
        vendor: 'Ericsson',
        raised_at: '2026-02-08T14:35:12Z',
        description: 'Inter-cell interference detected on n78 band, SINR degraded to 3dB',
        ack: false,
      },
    ],
    total: 5,
    filters_applied: params.severity || 'all',
  }),

  get_alarm_details: (params) => ({
    alarm_id: params.alarm_id || 'ALM-20260208-0847',
    severity: 'critical',
    category: 'link_degradation',
    site: {
      code: 'MUM-BKC-042',
      name: 'Bandra-Kurla Complex Tower',
      lat: 19.0596,
      lng: 72.8656,
      circle: 'Mumbai',
      zone: 'West',
      address: 'Plot C-66, BKC, Bandra East, Mumbai 400051',
    },
    equipment: {
      vendor: 'Nokia',
      model: 'AirScale AAFIA',
      serial: 'NK-5G-2024-08847',
      firmware: 'v23.4.1-SA',
      technology: '5G SA',
      band: 'n78 (3500MHz)',
      cells: ['MUM-BKC-042-C1', 'MUM-BKC-042-C2', 'MUM-BKC-042-C3'],
    },
    metrics: {
      rsrp: -112,
      rsrq: -15,
      sinr: 2.3,
      dl_throughput_mbps: 42,
      ul_throughput_mbps: 8,
      prb_utilization: 78,
      connected_ues: 342,
    },
    timeline: [
      { time: '2026-02-08T14:20:00Z', event: 'RSRP degradation detected on C1' },
      { time: '2026-02-08T14:21:30Z', event: 'Degradation spread to C2, C3' },
      { time: '2026-02-08T14:23:11Z', event: 'Alarm raised — DL throughput below 50Mbps' },
    ],
    correlated_alarms: ['ALM-20260208-0853'],
    affected_subscribers: 342,
    sla_at_risk: true,
  }),

  acknowledge_alarm: (params) => ({
    alarm_id: params.alarm_id || 'ALM-20260208-0847',
    acknowledged: true,
    acknowledged_by: params.operator || 'Rajesh K.',
    acknowledged_at: '2026-02-08T14:45:00Z',
    notes: params.notes || 'Acknowledged — investigating root cause',
  }),

  get_site_inventory: (params) => ({
    site_code: params.site_code || 'MUM-BKC-042',
    site_name: 'Bandra-Kurla Complex Tower',
    type: 'macro',
    location: { lat: 19.0596, lng: 72.8656, circle: 'Mumbai', zone: 'West', city: 'Mumbai' },
    equipment: [
      {
        type: 'Baseband Unit',
        vendor: 'Nokia',
        model: 'AirScale BB 5216',
        serial: 'NK-BB-2024-4421',
        status: 'operational',
      },
      {
        type: 'Radio Unit (5G)',
        vendor: 'Nokia',
        model: 'AirScale AAFIA',
        serial: 'NK-5G-2024-08847',
        band: 'n78',
        status: 'degraded',
      },
      {
        type: 'Radio Unit (4G)',
        vendor: 'Nokia',
        model: 'AAHIA',
        serial: 'NK-4G-2023-03211',
        band: 'B3/B40',
        status: 'operational',
      },
      {
        type: 'Power System',
        vendor: 'Eltek',
        model: 'Flatpack2 48V',
        status: 'operational',
        battery_backup_hrs: 4,
      },
      {
        type: 'Transport',
        vendor: 'Ciena',
        model: 'WaveLogic 5e',
        link_capacity_gbps: 100,
        status: 'operational',
      },
    ],
    technologies: ['5G SA', '4G LTE-A'],
    tower_height_m: 45,
    commissioned: '2024-03-15',
    last_pm: '2026-01-20',
  }),

  get_network_topology: (params) => ({
    region: params.region || 'Mumbai',
    sites_total: 847,
    sites_active: 839,
    sites_degraded: 5,
    sites_down: 3,
    topology: [
      {
        from: 'MUM-CORE-01',
        to: 'MUM-AGG-WEST-01',
        link_type: 'fiber',
        capacity_gbps: 400,
        utilization: 0.62,
      },
      {
        from: 'MUM-AGG-WEST-01',
        to: 'MUM-BKC-042',
        link_type: 'fiber',
        capacity_gbps: 100,
        utilization: 0.71,
      },
      {
        from: 'MUM-AGG-WEST-01',
        to: 'MUM-AND-015',
        link_type: 'fiber',
        capacity_gbps: 100,
        utilization: 0.45,
      },
      {
        from: 'MUM-CORE-01',
        to: 'MUM-AGG-EAST-01',
        link_type: 'fiber',
        capacity_gbps: 400,
        utilization: 0.38,
      },
    ],
    health_score: 94,
  }),

  // --- Link Analysis (4) ---
  analyze_link_health: (params) => ({
    link_id: params.link_id || 'MUM-BKC-042-LINK-01',
    status: 'degraded',
    link_type: 'fiber',
    span_km: 14.7,
    optical_power_dbm: { tx: 2.1, rx: -18.4, threshold: -22.0 },
    ber: 1.2e-8,
    latency_ms: 1.8,
    jitter_ms: 0.3,
    packet_loss_pct: 0.02,
    events_24h: [
      { time: '2026-02-08T08:00:00Z', event: 'Rx power fluctuation detected' },
      {
        time: '2026-02-08T14:20:00Z',
        event: 'Signal degradation — possible fiber bend or micro-fracture',
      },
    ],
    recommendation:
      'OTDR test recommended — suspected fiber fault between splice point 3 and 4 (km 12-13)',
  }),

  get_link_history: (params) => ({
    link_id: params.link_id || 'MUM-BKC-042-LINK-01',
    history: [
      {
        date: '2025-11-15',
        event: 'Fiber cut at km 8.2',
        resolution: 'Splice repair',
        mttr_hours: 4.5,
      },
      {
        date: '2025-08-22',
        event: 'Rx power degradation',
        resolution: 'Connector cleaning',
        mttr_hours: 1.2,
      },
      {
        date: '2025-03-10',
        event: 'Routine OTDR test',
        result: 'Normal — no anomalies',
        mttr_hours: 0,
      },
    ],
    total_outages_12m: 2,
    avg_mttr_hours: 2.85,
    fiber_age_years: 3.2,
  }),

  run_link_diagnostics: (params) => ({
    link_id: params.link_id || 'MUM-BKC-042-LINK-01',
    test_type: params.test_type || 'OTDR',
    results: {
      otdr_trace: {
        total_span_km: 14.7,
        fault_detected: true,
        fault_location_km: 12.3,
        fault_type: 'reflective_event',
        estimated_loss_db: 3.8,
        confidence: 0.94,
      },
      loopback_test: { status: 'pass', round_trip_ms: 3.6 },
      ber_test: { pre_fec_ber: 1.2e-8, post_fec_ber: 0, status: 'marginal' },
    },
    diagnosis:
      'Reflective fault at 12.3 km — consistent with fiber micro-fracture or damaged splice. Estimated 3.8 dB excess loss.',
    recommended_action:
      'Dispatch fiber team for splice repair at km 12.3 (between splice point SP-3 and SP-4)',
    estimated_repair_time_hours: 3,
  }),

  get_affected_services: (params) => ({
    site_code: params.site_code || 'MUM-BKC-042',
    affected_subscribers: 342,
    enterprise_customers: [
      {
        name: 'HDFC Bank BKC Branch',
        circuit_id: 'ENT-HDFC-BKC-001',
        sla_tier: 'platinum',
        impact: 'degraded throughput',
      },
      {
        name: 'Accenture BKC Campus',
        circuit_id: 'ENT-ACC-BKC-003',
        sla_tier: 'gold',
        impact: 'degraded throughput',
      },
    ],
    consumer_impact: {
      total_users: 340,
      avg_experience_score: 3.2,
      normal_score: 8.7,
      services_affected: ['5G data', 'VoNR', 'video streaming'],
    },
    sla_risk: {
      platinum_breach_eta_min: 45,
      gold_breach_eta_min: 120,
      penalty_estimate_inr: 250000,
    },
    revenue_impact_per_hour_inr: 185000,
  }),

  // --- Capacity / Traffic (5) ---
  get_traffic_analytics: (params) => ({
    region: params.region || 'Mumbai',
    period: params.period || 'last_24h',
    summary: {
      total_data_tb: 847.3,
      peak_throughput_gbps: 234.5,
      avg_prb_utilization: 0.62,
      busiest_hour: '21:00-22:00',
    },
    top_congested_sites: [
      { site_code: 'DEL-CP-017', prb_util: 0.87, technology: '5G NSA', subscribers: 1247 },
      { site_code: 'BLR-KOR-089', prb_util: 0.83, technology: '5G SA', subscribers: 956 },
      { site_code: 'MUM-AND-015', prb_util: 0.81, technology: '4G LTE-A', subscribers: 2103 },
    ],
    traffic_growth_pct_mom: 4.2,
    forecast_congestion_sites_7d: ['DEL-CP-017', 'BLR-KOR-089'],
  }),

  get_capacity_forecast: (params) => ({
    region: params.region || 'Mumbai',
    forecast_period: '90_days',
    current_capacity_utilization: 0.62,
    predicted_utilization_30d: 0.67,
    predicted_utilization_60d: 0.71,
    predicted_utilization_90d: 0.76,
    sites_needing_expansion: [
      {
        site_code: 'DEL-CP-017',
        reason: 'PRB saturation in 45 days',
        recommendation: 'Add n78 carrier',
      },
      {
        site_code: 'MUM-AND-015',
        reason: 'Subscriber growth 8% MoM',
        recommendation: 'Split sector or add small cell',
      },
    ],
    capex_estimate_inr: 45000000,
    confidence: 0.88,
  }),

  simulate_traffic_shift: (params) => ({
    source_site: params.source_site || 'DEL-CP-017',
    target_sites: params.target_sites || ['DEL-CP-018', 'DEL-CP-019'],
    shift_percentage: params.shift_pct || 30,
    simulation_result: {
      source_prb_after: 0.61,
      target_prb_after: [0.58, 0.52],
      subscriber_experience_impact: 'minimal — avg throughput increase 15%',
      handover_success_rate: 0.97,
      estimated_dropped_calls: 2,
    },
    risk_assessment: 'low',
    recommendation: 'Safe to execute — all target sites within capacity',
  }),

  execute_traffic_shift: (params) => ({
    shift_id: 'TS-20260208-001',
    status: 'executed',
    source_site: params.source_site || 'DEL-CP-017',
    target_sites: params.target_sites || ['DEL-CP-018', 'DEL-CP-019'],
    shift_percentage: params.shift_pct || 30,
    executed_at: '2026-02-08T15:00:00Z',
    executed_by: 'Capacity_Planner_Agent',
    rollback_available: true,
    rollback_deadline: '2026-02-08T19:00:00Z',
  }),

  get_subscriber_experience: (params) => ({
    site_code: params.site_code || 'MUM-BKC-042',
    period: 'last_1h',
    metrics: {
      avg_dl_throughput_mbps: 42.3,
      avg_ul_throughput_mbps: 8.1,
      avg_latency_ms: 18,
      video_mos: 3.2,
      voice_mos: 4.1,
      setup_success_rate: 0.98,
      drop_rate: 0.003,
    },
    benchmarks: { dl_target: 100, ul_target: 20, latency_target: 10, video_mos_target: 4.0 },
    experience_score: 3.2,
    normal_score: 8.7,
    degradation_reason: 'Link degradation affecting DL throughput and video quality',
  }),

  // --- Maintenance (4) ---
  get_predictive_alerts: (params) => ({
    region: params.region || 'all',
    alerts: [
      {
        alert_id: 'PMA-001',
        site_code: 'MUM-POW-033',
        category: 'battery_degradation',
        prediction: 'Battery capacity below 60% in 30 days',
        confidence: 0.91,
        recommended_action: 'Schedule battery replacement',
      },
      {
        alert_id: 'PMA-002',
        site_code: 'DEL-GGN-045',
        category: 'antenna_tilt_drift',
        prediction: 'Electrical tilt drift 0.5° over 90 days',
        confidence: 0.85,
        recommended_action: 'Schedule antenna alignment',
      },
      {
        alert_id: 'PMA-003',
        site_code: 'BLR-ELC-067',
        category: 'cooling_degradation',
        prediction: 'AC unit efficiency declining, failure in 60 days',
        confidence: 0.78,
        recommended_action: 'Schedule AC servicing',
      },
    ],
    total_alerts: 3,
    high_priority: 1,
  }),

  schedule_maintenance: (params) => ({
    maintenance_id: 'MW-20260215-001',
    site_code: params.site_code || 'MUM-POW-033',
    type: params.maintenance_type || 'battery_replacement',
    scheduled_date: params.date || '2026-02-15',
    window: params.window || '02:00-06:00 IST',
    assigned_team: 'Mumbai Field Ops Team-3',
    team_lead: 'Suresh P.',
    parts_reserved: [
      { item: '48V Li-Ion Battery Pack', quantity: 2, warehouse: 'MUM-WH-01', status: 'reserved' },
    ],
    impact_assessment: { affected_subscribers: 0, planned_outage: false, traffic_rerouted: true },
    approval_status: 'pending_supervisor',
  }),

  get_maintenance_history: (params) => ({
    site_code: params.site_code || 'MUM-BKC-042',
    history: [
      {
        mw_id: 'MW-20260120-003',
        date: '2026-01-20',
        type: 'preventive_maintenance',
        duration_hours: 3,
        result: 'completed',
        technician: 'Amit R.',
      },
      {
        mw_id: 'MW-20251115-007',
        date: '2025-11-15',
        type: 'fiber_splice_repair',
        duration_hours: 4.5,
        result: 'completed',
        technician: 'Deepak M.',
      },
      {
        mw_id: 'MW-20250822-002',
        date: '2025-08-22',
        type: 'connector_cleaning',
        duration_hours: 1.2,
        result: 'completed',
        technician: 'Amit R.',
      },
    ],
    total_maintenance_12m: 3,
    avg_duration_hours: 2.9,
    next_scheduled: 'MW-20260215-001',
  }),

  check_spare_inventory: (params) => ({
    region: params.region || 'Mumbai',
    warehouse: 'MUM-WH-01',
    items: [
      { item: '48V Li-Ion Battery Pack', stock: 12, reserved: 2, available: 10, lead_time_days: 3 },
      { item: 'Nokia AAFIA 5G RRU', stock: 4, reserved: 1, available: 3, lead_time_days: 14 },
      { item: 'Fiber Splice Kit', stock: 25, reserved: 0, available: 25, lead_time_days: 1 },
      { item: 'Ericsson Baseband 6630', stock: 2, reserved: 0, available: 2, lead_time_days: 21 },
      {
        item: 'Ciena WaveLogic 5e OTN Card',
        stock: 3,
        reserved: 1,
        available: 2,
        lead_time_days: 7,
      },
    ],
    low_stock_alerts: ['Nokia AAFIA 5G RRU', 'Ericsson Baseband 6630'],
  }),

  // --- Incident Management (5) ---
  create_incident: (params) => ({
    incident_id: 'INC-20260208-001',
    title: params.title || 'Critical link degradation at MUM-BKC-042',
    severity: params.severity || 'P1',
    status: 'open',
    created_at: '2026-02-08T14:45:00Z',
    created_by: 'NOC_Supervisor_Agent',
    assigned_to: 'Incident_Manager_Agent',
    related_alarms: params.alarm_ids || ['ALM-20260208-0847'],
    affected_site: params.site_code || 'MUM-BKC-042',
    affected_subscribers: 342,
    sla_response_deadline: '2026-02-08T15:15:00Z',
    sla_resolution_deadline: '2026-02-08T18:45:00Z',
  }),

  get_incident_timeline: (params) => ({
    incident_id: params.incident_id || 'INC-20260208-001',
    title: 'Critical link degradation at MUM-BKC-042',
    severity: 'P1',
    status: 'in_progress',
    timeline: [
      {
        time: '2026-02-08T14:23:11Z',
        event: 'Alarm raised: link degradation on MUM-BKC-042',
        actor: 'NMS',
      },
      {
        time: '2026-02-08T14:25:00Z',
        event: 'Auto-triaged by Network_Triage agent',
        actor: 'Network_Triage',
      },
      {
        time: '2026-02-08T14:25:30Z',
        event: 'Handed off to Link_Analyzer for diagnosis',
        actor: 'NOC_Supervisor',
      },
      { time: '2026-02-08T14:30:00Z', event: 'OTDR test initiated', actor: 'Link_Analyzer' },
      {
        time: '2026-02-08T14:35:00Z',
        event: 'Fault identified at km 12.3 — fiber micro-fracture',
        actor: 'Link_Analyzer',
      },
      {
        time: '2026-02-08T14:40:00Z',
        event: 'Incident created, field team dispatched',
        actor: 'Incident_Manager',
      },
      {
        time: '2026-02-08T14:45:00Z',
        event: 'Customer impact assessed: 342 subscribers, 2 enterprise',
        actor: 'Incident_Manager',
      },
    ],
    current_owner: 'Incident_Manager_Agent',
    elapsed_minutes: 22,
    sla_status: 'within_sla',
  }),

  generate_rca: (params) => ({
    incident_id: params.incident_id || 'INC-20260208-001',
    rca: {
      root_cause: 'Fiber micro-fracture at km 12.3 on transport link MUM-BKC-042-LINK-01',
      category: 'infrastructure_degradation',
      contributing_factors: [
        'Fiber age: 3.2 years with 2 previous splicing events',
        'Construction activity near splice point SP-3 reported on 2026-02-07',
        'Temperature cycling stress on aerial fiber segment',
      ],
      impact_summary:
        '342 subscribers experienced degraded 5G service for 22 minutes. 2 enterprise SLAs at risk.',
      corrective_actions: [
        { action: 'Splice repair at km 12.3', status: 'in_progress', eta: '2026-02-08T17:30:00Z' },
        { action: 'OTDR baseline after repair', status: 'pending' },
        { action: 'Notify enterprise customers of resolution', status: 'pending' },
      ],
      preventive_actions: [
        'Add fiber route to quarterly OTDR monitoring schedule',
        'Install vibration sensors near construction-adjacent splice points',
        'Evaluate underground rerouting for this segment',
      ],
    },
    generated_by: 'Incident_Manager_Agent',
    confidence: 0.92,
  }),

  update_incident_status: (params) => ({
    incident_id: params.incident_id || 'INC-20260208-001',
    previous_status: 'in_progress',
    new_status: params.status || 'resolved',
    updated_at: '2026-02-08T17:45:00Z',
    updated_by: params.updated_by || 'Incident_Manager_Agent',
    resolution_summary:
      params.resolution ||
      'Fiber splice repair completed at km 12.3. OTDR verification passed. All KPIs restored to normal.',
    mttr_minutes: 202,
    sla_met: true,
  }),

  get_customer_impact: (params) => ({
    incident_id: params.incident_id || 'INC-20260208-001',
    site_code: 'MUM-BKC-042',
    consumer: {
      affected_users: 340,
      avg_experience_degradation: '62%',
      complaints_received: 3,
      social_media_mentions: 0,
    },
    enterprise: [
      {
        name: 'HDFC Bank BKC Branch',
        sla_tier: 'platinum',
        impact: 'degraded',
        sla_breach: false,
        breach_eta_min: 23,
        contact: 'Vikram S. (IT Head)',
        notified: true,
      },
      {
        name: 'Accenture BKC Campus',
        sla_tier: 'gold',
        impact: 'degraded',
        sla_breach: false,
        breach_eta_min: 98,
        contact: 'Neha R. (Network Lead)',
        notified: true,
      },
    ],
    revenue_impact_inr: 185000,
    reputation_risk: 'medium',
  }),

  // --- OS Upgrade (5) ---
  get_upgrade_candidates: (params) => ({
    region: params.region || 'all',
    current_os: params.current_os || 'v23.4.1',
    target_os: params.target_os || 'v24.1.0',
    candidates: [
      {
        site_code: 'MUM-BKC-042',
        vendor: 'Nokia',
        model: 'AirScale BB 5216',
        current_version: 'v23.4.1',
        status: 'eligible',
        risk: 'low',
      },
      {
        site_code: 'DEL-CP-017',
        vendor: 'Nokia',
        model: 'AirScale BB 5216',
        current_version: 'v23.4.1',
        status: 'eligible',
        risk: 'low',
      },
      {
        site_code: 'BLR-WF-103',
        vendor: 'Nokia',
        model: 'AirScale BB 5216',
        current_version: 'v23.3.2',
        status: 'eligible',
        risk: 'medium',
      },
    ],
    total_eligible: 847,
    total_excluded: 12,
    exclusion_reasons: { active_alarms: 5, recent_maintenance: 4, manual_hold: 3 },
  }),

  create_upgrade_plan: (params) => ({
    plan_id: 'UPG-20260210-001',
    target_os: params.target_os || 'v24.1.0',
    strategy: params.strategy || 'canary',
    phases: [
      { phase: 1, name: 'canary', sites: 5, start: '2026-02-10T02:00:00Z', duration_hours: 4 },
      {
        phase: 2,
        name: 'early_adopter',
        sites: 42,
        start: '2026-02-11T02:00:00Z',
        duration_hours: 6,
      },
      {
        phase: 3,
        name: 'general_rollout',
        sites: 400,
        start: '2026-02-12T02:00:00Z',
        duration_hours: 12,
      },
      {
        phase: 4,
        name: 'final_batch',
        sites: 400,
        start: '2026-02-13T02:00:00Z',
        duration_hours: 12,
      },
    ],
    total_sites: 847,
    maintenance_window: '02:00-06:00 IST',
    rollback_criteria: {
      health_check_failures: 2,
      kpi_degradation_pct: 10,
      subscriber_complaints: 5,
    },
    approval_required: true,
    estimated_completion: '2026-02-13T14:00:00Z',
  }),

  execute_upgrade_batch: (params) => ({
    plan_id: params.plan_id || 'UPG-20260210-001',
    batch: params.batch || 1,
    status: 'completed',
    sites_attempted: 5,
    sites_succeeded: 5,
    sites_failed: 0,
    sites_rolled_back: 0,
    results: [
      {
        site_code: 'MUM-BKC-042',
        status: 'success',
        duration_min: 18,
        post_upgrade_health: 'green',
      },
      {
        site_code: 'DEL-CP-017',
        status: 'success',
        duration_min: 22,
        post_upgrade_health: 'green',
      },
      {
        site_code: 'BLR-WF-103',
        status: 'success',
        duration_min: 15,
        post_upgrade_health: 'green',
      },
      {
        site_code: 'HYD-HT-088',
        status: 'success',
        duration_min: 20,
        post_upgrade_health: 'green',
      },
      {
        site_code: 'CHN-OMR-055',
        status: 'success',
        duration_min: 17,
        post_upgrade_health: 'green',
      },
    ],
    next_batch_eligible: true,
    completed_at: '2026-02-10T05:32:00Z',
  }),

  verify_upgrade_health: (params) => ({
    site_code: params.site_code || 'MUM-BKC-042',
    os_version: 'v24.1.0',
    health_check: {
      system: { cpu_pct: 32, memory_pct: 45, disk_pct: 28, uptime_min: 45, status: 'pass' },
      radio: { cells_active: 3, cells_expected: 3, rsrp_avg: -85, prb_util: 0.55, status: 'pass' },
      transport: { link_status: 'up', throughput_gbps: 72.3, latency_ms: 1.2, status: 'pass' },
      kpi_comparison: {
        dl_throughput_change_pct: 8,
        ul_throughput_change_pct: 5,
        latency_change_pct: -3,
        drop_rate_change_pct: -12,
        status: 'improved',
      },
    },
    overall_status: 'healthy',
    rollback_recommended: false,
    verified_at: '2026-02-10T06:15:00Z',
  }),

  rollback_upgrade: (params) => ({
    site_code: params.site_code || 'BLR-WF-103',
    previous_os: 'v24.1.0',
    rolled_back_to: 'v23.4.1',
    status: 'completed',
    reason: params.reason || 'Health check failure — KPI degradation exceeded 10% threshold',
    duration_min: 12,
    post_rollback_health: 'green',
    rolled_back_at: '2026-02-10T05:45:00Z',
    requires_investigation: true,
  }),

  // --- General (2) ---
  get_noc_dashboard: () => ({
    timestamp: '2026-02-08T14:45:00Z',
    network_health_score: 94,
    active_alarms: { critical: 2, major: 3, minor: 7, warning: 12, total: 24 },
    active_incidents: { p1: 1, p2: 1, p3: 1, total: 3 },
    kpis: {
      mttr_minutes: 23,
      mtbf_hours: 847,
      availability_pct: 99.97,
      subscriber_experience_avg: 8.2,
    },
    agent_sessions: { active: 2, completed_24h: 14, avg_resolution_min: 18 },
    regions: [
      { name: 'Mumbai', health: 92, sites: 847, alarms: 8 },
      { name: 'Delhi', health: 96, sites: 623, alarms: 5 },
      { name: 'Bangalore', health: 98, sites: 512, alarms: 3 },
      { name: 'Hyderabad', health: 95, sites: 389, alarms: 4 },
      { name: 'Chennai', health: 97, sites: 445, alarms: 4 },
    ],
    shift: { current: 'Day Shift (06:00-14:00 IST)', supervisor: 'Priya M.', operators_on_duty: 6 },
  }),

  send_notification: (params) => ({
    notification_id: 'NOT-20260208-001',
    type: params.type || 'email',
    recipients: params.recipients || ['noc-team@telco.in', 'shift-lead@telco.in'],
    subject: params.subject || 'P1 Incident: Link degradation at MUM-BKC-042',
    status: 'sent',
    sent_at: '2026-02-08T14:45:30Z',
    delivery_confirmed: true,
  }),

  // ── Banking tools ──

  get_credit_card_bill: (params) => {
    const cards: Record<string, string> = {
      visa_4242: 'Visa ending 4242',
      amex_1234: 'Amex ending 1234',
      mastercard_5678: 'Mastercard ending 5678',
    };
    const bills: Record<string, { bill_amount: number; due_date: string; minimum_due: number }> = {
      current: { bill_amount: 500, due_date: '2026-03-15', minimum_due: 50 },
      previous: { bill_amount: 320, due_date: '2026-02-15', minimum_due: 32 },
      last_3_months: { bill_amount: 1450, due_date: '2026-03-15', minimum_due: 145 },
    };
    const period = String(params.period || 'current');
    const bill = bills[period] || bills.current;
    return { ...bill, card_name: cards[String(params.card_id)] || String(params.card_id) };
  },

  pay_credit_card_bill: (params) => ({
    transaction_id: `TXN-${Math.floor(Math.random() * 10000)}`,
    payment_status: 'success',
    remaining_balance: Math.max(0, 500 - Number(params.amount || 0)),
  }),

  get_balance: (params) => {
    const accounts: Record<
      string,
      { balance: number; pending_amount: number; available_balance: number; account_id: string }
    > = {
      savings: { balance: 2000, pending_amount: 0, available_balance: 2000, account_id: 'SAV-001' },
      checking: {
        balance: 1500,
        pending_amount: 50,
        available_balance: 1450,
        account_id: 'CHK-001',
      },
      credit: { balance: -500, pending_amount: 0, available_balance: 4500, account_id: 'CRD-001' },
    };
    return accounts[String(params.account_type)] || accounts.savings;
  },

  get_transactions: (params) => {
    const txns = [
      { date: '2026-03-08', description: 'Grocery Store', amount: -45.5, type: 'debit' },
      { date: '2026-03-07', description: 'Salary Deposit', amount: 3200, type: 'credit' },
      { date: '2026-03-06', description: 'Electric Bill', amount: -120, type: 'debit' },
      { date: '2026-03-05', description: 'Restaurant', amount: -65.3, type: 'debit' },
      { date: '2026-03-04', description: 'ATM Withdrawal', amount: -200, type: 'debit' },
    ];
    const n = Number(params.limit) || 5;
    return {
      transactions: txns.slice(0, n),
      account_id: `${String(params.account_type || 'savings')
        .toUpperCase()
        .slice(0, 3)}-001`,
    };
  },

  transfer_amount: (params) => ({
    transaction_id: `TRF-${Math.floor(Math.random() * 10000)}`,
    status: 'completed',
    from: params.from_account,
    to: params.to_account,
    amount: params.amount,
  }),

  get_payees: () => ({
    payees: [
      { payee_id: 'PAY-001', name: 'John Smith', account_number: '****5678', bank: 'Chase' },
      {
        payee_id: 'PAY-002',
        name: 'Electric Company',
        account_number: '****9012',
        bank: 'Wells Fargo',
      },
      {
        payee_id: 'PAY-003',
        name: 'Landlord LLC',
        account_number: '****3456',
        bank: 'Bank of America',
      },
    ],
  }),

  add_payee: (params) => ({
    payee_id: `PAY-${Math.floor(Math.random() * 1000)}`,
    name: params.name,
    status: 'added',
  }),
};
