/**
 * Airlines Domain Test Documents
 *
 * 4 realistic airline documents for SearchAI ingestion.
 * Each ~1000 words to produce 3-5 chunks with chunkSize: 256 tokens (~1024 chars).
 * Differentiated sourceMetadata enables meaningful filter and aggregation testing.
 */

export interface TestDocumentDef {
  title: string;
  rawText: string;
  sourceMetadata: Record<string, unknown>;
}

// =============================================================================
// 1. FLIGHT OPERATIONS MANUAL (~1000 words)
// =============================================================================

export const FLIGHT_OPERATIONS_MANUAL: TestDocumentDef = {
  title: 'SkyWay Airlines Flight Operations Manual',
  sourceMetadata: {
    category: 'operations',
    document_type: 'manual',
    cabin_class: 'all',
    route_type: 'international',
    base_fare: 450.0,
  },
  rawText: `SkyWay Airlines Flight Operations Manual provides comprehensive guidance for all flight operations across the airline's global network. This manual covers fleet management, route networks, hub operations, crew scheduling, and turnaround procedures essential for maintaining safe and efficient air travel.

Fleet Overview and Aircraft Types. SkyWay Airlines operates a diverse fleet designed to serve both short-haul and long-haul routes efficiently. The Boeing 737-800 serves as the workhorse for domestic and regional routes, configured with 162 seats in a two-class layout featuring 16 business class seats and 146 economy seats. The Airbus A320neo handles medium-haul operations with enhanced fuel efficiency, carrying 180 passengers in economy or 150 in a mixed-class configuration. For long-haul international routes, the Boeing 787-9 Dreamliner provides superior range and passenger comfort with 290 seats across three classes: 28 first class suites, 48 business class lie-flat seats, and 214 economy seats. The fleet also includes the Airbus A350-900 for ultra-long-haul routes, capable of nonstop flights exceeding 15 hours with 325 passengers.

Route Network and Hub Operations. The airline operates a hub-and-spoke network centered on three primary hubs. The main hub at Metropolitan International Airport handles over 400 daily departures connecting to 120 domestic destinations and 85 international destinations across six continents. The secondary hub at Pacific Gateway serves as the primary connection point for Asia-Pacific routes, with 180 daily flights. The European hub at Atlantic Crossroads Airport manages 150 daily operations serving 60 European and Middle Eastern destinations. Spoke airports connect to the hubs through frequent shuttle services, typically operating every 30 to 90 minutes during peak periods. Code-share agreements with partner airlines extend the effective network to over 500 destinations worldwide.

Crew Scheduling and Management. Flight crew scheduling follows strict regulatory requirements for duty time limitations and rest periods. Pilots are limited to 8 hours of flight time per duty period and 100 hours per 28-day rolling period. Flight attendant duty periods may not exceed 14 hours with a minimum rest period of 10 consecutive hours between assignments. Reserve crews are maintained at each hub with a minimum response time of 2 hours for domestic operations and 4 hours for international departures. Crew pairing optimization software assigns crews to multi-day trip sequences that balance cost efficiency with quality of life, considering home base proximity, qualification currencies, and seniority preferences.

Turnaround Procedures. Standard turnaround time for domestic narrow-body operations is 35 minutes, comprising 8 minutes for passenger deplaning, 12 minutes for cabin cleaning and catering replenishment, 10 minutes for refueling and cargo handling, and 5 minutes for passenger boarding finalization. International wide-body turnarounds require 90 minutes minimum, adding time for customs documentation, galley restocking for multi-course meal service, and extended safety equipment checks. Quick turnaround procedures can reduce domestic turnaround to 25 minutes for on-time performance recovery, though this requires pre-positioned ground crews and simplified catering. Gate assignment optimization ensures aircraft taxi distances are minimized, with wide-body aircraft assigned to gates with dual jet bridges for simultaneous boarding from both doors.

Dispatch and Flight Planning. Flight dispatchers prepare comprehensive flight plans including fuel calculations, weather analysis, route optimization, and alternate airport selection. Fuel planning includes trip fuel, contingency reserves of 5 percent, alternate airport fuel, holding fuel for 30 minutes, and taxiing fuel. Cost index optimization balances fuel consumption against time-related costs to determine optimal cruising speed. Dispatchers monitor flights in real-time through the operations control center, providing crews with updated weather information, turbulence reports, and routing amendments. Automated flight planning systems generate initial plans that dispatchers review and modify based on operational knowledge and current conditions.

Maintenance and Airworthiness. Aircraft maintenance follows a structured program of line checks, A-checks, B-checks, C-checks, and D-checks at prescribed intervals. Daily line checks require 45 minutes and cover fluid levels, tire pressure, control surfaces, and cabin safety equipment. A-checks occur every 500 flight hours and take approximately 6 hours. C-checks at 18-month intervals require 2 weeks and involve detailed structural inspections. D-checks every 6 years require 4 to 6 weeks at specialized maintenance facilities. The maintenance control center coordinates aircraft routing to align scheduled maintenance with operational requirements, minimizing revenue impact while ensuring compliance with airworthiness directives.

Safety Management System. SkyWay Airlines maintains a proactive safety management system that identifies hazards before they lead to incidents. Voluntary safety reporting encourages crew members to report concerns without fear of punitive action. Safety performance indicators track rates of unstabilized approaches, hard landings, ground incidents, and crew fatigue reports. Monthly safety review boards analyze trends and implement corrective actions. Emergency response procedures are tested through regular tabletop exercises and full-scale annual emergency drills involving all operational departments.`,
};

