# Domain Definition: Pharmaceuticals & Life Sciences

> **Version**: 1.0
> **Industry**: Pharmaceuticals, Biotechnology, Crop Science, Animal Health
> **Last Updated**: 2026-02-24
> **Applicable To**: Drug discovery, clinical trials, regulatory submissions, agricultural products

This is a default domain definition that can be customized per tenant/index. It provides foundational vocabulary, product taxonomy, and disambiguation rules for pharmaceutical and life sciences organizations.

---

## Product Hierarchy

### 1. Pharmaceuticals (Department: Human Pharma)

#### 1.1 Prescription Drugs (Sub-department: Rx Products)

- **Description**: Prescription medications requiring physician authorization
- **Key Attributes**:
  - `active_ingredient`: API (Active Pharmaceutical Ingredient)
  - `dosage_form`: Tablet, capsule, injection, syrup, cream, etc.
  - `strength`: Dosage strength (mg, mcg, units)
  - `indication`: Therapeutic use / disease treated
  - `contraindications`: Conditions where drug should not be used
  - `drug_class`: Therapeutic class (antibiotic, antihypertensive, etc.)
  - `nda_number`: New Drug Application number (FDA)
  - `patent_status`: On-patent or generic
- **Identifier Patterns**:
  - `RX-#####` (Rx Product ID)
  - `NDA-######` (FDA New Drug Application number)
  - `US-#######` (Patent number pattern)
- **Disambiguation Keywords**: prescription, Rx, NDA, clinical trial, FDA approval, controlled substance, dosing
- **Regulatory Pathway**: IND → Phase I → Phase II → Phase III → NDA → FDA Approval → Post-market surveillance

#### 1.2 Over-the-Counter (OTC) Drugs (Sub-department: Consumer Health)

- **Description**: Non-prescription medications available without physician authorization
- **Key Attributes**:
  - `active_ingredient`: API
  - `dosage_form`: Tablet, liquid, cream, etc.
  - `strength`: Dosage strength
  - `indication`: Therapeutic use (pain relief, allergy, cold/flu, etc.)
  - `warning_labels`: Required safety warnings
  - `monograph`: OTC monograph category
- **Identifier Patterns**: `OTC-#####`
- **Disambiguation Keywords**: over-the-counter, OTC, self-care, consumer health, non-prescription
- **Regulatory Pathway**: OTC Monograph or NDA-to-OTC switch

#### 1.3 Biologics (Sub-department: Biologics & Biosimilars)

- **Description**: Biological products derived from living organisms (proteins, antibodies, vaccines)
- **Key Attributes**:
  - `biologic_type`: Monoclonal antibody, vaccine, blood product, gene therapy, etc.
  - `target`: Molecular target or disease
  - `indication`: Therapeutic use
  - `administration_route`: IV infusion, subcutaneous injection, etc.
  - `storage_requirements`: Cold chain (2-8°C), frozen, etc.
  - `bla_number`: Biologics License Application number (FDA)
- **Identifier Patterns**:
  - `BIO-#####` (Biologics Product ID)
  - `BLA-######` (FDA Biologics License Application number)
- **Disambiguation Keywords**: biologic, monoclonal antibody, mAb, vaccine, biosimilar, infusion, cold chain
- **Regulatory Pathway**: IND → Phase I-III → BLA → FDA Approval

---

### 2. Crop Science (Department: Agriculture Division)

#### 2.1 Herbicides (Sub-department: Crop Protection - Weeds)

- **Description**: Chemical agents for weed control in agriculture
- **Key Attributes**:
  - `active_ingredient`: Chemical compound
  - `mode_of_action`: How it kills weeds (photosynthesis inhibitor, growth regulator, etc.)
  - `crop_selectivity`: Crops it can be used on (corn, soy, wheat, etc.)
  - `weed_spectrum`: Target weed species
  - `application_timing`: Pre-emergence, post-emergence
  - `epa_registration`: EPA registration number
  - `toxicity_rating`: WHO toxicity class (I, II, III, IV)
- **Identifier Patterns**:
  - `HRB-#####` (Herbicide Product ID)
  - `EPA Reg. No. #####-###` (EPA registration pattern)
