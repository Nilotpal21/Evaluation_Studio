# Domain Definition: Consumer Packaged Goods (CPG)

> **Version**: 1.0
> **Industry**: Consumer Goods, Food & Beverage, Pet Care, Personal Care
> **Last Updated**: 2026-02-24
> **Applicable To**: Fast-moving consumer goods, retail products, multi-brand portfolios

This is a default domain definition that can be customized per tenant/index. It provides foundational vocabulary, product taxonomy, and disambiguation rules for CPG organizations.

---

## Product Hierarchy

### 1. Food Products (Department: Food Division)

#### 1.1 Chocolate & Confectionery (Sub-department: Chocolate)

- **Description**: Chocolate bars, candies, seasonal chocolates
- **Key Attributes**:
  - `brand_name`: Commercial brand (e.g., M&M's, Snickers, Milky Way)
  - `product_variant`: Flavor, size, format (e.g., "Peanut", "King Size", "Fun Size")
  - `cocoa_content`: Percentage of cocoa (for premium chocolate)
  - `ingredients`: Ingredient list
  - `allergens`: Common allergens (milk, tree nuts, soy, etc.)
  - `nutritional_info`: Calories, fat, sugar, protein per serving
  - `package_size`: Net weight or count (e.g., "1.69 oz", "24-count bag")
  - `upc`: Universal Product Code
- **Identifier Patterns**:
  - `CHC-#####` (Chocolate Product ID)
  - UPC barcode (pattern: `############`)
- **Disambiguation Keywords**: chocolate, candy, confectionery, cocoa, dessert, sweet, treat
- **Regulatory Compliance**: FDA food labeling, allergen declarations, nutritional facts

#### 1.2 Pet Food (Sub-department: Pet Nutrition)

- **Description**: Dry food, wet food, treats for dogs and cats
- **Key Attributes**:
  - `brand_name`: Commercial brand (e.g., Pedigree, Whiskas, Iams)
  - `species`: Dog or cat
  - `life_stage`: Puppy, adult, senior / Kitten, adult, senior
  - `formulation`: Chicken, beef, fish, lamb, grain-free, etc.
  - `format`: Dry kibble, wet canned, pouch, treats
  - `nutritional_profile`: Protein %, fat %, fiber %, guaranteed analysis
  - `package_size`: Bag/can weight (e.g., "15 lb bag", "5.5 oz can")
  - `feeding_guidelines`: Recommended daily amount by pet weight
  - `upc`: Universal Product Code
- **Identifier Patterns**: `PET-#####`
- **Disambiguation Keywords**: pet food, dog food, cat food, kibble, wet food, treats, nutrition, feeding
- **Regulatory Compliance**: AAFCO nutritional adequacy, FDA pet food regulations

#### 1.3 Food Ingredients & Staples (Sub-department: Food Ingredients)

- **Description**: Rice, pasta, sauces, cooking ingredients
- **Key Attributes**:
  - `brand_name`: Commercial brand
  - `product_type`: Rice (basmati, jasmine, long-grain), pasta (penne, spaghetti), sauce (tomato, alfredo)
  - `ingredients`: Ingredient list
  - `cooking_instructions`: Preparation directions
  - `shelf_life`: Expiration or best-by date guidance
  - `package_size`: Net weight (e.g., "2 lb", "500g")
  - `upc`: Universal Product Code
- **Identifier Patterns**: `FOOD-#####`
- **Disambiguation Keywords**: rice, pasta, sauce, ingredients, cooking, meal, recipe
- **Regulatory Compliance**: FDA food labeling, country-of-origin labeling

---

### 2. Personal Care (Department: Personal Care Division)

#### 2.1 Skincare (Sub-department: Skincare & Beauty)

- **Description**: Lotions, creams, cleansers, anti-aging products
- **Key Attributes**:
  - `brand_name`: Commercial brand
  - `product_type`: Moisturizer, cleanser, serum, sunscreen, anti-aging
  - `skin_type`: Oily, dry, combination, sensitive, normal
  - `active_ingredients`: Key ingredients (hyaluronic acid, retinol, vitamin C, SPF)
  - `benefits`: Hydration, anti-aging, acne control, brightening, etc.
  - `fragrance`: Scented or fragrance-free
  - `package_size`: Volume (e.g., "1.7 fl oz", "50 ml")
  - `upc`: Universal Product Code
- **Identifier Patterns**: `SKIN-#####`
- **Disambiguation Keywords**: skincare, moisturizer, lotion, cream, anti-aging, sunscreen, SPF, beauty
- **Regulatory Compliance**: FDA cosmetic regulations, sunscreen drug monograph (if SPF)

#### 2.2 Hair Care (Sub-department: Hair Care)

- **Description**: Shampoos, conditioners, styling products, hair color
- **Key Attributes**:
  - `brand_name`: Commercial brand
  - `product_type`: Shampoo, conditioner, styling gel, hair color, treatment
  - `hair_type`: Oily, dry, color-treated, curly, fine, thick
  - `benefits`: Volumizing, moisturizing, color protection, dandruff control, etc.
  - `fragrance`: Scent description
  - `package_size`: Volume (e.g., "12 fl oz", "355 ml")
  - `upc`: Universal Product Code
- **Identifier Patterns**: `HAIR-#####`
- **Disambiguation Keywords**: shampoo, conditioner, hair care, styling, hair color, dandruff, volumizing
- **Regulatory Compliance**: FDA cosmetic regulations, hair dye safety

---

### 3. Household Products (Department: Home Care Division)

#### 3.1 Cleaning Products (Sub-department: Household Cleaning)

- **Description**: Surface cleaners, laundry detergents, disinfectants
- **Key Attributes**:
  - `brand_name`: Commercial brand
  - `product_type`: All-purpose cleaner, glass cleaner, laundry detergent, disinfectant
  - `surface_compatibility`: Countertops, glass, wood, fabric, etc.
  - `active_ingredients`: Cleaning agents, disinfecting agents
  - `fragrance`: Scent (lemon, lavender, unscented)
  - `epa_registration`: EPA registration (if disinfectant claim)
  - `package_size`: Volume or weight (e.g., "32 fl oz", "100 oz")
  - `upc`: Universal Product Code
- **Identifier Patterns**: `CLEAN-#####`
- **Disambiguation Keywords**: cleaner, detergent, disinfectant, laundry, household, cleaning, surface
- **Regulatory Compliance**: EPA registration (disinfectants), OSHA hazard communication (if applicable)

---

## Attribute Specificity Rules

### Attribute: `species`

- **Applies to**: pet_food (dog or cat)
- **Does NOT apply to**: human_food, personal_care, household_products
- **Contextual Meanings**:
  - **pet_food**: Dog or cat (target animal)

### Attribute: `life_stage`

- **Applies to**: pet_food (puppy/adult/senior for dogs; kitten/adult/senior for cats)
- **Does NOT apply to**: human_food, personal_care, household_products
- **Contextual Meanings**:
  - **pet_food**: Nutritional requirements vary by age

### Attribute: `allergens`

- **Applies to**: food_products (human and pet food)
- **Does NOT apply to**: personal_care (though "hypoallergenic" is a marketing term), household_products
- **Contextual Meanings**:
  - **human_food**: FDA "Big 8" allergens (milk, eggs, fish, shellfish, tree nuts, peanuts, wheat, soy)
  - **pet_food**: Common allergens (beef, dairy, chicken, wheat, soy, corn)

### Attribute: `spf` / `sun_protection`

- **Applies to**: skincare_products (sunscreens, moisturizers with SPF)
- **Does NOT apply to**: food_products, hair_care, household_products
- **Contextual Meanings**:
  - **skincare**: Sun Protection Factor (SPF 15, 30, 50, etc.) — regulated as OTC drug by FDA

### Attribute: `epa_registration`

- **Applies to**: cleaning_products (disinfectants with antimicrobial claims)
- **Does NOT apply to**: food_products, personal_care (except hand sanitizers)
- **Contextual Meanings**:
  - **disinfectants**: EPA registration number for pathogen kill claims

### Attribute: `nutritional_info`

- **Applies to**: human_food, pet_food
- **Does NOT apply to**: personal_care, household_products
- **Contextual Meanings**:
  - **human_food**: FDA Nutrition Facts panel (calories, fat, sodium, etc.)
  - **pet_food**: AAFCO guaranteed analysis (protein %, fat %, fiber %, moisture %)

### Attribute: `skin_type` / `hair_type`

- **Applies to**: skincare_products, hair_care_products
- **Does NOT apply to**: food_products, household_products
- **Contextual Meanings**:
  - **skincare**: Oily, dry, combination, sensitive, normal
  - **hair_care**: Oily, dry, color-treated, curly, fine, thick

---

## Department Boundaries

### Food Division

- **Includes**: chocolate_confectionery, pet_food, food_ingredients
- **Excludes**: personal_care, household_products
- **Reasoning**: Food products are ingested (human or animal); personal care and household products are not

### Chocolate & Confectionery Sub-department

- **Excludes**: pet_food, food_ingredients
- **Can relate to**: seasonal_products (Halloween, Christmas, Easter), gift_sets
- **Reasoning**: Chocolate is a distinct category with unique ingredients (cocoa) and consumption patterns

### Pet Food Sub-department

- **Excludes**: human_food, personal_care, household_products
- **Can relate to**: pet_treats, pet_supplies
- **Reasoning**: Pet food has distinct nutritional requirements (AAFCO standards) and regulatory pathways vs human food

### Personal Care Division

- **Includes**: skincare, hair_care, oral_care (if applicable)
- **Excludes**: food_products, household_products
- **Reasoning**: Personal care products applied to body; different regulatory framework (FDA cosmetics) vs food or household cleaners

### Skincare Sub-department

- **Excludes**: hair_care, food_products, household_products
- **Can relate to**: sunscreens (if SPF claim, regulated as OTC drug)
- **Reasoning**: Skincare targets skin health/appearance; hair care targets hair/scalp

### Home Care Division

- **Includes**: cleaning_products, paper_products, air_fresheners
- **Excludes**: food_products, personal_care
- **Reasoning**: Household products used on surfaces/environments; different regulatory framework (EPA for disinfectants, CPSC for consumer product safety)

---

## Common Entity Types

### Product Entities

- **UPC**: Universal Product Code (barcode pattern: `############`)
- **SKU**: Stock-keeping unit (internal identifier)
- **GTIN**: Global Trade Item Number (barcode pattern: `##############`)
- **BRAND_NAME**: Commercial brand
- **PRODUCT_NAME**: Specific product variant

### Regulatory Entities

- **FDA_NDC**: National Drug Code (for OTC drugs like sunscreens)
- **EPA_REG_NUMBER**: EPA registration (pattern: `#####-###`)
- **AAFCO_STATEMENT**: Pet food nutritional adequacy statement
- **USDA_ORGANIC**: Organic certification (if applicable)
- **NON_GMO_PROJECT**: Non-GMO verification (if applicable)

### Supply Chain Entities

- **MANUFACTURING_PLANT**: Production facility location
- **LOT_CODE**: Production lot/batch identifier
- **BEST_BY_DATE**: Expiration or best-by date
- \*\*COUNTRY_OF_ORIGIN`: Manufacturing country

### Marketing Entities

- \*\*CAMPAIGN_NAME`: Marketing campaign identifier
- \*\*PROMOTIONAL_OFFER`: Discount, coupon, bundle deal
- \*\*SEASONAL_PRODUCT`: Halloween, Christmas, Valentine's, Easter, etc.

---

## Common Relationship Types

### Product-to-Brand

- `BRAND_PORTFOLIO`: Brand belongs to parent brand or company
- `SUB_BRAND`: Product is a variant of parent brand
- `BRAND_EXTENSION`: New product leverages existing brand equity

### Product-to-Category

- `CATEGORY_MEMBER`: Product belongs to category (e.g., "chocolate" category)
- `ADJACENT_CATEGORY`: Related but distinct category (e.g., "candy" vs "gum")

### Product-to-Retailer

- `SOLD_AT_RETAILER`: Product available at specific retailer
- `EXCLUSIVE_TO_RETAILER`: Product only available at specific retailer
- `PRIVATE_LABEL`: Retailer-branded product

### Product-to-Consumer

- `TARGET_DEMOGRAPHIC`: Age, gender, lifestyle segment
- `USAGE_OCCASION`: When/how product is consumed (breakfast, snack, gift, etc.)
- `CONSUMPTION_FREQUENCY`: Daily, weekly, occasional

### Product-to-Ingredient

- `CONTAINS_INGREDIENT`: Product contains specific ingredient
- `FREE_FROM_INGREDIENT`: Product excludes specific ingredient (allergen-free, gluten-free, etc.)
- `FEATURES_INGREDIENT`: Key ingredient highlighted in marketing

---

## Use Case Examples

### Use Case 1: Pet Food by Species

**User Query**: "What dog food options do you have?"

**Expected Behavior**:

1. Detect product scope: `pet_food`
2. Extract entities: `dog` (species)
3. Filter to pet food sub-department with species=dog (exclude cat food, human food)
4. Return: Dog food brands, formulations, life stages

**Avoid False Positives**: Do NOT return cat food or human food products

---

### Use Case 2: Allergen Information for Human Food

**User Query**: "Does this chocolate contain peanuts?"

**Expected Behavior**:

1. Detect product scope: `chocolate_confectionery`
2. Extract entities: `chocolate`, `peanuts` (allergen)
3. Filter to chocolate sub-department (exclude pet food, personal care)
4. Return: Allergen declaration (e.g., "Contains peanuts" or "May contain traces of peanuts")

**Avoid False Positives**: Do NOT return pet food allergen information

---

### Use Case 3: Skincare for Specific Skin Type

**User Query**: "What moisturizer is best for dry skin?"

**Expected Behavior**:

1. Detect product scope: `skincare_products`
2. Extract entities: `moisturizer`, `dry_skin` (skin type)
3. Filter to skincare sub-department (exclude hair care, food, household)
4. Return: Moisturizers formulated for dry skin

**Avoid False Positives**: Do NOT return hair care conditioners or food/pet food products

---

### Use Case 4: Disinfectant EPA Registration

**User Query**: "Is this cleaner EPA-registered to kill viruses?"

**Expected Behavior**:

1. Detect product scope: `cleaning_products`
2. Extract entities: `cleaner`, `EPA-registered`, `viruses`
3. Filter to household cleaning sub-department (exclude personal care, food)
4. Return: EPA registration number and pathogen kill claims (e.g., "EPA Reg. No. 12345-67, kills 99.9% of viruses")

**Avoid False Positives**: Do NOT return personal care hand sanitizers (different regulatory pathway) or food safety information

---

## Disambiguation Examples

### Example 1: "treats"

- **Context**: Pet food document
- **Correct Interpretation**: Dog/cat treats (edible rewards for pets)
- **Context**: Chocolate document
- **Correct Interpretation**: Sweet snacks for humans
- **Incorrect Cross-context Match**: Do NOT relate pet treats to human chocolate treats

### Example 2: "moisturizer"

- **Context**: Skincare document
- **Correct Interpretation**: Facial/body lotion for human skin
- **Context**: Hair care document
- **Correct Interpretation**: Conditioner for hair hydration
- **Incorrect Cross-context Match**: Do NOT relate facial moisturizer to hair conditioner

### Example 3: "nutritional info"

- **Context**: Human food document
- **Correct Interpretation**: FDA Nutrition Facts (calories, fat, sodium, etc.)
- **Context**: Pet food document
- **Correct Interpretation**: AAFCO guaranteed analysis (protein %, fat %, fiber %, moisture %)
- **Note**: Both use "nutritional info" but with different regulatory frameworks and formats

---

## Configuration Recommendations

### Enable Knowledge Graph For:

- Multi-brand portfolios (100+ brands across food/pet/personal care/household)
- Product recommendation systems (linking similar products, cross-sell)
- Allergen/ingredient tracking (linking ingredients to products to allergen declarations)
- Supply chain traceability (linking products to plants to lot codes)
- Regulatory compliance tracking (linking products to certifications to claims)

### Disable Knowledge Graph For:

- Single-brand product catalogs (< 50 SKUs)
- Marketing-only content (no product specifications)
- Simple FAQ chatbots

---

## Tenant-Specific Customization Notes

This default definition should be customized per tenant by:

1. **Adding proprietary brands** (internal brand portfolios)
2. **Defining brand hierarchies** (parent brands, sub-brands, brand extensions)
3. **Adding regional products** (products only available in specific markets)
4. **Defining ingredient taxonomies** (proprietary ingredient lists, supplier relationships)
5. **Adding certifications** (Fair Trade, Rainforest Alliance, B Corp, etc.)

**Customization Path**: `config/knowledge-graph/domain-definitions/{tenantId}/cpg-consumer-goods.md` (overrides this default)

---

**End of Default CPG Consumer Goods Domain Definition**
