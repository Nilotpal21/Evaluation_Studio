# Table Metadata Generation

**Date**: 2026-02-23
**Purpose**: Explain how table metadata is automatically generated during ingestion for table discovery

## Overview

During the **two-phase ingestion API** (Phase 1: analyze, Phase 2: finalize), we automatically generate rich table metadata that powers table discovery.

**LLM Usage**: LLM-based description generation is **optional** and controlled by index-level configuration. When disabled, the system falls back to heuristic-based descriptions.

---

## Configuration: LLM Settings

### Index-Level Configuration

Table metadata generation follows the same LLM configuration pattern used for document chunking and extraction.

```typescript
interface IIndex {
  _id: ObjectId;
  tenantId: string;
  name: string;

  // Chunking & Extraction Config
  chunkingConfig: {
    enableLLM: boolean; // Master switch for LLM usage
    llmProvider?: string; // 'openai', 'anthropic', 'azure'
    llmModel?: string; // 'gpt-4o-mini', 'claude-3-haiku'
    // ... other chunking settings
  };

  // NEW: Structured Data Config
  structuredDataConfig?: {
    enableLLMMetadataGeneration?: boolean; // Optional override (defaults to chunkingConfig.enableLLM)
    llmProvider?: string; // Optional override (defaults to chunkingConfig.llmProvider)
    llmModel?: string; // Optional override (defaults to chunkingConfig.llmModel)
  };
}
```

### Configuration Precedence

```typescript
function getLLMConfig(index: IIndex): { enabled: boolean; provider?: string; model?: string } {
  // Check structured data specific config first
  if (index.structuredDataConfig?.enableLLMMetadataGeneration !== undefined) {
    return {
      enabled: index.structuredDataConfig.enableLLMMetadataGeneration,
      provider: index.structuredDataConfig.llmProvider || index.chunkingConfig.llmProvider,
      model: index.structuredDataConfig.llmModel || index.chunkingConfig.llmModel || 'gpt-4o-mini',
    };
  }

  // Fall back to chunking config
  return {
    enabled: index.chunkingConfig.enableLLM,
    provider: index.chunkingConfig.llmProvider,
    model: index.chunkingConfig.llmModel || 'gpt-4o-mini',
  };
}
```

### Use Cases

**Scenario 1: LLM Enabled Globally**

```typescript
{
  chunkingConfig: {
    enableLLM: true,
    llmProvider: 'openai',
    llmModel: 'gpt-4o-mini'
  }
  // structuredDataConfig not set → uses chunking config
}
// Result: LLM used for metadata generation
```

**Scenario 2: LLM Disabled Globally**

```typescript
{
  chunkingConfig: {
    enableLLM: false;
  }
}
// Result: Heuristic-based metadata only (no LLM calls)
```

**Scenario 3: LLM Enabled for Documents, Disabled for Structured Data**

```typescript
{
  chunkingConfig: {
    enableLLM: true,
    llmProvider: 'openai',
    llmModel: 'gpt-4o'  // Expensive model for document chunking
  },
  structuredDataConfig: {
    enableLLMMetadataGeneration: false  // Disable for structured data
  }
}
// Result: Heuristic-based metadata for tables, LLM for documents
```

**Scenario 4: Different Models for Different Use Cases**

```typescript
{
  chunkingConfig: {
    enableLLM: true,
    llmProvider: 'anthropic',
    llmModel: 'claude-3-opus'  // High-quality for semantic chunking
  },
  structuredDataConfig: {
    enableLLMMetadataGeneration: true,
    llmProvider: 'openai',
    llmModel: 'gpt-4o-mini'  // Cheap and fast for metadata
  }
}
// Result: Both enabled, but different models
```

---

## Generation Pipeline