- **Disambiguation Keywords**: herbicide, weed control, pre-emergence, post-emergence, crop selectivity, glyphosate, atrazine
- **Regulatory Pathway**: EPA registration, state approvals, label requirements

#### 2.2 Insecticides (Sub-department: Crop Protection - Pests)

- **Description**: Chemical agents for insect pest control in agriculture
- **Key Attributes**:
  - `active_ingredient`: Chemical compound
  - `mode_of_action`: How it kills insects (nerve agent, growth regulator, etc.)
  - `crop_use`: Approved crops
  - `target_pests`: Insect species targeted
  - `application_method`: Foliar spray, soil treatment, seed treatment
  - `epa_registration`: EPA registration number
  - `toxicity_rating`: WHO toxicity class
  - `bee_toxicity`: Impact on pollinators
- **Identifier Patterns**: `INS-#####`
- **Disambiguation Keywords**: insecticide, pest control, foliar, soil treatment, neonicotinoid, pyrethroid, bee safety
- **Regulatory Pathway**: EPA registration, pollinator risk assessment, label restrictions

#### 2.3 Fungicides (Sub-department: Crop Protection - Diseases)

- **Description**: Chemical agents for fungal disease control in agriculture
- **Key Attributes**:
  - `active_ingredient`: Chemical compound
  - `mode_of_action`: How it controls fungi (respiration inhibitor, etc.)
  - `crop_use`: Approved crops
  - `target_diseases`: Fungal diseases targeted
  - `application_timing`: Preventive or curative
  - `epa_registration`: EPA registration number
  - `resistance_management`: FRAC code for rotation
- **Identifier Patterns**: `FNG-#####`
- **Disambiguation Keywords**: fungicide, disease control, FRAC, resistance management, preventive, curative
- **Regulatory Pathway**: EPA registration, resistance management protocols

#### 2.4 Seeds & Traits (Sub-department: Seeds & Biotechnology)

- **Description**: Crop seeds with genetic traits (GMO or conventional)
- **Key Attributes**:
  - `crop_type`: Corn, soy, cotton, canola, etc.
  - `trait_stack`: Herbicide tolerance, insect resistance, drought tolerance, etc.
  - `germplasm`: Genetic background
  - `maturity_group`: Days to maturity
  - `yield_potential`: Expected yield
  - `regulatory_status`: Deregulated, pending, approved markets
- **Identifier Patterns**: `SEED-#####`
- **Disambiguation Keywords**: seed, trait, GMO, herbicide tolerant, Bt, hybrid, germplasm, yield
- **Regulatory Pathway**: USDA-APHIS deregulation, EPA (Bt traits), FDA (food safety)

---

### 3. Animal Health (Department: Veterinary Medicine)

#### 3.1 Companion Animal Products (Sub-department: Pets)

- **Description**: Veterinary drugs and vaccines for dogs, cats, horses
- **Key Attributes**:
  - `species`: Dog, cat, horse, etc.
  - `indication`: Disease treated or prevented
  - `dosage_form`: Tablet, chewable, injection, topical
  - `active_ingredient`: API
  - `nada_number`: New Animal Drug Application number (FDA-CVM)
- **Identifier Patterns**:
  - `CAH-#####` (Companion Animal Health Product ID)
  - `NADA-###-###` (FDA NADA number)
- **Disambiguation Keywords**: veterinary, pet, dog, cat, flea/tick, heartworm, vaccine, companion animal
- **Regulatory Pathway**: INAD → Field studies → NADA → FDA-CVM Approval

#### 3.2 Livestock Products (Sub-department: Production Animals)

- **Description**: Veterinary drugs for cattle, swine, poultry
- **Key Attributes**:
  - `species`: Cattle, swine, poultry, fish
  - `indication`: Disease treated or growth promotion
  - `dosage_form`: Feed additive, injection, water medication
  - `withdrawal_period`: Time before slaughter for food safety
  - `nada_number`: New Animal Drug Application number
- **Identifier Patterns**: `LAH-#####`
- **Disambiguation Keywords**: livestock, cattle, swine, poultry, feed additive, growth promoter, withdrawal period
- **Regulatory Pathway**: INAD → Target animal safety → Food safety → NADA → FDA-CVM Approval

