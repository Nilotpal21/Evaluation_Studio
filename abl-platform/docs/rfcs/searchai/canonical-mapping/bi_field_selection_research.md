# Business Intelligence Field Selection Research

## How BI Tools Handle Context Fields in Aggregated vs Detail Views

---

## EXECUTIVE SUMMARY

**YES** - BI tools systematically show different fields in aggregated views versus detailed views. This is both a **technical requirement** (SQL GROUP BY rules) and a **UX best practice** (information density optimization).

### Core Pattern:

- **Detail View**: All fields
- **Aggregated View**: Grouping dimensions (1-3) + measures only
- **Drill-Down View**: Progressive disclosure - intermediate field count

---

## 1. SQL GROUP BY CONSTRAINT (Database-Level)

### Technical Requirement

SQL databases **enforce** field selection rules in aggregated queries:

```sql
-- VALID: All non-aggregated fields are in GROUP BY
SELECT customer_name, region, SUM(deal_value) AS total_revenue
FROM deals
GROUP BY customer_name, region

-- INVALID: Cannot select fields not in GROUP BY or aggregate function
SELECT customer_name, region, notes, SUM(deal_value)
FROM deals
GROUP BY customer_name, region
-- ERROR: Column 'notes' must appear in GROUP BY or be used in aggregate function
```

### Key Rule

**You can ONLY select:**

1. Fields explicitly listed in GROUP BY clause
2. Aggregated fields (SUM, AVG, COUNT, MAX, MIN, etc.)

**You CANNOT select:**

- Any field not in GROUP BY that isn't aggregated
- This makes it impossible to show detail fields like notes, timestamps, status in aggregated queries

---

## 2. POWER BI PATTERN

### Source

Microsoft Power BI Documentation - Table Visualizations

### Implementation

Power BI separates field types in the UI:

**For Aggregated Visualizations:**

- **Columns section**: Dimensions (grouping fields)
- **Values section**: Measures (automatically aggregated)

**Example from Documentation:**

```
Aggregated Table showing Category performance:
- Category (dimension)
- Average Unit Price (measure)
- Last Year Sales (measure)
- This Year Sales - Value (measure)
- This Year Sales - Goal (measure)
- This Year Sales - Status (measure)

Total: 1 dimension + 5 measures = 6 fields
```

**NOT shown in aggregated view:**

- Product descriptions
- Individual transaction timestamps
- Sales rep names
- Customer notes
- Internal IDs

### Conditional Formatting

Power BI applies visual formatting to aggregated tables:

- Background color gradients based on value ranges
- Data bars replacing numbers
- Icons for status indicators

This works because aggregated views show **numeric measures**, not free-text fields.

---

## 3. OLAP CUBE PATTERN

### Source

OLAP Cube concepts (Tableau, Microsoft Analysis Services, Oracle OLAP)

### Core Concepts

**Dimensions**: Context/categorical fields

- Time (Year → Quarter → Month → Day)
- Geography (Country → Region → City)
- Product (Category → Subcategory → Product)
- Customer (Segment → Account)

**Measures**: Quantitative aggregated values

- Sales Revenue (SUM)
- Average Order Value (AVG)
- Customer Count (COUNT DISTINCT)
- Profit Margin (calculated)

### Operations

**Drill Down**: Add more detailed dimensions

```
Summary Level:    [Year, Total Sales]
↓ Drill Down
Quarter Level:    [Year, Quarter, Total Sales]
↓ Drill Down
Month Level:      [Year, Quarter, Month, Total Sales]
```

**Roll Up**: Remove dimensions for higher summary

```
Product Level:    [Product, Category, Total Sales]
↓ Roll Up
Category Level:   [Category, Total Sales]
```

**Slice**: Fix one dimension, show others

```
Full Cube:        [Year, Region, Product, Sales]
↓ Slice (2024 only)
2024 Slice:       [Region, Product, Sales] WHERE Year = 2024
```

### Key Insight

OLAP tools explicitly model the separation:

- **Dimension tables**: Context attributes (customer info, product info, dates)
- **Fact tables**: Measures (sales amounts, quantities, costs)
- **Aggregated views**: Always select from dimensions + fact measures, never dimension detail fields

---

## 4. TOP N QUERY PATTERN

### Standard Field Selection

**Top 10 Customers by Revenue:**