```
┌─────────────────────────────────────────────────────────────────┐
│                   USER UPLOADS FILE                              │
│              (CSV, JSON, Excel)                                  │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ↓
         ┌─────────────────────────────┐
         │   PHASE 1: ANALYZE          │
         │  - Parse file format        │
         │  - Infer schema             │
         │  - Generate metadata        │
         └─────────────┬───────────────┘
                       │
                       ↓
         ┌─────────────────────────────┐
         │   METADATA GENERATION       │
         │  (Automated)                │
         │                             │
         │  1. Schema Analysis         │
         │  2. Statistics Calculation  │
         │  3. Sample Row Selection    │
         │  4. Description Generation  │
         │  5. Embedding Creation      │
         └─────────────┬───────────────┘
                       │
                       ↓
         ┌─────────────────────────────┐
         │   USER REVIEW               │
         │  - Approve/edit metadata    │
         │  - Add custom descriptions  │
         │  - Adjust column types      │
         └─────────────┬───────────────┘
                       │
                       ↓
         ┌─────────────────────────────┐
         │   PHASE 2: FINALIZE         │
         │  - Store table in ClickHouse│
         │  - Store metadata in MongoDB│
         │  - Create embeddings        │
         └─────────────────────────────┘
```

---

## Component 1: Schema Analysis

### Input

Raw parsed data from CSV/JSON/Excel:

```typescript
interface ParsedTable {
  headers: string[];
  rows: any[][];
  format: 'csv' | 'json' | 'excel';
}

// Example CSV
const parsedData = {
  headers: ['id', 'name', 'revenue', 'status', 'description', 'created_at'],
  rows: [
    [1, 'Acme Corp', 1000000, 'active', 'Leading AI company...', '2023-01-15'],
    [2, 'Beta Inc', 500000, 'trial', 'SaaS startup...', '2024-03-20'],
    // ...99,998 more rows
  ],
  format: 'csv',
};
```

### Process

```typescript
async function analyzeSchema(parsedData: ParsedTable): Promise<TableSchema> {
  const schema: TableSchema = {
    tableName: '', // User provides or inferred from filename
    columns: [],
    rowCount: parsedData.rows.length,
    sampleRows: [],
    statistics: {},
  };

  // Step 1: Analyze each column
  for (let colIndex = 0; colIndex < parsedData.headers.length; colIndex++) {
    const columnName = parsedData.headers[colIndex];
    const columnValues = parsedData.rows.map((row) => row[colIndex]);

    const columnAnalysis = await analyzeColumn(columnName, columnValues);
    schema.columns.push(columnAnalysis);
  }

  // Step 2: Detect primary key
  schema.primaryKey = detectPrimaryKey(schema.columns, parsedData.rows);

  return schema;
}
```

### Column Type Inference

```typescript
function analyzeColumn(name: string, values: any[]): ColumnSchema {
  // Filter out nulls/undefined
  const nonNullValues = values.filter((v) => v !== null && v !== undefined && v !== '');

  // Sample 1000 values for analysis (not all rows)
  const sample = nonNullValues.slice(0, 1000);

  // Detect type
  const type = inferColumnType(sample);

  // Calculate statistics based on type
  const stats = calculateColumnStatistics(sample, type);

  // Generate auto-description
  const description = generateColumnDescription(name, type, stats);

  // Calculate average length (for strings)
  const avgLength =
    type === 'string'
      ? Math.round(sample.reduce((sum, v) => sum + String(v).length, 0) / sample.length)
      : null;

  return {
    name,
    type,
    description,
    nullable: nonNullValues.length < values.length,
    avgLength,
    statistics: stats,
    isEmbeddable: type === 'string' && avgLength > 100, // Long text fields
    isFilterable: ['number', 'integer', 'boolean', 'date', 'enum'].includes(type),
  };
}

function inferColumnType(sample: any[]): ColumnType {
  // Count type occurrences
  const typeCounts = {
    number: 0,
    integer: 0,
    boolean: 0,
    date: 0,
    string: 0,
  };

  for (const value of sample) {
    if (typeof value === 'number') {
      typeCounts.number++;
      if (Number.isInteger(value)) {
        typeCounts.integer++;
      }
    } else if (typeof value === 'boolean') {
      typeCounts.boolean++;
    } else if (isDate(value)) {
      typeCounts.date++;
    } else {
      typeCounts.string++;
    }
  }

  // Determine dominant type (>80% threshold)
  const totalSample = sample.length;
  if (typeCounts.integer / totalSample > 0.8) return 'integer';
  if (typeCounts.number / totalSample > 0.8) return 'number';
  if (typeCounts.boolean / totalSample > 0.8) return 'boolean';
  if (typeCounts.date / totalSample > 0.8) return 'date';

  // Check if it's an enum (low cardinality string)
  const uniqueValues = new Set(sample);
  if (typeCounts.string / totalSample > 0.8 && uniqueValues.size < 20) {
    return 'enum';
  }

  return 'string';
}

function isDate(value: any): boolean {
  if (value instanceof Date) return true;
  if (typeof value !== 'string') return false;

  // Common date patterns
  const datePatterns = [
    /^\d{4}-\d{2}-\d{2}$/, // 2023-01-15
    /^\d{2}\/\d{2}\/\d{4}$/, // 01/15/2023
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, // ISO 8601
  ];

  return datePatterns.some((pattern) => pattern.test(value));
}
```

