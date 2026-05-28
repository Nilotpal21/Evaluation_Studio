# Domain Definition: Manufacturing & Industrial Products

> **Version**: 1.0
> **Industry**: Manufacturing, Industrial Equipment, Supply Chain
> **Last Updated**: 2026-02-24
> **Applicable To**: Electrical equipment, cables, wires, industrial machinery, components

This is a default domain definition that can be customized per tenant/index. It provides foundational vocabulary, product taxonomy, and disambiguation rules for manufacturing organizations.

---

## Product Hierarchy

### 1. Electrical Cables & Wires (Department: Wire & Cable Division)

#### 1.1 Building Wire (Sub-department: Residential Wire)

- **Description**: Electrical wire for residential and commercial building applications
- **Key Attributes**:
  - `conductor_material`: Copper or Aluminum
  - `insulation_type`: THHN, THWN, XHHW, etc.
  - `voltage_rating`: Maximum operating voltage (e.g., 600V, 1000V)
  - `ampacity`: Current-carrying capacity (amps)
  - `awg_size`: American Wire Gauge size (14 AWG, 12 AWG, 10 AWG, etc.)
  - `temperature_rating`: Maximum operating temperature (60°C, 75°C, 90°C)
  - `nec_compliance`: National Electrical Code article references
- **Identifier Patterns**:
  - `BW-#####` (Building Wire SKU)
  - `THHN-##AWG-###FT` (Product code format)
- **Disambiguation Keywords**: building wire, THHN, THWN, residential, branch circuit, NEC, romex, conductor
- **Standards Compliance**: NEC Article 310, UL 83, ASTM B3

#### 1.2 Power Cable (Sub-department: Power Transmission)

- **Description**: High-voltage cables for power transmission and distribution
- **Key Attributes**:
  - `conductor_material`: Copper or Aluminum
  - `insulation_type`: XLPE, EPR, PVC
  - `voltage_rating`: Medium voltage (5kV-35kV) or High voltage (>35kV)
  - `conductor_size`: kcmil or mm²
  - `shielding`: Tape shield, wire shield, or concentric neutral
  - `jacket_type`: PVC, PE, or LSZH (Low Smoke Zero Halogen)
  - `armor`: Steel wire armor (SWA), aluminum wire armor (AWA), or none
- **Identifier Patterns**:
  - `PC-#####` (Power Cable SKU)
  - `MV-###KV-####KCMIL` (Medium voltage format)
- **Disambiguation Keywords**: power cable, MV, HV, XLPE, transmission, distribution, substation, utility
- **Standards Compliance**: IEEE 1202, ICEA S-94-649, IEC 60502

#### 1.3 Control Cable (Sub-department: Industrial Control)

- **Description**: Multi-conductor cables for industrial control and automation systems
- **Key Attributes**:
  - `conductor_count`: Number of conductors (2, 4, 8, 12, 18, etc.)
  - `conductor_size`: AWG size (typically 18 AWG to 12 AWG)
  - `shielding`: Foil shield, braid shield, or unshielded
  - `voltage_rating`: Typically 600V
  - `application`: Motor control, instrumentation, PLC, DCS
  - `temperature_rating`: -20°C to 105°C
  - `oil_resistance`: Oil-resistant jacket for industrial environments
- **Identifier Patterns**:
  - `CC-#####` (Control Cable SKU)
  - `CTRL-##C-##AWG` (Product code format)
- **Disambiguation Keywords**: control cable, PLC, motor control, instrumentation, multi-conductor, shielded
- **Standards Compliance**: NEC Article 725, UL 1277, CSA C22.2

#### 1.4 Fiber Optic Cable (Sub-department: Data Communications)

- **Description**: Optical fiber cables for high-speed data transmission
- **Key Attributes**:
  - `fiber_type`: Single-mode or Multi-mode
  - `fiber_count`: Number of fibers (2, 4, 6, 12, 24, 48, 96, etc.)
  - `core_diameter`: 9/125µm (single-mode) or 50/125µm, 62.5/125µm (multi-mode)
  - `cable_type`: Loose tube, tight-buffered, ribbon
  - `application`: Indoor, outdoor, aerial, direct burial
  - `jacket_type`: OFNR, OFNP, LSZH
  - `bandwidth`: OM1, OM2, OM3, OM4, OM5 (multi-mode) or OS2 (single-mode)
