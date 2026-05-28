# Organization Profile: Southwire Company

> **Company**: Southwire Company, LLC
> **Industry**: Electrical Wire & Cable Manufacturing
> **Profile Version**: 1.0
> **Last Updated**: 2026-02-24
> **Purpose**: Company-specific context for knowledge graph configuration

This organization profile provides company-specific details about Southwire's structure, operations, and business context. This is **distinct from domain definitions** (which define product taxonomies) and provides the LLM with company-specific context for accurate entity extraction and relationship building.

---

## Section 1: Company Overview

### Corporate Identity

- **Legal Name**: Southwire Company, LLC
- **Founded**: 1950 (75+ years in operation)
- **Ownership**: Family-owned, privately held company
- **Headquarters**: One Southwire Drive, Carrollton, Georgia 30119, United States
- **Stock Exchange**: Not publicly traded (private company)
- **Tagline**: "We Deliver Power...Responsibly®"

### Company Size & Market Position

- **Employee Count**: ~4,600-5,000 employees
- **Industry Classification**: Appliances, Electrical, and Electronics Manufacturing
- **Market Position**: One of North America's largest wire and cable manufacturers
- **Geographic Presence**: United States (primary), Canada, International (via SCR Technologies)
- **Production Scale**:
  - Nearly 1 in 2 new U.S. homes contains Southwire wire
  - Produces half of the cable used to transmit and distribute electricity throughout the U.S.
  - More than half of the world's refined copper passes through their SCR systems

### Key Business Model Characteristics

- **Type**: Vertically integrated manufacturer
- **Integration Scope**: Raw material processing (copper/aluminum rod) → Finished products (wire, cable, tools) → Installation services → Training
- **Ownership Structure**: Generational family ownership maintaining long-term perspective
- **Core Values**: Team members, customers, communities, shareholders (ONE Southwire culture)

---

## Section 2: Product Disambiguation (CRITICAL)

This section explains how similar-sounding products differ within Southwire's offerings. This is the **most important section for preventing false relationships** in the knowledge graph.

### 2.1 Cable Types: Voltage-Based Disambiguation

**CRITICAL**: "Cable" at Southwire has drastically different meanings based on voltage class. DO NOT mix these up.

#### Building Wire (Low Voltage: ≤600V)

- **Use Case**: Residential and commercial branch circuits, lighting, receptacles
- **Voltage Rating**: 600V or less
- **Typical Applications**: Inside buildings, NEC-compliant installations
- **Key Products**: THHN, THWN, XHHW, Romex, MC Cable
- **Standards**: NEC Article 310, UL 83
- **Sizing**: AWG (American Wire Gauge) - 14 AWG, 12 AWG, 10 AWG, etc.
- **Customer Segment**: Electrical contractors (residential/commercial)
- **Disambiguation Keywords**: building wire, branch circuit, NEC, THHN, residential, commercial

**DO NOT CONFUSE WITH**:

- Medium voltage cable (different voltage class, different applications, different standards)
- Power cable (high voltage transmission - completely different product line)

#### Medium Voltage Cable (1kV - 69kV)

- **Use Case**: Utility distribution from substation to transformers, industrial power distribution
- **Voltage Rating**: 1kV to 69kV (most common: 15kV, 25kV, 35kV)
- **Typical Applications**: Underground distribution, primary UD, industrial plants
- **Key Products**: XLPE insulated power cable, EPR cable, Primary UD cable
- **Standards**: ICEA S-94-649, AEIC specifications
- **Sizing**: kcmil (thousand circular mils) - 250 kcmil, 500 kcmil, 1000 kcmil
- **Customer Segment**: Electric utilities, large industrial facilities
- **Disambiguation Keywords**: medium voltage, MV, primary distribution, XLPE, utility, substation

**DO NOT CONFUSE WITH**:

- Building wire (much lower voltage - 600V vs 15kV+)
- High voltage transmission cable (higher voltage class - 69kV+)

#### High Voltage Transmission Cable (≥69kV)

- **Use Case**: Long-distance power transmission, utility transmission lines
- **Voltage Rating**: 69kV and above (138kV, 230kV, 500kV)
- **Typical Applications**: Utility transmission grids, power plant connections
- **Key Products**: HV underground transmission cable, EHV cable
- **Standards**: IEEE 1202, AEIC CS8
- **Sizing**: Large kcmil sizes, specialized constructions
- **Customer Segment**: Electric utilities (transmission division), power authorities
- **Disambiguation Keywords**: high voltage, HV, transmission, 69kV, 138kV, utility grid

**DO NOT CONFUSE WITH**:

- Medium voltage cable (lower voltage - distribution vs transmission)
- Building wire (orders of magnitude lower voltage)

### 2.2 "Distribution" - Context-Dependent Meaning

**CRITICAL**: "Distribution" has two completely different meanings at Southwire. Always disambiguate by context.

#### Electrical Distribution (Technical)