---

## Attribute Specificity Rules

### Attribute: `indication` (therapeutic use)

- **Applies to**: prescription_drugs, otc_drugs, biologics, companion_animal_products, livestock_products
- **Does NOT apply to**: herbicides, insecticides, fungicides, seeds
- **Contextual Meanings**:
  - **prescription_drugs**: Human disease treated (hypertension, diabetes, cancer, etc.)
  - **biologics**: Targeted disease (rheumatoid arthritis, cancer, etc.)
  - **companion_animal**: Veterinary disease (heartworm, flea/tick, infections)
  - **livestock**: Animal disease (respiratory, enteric, etc.)

### Attribute: `active_ingredient`

- **Applies to**: ALL product types (pharmaceuticals, crop protection, animal health)
- **Contextual Meanings**:
  - **pharmaceuticals**: API (atorvastatin, metformin, etc.)
  - **herbicides**: Chemical compound (glyphosate, atrazine, etc.)
  - **insecticides**: Chemical compound (imidacloprid, lambda-cyhalothrin, etc.)
  - **fungicides**: Chemical compound (azoxystrobin, propiconazole, etc.)
  - **animal_health**: API (fipronil, ivermectin, etc.)

### Attribute: `mode_of_action`

- **Applies to**: herbicides, insecticides, fungicides (crop protection)
- **Does NOT apply to**: pharmaceuticals, biologics, seeds, animal_health
- **Contextual Meanings**:
  - **herbicides**: WSSA Group (photosynthesis inhibitors, growth regulators, etc.)
  - **insecticides**: IRAC Group (nerve agents, growth regulators, etc.)
  - **fungicides**: FRAC Group (respiration inhibitors, etc.)

### Attribute: `epa_registration`

- **Applies to**: herbicides, insecticides, fungicides (crop protection only)
- **Does NOT apply to**: pharmaceuticals, biologics, seeds, animal_health (FDA/USDA regulated)
- **Contextual Meanings**:
  - **crop_protection**: EPA registration number for pesticide use

### Attribute: `nda_number` / `bla_number` / `nada_number`

- **Applies to**:
  - `nda_number`: prescription_drugs, otc_drugs (human pharma)
  - `bla_number`: biologics (human pharma)
  - `nada_number`: companion_animal_products, livestock_products (animal health)
- **Does NOT apply to**: crop_protection, seeds
- **Contextual Meanings**:
  - Regulatory approval identifier specific to product category

### Attribute: `crop_use` / `crop_selectivity`

- **Applies to**: herbicides, insecticides, fungicides, seeds (agriculture only)
- **Does NOT apply to**: pharmaceuticals, biologics, animal_health
- **Contextual Meanings**:
  - **crop_protection**: Approved crops for pesticide application
  - **seeds**: Crop type of seed product

---

## Department Boundaries

### Human Pharma Department

- **Includes**: prescription_drugs, otc_drugs, biologics
- **Excludes**: crop_protection, seeds, animal_health
- **Reasoning**: Human health products have distinct regulatory pathways (FDA-CDER, FDA-CBER) vs EPA (crop) or FDA-CVM (animal)

### Prescription Drugs Sub-department

- **Excludes**: otc_drugs, biologics
- **Can relate to**: clinical_trials, patents, regulatory_submissions
- **Reasoning**: Prescription drugs require physician authorization; OTC drugs do not

### Biologics Sub-department

- **Excludes**: prescription_drugs (small molecules), otc_drugs
- **Can relate to**: clinical_trials, cold_chain_logistics, specialty_pharmacies
- **Reasoning**: Biologics are large molecules with different manufacturing, storage, and administration vs small-molecule drugs

### Crop Protection Sub-department

- **Includes**: herbicides, insecticides, fungicides
- **Excludes**: pharmaceuticals, animal_health, seeds
- **Reasoning**: Crop protection products target pests/weeds/diseases; regulated by EPA, not FDA

### Herbicides Sub-department