- **Identifier Patterns**:
  - `FO-#####` (Fiber Optic SKU)
  - `SM-##F-OS2` or `MM-##F-OM4` (Product code format)
- **Disambiguation Keywords**: fiber optic, single-mode, multi-mode, data center, telecommunications, backbone
- **Standards Compliance**: TIA-568, ISO/IEC 11801, IEC 60794

---

### 2. Industrial Equipment (Department: Equipment Manufacturing)

#### 2.1 Transformers (Sub-department: Power Conversion)

- **Description**: Electrical transformers for voltage conversion
- **Key Attributes**:
  - `kva_rating`: Power capacity (kVA)
  - `primary_voltage`: Input voltage
  - `secondary_voltage`: Output voltage
  - `phase`: Single-phase or Three-phase
  - `cooling_type`: Dry-type, oil-immersed, or forced-air
  - `enclosure_type`: Indoor, outdoor, pad-mounted, pole-mounted
  - `temperature_rise`: 80°C, 115°C, or 150°C
- **Identifier Patterns**: `TRF-#####`
- **Disambiguation Keywords**: transformer, kVA, primary, secondary, step-down, step-up, voltage conversion
- **Standards Compliance**: IEEE C57, NEMA ST-1, IEC 60076

#### 2.2 Switchgear (Sub-department: Electrical Distribution)

- **Description**: Electrical switchgear for power distribution and protection
- **Key Attributes**:
  - `voltage_rating`: Operating voltage (480V, 600V, 4.16kV, 15kV, etc.)
  - `amperage_rating`: Current rating (amps)
  - `interrupting_capacity`: Short-circuit current rating (kA)
  - `type`: Low-voltage, medium-voltage, or high-voltage
  - `configuration`: Main-tie-main, single-ended, ring bus
  - `protection`: Circuit breakers, fuses, relays
- \*\*Identifier Patterns`: `SWG-#####`
- **Disambiguation Keywords**: switchgear, circuit breaker, distribution, protection, bus, panelboard
- **Standards Compliance**: IEEE C37, NEMA PB-1, IEC 62271

---

### 3. Cable Accessories (Department: Accessories & Terminations)

#### 3.1 Cable Lugs (Sub-department: Terminations)