---

## Component 2: Statistics Calculation

### Numeric Columns

```typescript
function calculateNumericStats(values: number[]): NumericStatistics {
  const sorted = values.filter((v) => !isNaN(v)).sort((a, b) => a - b);

  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: sorted.reduce((sum, v) => sum + v, 0) / sorted.length,
    median: sorted[Math.floor(sorted.length / 2)],
    stddev: calculateStdDev(sorted),
    percentiles: {
      p25: sorted[Math.floor(sorted.length * 0.25)],
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p75: sorted[Math.floor(sorted.length * 0.75)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
    },
  };
}

// Example output:
// {
//   min: 0,
//   max: 5000000,
//   avg: 250000,
//   median: 180000,
//   stddev: 450000,
//   percentiles: { p25: 50000, p50: 180000, p75: 500000, p95: 2000000 }
// }
```

### Categorical Columns (Enums)

```typescript
function calculateCategoricalStats(values: string[]): CategoricalStatistics {
  const valueCounts = new Map<string, number>();

  for (const value of values) {
    valueCounts.set(value, (valueCounts.get(value) || 0) + 1);
  }

  const total = values.length;
  const distribution = Object.fromEntries(
    Array.from(valueCounts.entries())
      .map(([value, count]) => [value, (count / total) * 100])
      .sort((a, b) => b[1] - a[1]), // Sort by frequency descending
  );

  return {
    uniqueValues: Array.from(valueCounts.keys()),
    cardinality: valueCounts.size,
    distribution, // { "active": 80, "inactive": 15, "trial": 5 }
    mostCommon: Array.from(valueCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([value, count]) => ({ value, count })),
  };
}
```

### String Columns (Text)

```typescript
function calculateStringStats(values: string[]): StringStatistics {
  const lengths = values.map((v) => v.length);

  return {
    avgLength: Math.round(lengths.reduce((sum, len) => sum + len, 0) / lengths.length),
    minLength: Math.min(...lengths),
    maxLength: Math.max(...lengths),
    totalChars: lengths.reduce((sum, len) => sum + len, 0),
  };
}
```

---

## Component 3: Sample Row Selection

### Strategy: Representative Sampling

**Goal**: Select 5-10 rows that best represent the table's diversity

```typescript
async function selectSampleRows(parsedData: ParsedTable, schema: TableSchema): Promise<any[]> {
  const rows = parsedData.rows;
  const sampleSize = Math.min(10, rows.length);

  // Strategy: Stratified sampling across categorical columns
  const categoricalColumns = schema.columns.filter((c) => c.type === 'enum');

  if (categoricalColumns.length === 0) {
    // No categorical columns - just take first 10 rows
    return rows.slice(0, sampleSize);
  }

  // Find the most important categorical column (lowest cardinality)
  const primaryCategorical = categoricalColumns.reduce((prev, curr) =>
    curr.statistics.cardinality < prev.statistics.cardinality ? curr : prev,
  );

  const colIndex = schema.columns.indexOf(primaryCategorical);

  // Group rows by this column's value
  const groups = new Map<any, any[]>();
  for (const row of rows) {
    const key = row[colIndex];
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(row);
  }

  // Sample evenly from each group
  const samplesPerGroup = Math.ceil(sampleSize / groups.size);
  const samples: any[] = [];

  for (const [_key, groupRows] of groups.entries()) {
    samples.push(...groupRows.slice(0, samplesPerGroup));
    if (samples.length >= sampleSize) break;
  }

  return samples.slice(0, sampleSize);
}

// Example result:
// [
//   { id: 1, name: "Acme", status: "active", ... },   // active example
//   { id: 2, name: "Beta", status: "active", ... },   // active example
//   { id: 3, name: "Gamma", status: "inactive", ... }, // inactive example
//   { id: 4, name: "Delta", status: "trial", ... },    // trial example
//   ...
// ]
```