```
Fields shown:
- customer_name (identifier)
- total_revenue (ranking measure)
- region (context dimension)
- order_count (supporting measure)

Fields NOT shown:
- customer_address
- customer_notes
- account_manager
- contract_start_date
- last_contact_timestamp
```

**Top 10 Products by Units Sold:**

```
Fields shown:
- product_name (identifier)
- units_sold (ranking measure)
- category (context dimension)
- revenue (supporting measure)

Fields NOT shown:
- product_description
- manufacturer_notes
- warehouse_location
- last_restock_date
- supplier_contact
```

### Pattern Analysis

Top N queries consistently show:

1. **Identifier** (1 field): What is being ranked
2. **Primary measure** (1 field): What it's being ranked by
3. **Context dimensions** (1-2 fields): Essential for interpretation
4. **Supporting measures** (0-2 fields): Related metrics

**Total: 3-6 fields** vs 10-20+ fields in detail view

---

## 5. LOOKER/LOOKML PATTERN

### Model Definition Approach

Looker explicitly separates dimensions and measures in LookML:

```lookml
view: deals {
  # DIMENSIONS (for grouping)
  dimension: customer_name { type: string }
  dimension: region { type: string }
  dimension: deal_date { type: date }

  # MEASURES (for aggregation)
  measure: total_revenue {
    type: sum
    sql: ${deal_value} ;;
  }

  measure: avg_deal_size {
    type: average
    sql: ${deal_value} ;;
  }

  measure: deal_count {
    type: count
  }
}
```

### User Experience

When users create an "Explore":

- Select dimensions from dimension list
- Select measures from measure list
- Looker automatically builds correct SQL GROUP BY

**Users cannot accidentally mix detail fields with aggregations** - the UI enforces proper field selection.

---

## 6. INFORMATION DENSITY PRINCIPLE

### UX Research Basis

**Aggregated Views (Scanning Mode):**

- Purpose: Compare values across groups quickly
- User behavior: Scanning, not reading
- Optimal fields: 3-7 (matches working memory capacity)
- Field types: Categorical identifiers + numeric measures
- Exclude: Long text, metadata, process fields

**Detail Views (Investigation Mode):**

- Purpose: Understand complete entity context
- User behavior: Deep reading and analysis
- Optimal fields: All relevant fields (10-30+)
- Field types: Everything - text, dates, status, relationships
- Include: Comprehensive information

### Cognitive Load

From Power BI example:

- Aggregated table: 6 fields (1 dimension + 5 measures)
- User can scan and compare categories quickly
- Visual formatting (colors, icons) enhances scanning

If aggregated view showed all 20 fields from detail record:

- Horizontal scrolling required
- Cognitive overload
- Unable to quickly compare
- Defeats purpose of aggregation

---

## 7. REAL IMPLEMENTATION EXAMPLES

### Example 1: CRM Sales Dashboard

**Aggregated View - "Top 10 Sales Reps":**

```
rep_name | total_revenue | deals_closed | avg_deal_size | region
---------|---------------|--------------|---------------|--------
Alice    | $2.5M        | 45           | $55,556       | West
Bob      | $2.3M        | 52           | $44,231       | East
...
```

**Detail View - "Alice's Profile":**

```
rep_name: Alice Johnson
employee_id: EMP-2847
email: alice.johnson@company.com
region: West
territory: California, Nevada
hire_date: 2020-03-15
total_revenue: $2,500,000
deals_closed: 45
avg_deal_size: $55,556
win_rate: 68%
quota_attainment: 125%
manager: Sarah Wilson
notes: Top performer, specializes in enterprise deals
last_activity: 2024-03-05 14:30:00
certifications: Enterprise Sales, Advanced Negotiation
...
```

### Example 2: E-commerce Analytics

**Aggregated View - "Revenue by Category":**

```
category      | total_revenue | units_sold | avg_price | growth_pct
--------------|---------------|------------|-----------|------------
Electronics   | $1.2M        | 3,450      | $348      | +15.3%
Clothing      | $890K        | 15,200     | $59       | +8.7%
Home & Garden | $654K        | 4,100      | $159      | -2.1%
...
```

**Detail View - "Electronics Category Deep Dive":**
Shows: Individual products, SKUs, suppliers, inventory levels, descriptions, images, reviews, ratings, shipping info, etc.

---

## 8. CURRENT CODEBASE PATTERNS

### From analytics.ts