- **Excludes**: insecticides, fungicides
- **Can relate to**: herbicide_tolerant_seeds (trait stacks)
- **Reasoning**: Herbicides target weeds; insecticides target insects; fungicides target fungi — different modes of action

### Seeds & Traits Sub-department

- **Excludes**: crop_protection products
- **Can relate to**: herbicides (trait compatibility, e.g., glyphosate-tolerant seeds)
- **Reasoning**: Seeds are living organisms with genetic traits; crop protection products are chemical agents

### Animal Health Department

- **Includes**: companion_animal_products, livestock_products
- **Excludes**: human_pharma, crop_protection
- **Reasoning**: Veterinary products regulated by FDA-CVM, different safety standards (withdrawal periods, target animal safety)

---

## Common Entity Types

### Product Entities

- **NDA_NUMBER**: New Drug Application (pattern: `NDA-######`)
- **BLA_NUMBER**: Biologics License Application (pattern: `BLA-######`)
- **NADA_NUMBER**: New Animal Drug Application (pattern: `NADA-###-###`)
- **EPA_REG_NUMBER**: EPA Registration (pattern: `EPA Reg. No. #####-###`)
- **PATENT_NUMBER**: Patent (pattern: `US-#######`, `EP-#######`)
- **TRADE_NAME**: Commercial product name
- **GENERIC_NAME**: Non-proprietary name (INN, USAN)

### Regulatory Entities

- \*\*CLINICAL_TRIAL_ID`: ClinicalTrials.gov identifier (pattern: `NCT########`)
- \*\*IND_NUMBER`: Investigational New Drug application (pattern: `IND-#####`)
- \*\*PROTOCOL_NUMBER`: Clinical trial protocol identifier
- \*\*FDA_APPROVAL_DATE`: Date of regulatory approval
- \*\*REGULATORY_STATUS`: Approved, pending, withdrawn

### Scientific Entities

- **DISEASE**: Medical condition or indication
- \*\*TARGET`: Molecular target (protein, receptor, enzyme, gene)
- **BIOMARKER**: Diagnostic or prognostic marker
- \*\*PATHWAY`: Biological pathway
- \*\*MECHANISM_OF_ACTION`: How drug/product works

### Manufacturing Entities