// =============================================================================
// 2. BAGGAGE & FARE POLICY (~1000 words)
// =============================================================================

export const BAGGAGE_FARE_POLICY: TestDocumentDef = {
  title: 'SkyWay Airlines Baggage and Fare Policy',
  sourceMetadata: {
    category: 'policy',
    document_type: 'reference',
    cabin_class: 'economy',
    route_type: 'domestic',
    base_fare: 199.99,
  },
  rawText: `SkyWay Airlines Baggage and Fare Policy outlines the rules and allowances for checked baggage, carry-on items, excess baggage fees, fare families, and cancellation and refund procedures. This policy applies to all passengers traveling on SkyWay Airlines operated flights.

Checked Baggage Allowances by Class. Economy class passengers on domestic routes receive one free checked bag weighing up to 23 kilograms with maximum linear dimensions of 158 centimeters. Economy passengers on international routes receive two free checked bags at 23 kilograms each. Business class passengers receive two checked bags at 32 kilograms each on all routes, with priority handling tags for expedited delivery at the destination carousel. First class passengers receive three checked bags at 32 kilograms each, with dedicated baggage handling and guaranteed delivery within 15 minutes of aircraft arrival at the gate. All checked bags must comply with size restrictions to fit standard baggage handling systems.

Carry-On Baggage Rules. All passengers may bring one carry-on bag and one personal item aboard the aircraft. The carry-on bag must fit in the overhead compartment with maximum dimensions of 56 by 36 by 23 centimeters and weight not exceeding 10 kilograms. The personal item must fit under the seat and may not exceed 43 by 33 by 16 centimeters. Business and first class passengers may bring an additional garment bag. Laptop bags, purses, and small backpacks qualify as personal items. Duty-free purchases in sealed transparent bags are permitted in addition to the standard allowance.

Excess Baggage Fees and Overweight Charges. Additional checked bags beyond the class allowance incur a fee of 35 dollars per bag on domestic routes and 75 dollars per bag on international routes. Overweight bags between 23 and 32 kilograms incur a surcharge of 50 dollars. Bags weighing between 32 and 45 kilograms are subject to a 100-dollar heavy bag fee. No individual bag may exceed 45 kilograms or 203 centimeters in linear dimensions. Oversized items such as sports equipment, musical instruments, and surfboards are accepted as checked baggage with applicable oversize fees of 75 to 150 dollars depending on the item category.

Fare Families and Ticket Types. SkyWay Airlines offers three fare families in economy class. Basic Economy is the most affordable option at fares starting from 89 dollars, including one carry-on and one personal item but no checked baggage, no seat selection until check-in, and no changes or cancellations. Flex Economy starts at 199 dollars and includes one checked bag, advance seat selection, free changes with fare difference payment, and cancellation for a 75-dollar fee with travel credit issued. Premium Economy starts at 349 dollars and includes two checked bags, priority boarding, extra legroom seating, free unlimited changes, and full refund on cancellation. Business and first class tickets include full flexibility with free changes and refundable cancellations.

Cancellation and Refund Rules. Passengers may cancel any ticket within 24 hours of purchase for a full refund regardless of fare type, in compliance with regulatory requirements. After the 24-hour window, cancellation terms depend on the fare family purchased. Basic Economy tickets are nonrefundable and nonchangeable after the 24-hour grace period. Flex Economy cancellations receive a travel credit valid for 12 months minus the cancellation fee. Premium Economy and above receive full refunds to the original payment method within 7 business days. Schedule changes initiated by the airline exceeding 2 hours entitle passengers to a full refund or rebooking at no additional cost. Involuntary cancellations due to weather, mechanical issues, or crew availability include rebooking on the next available flight, meal vouchers for delays exceeding 3 hours, and hotel accommodation for overnight delays.

Fare Rules and Pricing Structure. All fares are subject to government taxes, airport fees, and fuel surcharges displayed separately at the time of booking. Fare rules vary by route, season, and advance purchase period. Tickets purchased 21 or more days in advance typically offer the lowest fares. Same-day standby is available for Flex Economy and above at no additional charge when seats are available. Unaccompanied minor service is available for children aged 5 to 14 traveling alone, with a service fee of 100 dollars each way including dedicated staff escort and priority boarding. Group bookings of 10 or more passengers qualify for negotiated group fares with dedicated reservation support.

Special Items and Restricted Articles. Passengers may transport special items subject to advance notification and applicable fees. Mobility aids including wheelchairs and scooters are transported free of charge. Service animals are permitted in the cabin at no charge with proper documentation. Pet carriers meeting size requirements are allowed in the cabin for a fee of 95 dollars per segment. Live animals in checked baggage are accepted on select routes with temperature restrictions to ensure animal welfare. Dangerous goods including lithium batteries, flammable liquids, and compressed gases are subject to IATA dangerous goods regulations and may require special packaging or documentation.`,
};