```typescript
// Aggregated metrics endpoint
const result = await queryService.aggregate({
  tenantId,
  projectId,
  timeRange,
  groupBy: ['category', 'agent_name'], // Dimensions only
  metrics: ['count', 'avg_duration', 'error_rate', 'sum_cost'], // Measures only
  filters: { category: 'session' },
});
```

### From aggregation-query.ts

```typescript
// MongoDB aggregation pipeline
const groupStage = {
  _id: groupBy
    ? Object.fromEntries(
        groupBy.map((f) => [f, `$canonicalMetadata.${f}`]), // Only groupBy fields
      )
    : null,
  count: { $sum: 1 },
  value: { $sum: measurePath }, // Only aggregated measures
};
```

**Current codebase already follows this pattern** - aggregation queries only return:

- groupBy dimensions
- Aggregated measures (count, sum, avg)

---

## 9. ANSWERS TO SPECIFIC QUESTIONS

### Q1: Is there a standard pattern for which fields to show with aggregations?

**Answer: YES**

**Standard Pattern:**

- Grouping dimensions (1-3 fields)
- Aggregated measures (1-5 fields)
- Total: 3-7 fields typically

**Exclude:**

- Text fields (notes, descriptions, comments)
- Granular timestamps (created_at, updated_at)
- Status/process fields (stage, state)
- Metadata fields (version, modified_by)
- Foreign keys/internal IDs

### Q2: Do systems automatically select fewer fields for aggregated views?

**Answer: YES - Multiple enforcement levels**

1. **Database Level**: SQL GROUP BY syntax requirement
2. **BI Tool Level**: Separate UI sections for dimensions vs measures
3. **API Level**: Separate parameters (groupBy, metrics)
4. **UX Level**: Best practices for information density

### Q3: Are there different field sets for individual record vs aggregated summary vs drill-down?

**Answer: YES - Three distinct levels**

**Level 1: Individual Record View**

- Fields: ALL fields (10-30+ fields)
- Purpose: Complete entity understanding
- User action: Clicked specific item

**Level 2: Drill-Down View**

- Fields: Multiple dimensions + measures (5-12 fields)
- Purpose: Hierarchical analysis
- User action: Drilling into aggregation
- Example: Year → Quarter → Month breakdown

**Level 3: Aggregated Summary View**

- Fields: Minimal dimensions + measures (3-7 fields)
- Purpose: High-level comparison
- User action: Dashboard overview, top N lists

---

## 10. RECOMMENDATIONS

### For Top N Queries

**Return fields:**

```typescript
{
  identifier: string,          // e.g., deal_id, customer_name
  primaryMeasure: number,       // e.g., total_revenue
  contextDimension1?: string,   // e.g., region
  contextDimension2?: string,   // e.g., category
  supportingMeasure?: number,   // e.g., count
}
```

**Do NOT return:**

- Text notes
- Detailed timestamps
- Status fields
- Metadata
- Process fields

### For Aggregated Reports

**Allow configuration:**

```typescript
interface AggregationConfig {
  groupBy: string[]; // Required dimensions
  measures: Measure[]; // Required aggregated measures
  contextFields?: string[]; // Optional additional dimensions (max 2-3)
  excludeFields?: string[]; // Fields to never include
}
```

### For Detail Views

**Return all fields** - user has indicated interest in specific record

---

## SOURCES

1. **Microsoft Power BI Documentation**
   - Table Visualizations guide
   - Shows explicit separation of columns vs measures
   - Real example: 1 dimension + 5 measures for category performance

2. **OLAP Cube Concepts (Wikipedia)**
   - Dimension vs Measure architecture
   - Drill down/roll up operations
   - Slice and dice patterns

3. **SQL GROUP BY Standard**
   - Database enforced rule
   - Only grouped fields or aggregates can be selected

4. **Existing Codebase**
   - `/apps/runtime/src/routes/analytics.ts`
   - `/apps/search-ai-runtime/src/services/query/aggregation-query.ts`
   - Already implements dimension + measure pattern

---

## CONCLUSION

**Production BI tools universally show different fields in aggregated vs detailed views.**

This is both:

1. **Technically required** by SQL GROUP BY syntax
2. **UX optimized** for information density and cognitive load
3. **Industry standard** across all major BI platforms

**For aggregations:** Show only grouping dimensions (1-3) + measures
**For details:** Show all fields

This pattern is already implemented in the current codebase's aggregation endpoints.