- \*\*BATCH_NUMBER`: Manufacturing batch/lot identifier
- \*\*EXPIRY_DATE`: Product expiration date
- **MANUFACTURING_SITE**: Production facility location
- \*\*GMP_CERTIFICATION`: Good Manufacturing Practice certification

---

## Common Relationship Types

### Product-to-Regulatory

- `APPROVED_BY_FDA`: Product has FDA approval (with NDA/BLA/NADA number)
- `REGISTERED_WITH_EPA`: Product has EPA registration (with EPA Reg. No.)
- `IN_CLINICAL_TRIAL`: Product is being tested (with NCT number)
- `PROTECTED_BY_PATENT`: Product has patent protection (with patent number and expiry)

### Product-to-Disease/Target

- `TREATS_DISEASE`: Drug treats medical condition
- `PREVENTS_DISEASE`: Vaccine prevents disease
- `TARGETS_PROTEIN`: Biologic targets specific protein/receptor
- `CONTROLS_PEST`: Insecticide controls insect species
- `CONTROLS_WEED`: Herbicide controls weed species
- `CONTROLS_DISEASE`: Fungicide controls fungal disease

### Product-to-Product

- `COMBINATION_WITH`: Two drugs used in combination therapy
- `CONTRAINDICATED_WITH`: Two drugs should not be used together
- `TRAIT_COMPATIBLE_WITH`: Seed trait compatible with herbicide
- `TANK_MIX_COMPATIBLE`: Two pesticides can be mixed for application

### Product-to-Evidence

- `SUPPORTED_BY_TRIAL`: Clinical trial evidence for efficacy
- `SAFETY_DATA_FROM_STUDY`: Safety data source
- `LABEL_INCLUDES_WARNING`: Product label has specific warning

---

## Use Case Examples

### Use Case 1: Prescription Drug Indication

**User Query**: "What is atorvastatin used for?"

**Expected Behavior**:

1. Detect product scope: `prescription_drug`
2. Extract entities: `atorvastatin` (drug name), `indication`
3. Filter to prescription drugs sub-department (exclude OTC, biologics, crop products)
4. Return: "Atorvastatin is a prescription drug used to treat high cholesterol and reduce cardiovascular risk."

**Avoid False Positives**: Do NOT return OTC cholesterol supplements or veterinary products

---

### Use Case 2: Herbicide Crop Use

**User Query**: "Can I use glyphosate on soybeans?"

**Expected Behavior**:

1. Detect product scope: `herbicide`
2. Extract entities: `glyphosate` (active ingredient), `soybeans` (crop)
3. Filter to herbicides sub-department (exclude insecticides, fungicides, pharma)
4. Return: "Glyphosate can be used on glyphosate-tolerant soybeans. Check seed trait compatibility."

**Avoid False Positives**: Do NOT return pharmaceutical information or animal health products

---

### Use Case 3: Biologic Storage Requirements

**User Query**: "How should I store adalimumab?"

**Expected Behavior**:

1. Detect product scope: `biologic`
2. Extract entities: `adalimumab` (biologic name), `storage`
3. Filter to biologics sub-department (exclude small-molecule drugs, crop products)
4. Return: "Adalimumab requires refrigeration (2-8°C). Do not freeze."

**Avoid False Positives**: Do NOT return storage for small-molecule tablets (room temperature) or crop protection products

---

### Use Case 4: Companion Animal Flea Treatment

**User Query**: "What flea treatment is safe for cats?"

**Expected Behavior**:

1. Detect product scope: `companion_animal_product`
2. Extract entities: `flea`, `cats` (species)
3. Filter to companion animal sub-department (exclude livestock, human pharma, crop products)
4. Return: "Fipronil and selamectin are approved for flea treatment in cats."

**Avoid False Positives**: Do NOT return livestock flea control or human antiparasitic drugs

---

## Disambiguation Examples

### Example 1: "indication"

- **Context**: Prescription drug document
- **Correct Interpretation**: Human disease treated (e.g., hypertension, diabetes)
- **Context**: Herbicide document
- **Correct Interpretation**: NOT APPLICABLE (herbicides don't have indications; they have "target weeds")

### Example 2: "active ingredient"

- **Context**: Prescription drug document
- **Correct Interpretation**: API for human use (e.g., atorvastatin)
- **Context**: Herbicide document
- **Correct Interpretation**: Chemical compound for weed control (e.g., glyphosate)
- **Incorrect Cross-context Match**: Do NOT relate pharmaceutical APIs to crop protection chemicals

### Example 3: "mode of action"

- **Context**: Fungicide document
- **Correct Interpretation**: FRAC group (e.g., "respiration inhibitor - Complex III")
- **Context**: Prescription drug document
- **Correct Interpretation**: Mechanism of action (e.g., "HMG-CoA reductase inhibitor")
- **Note**: Both use "mode of action" but mean different things

---

## Configuration Recommendations

### Enable Knowledge Graph For:

- Multi-division life sciences companies (pharma + crop + animal health)
- Regulatory document tracking (linking products to approvals, trials, patents)
- R&D pipeline management (linking compounds to targets to trials)
- Scientific literature mining (linking publications to products to diseases)
- Pharmacovigilance (adverse event tracking across products)
- Agronomic recommendations (linking seeds to herbicides to traits)

### Disable Knowledge Graph For:

- Single-product documentation (e.g., one drug label)
- Marketing materials (no technical/scientific content)
- Simple FAQs

---

## Tenant-Specific Customization Notes

This default definition should be customized per tenant by:

1. **Adding proprietary product lines** (brand names, pipeline compounds)
2. **Defining therapeutic areas** (oncology, cardiology, CNS, etc.)
3. **Adding regional regulatory entities** (EMA, PMDA, Health Canada, etc.)
4. **Defining internal identifiers** (project codes, compound IDs, etc.)
5. **Adding indication-specific terminology** (e.g., oncology: "PFS", "OS", "ORR")

**Customization Path**: `config/knowledge-graph/domain-definitions/{tenantId}/pharma-lifesciences.md` (overrides this default)

---

**End of Default Pharma & Life Sciences Domain Definition**