// =============================================================================
// 3. LOYALTY PROGRAM GUIDE (~1000 words)
// =============================================================================

export const LOYALTY_PROGRAM_GUIDE: TestDocumentDef = {
  title: 'SkyWay Airlines Loyalty Program Guide',
  sourceMetadata: {
    category: 'loyalty',
    document_type: 'guide',
    cabin_class: 'business',
    route_type: 'international',
    base_fare: 850.0,
  },
  rawText: `SkyWay Airlines Loyalty Program Guide describes the SkyMiles frequent flyer program, including tier structure, earning rates, redemption options, partner airlines, lounge access, and upgrade priority. SkyMiles is designed to reward loyal travelers with increasingly valuable benefits as they advance through membership tiers.

Tier Structure and Qualification. The SkyMiles program features four membership tiers: Blue, Silver, Gold, and Platinum. Blue membership is the entry level, automatically granted upon program enrollment at no cost. Silver status requires earning 25,000 qualifying miles or completing 30 qualifying segments within a calendar year. Gold status requires 50,000 qualifying miles or 60 qualifying segments. Platinum status, the most prestigious tier, requires 75,000 qualifying miles or 100 qualifying segments. Qualifying miles are earned based on the distance flown and the fare class purchased, with premium cabins earning a higher multiplier. Status is valid for the qualification year plus the following calendar year, giving members a minimum 12-month status window.

Earning Rates and Accrual. Members earn SkyMiles on every SkyWay Airlines flight based on distance flown and fare class multiplier. Economy class tickets earn 100 percent of miles flown. Premium Economy earns 125 percent. Business class earns 150 percent. First class earns 200 percent of miles flown. Bonus earning rates apply based on tier status: Silver members receive a 25 percent bonus on base miles, Gold members receive 50 percent, and Platinum members receive 100 percent bonus miles. For example, a Platinum member flying 5,000 miles in business class would earn 5,000 base miles times 150 percent class multiplier times 200 percent Platinum bonus, totaling 15,000 SkyMiles. Partner airline flights earn miles at published partner rates, typically between 50 and 100 percent of miles flown.

Redemption Options and Award Travel. SkyMiles can be redeemed for award flights, upgrades, and non-flight rewards. Domestic economy award flights start at 12,500 miles each way. International economy awards start at 30,000 miles. Business class awards range from 50,000 to 80,000 miles depending on the destination. First class awards range from 80,000 to 120,000 miles. Dynamic pricing applies to award availability, with off-peak travel dates offering lower redemption rates. Upgrade awards allow members to move from economy to business or business to first class using a combination of miles and a co-pay amount. Non-flight redemptions include hotel stays, car rentals, merchandise, and charity donations, though flight redemptions typically offer the best value per mile.

Partner Airlines and Alliances. SkyWay Airlines is a member of the Global Wings Alliance, connecting frequent flyers to a network of 26 partner airlines spanning every continent. SkyMiles members earn and redeem miles across all alliance partners, access reciprocal lounge benefits based on tier status, and enjoy priority services including check-in, boarding, and baggage handling. Key alliance partners include EuroWings for European coverage, Pacific Star for Asia-Pacific routes, Southern Cross Airlines for South American destinations, and Safari Airways for African routes. Non-alliance bilateral partners include select regional carriers that extend the earning network to secondary destinations.

Lounge Access and Premium Benefits. Silver members receive two complimentary lounge passes per year for use at any SkyWay Airlines lounge worldwide. Gold members enjoy unlimited lounge access when traveling on SkyWay Airlines or partner flights, including access to alliance partner lounges. Platinum members receive complimentary access to all SkyWay Airlines lounges plus the exclusive Platinum Lounge at the three hub airports, featuring private suites, spa services, gourmet dining, and dedicated concierge assistance. Platinum members may also bring one guest to any lounge. Lounge amenities include complimentary beverages and snacks, high-speed wireless internet, business center facilities, shower suites, and quiet rest areas.

Upgrade Priority and Cabin Benefits. Upgrade availability is allocated based on tier status, with Platinum members receiving highest priority for complimentary upgrades, followed by Gold and Silver members. Complimentary upgrades are processed 72 hours before departure for Platinum members, 48 hours for Gold members, and 24 hours for Silver members. When multiple members are on the upgrade waitlist for the same flight, Platinum members clear first regardless of check-in time. All elite members receive priority check-in counters, expedited security screening where available, and priority boarding. Platinum members additionally receive guaranteed economy seating on sold-out flights when booked at least 24 hours in advance, waived change and cancellation fees on all fare types, and a dedicated reservation phone line with average hold times under 60 seconds.

SkyMiles Credit Card Benefits. The SkyMiles co-branded credit card offers accelerated earning on everyday purchases. The standard card earns 1 mile per dollar on general spending and 2 miles per dollar on SkyWay Airlines purchases. The premium card earns 1.5 miles per dollar general and 3 miles per dollar on airline purchases, plus an annual companion certificate for domestic travel. Card spending counts toward status qualification at a rate of 1 qualifying mile per 5 dollars spent, providing a path to elite status for travelers who may not fly frequently enough to qualify through flying alone.`,
};