- **Description**: Compression or mechanical lugs for cable termination
- **Key Attributes**:
  - `conductor_size`: Compatible AWG or kcmil range
  - `lug_type`: Compression, mechanical, or solder
  - `material`: Copper or Aluminum
  - `barrel_type`: Standard or long barrel
  - `stud_size`: Bolt hole diameter (1/4", 3/8", 1/2", etc.)
- **Identifier Patterns**: `LUG-#####`
- **Disambiguation Keywords**: lug, termination, compression, mechanical, crimp, barrel
- **Standards Compliance**: UL 486A-486B

#### 3.2 Cable Connectors (Sub-department: Splicing & Connectors)

- **Description**: Splice connectors, wire nuts, and terminal blocks
- **Key Attributes**:
  - `connector_type`: Wire nut, crimp connector, terminal block
  - `conductor_size`: Compatible AWG range
  - `material`: Copper, aluminum, or brass
  - `insulation`: Insulated or non-insulated
- **Identifier Patterns**: `CONN-#####`
- **Disambiguation Keywords**: connector, wire nut, splice, terminal block, crimp
- **Standards Compliance**: UL 486C

---

### 4. Conduit & Raceways (Department: Cable Management)

#### 4.1 Rigid Metal Conduit (RMC) (Sub-department: Metal Conduit)

- **Description**: Heavy-duty steel conduit for electrical wiring protection
- **Key Attributes**:
  - `conduit_size`: Trade size (1/2", 3/4", 1", 1.25", 2", etc.)
  - `material`: Galvanized steel or stainless steel
  - `length`: Standard 10-foot lengths
  - `threading`: Threaded or unthreaded
  - `coating`: Hot-dip galvanized, PVC-coated, or bare
- **Identifier Patterns**: `RMC-#####`
- **Disambiguation Keywords**: rigid conduit, RMC, galvanized, steel, threaded, heavy-duty
- **Standards Compliance**: NEC Article 344, ANSI C80.1

#### 4.2 EMT (Electrical Metallic Tubing) (Sub-department: Metal Conduit)

- **Description**: Lightweight steel tubing for electrical wiring protection
- **Key Attributes**:
  - `conduit_size`: Trade size (1/2", 3/4", 1", etc.)
  - `material`: Galvanized steel
  - `wall_thickness`: Thinner than RMC
  - `length`: Standard 10-foot lengths
  - `connection`: Compression or set-screw fittings
- **Identifier Patterns**: `EMT-#####`
- **Disambiguation Keywords**: EMT, thin-wall, electrical metallic tubing, lightweight, compression fitting
- **Standards Compliance**: NEC Article 358, ANSI C80.3

---

## Attribute Specificity Rules

### Attribute: `voltage_rating`

- **Applies to**: building_wire, power_cable, control_cable, transformers, switchgear
- **Does NOT apply to**: fiber_optic_cable, conduit, lugs (though lugs must be compatible with voltage-rated cables)
- **Contextual Meanings**:
  - **building_wire**: Typically 600V or 1000V (branch circuit applications)
  - **power_cable**: 5kV to 35kV (medium voltage) or >35kV (high voltage)
  - **control_cable**: Typically 600V (industrial control)
  - **transformers**: Primary/secondary voltage specifications
  - **switchgear**: Operating voltage of distribution system

### Attribute: `ampacity` / `current_rating`

- **Applies to**: building_wire, power_cable, switchgear, circuit_breakers
- **Does NOT apply to**: fiber_optic_cable, conduit, accessories
- **Contextual Meanings**:
  - **building_wire**: Current-carrying capacity based on AWG size and insulation type
  - **power_cable**: Current capacity based on conductor size and installation method
  - **switchgear**: Maximum continuous current rating

### Attribute: `awg_size`

- **Applies to**: building_wire, control_cable
- **Does NOT apply to**: power_cable (uses kcmil), fiber_optic_cable, equipment
- **Contextual Meanings**:
  - **building_wire**: 14 AWG, 12 AWG, 10 AWG for branch circuits
  - **control_cable**: 18 AWG, 16 AWG, 14 AWG for control wiring

### Attribute: `conductor_size`

- **Applies to**: power_cable (kcmil or mm²), building_wire (AWG), control_cable (AWG)
- **Does NOT apply to**: fiber_optic_cable (uses fiber_count and core_diameter)
- **Contextual Meanings**:
  - **power_cable**: 250 kcmil, 500 kcmil, 1000 kcmil for transmission
  - **building_wire**: 14 AWG, 12 AWG, 10 AWG for residential/commercial

### Attribute: `shielding`

- **Applies to**: power_cable, control_cable, fiber_optic_cable (armor/jacket protection)
- **Does NOT apply to**: building_wire, conduit, equipment
- **Contextual Meanings**:
  - **power_cable**: EMI/RFI protection and grounding
  - **control_cable**: Noise immunity for signal integrity
  - **fiber_optic_cable**: Physical protection (armor, not electrical shielding)

---

## Department Boundaries

### Wire & Cable Division

- **Includes**: building_wire, power_cable, control_cable, fiber_optic_cable
- **Excludes**: transformers, switchgear, conduit (different product categories)
- **Reasoning**: Cables are conductors; equipment and raceways serve different functions

### Building Wire Sub-department

- **Excludes**: power_cable, control_cable, fiber_optic_cable
- **Can relate to**: conduit (building wire is installed in conduit), lugs (for termination)
- **Reasoning**: Building wire is low-voltage branch circuit wiring, distinct from power transmission or control applications

### Power Cable Sub-department

- **Excludes**: building_wire, control_cable, fiber_optic_cable
- **Can relate to**: transformers (power cables connect transformers), switchgear (power distribution)
- **Reasoning**: Power cable is medium/high-voltage transmission, requires different installation practices and safety standards

### Control Cable Sub-department

- **Excludes**: building_wire, power_cable, fiber_optic_cable
- **Can relate to**: PLCs, motor_control_centers, instrumentation
- **Reasoning**: Control cable is for low-voltage signaling and automation, not power or data

### Fiber Optic Cable Sub-department

- **Excludes**: building_wire, power_cable, control_cable
- **Can relate to**: data_centers, telecommunications_equipment, network_switches
- **Reasoning**: Fiber optic is optical (light-based), not electrical

### Equipment Manufacturing Division

- **Includes**: transformers, switchgear, motor_control_centers, panelboards
- **Excludes**: cables, conduit, accessories
- **Can relate to**: power_cable (equipment connections), building_wire (internal wiring)
- **Reasoning**: Equipment manufactures/distributes power; cables transmit it

---

## Common Entity Types

### Product Entities

- **SKU**: Product stock-keeping unit (pattern: `BW-#####`, `PC-#####`, `TRF-#####`)
- **PART_NUMBER**: Manufacturer part number
- **CATALOG_NUMBER**: Distributor catalog number
- **MODEL_NUMBER**: Equipment model identifier

### Technical Specification Entities

- **VOLTAGE**: Voltage ratings (pattern: `###V`, `##.#kV`, `###kV`)
- **CURRENT**: Amperage ratings (pattern: `###A`, `####A`)
- **POWER**: kVA, kW, HP ratings (pattern: `###kVA`, `###kW`)
- **AWG_SIZE**: Wire gauge (pattern: `##AWG`)
- **KCMIL_SIZE**: Large conductor size (pattern: `###kcmil`, `####kcmil`)

### Standards & Compliance Entities

- **NEC_ARTICLE**: National Electrical Code references (pattern: `NEC Article ###`)
- **UL_STANDARD**: UL certification standards (pattern: `UL ##`, `UL ####`)
- **IEEE_STANDARD**: IEEE standards (pattern: `IEEE C##`, `IEEE ####`)
- **ASTM_STANDARD**: Material standards (pattern: `ASTM B#`, `ASTM D####`)

### Manufacturing Entities

- **LOT_NUMBER**: Production lot identifier
- **SERIAL_NUMBER**: Equipment serial number
- **MANUFACTURING_DATE**: Production date
- \*\*PLANT_CODE`: Manufacturing facility identifier

---

## Common Relationship Types

### Product-to-Standard

- `COMPLIES_WITH_STANDARD`: Product meets specific standard (e.g., "THHN wire COMPLIES_WITH NEC Article 310")
- `CERTIFIED_BY`: Product certified by agency (e.g., "Power cable CERTIFIED_BY UL")

### Product-to-Product

- `COMPATIBLE_WITH`: Products that work together (e.g., "12 AWG wire COMPATIBLE_WITH 20A circuit breaker")
- `REQUIRES_ACCESSORY`: Product needs accessory (e.g., "Power cable REQUIRES compression lug")
- `INSTALLED_IN`: Cable installed in conduit/raceway
- `CONNECTS_TO`: Cable connects equipment

### Product-to-Application

- `SUITABLE_FOR_APPLICATION`: Product appropriate for use case (e.g., "THHN wire SUITABLE_FOR residential branch circuits")
- `NOT_SUITABLE_FOR_APPLICATION`: Product not appropriate (e.g., "Building wire NOT_SUITABLE_FOR medium-voltage applications")

### Technical Specification Relationships

- `AMPACITY_RATING`: Wire has current-carrying capacity
- `VOLTAGE_RATING`: Product has voltage specification
- `TEMPERATURE_RATING`: Product has operating temperature range

---

## Use Case Examples

### Use Case 1: Wire Size Selection for Branch Circuit

**User Query**: "What wire size do I need for a 20A circuit?"

**Expected Behavior**:

1. Detect product scope: `building_wire`
2. Extract entities: `20A`, `circuit`, `wire_size`
3. Filter to building wire sub-department (exclude power_cable, control_cable)
4. Return: 12 AWG THHN/THWN copper wire for 20A circuit

**Avoid False Positives**: Do NOT return power cable (kcmil sizes) or control cable recommendations

---

### Use Case 2: Power Cable Specification for Substation

**User Query**: "What cable do I need for a 15kV feeder?"

**Expected Behavior**:

1. Detect product scope: `power_cable`
2. Extract entities: `15kV`, `feeder`, `cable`
3. Filter to power cable sub-department (exclude building_wire, control_cable)
4. Return: Medium-voltage XLPE power cable specifications

**Avoid False Positives**: Do NOT return building wire (600V rated) or control cable

---

### Use Case 3: Control Cable for PLC Wiring

**User Query**: "What cable should I use for PLC connections?"

**Expected Behavior**:

1. Detect product scope: `control_cable`
2. Extract entities: `PLC`, `control`, `cable`
3. Filter to control cable sub-department (exclude building_wire, power_cable)
4. Return: Multi-conductor shielded control cable (e.g., 18 AWG, 8-conductor)

**Avoid False Positives**: Do NOT return building wire or power cable

---

### Use Case 4: Fiber Optic Cable for Data Center

**User Query**: "What fiber cable do I need for a 10G network backbone?"

**Expected Behavior**:

1. Detect product scope: `fiber_optic_cable`
2. Extract entities: `10G`, `network`, `backbone`, `fiber`
3. Filter to fiber optic sub-department (exclude all electrical cables)
4. Return: OM3 or OM4 multi-mode fiber (50/125µm) or OS2 single-mode

**Avoid False Positives**: Do NOT return building wire, power cable, or control cable

---

## Disambiguation Examples

### Example 1: "voltage rating"

- **Context**: Building wire document
- **Correct Interpretation**: 600V or 1000V branch circuit rating
- **Context**: Power cable document
- **Correct Interpretation**: 15kV, 25kV, or 35kV medium-voltage rating
- **Incorrect Cross-context Match**: Do NOT relate building wire 600V to power cable 15kV

### Example 2: "conductor size"

- **Context**: Building wire document
- **Correct Interpretation**: AWG size (14 AWG, 12 AWG, 10 AWG)
- **Context**: Power cable document
- **Correct Interpretation**: kcmil size (250 kcmil, 500 kcmil)
- **Incorrect Cross-context Match**: Do NOT confuse AWG with kcmil

### Example 3: "application"

- **Context**: Control cable document
- **Correct Interpretation**: PLC wiring, motor control, instrumentation
- **Context**: Building wire document
- **Correct Interpretation**: Branch circuits, lighting, receptacles
- **Incorrect Cross-context Match**: Do NOT recommend building wire for PLC applications

---

## Configuration Recommendations

### Enable Knowledge Graph For:

- Large product catalogs (1000s of SKUs with complex relationships)
- Technical specification searches (voltage, ampacity, AWG size disambiguation)
- Standards compliance tracking (NEC, UL, IEEE cross-references)
- Application-specific product recommendations
- Installation guideline documents (linking products to procedures)

### Disable Knowledge Graph For:

- Simple product catalogs (< 100 SKUs, no overlapping terminology)
- Marketing content (no technical specifications)
- Single-product-line systems

---

## Tenant-Specific Customization Notes

This default definition should be customized per tenant by:

1. **Adding proprietary product lines** (e.g., "SIMpull" cable, "SLiM" lugs)
2. **Defining internal SKU patterns** matching tenant's catalog
3. **Adding regional standards** (IEC vs NEC, BS standards, etc.)
4. **Defining custom applications** (marine, mining, oil & gas, renewable energy)
5. **Adding supply chain entities** (suppliers, distributors, plants)

**Customization Path**: `config/knowledge-graph/domain-definitions/{tenantId}/manufacturing.md` (overrides this default)

---

**End of Default Manufacturing Domain Definition**