---

## Component 4: Description Generation

### Configuration-Driven Approach

```typescript
async function generateTableDescription(
  tableName: string,
  schema: TableSchema,
  sampleRows: any[],
  llmConfig: { enabled: boolean; provider?: string; model?: string },
): Promise<string> {
  if (llmConfig.enabled) {
    return await generateTableDescriptionWithLLM(tableName, schema, sampleRows, llmConfig);
  } else {
    return generateTableDescriptionHeuristic(tableName, schema);
  }
}
```

### Option 1: LLM-Based Description (when enableLLM = true)

```typescript
async function generateTableDescriptionWithLLM(
  tableName: string,
  schema: TableSchema,
  sampleRows: any[],
  llmConfig: { provider: string; model: string },
): Promise<string> {
  const prompt = `
You are analyzing a database table. Generate a concise description (1-2 sentences) of what this table contains.

Table Name: ${tableName}

Columns:
${schema.columns.map((col) => `- ${col.name} (${col.type})`).join('\n')}

Sample Rows:
${JSON.stringify(sampleRows.slice(0, 3), null, 2)}

Statistics:
- Total rows: ${schema.rowCount}
- Columns: ${schema.columns.length}

Generate a description that explains:
1. What entity this table represents
2. What kind of data it contains
3. Its primary purpose

Format: Single paragraph, 1-2 sentences, no jargon.

Example: "Customer records with company information and contact details. Includes revenue data and account status for business analytics."
`;

  const response = await llm.complete({
    prompt,
    provider: llmConfig.provider,
    model: llmConfig.model || 'gpt-4o-mini', // Default to fast, cheap model
    maxTokens: 100,
  });

  return response.text.trim();
}

// Example output:
// "Customer records with company information, revenue data, and account status. Used for business analytics and customer relationship management."
```

### Option 2: Heuristic-Based Description (when enableLLM = false)

```typescript
function generateTableDescriptionHeuristic(tableName: string, schema: TableSchema): string {
  // Strategy: Build description from table name and column analysis

  // Step 1: Humanize table name
  const humanizedName = humanizeTableName(tableName);
  // "customers" → "Customers"
  // "order_items" → "Order Items"
  // "revenue_by_region" → "Revenue By Region"

  // Step 2: Identify key column types
  const hasText = schema.columns.some((c) => c.type === 'string' && c.avgLength > 100);
  const hasNumbers = schema.columns.some((c) => ['number', 'integer', 'decimal'].includes(c.type));
  const hasDates = schema.columns.some((c) => c.type === 'date');
  const hasStatus = schema.columns.some((c) => c.name.toLowerCase().includes('status'));

  // Step 3: Build description components
  let description = `${humanizedName} table`;

  // Add column hints
  const hints: string[] = [];
  if (hasText) hints.push('detailed records');
  if (hasNumbers) hints.push('numeric data');
  if (hasDates) hints.push('temporal information');
  if (hasStatus) hints.push('status tracking');

  if (hints.length > 0) {
    description += ` with ${hints.join(', ')}`;
  }

  description += `.`;

  // Add row count context
  if (schema.rowCount > 100000) {
    description += ` Large dataset with ${formatNumber(schema.rowCount)} rows.`;
  } else if (schema.rowCount > 1000) {
    description += ` Contains ${formatNumber(schema.rowCount)} records.`;
  } else {
    description += ` Reference table with ${schema.rowCount} entries.`;
  }

  return description;
}

function humanizeTableName(tableName: string): string {
  return tableName
    .split(/[_-]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// Example outputs:
// "customers" → "Customers table with detailed records, numeric data, temporal information, status tracking. Contains 100,000 records."
// "order_items" → "Order Items table with numeric data. Contains 500,000 records."
// "countries" → "Countries table. Reference table with 195 entries."
```

### Quality Comparison