// =============================================================================
// 4. IN-FLIGHT SERVICES CATALOG (~1000 words)
// =============================================================================

export const INFLIGHT_SERVICES_CATALOG: TestDocumentDef = {
  title: 'SkyWay Airlines In-Flight Services Catalog',
  sourceMetadata: {
    category: 'services',
    document_type: 'catalog',
    cabin_class: 'first',
    route_type: 'international',
    base_fare: 1299.99,
  },
  rawText: `SkyWay Airlines In-Flight Services Catalog details the comprehensive range of services available aboard SkyWay Airlines flights, including meal service by class and route, entertainment systems, Wi-Fi connectivity, duty-free shopping, and premium amenities for business and first class passengers.

Meal Service by Class and Route. Domestic economy flights of 2 hours or more include a complimentary snack box with a selection of crackers, cheese, dried fruit, and a cookie, along with complimentary non-alcoholic beverages. Premium buy-on-board options are available including fresh sandwiches at 9 dollars, salad boxes at 8 dollars, and snack platters at 6 dollars. Domestic business class receives a freshly prepared meal selected from two entree options with a starter salad, artisan bread roll, and dessert. International economy meals include a full three-course meal with choice of two entrees, bread roll, salad, and dessert, served with complimentary beer and wine. International business class features a multi-course dining experience beginning with canapes and champagne during boarding, followed by an appetizer course, soup or salad, choice of three premium entrees, cheese course, and dessert with specialty coffee. International first class offers an exclusive chef-curated menu with seven courses including amuse-bouche, caviar service, seasonal soup, premium entree selections such as beef tenderloin or lobster thermidor, artisanal cheese, dessert, and petit fours.

Entertainment Systems. All aircraft are equipped with personal seatback screens in every seat. Economy screens measure 10 inches with touchscreen interface, featuring over 200 movies, 400 television episodes, music playlists, games, and a moving flight map. Business class screens are 15 inches with noise-cancelling headphones provided. First class features 22-inch high-definition screens with Bluetooth connectivity for personal headphones and a library of over 500 movies including new releases. Content is refreshed monthly with a mix of recent theatrical releases, classic films, documentaries, and children's programming. Live television is available on selected routes with news and sports channels. Audio entertainment includes curated playlists, podcasts, and meditation content for relaxation during flight.

Wi-Fi Connectivity and Connectivity Services. High-speed satellite Wi-Fi is available on all aircraft. Economy passengers may purchase Wi-Fi access at 8 dollars per hour or 19 dollars for a full-flight pass. Business class passengers receive complimentary Wi-Fi for the duration of the flight. First class passengers enjoy premium high-bandwidth Wi-Fi suitable for video conferencing and streaming. Messaging packages allowing text-based messaging apps are available for 3 dollars per flight for all passengers. The onboard portal provides free access to destination guides, airline information, and flight status without a Wi-Fi purchase. Power outlets and USB charging ports are available at every seat across all classes.

Duty-Free Shopping. The in-flight duty-free catalog features a curated selection of premium products available for purchase on international flights exceeding 3 hours. Categories include fragrances from luxury brands, premium spirits and wine collections, designer accessories, skincare products, and confectionery. Pre-order service allows passengers to browse the catalog online before their flight and have purchases delivered to their seat. Payment is accepted in major currencies and all major credit cards. Exclusive SkyWay Airlines branded merchandise includes travel accessories, model aircraft, and limited-edition collaboration items. SkyMiles members earn bonus miles on all duty-free purchases.

Premium Amenities for Business Class. Business class passengers enjoy lie-flat seats that convert to a 180-degree fully flat bed measuring 78 inches in length. Each seat includes a personal reading light, adjustable headrest, lumbar support, and in-seat massage function. A memory foam mattress pad, duvet, and full-size pillow are provided for overnight flights. Amenity kits by luxury brand partners include skincare products, eye mask, earplugs, socks, and dental kit. Turn-down service on overnight flights includes seat conversion to bed mode, ambient lighting adjustment, and a warm beverage service. Pre-departure service includes welcome champagne or juice and warm towel service.

Premium Amenities for First Class. First class passengers experience the ultimate in air travel luxury. Private suites with sliding doors provide complete personal space. Seats convert to lie-flat beds measuring 82 inches with premium bedding including a plush mattress topper, goose-down duvet, and multiple pillow options. Pajama kits by designer brands are offered on all international flights exceeding 8 hours. The onboard shower suite on selected Boeing 787 aircraft allows first class passengers to refresh during long-haul flights with a 15-minute shower appointment. Personal wardrobe closets accommodate hanging garments. Individual minibars are stocked with premium beverages. The onboard lounge area between first and business class offers a social space for cocktails and conversation. First class passengers receive expedited immigration and customs assistance at select international destinations through the airline's arrival concierge service.

Health and Wellness. SkyWay Airlines promotes passenger wellness with several in-flight features. Cabin air is refreshed every 3 minutes through HEPA filtration systems that remove 99.97 percent of airborne particles. Cabin humidity systems on Boeing 787 aircraft maintain comfortable moisture levels to reduce the effects of dry cabin air. In-flight exercise guides are available through the entertainment system with stretching routines designed for seated passengers. Hydration service ensures water is offered regularly throughout the flight. Medical kits and automated external defibrillators are carried on all flights, and crew members receive regular first aid training.`,
};

// =============================================================================
// ALL DOCUMENTS
// =============================================================================

export const ALL_AIRLINE_DOCUMENTS: TestDocumentDef[] = [
  FLIGHT_OPERATIONS_MANUAL,
  BAGGAGE_FARE_POLICY,
  LOYALTY_PROGRAM_GUIDE,
  INFLIGHT_SERVICES_CATALOG,
];