- **Meaning**: Movement of electrical power from substations to end users
- **Subdivisions**:
  - **Primary Distribution**: Medium voltage (15kV-35kV) from substation to transformers
  - **Secondary Distribution**: Low voltage (120V-480V) from transformers to buildings
- **Products Involved**: Medium voltage cable, secondary cable, transformers, switchgear
- **Department**: Wire & Cable Division (technical product line)
- **Disambiguation Keywords**: primary distribution, secondary distribution, MV, substation, transformer, electrical grid

#### Product Distribution (Logistics)

- **Meaning**: Physical delivery of Southwire products from factories to customers
- **Involves**: Warehouses, freight, distributors, reel tracking, inventory management
- **Customer Segment**: Electrical distributors (wholesalers)
- **Department**: Sales & Logistics
- **Disambiguation Keywords**: distributor, warehouse, freight, delivery, reel tracking, inventory

**Query Disambiguation**:

- "What is secondary distribution?" → **Answer from Electrical Distribution** (technical: low voltage from transformers)
- "Who are our distributors?" → **Answer from Product Distribution** (logistics: wholesale customers)
- "Distribution cable specifications" → **Electrical Distribution** (technical product)
- "Distribution center locations" → **Product Distribution** (logistics facilities)

### 2.3 Cable vs Wire: Important Distinction

**Wire**:

- Single conductor (one conductive path)
- May or may not have insulation
- Examples: Building wire (THHN), bare copper wire, grounding wire
- Sizing: AWG for smaller sizes

**Cable**:

- Multiple conductors bundled together, or
- Single conductor with multiple protective layers (insulation + jacket + armor)
- Examples: MC Cable (metal-clad), power cable (MV/HV), armored cable, transit cable
- Sizing: AWG or kcmil depending on application

**Disambiguation in Knowledge Graph**:

- "12 AWG THHN" → **Wire** (single conductor building wire)
- "12/2 MC Cable" → **Cable** (two 12 AWG conductors bundled in metal-clad assembly)
- "500 kcmil power cable" → **Cable** (medium/high voltage power cable)

### 2.4 Service Types: Field Service vs Customer Service vs Product Services

**CRITICAL**: "Service" has multiple distinct meanings. Never mix these.

#### Field Service (Installation & Support)

- **Meaning**: On-site installation, splicing, termination, testing of cable systems
- **Offerings**:
  - High Voltage Installation Team (HV cable installation)
  - Storm Activation Team (emergency utility response)
  - Cable Rejuvenation (underground system maintenance)
  - Field Assessment Services (diagnostic evaluation)
- **Department**: Technical Services Division
- **Customer Interaction**: On-site at utility substations, industrial facilities, construction sites
- **Disambiguation Keywords**: installation, field service, HV installation, storm response, on-site, splice, terminate

#### Customer Service (Order Support)

- **Meaning**: Order processing, pricing, delivery coordination, general inquiries
- **Offerings**:
  - Customer Hub (online ordering platform)
  - Order tracking and promise dates
  - Reel return processing
  - Quote generation
- **Department**: Customer Service & Sales Support
- **Customer Interaction**: Phone, email, online portal
- **Disambiguation Keywords**: order status, pricing, delivery, customer hub, quote, reel return

#### Product Services (Value-Added Offerings)

- **Meaning**: Specialized product-related services sold as distinct offerings
- **Offerings**:
  - SPEED Services (expedited manufacturing)
  - Reel Leasing Program
  - Custom cable manufacturing
  - Cable cutting and packaging
- **Department**: Wire & Cable Division (product line extensions)
- **Customer Interaction**: Through sales representatives as add-on services
- **Disambiguation Keywords**: SPEED Services, expedited, custom cable, reel lease, manufacturing services

**Query Disambiguation**:

- "How do I request service?" → **Disambiguate**: Are you asking about (1) field installation, (2) order support, or (3) expedited manufacturing?
- "Service team contact" → **Context needed**: Installation team? Customer service? Technical support?

### 2.5 "Rod" - Copper Rod vs Fishing Rod (Tools)

**Copper/Aluminum Rod (Material)**:

- **Meaning**: Intermediate product form - continuous cast rod used as raw material for wire drawing
- **Context**: SCR Technologies Division (equipment) and internal manufacturing
- **Form**: 5/16" or 3/8" diameter continuous rod on large reels
- **Use**: Fed into wire drawing machines to produce smaller wire sizes
- **Disambiguation Keywords**: copper rod, aluminum rod, continuous rod, SCR, rod mill, casting

**Fishing Rod (Tool)**:

- **Meaning**: Flexible fiberglass or steel rod used to pull cable through conduit or walls
- **Context**: Tools & Equipment Division (contractor tools)
- **Form**: 1/4" to 1/2" diameter, lengths of 3-6 feet, often in kits
- **Use**: Cable installation - navigate through conduit to attach pull rope
- **Disambiguation Keywords**: fish rod, fish tape, cable fishing, pulling rod, conduit rod

**Query Disambiguation**:

- "Rod diameter specifications" → **Context needed**: Copper rod (5/16") or fishing rod (1/4"-1/2")?
- "Rod production" → **Copper rod** (SCR Technologies manufacturing)
- "Rod kit" → **Fishing rod** (contractor tool kit)

### 2.6 Grounding: Electrical Grounding vs Physical Ground

**Electrical Grounding (Safety Connection)**:

- **Meaning**: Electrical connection to earth potential for safety and system protection
- **Components**: Grounding wire, grounding electrodes, ground rods, bonding conductors
- **Standards**: NEC Article 250, grounding requirements
- **Purpose**: Fault current path, lightning protection, voltage stabilization
- **Disambiguation Keywords**: electrical ground, safety ground, grounding conductor, earth ground, bonding, NEC 250

**Physical Ground (Soil/Earth)**:

- **Meaning**: Physical earth, soil, or terrain for cable burial
- **Context**: Underground cable installation, direct burial cable
- **Considerations**: Soil resistivity, moisture, corrosion, depth
- **Disambiguation Keywords**: direct burial, underground, soil, earth, buried cable, trench

**Query Disambiguation**:

- "Ground requirements" → **Electrical grounding** (safety standards)
- "Ground conditions" → **Physical ground** (soil characteristics for burial)

---

## Section 3: Business Divisions & Department Structure

### 3.1 Division Hierarchy

```
Southwire Company
│
├── Wire & Cable Division (PRIMARY BUSINESS)
│   ├── Transmission & Distribution Products
│   │   ├── High Voltage Underground Transmission (≥69kV)
│   │   ├── Bare Aluminum Overhead Transmission & Distribution
│   │   ├── Medium Voltage Power Cable (1kV-69kV)
│   │   ├── 600V Secondary Distribution
│   │   └── Covered Aerial MV (CAMV) Systems
│   │
│   ├── Building & Construction Products
│   │   ├── Building Wire (THHN, THWN, XHHW)
│   │   ├── Metal Clad Cable (MC Cable)
│   │   ├── Armored Power Cable
│   │   ├── SIMpull Cable In Conduit
│   │   └── Genesis Cable
│   │
│   ├── Specialty Cables
│   │   ├── Transit Cable & Accessories
│   │   ├── Mining Cable
│   │   ├── Low Voltage Cable
│   │   ├── Instrumentation Cable
│   │   ├── Telecom Power Cable
│   │   └── Substation Cable
│   │
│   └── Industrial Applications
│       ├── Power & Control Cable
│       ├── Industrial Flexible Cable
│       ├── Flexible Conduit & Cord
│       ├── Pump & Irrigation Cable
│       ├── HVAC Cable
│       ├── Leadwire
│       └── Whips (Modular Cable Assemblies)
│
├── Tools & Equipment Division
│   ├── Cable Installation Tools
│   │   ├── Cable Pulling & Fishing Equipment
│   │   ├── Bending Tools
│   │   └── Cable Preparation & Termination
│   │
│   ├── Hole Making Equipment
│   │   ├── Drills & Punches
│   │   └── Saws & Cutting Tools
│   │
│   ├── Material Handling
│   │   ├── Entertainment Lifts
│   │   ├── Chain Hoists
│   │   └── Jacks & Stands
│   │
│   └── Test & Measurement
│       ├── Electrical Testing Equipment
│       └── VDV Tools (Voice-Data-Video)
│
├── SCR Technologies Division
│   ├── Copper Rod Systems
│   │   ├── Continuous Rod Casting Equipment
│   │   └── SCR AMPS Upgrades
│   │
│   ├── Aluminum Rod Systems
│   │   ├── EC Aluminum Rod Systems
│   │   └── Alloy Rod Systems
│   │
│   └── Support Equipment
│       ├── Shaft Furnaces & Vortex Burners
│       ├── Ultra-D Ultrasonic Degassing
│       └── SMART Service Programs
│
├── Power Management Division
│   ├── Extension Cords
│   └── Temporary Power Distribution
│
├── Lighting Division
│   ├── Temporary Lighting (jobsite)
│   └── Lamps & Luminaires (permanent)
│
└── Electrical Components Division
    ├── Electrical Boxes & Covers
    ├── Cable Ties & Fasteners
    ├── Grounding & Bonding Products
    └── Conduit Accessories
```

### 3.2 Department Boundary Rules for Knowledge Graph

**RULE 1: Wire & Cable Division Boundaries**

**Building Wire EXCLUDES**:

- Medium voltage cable (different voltage class, different applications, different standards)
- Power cable (high voltage transmission)
- Specialty cables (transit, mining - different environmental requirements)

**Cross-Product Queries**:

- "What cable do I need for a 20A circuit?" → **Building Wire ONLY** (12 AWG THHN)
- "What cable do I need for a 15kV feeder?" → **Medium Voltage Power Cable ONLY** (not building wire)

**RULE 2: Tools & Equipment Division Boundaries**

**Tools EXCLUDE**:

- Wire/cable products (Tools install/prepare cable, they are not cable themselves)
- SCR equipment (manufacturing equipment, not installation tools)

**Cross-Product Queries**:

- "What do I need to pull cable?" → **Tools Division** (cable pullers, fish rods) + **Wire/Cable Division** (the cable being pulled)
- "Copper rod equipment" → **SCR Technologies** (manufacturing equipment, not contractor tools)

**RULE 3: Service Offering Boundaries**

**Field Installation Services EXCLUDE**:

- Customer service (order support)
- Technical support (CableTechSupport - engineering consultation)

**Cross-Service Queries**:

- "I need help installing HV cable" → **Field Installation Services** (HV Installation Team)
- "I need help sizing cable for my application" → **Technical Support** (CableTechSupport)
- "Where is my order?" → **Customer Service** (order tracking)

---

## Section 4: Customer Segments & Use Cases

### 4.1 Customer Segment Definitions

#### Electrical Contractors

- **Description**: Licensed electricians and electrical contracting firms
- **Subsegments**:
  - Residential contractors (home wiring, service upgrades)
  - Commercial contractors (office buildings, retail, hospitality)
  - Industrial contractors (factories, plants, heavy industry)
- **Typical Purchases**: Building wire, MC cable, tools, temporary lighting
- **Key Needs**: Product availability, local inventory, technical support, training (Solutions University)
- **Decision Criteria**: Code compliance, ease of installation (SIMpull), price
- **Buying Channels**: Through electrical distributors, direct for large projects
- **Typical Questions**:
  - "What wire size for a 50A circuit?"
  - "How to install MC cable?"
  - "Where can I buy THHN wire locally?"

#### Electric Utilities

- **Description**: Investor-owned utilities (IOUs), municipal utilities, co-ops providing electricity distribution and transmission
- **Subsegments**:
  - Transmission utilities (high voltage bulk power)
  - Distribution utilities (medium/low voltage to end customers)
  - Municipal utilities (city-owned)
  - Rural electric cooperatives
- **Typical Purchases**: Medium voltage cable, high voltage transmission cable, overhead bare conductor, transformers, switchgear
- **Key Needs**: Grid reliability, storm response, cable rejuvenation, long-term asset management
- **Decision Criteria**: Standards compliance (AEIC, IEEE), proven reliability, utility-specific specs, total cost of ownership
- **Buying Channels**: Direct from manufacturer (project-based), long-term supply agreements
- **Typical Questions**:
  - "What is the expected life of 15kV XLPE cable?"
  - "Storm response availability in hurricane season"
  - "Cable rejuvenation for 30-year-old underground system"

#### Industrial Customers

- **Description**: Manufacturing facilities, process industries, heavy industry with significant on-site power infrastructure
- **Subsegments**:
  - Oil, gas & petrochemical
  - Automotive manufacturing (including EV production)
  - Mining operations
  - Data centers
  - Food & beverage processing
- **Typical Purchases**: Power cable (MV and HV), control cable, instrumentation cable, specialized cables (mining, hazardous locations)
- **Key Needs**: High reliability, harsh environment performance, compliance with industry-specific standards (MSHA for mining, API for oil & gas)
- **Decision Criteria**: Technical specifications, industry certifications, total cost of ownership, supplier reliability
- **Buying Channels**: Direct or through industrial distributors
- **Typical Questions**:
  - "MSHA-approved mining cable specifications"
  - "Cable for Class I Div 2 hazardous location"
  - "Data center power redundancy design"

#### Electrical Distributors

- **Description**: Wholesale electrical distributors that stock and resell Southwire products
- **Subsegments**:
  - National chains (Graybar, Rexel, etc.)
  - Regional distributors
  - Specialty distributors (data center, renewable energy)
- **Typical Purchases**: Full product range (wire, cable, tools, accessories) for resale
- **Key Needs**: Inventory management (Reel Tracking System), real-time pricing, product training, marketing support
- **Decision Criteria**: Margin, inventory turns, supplier support, brand recognition
- **Buying Channels**: Direct from manufacturer with negotiated pricing
- **Typical Questions**:
  - "Reel tracking for inventory management"
  - "Product training for counter staff"
  - "Contractor referral program"

#### Renewable Energy & Infrastructure

- **Description**: Solar farms, wind farms, battery energy storage systems (BESS), EV charging infrastructure
- **Subsegments**:
  - Solar farm developers
  - Wind farm operators
  - BESS integrators
  - EV charging network operators
- **Typical Purchases**: Medium voltage cable, grounding products, specialized cables for harsh environments
- **Key Needs**: Long-term reliability (25+ year design life), environmental durability, cost optimization
- **Decision Criteria**: Levelized cost of energy (LCOE), proven reliability, compliance with renewable energy standards
- **Buying Channels**: Direct or through renewable energy specialists
- **Typical Questions**:
  - "Solar farm cable with 30-year warranty"
  - "Direct burial cable for wind farm collection systems"
  - "Grounding for BESS installations"

### 4.2 Use Case Mapping (Query → Product → Customer Segment)

| User Query                     | Product Category                       | Voltage Class                 | Customer Segment                               | Department                                 |
| ------------------------------ | -------------------------------------- | ----------------------------- | ---------------------------------------------- | ------------------------------------------ |
| "Wire for a 20A circuit"       | Building Wire                          | 600V                          | Electrical Contractor (Residential/Commercial) | Wire & Cable - Building                    |
| "Cable for 15kV distribution"  | Medium Voltage Power Cable             | 15kV                          | Electric Utility                               | Wire & Cable - Transmission & Distribution |
| "Mining cable specs"           | Mining Cable                           | Varies (typically 600V-5kV)   | Industrial (Mining)                            | Wire & Cable - Specialty                   |
| "Fish rod for conduit"         | Cable Fishing Tools                    | N/A (tool, not cable)         | Electrical Contractor                          | Tools & Equipment                          |
| "Storm response for utility"   | Field Installation Services + MV Cable | 15kV-35kV                     | Electric Utility                               | Technical Services + Wire & Cable          |
| "Data center power cable"      | Power Cable                            | MV (typically 15kV-25kV)      | Industrial (Data Center)                       | Wire & Cable - Industrial                  |
| "Copper rod casting equipment" | SCR Technology Systems                 | N/A (manufacturing equipment) | Global Rod Producers                           | SCR Technologies                           |

---

## Section 5: Internal Codes, Identifiers & Terminology

### 5.1 Product Identifier Patterns

**Building Wire SKU Pattern**:

- Format: `BW-#####` (Building Wire SKU)
- Example: `BW-12345` = 12 AWG THHN copper building wire
- Alternative format: `THHN-12AWG-1000FT` (product code with specs)

**Medium Voltage Cable SKU Pattern**:

- Format: `PC-#####` (Power Cable SKU)
- Example: `PC-67890` = 15kV 500 kcmil XLPE power cable
- Alternative format: `MV-15KV-500KCMIL` (voltage-size format)

**Tools SKU Pattern**:

- Format: `TOOL-#####`
- Example: `TOOL-98765` = Cable pulling grip

**SCR Equipment Model Pattern**:

- Format: `SCR-MODEL-####`
- Example: `SCR-AMPS-2024` = SCR AMPS copper rod system

### 5.2 Order & Project Identifiers

**Order Numbers**:

- Format: `ORD-YYMMDD-####`
- Example: `ORD-260224-1234` = Order placed on February 24, 2026

**Project Codes** (for large utility/industrial projects):

- Format: `PROJ-CUSTOMER-YEAR-##`
- Example: `PROJ-UTILITY-2026-05` = Utility project #5 in 2026

**Reel Numbers** (for tracking):

- Format: `REEL-#########` (unique reel identifier)
- Example: `REEL-123456789` = Specific cable reel

### 5.3 Standard Abbreviations

**Technical Abbreviations**:

- **AWG**: American Wire Gauge
- **kcmil** or **MCM**: Thousand circular mils (conductor size)
- **MV**: Medium Voltage (1kV-69kV)
- **HV**: High Voltage (≥69kV)
- **UD**: Underground Distribution
- **XLPE**: Cross-Linked Polyethylene (insulation type)
- **EPR**: Ethylene Propylene Rubber (insulation type)
- **NEC**: National Electrical Code
- **UL**: Underwriters Laboratories
- **ICEA**: Insulated Cable Engineers Association
- **AEIC**: Association of Edison Illuminating Companies (utility specs)

**Product Abbreviations**:

- **THHN**: Thermoplastic High Heat-resistant Nylon-coated (building wire)
- **THWN**: Thermoplastic Heat and Water-resistant Nylon-coated
- **XHHW**: Cross-linked High Heat-resistant Water-resistant
- **MC**: Metal-Clad (cable type)
- **CAMV**: Covered Aerial Medium Voltage
- **VDV**: Voice-Data-Video (low voltage communications)

**Organizational Abbreviations**:

- **SSU**: Solutions University (Southwire training division)
- **SCR**: Southwire Continuous Rod (technology/division name)
- **SPEED**: Expedited manufacturing service (not an acronym)

---

## Section 6: Business Processes

### 6.1 Order Fulfillment Process

**Standard Order Flow**:

1. **Quote Generation** - Customer or distributor requests pricing via Customer Hub or sales rep
2. **Real-Time Pricing** - Customer Hub provides instant pricing for standard products
3. **Order Placement** - Online (Customer Hub) or through sales representative
4. **Customer Promise Date** - System assigns committed delivery date based on manufacturing schedule
5. **Manufacturing** - Production scheduling and execution at manufacturing facility
6. **Reel Tracking** - Each reel assigned unique identifier for asset management
7. **Freight/Delivery** - Shipment per freight policy (LTL, truckload, or customer pickup)
8. **Reel Return Program** - Customer returns reusable reels for credit or lease program

**Expedited Process (SPEED Services)**:

- Reduced lead times (typically 50% faster than standard)
- Lower minimum order quantities
- Dedicated concierge specialists for order management
- Priority manufacturing scheduling
- Premium pricing

**Key Touchpoints**:

- Customer Hub (online ordering platform)
- Sales Representative (territory-based account management)
- Customer Service Team (order support and tracking)

### 6.2 Technical Support Process (CableTechSupport)

**Workflow**:

1. **Initial Consultation** - Customer describes technical challenge or application requirement
2. **Engineering Analysis** - Multi-disciplinary team (electrical, mechanical, civil, polymer science) reviews requirements
3. **Solution Development** - Product selection, system design, calculation verification
4. **Specification** - Detailed technical specifications and recommendations provided to customer
5. **Implementation Support** - Installation guidance, jobsite consultation (if needed)
6. **Ongoing Support** - Post-installation assistance, troubleshooting

**Expertise Areas**:

- Power engineering (voltage drop, ampacity, grounding)
- Electrical engineering (system design, protection coordination)
- Mechanical engineering (cable pulling tension, bending radius)
- Civil engineering (underground installation, direct burial)
- Chemical engineering (insulation degradation, environmental resistance)
- Polymer science (insulation materials, aging characteristics)
- Industrial engineering (manufacturing process optimization)
- Nuclear engineering (nuclear plant cable specifications)

**Access Points**:

- Phone: Technical support hotline
- Email: CableTechSupport email
- Online: Customer Hub support request
- Field: Sales representative coordination

### 6.3 Field Installation Services

**High Voltage Installation Process**:

1. **Project Assessment** - Site evaluation, installation method review, logistics planning
2. **Installation Planning** - Method statement, safety plan, crew mobilization
3. **Cable Pulling** - Factory-certified technicians execute pulling operation with tension monitoring
4. **Splicing** - High voltage cable joining using certified splicing kits
5. **Terminating** - Connection to transformers, switchgear, or other equipment
6. **Testing** - Electrical testing (insulation resistance, partial discharge, VLF) and commissioning
7. **Documentation** - As-built records, test reports, warranty documentation

**Quality Metrics**:

- Zero cable failures on 7+ million feet of HV cable installed (track record)
- Factory certification required for all installers
- Onsite project management for critical installations

**Storm Activation Team Protocol**:

1. **Weather Monitoring** - Year-round tracking of potential storm events
2. **Pre-Storm Preparation** - Inventory staging, team mobilization, utility coordination
3. **During Storm** - Real-time communication with utilities, rapid deployment capability
4. **Post-Storm Recovery** - Damage assessment support, expedited material delivery, restoration coordination

### 6.4 Training & Education (Solutions University)

**Program Types**:

- **Contractor Training**: Installation best practices, code compliance, product selection
- **Distributor Training**: Product knowledge for counter staff, sales techniques
- **Apprenticeship Programs**: Partnerships with trade schools and unions
- **Utility Training**: Specialized programs for utility crews (HV cable handling, safety)

**Delivery Methods**:

- Digital learning (online courses)
- Hands-on training (Thorn Center - Solutions University campus in Carrollton, GA)
- Jobsite demonstrations (field-based training)
- Webinars and virtual sessions

**Topics Covered**:

- Safe cable installation practices
- Product selection and application
- Code compliance (NEC, NFPA 70E)
- Tool usage and maintenance
- Advanced techniques (HV splicing, terminating)

---

## Section 7: Regulatory & Standards Context

### 7.1 Primary Standards Organizations

**NEC (National Electrical Code)**:

- NFPA 70 - governs all building wire and cable installations in the U.S.
- Updated every 3 years (2020, 2023, 2026 editions)
- Southwire products marked with NEC article compliance (e.g., "NEC Article 310")

**UL (Underwriters Laboratories)**:

- Primary safety certification for electrical products
- Key standards: UL 83 (building wire), UL 1277 (control cable), UL 1581 (testing)
- All Southwire wire/cable products carry UL listing

**CSA (Canadian Standards Association)**:

- Required for Canadian market
- Parallel standards to UL (CSA C22.2)
- Bilingual labeling (English/French)

**ICEA (Insulated Cable Engineers Association)**:

- Industry standards for cable construction and testing
- Key for utility cables: ICEA S-94-649 (medium voltage), ICEA S-108-720 (high voltage)

**AEIC (Association of Edison Illuminating Companies)**:

- Utility-specific specifications developed by electric utilities
- Often more stringent than ICEA
- Southwire products engineered to meet AEIC specs

**IEEE (Institute of Electrical and Electronics Engineers)**:

- Technical standards for electrical systems
- Key: IEEE 1202 (flame testing), IEEE 48 (grounding)

### 7.2 Industry-Specific Regulations

**Utility Sector**:

- NERC (North American Electric Reliability Corporation) - grid reliability
- RUS (Rural Utilities Service) - rural electric cooperative standards
- Utility-specific specifications (often custom per utility company)

**Mining**:

- MSHA (Mine Safety and Health Administration) - mine safety approvals
- Flame-resistant, low-smoke requirements for underground mining

**Transit (Mass Transportation)**:

- FTA (Federal Transit Administration) - fire safety for rail systems
- Low-smoke, zero-halogen (LSZH) requirements for tunnels and underground stations

**Data Centers**:

- TIA-942 - data center infrastructure standards
- Uptime Institute - tier classifications and requirements

**Marine & Offshore**:

- U.S. Coast Guard approvals for marine applications
- API (American Petroleum Institute) - oil & gas specifications

### 7.3 Environmental & Safety Compliance

**RoHS (Restriction of Hazardous Substances)**:

- Limits use of lead, mercury, cadmium, and other hazardous materials
- Southwire products comply for European and global markets

**REACH (Registration, Evaluation, Authorization of Chemicals)**:

- EU regulation on chemical substances
- Southwire maintains REACH compliance for international sales

**OSHA (Occupational Safety and Health Administration)**:

- Workplace safety requirements
- NFPA 70E (arc flash protection) compliance for electrical work

**Recycling & Sustainability**:

- Copper and aluminum recycling programs
- Sustainability reporting and environmental stewardship initiatives

---

## Section 8: Competitive Context & Market Positioning

### 8.1 Market Position

- **Scale**: One of the largest wire and cable manufacturers in North America
- **Market Share**: Significant presence in building wire (residential/commercial), utility cable (transmission/distribution)
- **Ownership Differentiator**: Family-owned in an industry with many corporate-owned competitors

### 8.2 Key Differentiators

1. **Vertical Integration**: Own continuous casting technology (SCR) and rod production → Manufacturing efficiencies and quality control
2. **Technical Support Depth**: Multi-disciplinary engineering team (CableTechSupport) → Complex application support
3. **Service Breadth**: Products + Installation + Training → Full-service provider
4. **Innovation**: Proprietary technologies (SIMpull low-friction cable, SCR continuous casting)
5. **Customer Tools**: Digital platforms (Customer Hub), calculators, mobile apps → Ease of doing business
6. **Emergency Response**: Storm Activation Team → Critical for utility customers

### 8.3 Competitive Landscape (Awareness for Disambiguation)

**Major Competitors** (names for entity disambiguation, not for competitive intelligence):

- General Cable (now Prysmian Group)
- Encore Wire
- Cerrowire (General Cable brand)
- Nexans
- Belden (for specialized cables)

**Why This Matters for Knowledge Graph**:

- If documentation mentions "General Cable," do NOT confuse with Southwire's "Genesis Cable" product
- If query asks "Compare Southwire to General Cable," recognize as competitive comparison, not product comparison within Southwire

---

## Section 9: Digital Platforms & Systems

### 9.1 Customer-Facing Platforms

**Customer Hub**:

- Online ordering and quote generation
- Real-time pricing access
- Order tracking with customer promise dates
- Reel tracking for inventory management
- Curated product lists (save frequently ordered items)
- Most purchased lists
- Reel return processing

**Access Tiers**:

- Distributors: Full pricing and ordering access
- Contractors: Product information, sales rep contact, training registration
- Utilities: Project-based ordering, service coordination

**Mobile Apps**:

- Field calculation tools (voltage drop, ampacity)
- Product lookup and cross-reference
- Sales representative locator
- Training registration

**Solutions University (SSU) Platform**:

- Online training registration
- Course catalog and curriculum
- Digital learning modules
- Certification tracking

### 9.2 Internal Systems (For Context)

**Reel Tracking System**:

- Unique identifier for each cable reel
- Tracks location from manufacturing → distributor → contractor → return
- Reel lease program management
- Asset recovery and inventory optimization

**Manufacturing Systems**:

- Production scheduling
- Customer promise date calculation
- Inventory management
- Quality control and testing

---

## Section 10: Knowledge Graph Implementation Guidance

### 10.1 Entity Scoping Requirements

**Always Include Voltage Class for Cable Entities**:

- Correct: `entity: "15kV XLPE cable", type: "medium_voltage_cable", voltage_class: "15kV"`
- Incorrect: `entity: "cable", type: "cable"` (too vague - could be building wire, MV cable, or HV cable)

**Scope "Distribution" by Context**:

- If context includes "substation," "transformer," "primary," "secondary" → `type: "electrical_distribution"`
- If context includes "warehouse," "freight," "delivery," "distributor" → `type: "product_distribution"`

**Scope "Service" by Context**:

- If context includes "installation," "splicing," "on-site," "field" → `type: "field_service"`
- If context includes "order," "delivery," "customer hub," "tracking" → `type: "customer_service"`
- If context includes "SPEED," "expedited," "custom cable" → `type: "product_service"`

### 10.2 Relationship Constraints

**Building Wire → Medium Voltage Cable**:

- EXCLUDE relationship: `SIMILAR_TO`, `RELATED_TO` (too vague - false positives)
- ALLOW relationship: `DIFFERENT_VOLTAGE_CLASS` (explicit distinction)

**Wire & Cable Division → Tools Division**:

- EXCLUDE relationship: `CONTAINS` (different product categories)
- ALLOW relationship: `USED_WITH` (tools install/prepare cable)

**Copper Rod (Material) → Fishing Rod (Tool)**:

- EXCLUDE all relationships (completely different entities, homonym collision)
- Disambiguation: Always include entity type and department in relationship metadata

### 10.3 Query-Time Disambiguation Rules

**Rule 1: Voltage Disambiguation**

- If query mentions "600V or less," "branch circuit," "NEC," "THHN" → Route to **Building Wire**
- If query mentions "15kV," "25kV," "35kV," "substation," "utility" → Route to **Medium Voltage Cable**
- If query mentions "69kV," "138kV," "transmission" → Route to **High Voltage Cable**

**Rule 2: Context-Based "Distribution" Disambiguation**

- If query includes electrical terms ("substation," "transformer," "voltage") → **Electrical Distribution**
- If query includes logistics terms ("warehouse," "freight," "distributor location") → **Product Distribution**

**Rule 3: Service Disambiguation**

- If query asks "How to install..." or "On-site support for..." → **Field Service**
- If query asks "Where is my order..." or "Order status..." → **Customer Service**
- If query asks "Expedited manufacturing..." or "Custom cable..." → **Product Services (SPEED)**

**Rule 4: Impossible Queries (Error Detection)**

- Query: "Building wire for 15kV application" → ERROR: "Building wire is rated for 600V or less, not suitable for 15kV applications. You need medium voltage power cable."
- Query: "What is the ampacity of a fishing rod?" → ERROR: "Fishing rods are installation tools, not current-carrying conductors. Did you mean wire or cable ampacity?"

---

## Section 11: Common Customer Questions (by Segment)

### 11.1 Electrical Contractors

**Typical Questions**:

- "What wire size for a [X] amp circuit?" → Building Wire (AWG sizing)
- "How to install MC cable?" → Building Wire + Tools + Training (Solutions University)
- "THHN vs THWN - what's the difference?" → Building Wire (insulation type disambiguation)
- "Where can I buy Southwire products locally?" → Product Distribution (distributor locator)
- "NEC code requirements for grounding" → Building Wire + Regulatory Standards

### 11.2 Electric Utilities

**Typical Questions**:

- "What is the expected life of [X]kV cable?" → Medium Voltage or High Voltage Cable (asset management)
- "Storm response availability" → Field Service (Storm Activation Team)
- "Cable rejuvenation for aging underground system" → Field Service (Cable Rejuvenation)
- "AEIC specifications for [X]kV cable" → Medium Voltage Cable + Regulatory Standards
- "Cable failure analysis and testing" → Field Service (Field Assessment Services)

### 11.3 Industrial Customers

**Typical Questions**:

- "MSHA-approved mining cable" → Specialty Cable (Mining Cable) + Regulatory Standards
- "Cable for Class I Div 2 hazardous location" → Industrial Cable + Regulatory Standards (NEC Article 501)
- "Data center power redundancy design" → Power Cable (MV) + Technical Support (CableTechSupport)
- "Instrumentation cable for process control" → Specialty Cable (Instrumentation Cable)
- "Pump cable with submersible rating" → Industrial Cable (Pump & Irrigation Cable)

### 11.4 Distributors

**Typical Questions**:

- "Reel tracking for inventory management" → Digital Platform (Reel Tracking System)
- "Product training for counter staff" → Training (Solutions University)
- "Real-time pricing access" → Digital Platform (Customer Hub)
- "Reel return processing" → Customer Service + Digital Platform
- "Most popular products by market segment" → Product Knowledge + Market Data

---

## Section 12: Key Success Metrics (For Context)

### 12.1 Operational Metrics

**Manufacturing Performance**:

- Customer promise date adherence (on-time delivery)
- SPEED Services lead time (expedited orders)
- Quality control pass rate
- Reel tracking accuracy

**Field Service Performance**:

- Zero cable failures on 7+ million feet of HV cable installed
- Storm response mobilization time
- Installation project completion rate
- Customer satisfaction (Net Promoter Score)

**Customer Engagement**:

- Solutions University training participants
- Customer Hub active users
- Technical support response time (CableTechSupport)

### 12.2 Business Metrics

**Market Position**:

- Market share in building wire, utility cable segments
- Customer retention rate
- New customer acquisition

**Innovation**:

- New product introductions
- Patent filings (SIMpull, SCR technology improvements)
- SCR Technology Pool membership growth (100+ global users)

---

**End of Organization Profile: Southwire Company**

This organization profile should be used in conjunction with the **Manufacturing Domain Definition** (domain-definitions/manufacturing.md) to provide complete context for knowledge graph configuration. The domain definition provides generic product taxonomy; this organization profile provides Southwire-specific context, terminology, and disambiguation rules.