| Aspect             | LLM-Based                                                                      | Heuristic-Based                                                   |
| ------------------ | ------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| **Quality**        | ⭐⭐⭐⭐⭐ Rich, contextual, natural language                                  | ⭐⭐⭐ Functional, accurate, but formulaic                        |
| **Cost**           | $0.0001 per table                                                              | Free                                                              |
| **Speed**          | ~1-2 seconds (LLM latency)                                                     | <10ms (instant)                                                   |
| **Privacy**        | Sends sample data to LLM provider                                              | No external calls                                                 |
| **Example**        | "Customer records with company information, revenue data, and account status." | "Customers table with detailed records, numeric data. 100k rows." |
| **Search Quality** | Excellent (natural language matches user queries better)                       | Good (structured keywords still work)                             |

**Recommendation**: Use LLM for production indexes with diverse tables. Use heuristics for internal/testing indexes or privacy-sensitive data.

### Column Descriptions

```typescript
async function generateColumnDescription(
  columnName: string,
  columnType: ColumnType,
  stats: any,
  llmConfig: { enabled: boolean; provider?: string; model?: string },
): Promise<string> {
  // Step 1: Try heuristic-based descriptions (always try first)
  const heuristicDesc = generateColumnDescriptionHeuristic(columnName, columnType, stats);

  // Step 2: If heuristic found a match, return it (no LLM needed)
  if (heuristicDesc !== null) {
    return heuristicDesc;
  }

  // Step 3: For unknown columns, use LLM only if enabled
  if (llmConfig.enabled) {
    return await generateColumnDescriptionWithLLM(columnName, columnType, stats, llmConfig);
  }

  // Step 4: Fallback for unknown columns when LLM disabled
  return generateGenericColumnDescription(columnName, columnType);
}

function generateColumnDescriptionHeuristic(
  columnName: string,
  columnType: ColumnType,
  stats: any,
): string | null {
  // Heuristic-based descriptions (no LLM needed)
  const descriptions: Record<string, string> = {
    id: 'Unique identifier',
    name: 'Name or title',
    email: 'Email address',
    phone: 'Phone number',
    address: 'Physical address',
    created_at: 'Creation timestamp',
    updated_at: 'Last update timestamp',
    status: 'Current status',
    revenue: 'Revenue amount',
    price: 'Price value',
    cost: 'Cost amount',
    amount: 'Amount value',
    total: 'Total value',
    quantity: 'Quantity or count',
    count: 'Count value',
    description: 'Detailed description',
    notes: 'Additional notes or comments',
    url: 'URL link',
    link: 'Link or reference',
    type: 'Type or category',
    category: 'Category classification',
    tags: 'Tags or labels',
    user: 'User reference',
    customer: 'Customer reference',
    order: 'Order reference',
  };

  // Check for common patterns
  const lowerName = columnName.toLowerCase();
  for (const [pattern, desc] of Object.entries(descriptions)) {
    if (lowerName.includes(pattern)) {
      // Enhance with statistics
      if (columnType === 'number' && stats.min !== undefined) {
        return `${desc} (range: ${formatNumber(stats.min)} to ${formatNumber(stats.max)})`;
      }
      if (columnType === 'enum' && stats.uniqueValues) {
        return `${desc} (values: ${stats.uniqueValues.slice(0, 3).join(', ')}${stats.uniqueValues.length > 3 ? ', ...' : ''})`;
      }
      return desc;
    }
  }

  return null; // No heuristic match found
}

async function generateColumnDescriptionWithLLM(
  columnName: string,
  columnType: ColumnType,
  stats: any,
  llmConfig: { provider: string; model: string },
): Promise<string> {
  const prompt = `
Column name: ${columnName}
Type: ${columnType}
Statistics: ${JSON.stringify(stats, null, 2)}

Generate a brief (5-10 word) description of what this column likely contains.
Focus on the purpose, not the technical details.

Examples:
- "user_agent" → "Browser and device information"
- "session_duration" → "Length of user session in seconds"
- "conversion_rate" → "Percentage of successful conversions"
`;

  const response = await llm.complete({
    prompt,
    provider: llmConfig.provider,
    model: llmConfig.model || 'gpt-4o-mini',
    maxTokens: 30,
  });

  return response.text.trim();
}

function generateGenericColumnDescription(columnName: string, columnType: ColumnType): string {
  // Generic fallback when LLM is disabled and no heuristic match
  const humanizedName = columnName
    .split(/[_-]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

  const typeDesc =
    {
      string: 'text',
      number: 'numeric value',
      integer: 'integer value',
      decimal: 'decimal value',
      boolean: 'true/false flag',
      date: 'date/time value',
      enum: 'categorical value',
    }[columnType] || 'value';

  return `${humanizedName} (${typeDesc})`;
}

// Example outputs:

// Heuristic match (always used):
// "created_at" → "Creation timestamp"
// "revenue" → "Revenue amount (range: 0 to 5,000,000)"
// "status" → "Current status (values: active, inactive, trial)"

// LLM-based (when enabled, for unknown columns):
// "user_agent" → "Browser and device information"
// "session_duration" → "Length of user session in seconds"

// Generic fallback (when LLM disabled, for unknown columns):
// "user_agent" → "User Agent (text)"
// "session_duration" → "Session Duration (numeric value)"
```

---

## Component 5: Primary Key Detection

```typescript
function detectPrimaryKey(columns: ColumnSchema[], rows: any[][]): string | null {
  // Strategy 1: Look for columns named "id", "ID", "{table}_id"
  const idColumn = columns.find(
    (col) =>
      col.name.toLowerCase() === 'id' ||
      col.name.toLowerCase().endsWith('_id') ||
      col.name.toLowerCase() === 'pk',
  );

  if (idColumn) {
    // Verify uniqueness
    const colIndex = columns.indexOf(idColumn);
    const values = rows.map((row) => row[colIndex]);
    const uniqueValues = new Set(values);

    if (uniqueValues.size === values.length) {
      return idColumn.name; // All values are unique
    }
  }

  // Strategy 2: Find any column with 100% unique values
  for (const col of columns) {
    const colIndex = columns.indexOf(col);
    const values = rows.map((row) => row[colIndex]);
    const uniqueValues = new Set(values);

    if (uniqueValues.size === values.length && values.length > 0) {
      return col.name;
    }
  }

  return null; // No primary key detected
}
```

---

## Component 6: Embedding Creation

```typescript
async function createTableEmbedding(
  tableSchema: TableSchema,
  tableDescription: string,
): Promise<number[]> {
  // Build comprehensive text for embedding
  const embeddingText = `
Table: ${tableSchema.tableName}
Description: ${tableDescription}

Columns:
${tableSchema.columns.map((col) => `- ${col.name} (${col.type}): ${col.description}`).join('\n')}

Sample data:
${JSON.stringify(tableSchema.sampleRows, null, 2)}

Statistics:
- Row count: ${tableSchema.rowCount}
- Primary key: ${tableSchema.primaryKey || 'None'}
`.trim();

  // Generate embedding
  const embedding = await embeddingService.embed(embeddingText);

  return embedding; // 1536-dim vector
}
```

---

## Complete Workflow Example

### Input: CSV File

```csv
id,name,revenue,status,description,created_at
1,Acme Corp,1000000,active,Leading AI company specializing in enterprise software,2023-01-15
2,Beta Inc,500000,trial,SaaS startup in fintech sector,2024-03-20
3,Gamma LLC,2500000,active,Manufacturing company specializing in automotive parts,2022-06-10
...99997 more rows
```

### Step 1: Parse & Analyze

```typescript
const parsedData = parseCSV(file);
const schema = await analyzeSchema(parsedData);

// Result:
// {
//   tableName: 'customers',  // from filename: customers.csv
//   columns: [
//     { name: 'id', type: 'integer', description: 'Unique identifier', ... },
//     { name: 'name', type: 'string', description: 'Company name', avgLength: 15, ... },
//     { name: 'revenue', type: 'number', description: 'Revenue amount (range: 0 to 5000000)', ... },
//     { name: 'status', type: 'enum', description: 'Current status (values: active, inactive, trial)', ... },
//     { name: 'description', type: 'string', description: 'Detailed company profile', avgLength: 250, isEmbeddable: true, ... },
//     { name: 'created_at', type: 'date', description: 'Customer onboarding date', ... }
//   ],
//   rowCount: 100000,
//   primaryKey: 'id'
// }
```

### Step 2: Calculate Statistics

```typescript
const statistics = await calculateStatistics(parsedData, schema);

// Result:
// {
//   revenue: {
//     min: 0,
//     max: 5000000,
//     avg: 250000,
//     percentiles: { p25: 50000, p50: 180000, p75: 500000, p95: 2000000 }
//   },
//   status: {
//     uniqueValues: ['active', 'inactive', 'trial'],
//     cardinality: 3,
//     distribution: { active: 80, inactive: 15, trial: 5 }
//   }
// }
```

### Step 3: Select Sample Rows

```typescript
const sampleRows = await selectSampleRows(parsedData, schema);

// Result: 10 representative rows stratified by 'status'
```

### Step 4: Generate Descriptions

```typescript
const tableDescription = await generateTableDescription('customers', schema, sampleRows);

// Result:
// "Customer records with company information, revenue data, and account status. Used for business analytics and customer relationship management."
```

### Step 5: Create Embedding

```typescript
const embedding = await createTableEmbedding(schema, tableDescription);

// Result: [0.123, -0.456, 0.789, ...] (1536 dimensions)
```

### Step 6: Store Metadata

```typescript
// Store in ClickHouse
await clickhouse.insert({
  table: 'table_metadata',
  values: {
    table_id: generateUUID(),
    table_name: 'customers',
    display_name: 'Customers',
    tenant_id: 'acme-corp',
    index_id: 'idx123',
    columns: schema.columns.map((c) => c.name),
    column_types: schema.columns.map((c) => c.type),
    primary_key: 'id',
    row_count: 100000,
    table_description: tableDescription,
    column_descriptions: Object.fromEntries(schema.columns.map((c) => [c.name, c.description])),
    statistics: JSON.stringify(statistics),
    sample_rows: JSON.stringify(sampleRows),
    searchable_text: `${schema.tableName} ${tableDescription} ${schema.columns.map((c) => c.name).join(' ')}`,
  },
});

// Store embedding in MongoDB
await mongodb.collection('table_metadata_embeddings').insertOne({
  tableId: table_id,
  tableName: 'customers',
  tenantId: 'acme-corp',
  indexId: 'idx123',
  embedding,
  metadata: {
    rowCount: 100000,
    columnCount: 6,
    hasTextColumns: true,
    hasNumericColumns: true,
    primaryKey: 'id',
    tableType: 'fact',
  },
  fullContext: {
    tableDescription,
    columns: schema.columns,
    sampleRows,
    statistics,
  },
});
```

---

## Cost Analysis

### Per Table (100k rows) - With LLM Enabled

| Operation                     | Cost                 | Time    |
| ----------------------------- | -------------------- | ------- |
| **Schema inference**          | Free (computation)   | ~500ms  |
| **Statistics calculation**    | Free (computation)   | ~200ms  |
| **Sample row selection**      | Free (computation)   | ~50ms   |
| **Table description (LLM)**   | $0.0001 (100 tokens) | ~1s     |
| **Column descriptions (LLM)** | $0.0006 (600 tokens) | ~2s     |
| **Embedding generation**      | $0.0001 (1000 chars) | ~500ms  |
| **ClickHouse storage**        | ~5 KB                | ~50ms   |
| **MongoDB storage**           | ~10 KB               | ~50ms   |
| **Total per table (LLM ON)**  | **~$0.001**          | **~4s** |

### Per Table (100k rows) - With LLM Disabled

| Operation                           | Cost                 | Time      |
| ----------------------------------- | -------------------- | --------- |
| **Schema inference**                | Free (computation)   | ~500ms    |
| **Statistics calculation**          | Free (computation)   | ~200ms    |
| **Sample row selection**            | Free (computation)   | ~50ms     |
| **Table description (Heuristic)**   | Free (computation)   | ~5ms      |
| **Column descriptions (Heuristic)** | Free (computation)   | ~10ms     |
| **Embedding generation**            | $0.0001 (1000 chars) | ~500ms    |
| **ClickHouse storage**              | ~5 KB                | ~50ms     |
| **MongoDB storage**                 | ~10 KB               | ~50ms     |
| **Total per table (LLM OFF)**       | **~$0.0001**         | **~1.3s** |

### Per Index (100 tables)

| Metric              | With LLM            | Without LLM         |
| ------------------- | ------------------- | ------------------- |
| **Total cost**      | $0.10               | $0.01               |
| **Total time**      | ~7 minutes          | ~2 minutes          |
| **Storage**         | 1.5 MB (metadata)   | 1.5 MB (metadata)   |
| **Embedding count** | 100 (one per table) | 100 (one per table) |
| **Search quality**  | Excellent (natural) | Good (structured)   |

### Cost Savings: LLM Disabled

- **90% cost reduction**: $0.10 → $0.01 per index
- **70% faster ingestion**: 7 min → 2 min per index
- **Same search capability**: Metadata embeddings still work
- **Trade-off**: Descriptions are more formulaic, slightly lower semantic match quality

**Recommendation**:

- **LLM ON**: Production indexes with diverse, user-facing tables where search quality matters
- **LLM OFF**: Internal indexes, testing environments, privacy-sensitive data, or when minimizing costs

**Key Insight**: Metadata generation is cheap and fast - happens once during ingestion. Even with LLM enabled, the cost is negligible compared to embedding 100k rows of data ($0.001 vs $1.00).

---

## User Overrides

### Allow Custom Descriptions

```typescript
// Phase 1 response includes auto-generated metadata
POST /api/v1/indexes/:indexId/ingest/analyze
Response: {
  analysisId: "analysis_abc123",
  tables: [{
    tableName: "customers",
    description: "Customer records with company information...",  // Auto-generated
    columns: [
      { name: "id", type: "integer", description: "Unique identifier" },  // Auto-generated
      { name: "description", type: "string", description: "Detailed company profile" }  // Auto-generated
    ]
  }]
}

// User can override before Phase 2
POST /api/v1/indexes/:indexId/ingest/finalize
{
  analysisId: "analysis_abc123",
  overrides: {
    tables: {
      customers: {
        description: "Enterprise customer records for CRM system",  // User override
        columns: {
          description: "Company business profile and industry vertical"  // User override
        }
      }
    }
  }
}
```

### Benefits of User Overrides

1. ✅ **Domain-specific terminology**: User adds industry jargon
2. ✅ **Improved search quality**: Better descriptions = better semantic matching
3. ✅ **Column purpose clarification**: Auto-detection isn't always perfect
4. ✅ **Business context**: User explains why data matters

---

## Summary

### Automatic Generation (Always)

1. ✅ **Schema inference**: Column types, nullability, primary key (heuristic)
2. ✅ **Statistics**: Min/max/avg, distributions, cardinality (computed)
3. ✅ **Sample rows**: Representative stratified sampling (computed)
4. ✅ **Embeddings**: Semantic vectors for search (always generated)

### LLM-Based Generation (Optional - Controlled by `enableLLM`)

**When LLM Enabled**:

1. ✅ **Table descriptions**: Natural language, contextual summaries (~$0.0001 per table)
2. ✅ **Column descriptions**: Semantic descriptions for unknown columns (~$0.0001 per column)
3. ✅ **Higher search quality**: Better semantic matching with user queries

**When LLM Disabled**:

1. ✅ **Table descriptions**: Heuristic-based, formulaic but accurate (free)
2. ✅ **Column descriptions**: Pattern matching + generic fallbacks (free)
3. ✅ **90% cost savings**: $0.10 → $0.01 per 100 tables
4. ✅ **70% faster**: 7 min → 2 min per 100 tables

### User-Provided (Optional Override)

1. ⚙️ **Custom table descriptions**: Override auto-generated
2. ⚙️ **Custom column descriptions**: Add domain knowledge
3. ⚙️ **Table display names**: User-friendly names
4. ⚙️ **Column semantic hints**: For better extraction

### Configuration

**Follows existing chunking config pattern**:

```typescript
{
  chunkingConfig: {
    enableLLM: true,  // Master switch
    llmProvider: 'openai',
    llmModel: 'gpt-4o-mini'
  },
  structuredDataConfig: {
    enableLLMMetadataGeneration: true  // Optional override
  }
}
```

### Performance

| Metric             | LLM Enabled       | LLM Disabled      |
| ------------------ | ----------------- | ----------------- |
| **Time per table** | ~4 seconds        | ~1.3 seconds      |
| **Cost per table** | ~$0.001           | ~$0.0001          |
| **Search quality** | Excellent         | Good              |
| **Privacy**        | Sends sample data | No external calls |

### Recommendation

- **Use LLM**: Production indexes, user-facing search, diverse table schemas
- **Skip LLM**: Testing, internal tools, privacy-sensitive data, cost optimization

This metadata powers sub-500ms table discovery for 100+ tables.
