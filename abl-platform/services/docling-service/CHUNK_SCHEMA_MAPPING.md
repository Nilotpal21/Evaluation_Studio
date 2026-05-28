# Chunk Schema Mapping for Structured Data

**Task #20**: Design chunk schema mapping for JSON/CSV/Excel
**Date**: 2026-02-23
**Status**: In Progress

## Executive Summary

This document defines concrete schema mappings from structured data formats (JSON, CSV, Excel) to the extended `SearchChunk` model. It provides:

1. **Filterable vs. Embeddable Field Rules** - Clear criteria for field classification
2. **Format-Specific Mapping Strategies** - JSON, CSV, Excel with concrete examples
3. **Chunking Decision Logic** - When to split vs. inline
4. **Code Examples** - TypeScript interfaces and mapping functions
5. **Retrieval Patterns** - How to query each format effectively

## Filterable vs. Embeddable Field Classification

### Decision Matrix

| Field Type         | Examples                                       | Filterable | Embeddable | Reasoning                                                                  |
| ------------------ | ---------------------------------------------- | ---------- | ---------- | -------------------------------------------------------------------------- |
| **IDs**            | `id`, `customerId`, `orderId`                  | ✅         | ❌         | Exact match queries, no semantic value                                     |
| **Numbers**        | `price`, `quantity`, `revenue`                 | ✅         | ❌         | Range queries, aggregations, not semantic                                  |
| **Dates**          | `createdAt`, `orderDate`                       | ✅         | ❌         | Range queries, sorting, not semantic                                       |
| **Booleans**       | `isActive`, `hasDiscount`                      | ✅         | ❌         | Binary filters, no semantic value                                          |
| **Enums/Status**   | `status: "active"`, `type: "premium"`          | ✅         | ⚠️         | Exact match filters; small enum set → also embeddable for semantic queries |
| **Short Text IDs** | `sku: "ABC-123"`, `zipCode: "12345"`           | ✅         | ❌         | Exact match, no semantic value                                             |
| **Names/Titles**   | `productName`, `customerName`, `title`         | ✅         | ✅         | Filter + semantic search (similar products)                                |
| **Descriptions**   | `description`, `notes`, `comments`             | ❌         | ✅         | Semantic search only, not for filtering                                    |
| **Long Text**      | `articleContent`, `review`, `bio`              | ❌         | ✅         | Semantic search only                                                       |
| **Categories**     | `category: "Electronics"`, `region: "US-West"` | ✅         | ✅         | Filter + semantic (related categories)                                     |
| **Tags/Keywords**  | `tags: ["ml", "ai"]`, `keywords`               | ✅         | ✅         | Both exact match and semantic similarity                                   |
| **Metadata**       | `source`, `author`, `version`                  | ✅         | ⚠️         | Filterable; embeddable if semantic value (author names)                    |

### Rules

**Filterable-Only Fields** (never embed):

- Numeric values (integers, floats, decimals)
- Dates, timestamps, datetimes
- Booleans (true/false)
- UUIDs, auto-increment IDs
- Foreign keys, reference IDs
- Internal codes with no semantic meaning

**Embeddable-Only Fields** (never filter):

- Long text descriptions (>100 words)
- Article content, reviews, comments
- Freeform notes
- Rich text / HTML content

**Hybrid Fields** (both filterable and embeddable):

- Product names, titles (filter by exact match + find similar)
- Category names, tags (filter by exact + find related)
- Short enums with semantic value (`status: "premium"` → find similar tiers)
- Author names, company names (filter by exact + find similar entities)

### Embedding Content Construction

For records with multiple embeddable fields, concatenate with labels:

```
Table: {tableName}
{field1Label}: {field1Value}
{field2Label}: {field2Value}
...
```

**Example** (Customer record):

```
Table: Customers
Name: Acme Corporation
Industry: Software
Description: Leading provider of cloud-based enterprise solutions specializing in AI and machine learning platforms.
Notes: Long-term customer since 2020. High satisfaction scores. Interested in expanding to new regions.
```

**Token budget allocation**:

- If total embeddable content < `MAX_RECORD_TOKENS` (1000): inline all
- If any field > `MAX_FIELD_TOKENS` (500): chunk that field separately
- Preserve field labels in child chunks for context

---

## JSON Mapping

### Strategy

**Hierarchical Representation** (recommended):

- Preserve JSON structure in `fieldPath` using JSON path notation (`$.parent.child[0].field`)
- One chunk per object/record (if small)
- Separate chunks for large fields with `parentChunkId` linking
- Array elements get individual chunks with `arrayIndex`

### Example 1: Simple JSON Object

**Input**:

```json
{
  "id": 12345,
  "name": "Acme Corp",
  "revenue": 1000000,
  "status": "active",
  "description": "Technology company specializing in AI solutions.",
  "founded": "2010-01-15"
}
```

**Mapping**:

```typescript
{
  chunkType: 'record',
  recordId: '12345',
  recordType: 'customer',
  tableName: 'customers',
  fieldPath: '$',  // Root object

  // Embeddable content (for vector search)
  content: 'Table: customers\nName: Acme Corp\nDescription: Technology company specializing in AI solutions.',

  // Filterable metadata (for exact/range queries)
  filterableMetadata: {
    id: 12345,
    revenue: 1000000,
    status: 'active',
    founded: '2010-01-15'
  },

  // Embeddable metadata (also goes into content, stored separately for access)
  embeddableMetadata: {
    name: 'Acme Corp',
    description: 'Technology company specializing in AI solutions.'
  },

  // Schema metadata
  schemaMetadata: {
    primaryKey: 'id',
    jsonSchema: {
      type: 'object',
      properties: {
        id: { type: 'number' },
        name: { type: 'string' },
        revenue: { type: 'number' },
        status: { type: 'string', enum: ['active', 'inactive'] },
        description: { type: 'string' },
        founded: { type: 'string', format: 'date' }
      }
    }
  }
}
```

### Example 2: Nested JSON with Arrays

**Input**:

```json
{
  "orderId": "ORD-001",
  "customer": {
    "name": "John Doe",
    "email": "john@example.com"
  },
  "items": [
    {
      "productName": "Widget A",
      "price": 29.99,
      "description": "High-quality widget for industrial use."
    },
    {
      "productName": "Widget B",
      "price": 39.99,
      "description": "Premium widget with advanced features."
    }
  ],
  "total": 69.98
}
```

**Mapping Strategy**:

1. Root object → one chunk (if items array is small)
2. Each array element → separate chunk (if items are large or need individual retrieval)

**Root Chunk**:

```typescript
{
  chunkType: 'record',
  recordId: 'ORD-001',
  recordType: 'order',
  tableName: 'orders',
  fieldPath: '$',

  content: 'Table: orders\nCustomer: John Doe\nItems: Widget A, Widget B\nTotal: $69.98',

  filterableMetadata: {
    orderId: 'ORD-001',
    customerEmail: 'john@example.com',
    total: 69.98,
    itemCount: 2
  },

  embeddableMetadata: {
    customerName: 'John Doe',
    itemSummary: 'Widget A, Widget B'  // Short summary for quick retrieval
  },

  schemaMetadata: {
    primaryKey: 'orderId',
    jsonSchema: {
      type: 'object',
      properties: {
        orderId: { type: 'string' },
        customer: { type: 'object' },
        items: { type: 'array' },
        total: { type: 'number' }
      }
    }
  }
}
```

**Array Element Chunks** (if needed for granular retrieval):

```typescript
// Chunk for items[0]
{
  chunkType: 'array_element',
  recordId: 'ORD-001',
  recordType: 'order_item',
  tableName: 'orders',
  fieldPath: '$.items[0]',
  arrayIndex: 0,
  parentChunkId: '<root-chunk-id>',

  content: 'Product: Widget A\nPrice: $29.99\nDescription: High-quality widget for industrial use.',

  filterableMetadata: {
    orderId: 'ORD-001',  // Inherited from parent
    arrayIndex: 0,
    price: 29.99
  },

  embeddableMetadata: {
    productName: 'Widget A',
    description: 'High-quality widget for industrial use.'
  }
}

// Chunk for items[1]
{
  chunkType: 'array_element',
  recordId: 'ORD-001',
  recordType: 'order_item',
  tableName: 'orders',
  fieldPath: '$.items[1]',
  arrayIndex: 1,
  parentChunkId: '<root-chunk-id>',

  content: 'Product: Widget B\nPrice: $39.99\nDescription: Premium widget with advanced features.',

  filterableMetadata: {
    orderId: 'ORD-001',
    arrayIndex: 1,
    price: 39.99
  },

  embeddableMetadata: {
    productName: 'Widget B',
    description: 'Premium widget with advanced features.'
  }
}
```

### Example 3: Large Field Chunking

**Input**:

```json
{
  "id": 99,
  "title": "Annual Report 2025",
  "summary": "Overview of company performance.",
  "fullReport": "<10,000 word detailed report content...>"
}
```

**Mapping Strategy**:

1. Main record chunk with summary (embeddable, <1000 tokens)
2. Separate chunks for `fullReport` field (linked via `parentChunkId`)

**Main Chunk**:

```typescript
{
  chunkType: 'record',
  recordId: '99',
  recordType: 'report',
  tableName: 'reports',
  fieldPath: '$',

  content: 'Table: reports\nTitle: Annual Report 2025\nSummary: Overview of company performance.',

  filterableMetadata: {
    id: 99,
    hasLargeContent: true  // Flag for client
  },

  embeddableMetadata: {
    title: 'Annual Report 2025',
    summary: 'Overview of company performance.'
  }
}
```

**Field Chunks** (for large `fullReport` field):

```typescript
// Chunk 1 of fullReport (0-3000 chars)
{
  chunkType: 'field',
  recordId: '99',
  recordType: 'report',
  tableName: 'reports',
  fieldPath: '$.fullReport',
  fieldName: 'fullReport',
  chunkOffset: 0,
  parentChunkId: '<main-chunk-id>',

  content: '<First 3000 chars of fullReport with 200 char overlap...>',

  filterableMetadata: {
    id: 99,  // Inherited
    fieldName: 'fullReport',
    chunkOffset: 0
  }
}

// Chunk 2 of fullReport (2800-5800 chars, 200 char overlap)
{
  chunkType: 'field',
  recordId: '99',
  recordType: 'report',
  tableName: 'reports',
  fieldPath: '$.fullReport',
  fieldName: 'fullReport',
  chunkOffset: 2800,
  parentChunkId: '<main-chunk-id>',

  content: '<Chars 2800-5800 of fullReport with overlap...>',

  filterableMetadata: {
    id: 99,
    fieldName: 'fullReport',
    chunkOffset: 2800
  }
}

// ... more chunks until end of fullReport
```

### JSON Mapping Algorithm

```typescript
interface JSONMappingConfig {
  maxRecordTokens: number; // 1000 - max tokens for entire record
  maxFieldTokens: number; // 500 - max tokens for single field before chunking
  chunkSize: number; // 800 - target chunk size for large fields
  chunkOverlap: number; // 200 - overlap between consecutive field chunks
  inlineThreshold: number; // 200 - inline fields smaller than this
  arrayElementThreshold: number; // 3 - inline arrays with <= N elements
}

async function mapJSONToChunks(
  jsonData: Record<string, any>,
  config: JSONMappingConfig,
  fieldRules: FieldClassificationRules,
): Promise<SearchChunk[]> {
  const chunks: SearchChunk[] = [];

  // Step 1: Classify fields
  const { filterable, embeddable, hybrid } = classifyFields(jsonData, fieldRules);

  // Step 2: Build embeddable content
  const embeddableContent = buildEmbeddableContent(jsonData, embeddable, hybrid);
  const contentTokens = estimateTokens(embeddableContent);

  // Step 3: Check if we need to chunk large fields
  if (contentTokens <= config.maxRecordTokens) {
    // Simple case: entire record fits in one chunk
    chunks.push(createRecordChunk(jsonData, filterable, embeddable, embeddableContent));
  } else {
    // Complex case: need field-level chunking
    const largeFields = findLargeFields(jsonData, embeddable, config.maxFieldTokens);

    // Create main record chunk (without large fields)
    const mainContent = buildEmbeddableContent(
      jsonData,
      embeddable.filter((f) => !largeFields.includes(f)),
      hybrid,
    );
    const mainChunk = createRecordChunk(jsonData, filterable, embeddable, mainContent);
    chunks.push(mainChunk);

    // Create field chunks for large fields
    for (const fieldName of largeFields) {
      const fieldValue = jsonData[fieldName];
      const fieldChunks = chunkLargeField(
        fieldName,
        fieldValue,
        mainChunk.recordId,
        mainChunk._id,
        config,
      );
      chunks.push(...fieldChunks);
    }
  }

  // Step 4: Handle arrays (if present)
  for (const [key, value] of Object.entries(jsonData)) {
    if (Array.isArray(value) && value.length > config.arrayElementThreshold) {
      const arrayChunks = mapArrayElements(key, value, jsonData, filterable, embeddable, config);
      chunks.push(...arrayChunks);
    }
  }

  return chunks;
}
```

---

## CSV Mapping

### Strategy

**Row-Level Chunking** (most common):

- Each row → one `SearchChunk` (if total row content < MAX_RECORD_TOKENS)
- Column headers → stored in `schemaMetadata`
- Row number → stored in `rowNumber` field
- Large cells → separate field chunks (linked via `parentChunkId`)

### Example 1: Simple CSV Table

**Input CSV**:

```csv
id,name,email,status,revenue,notes
1,Acme Corp,acme@example.com,active,1000000,Long-term partner with high satisfaction
2,Beta Inc,beta@example.com,inactive,500000,Former client considering re-engagement
3,Gamma LLC,gamma@example.com,active,750000,New customer with growth potential
```

**Table Schema Chunk** (optional, for table-level queries):

```typescript
{
  chunkType: 'table_schema',
  tableName: 'customers',
  recordType: 'table_metadata',

  content: 'Table: customers\nColumns: id, name, email, status, revenue, notes\nRow count: 3',

  schemaMetadata: {
    columns: [
      { name: 'id', type: 'integer', description: 'Customer ID' },
      { name: 'name', type: 'string', description: 'Company name' },
      { name: 'email', type: 'string', description: 'Contact email' },
      { name: 'status', type: 'enum', description: 'Account status', enumValues: ['active', 'inactive'] },
      { name: 'revenue', type: 'number', description: 'Annual revenue' },
      { name: 'notes', type: 'text', description: 'Customer notes' }
    ],
    rowCount: 3,
    primaryKey: 'id'
  }
}
```

**Row Chunks**:

```typescript
// Row 1 (Acme Corp)
{
  chunkType: 'record',
  recordId: '1',
  recordType: 'customer',
  tableName: 'customers',
  rowNumber: 1,

  content: 'Table: customers\nName: Acme Corp\nNotes: Long-term partner with high satisfaction',

  filterableMetadata: {
    id: 1,
    email: 'acme@example.com',
    status: 'active',
    revenue: 1000000
  },

  embeddableMetadata: {
    name: 'Acme Corp',
    notes: 'Long-term partner with high satisfaction'
  }
}

// Row 2 (Beta Inc)
{
  chunkType: 'record',
  recordId: '2',
  recordType: 'customer',
  tableName: 'customers',
  rowNumber: 2,

  content: 'Table: customers\nName: Beta Inc\nNotes: Former client considering re-engagement',

  filterableMetadata: {
    id: 2,
    email: 'beta@example.com',
    status: 'inactive',
    revenue: 500000
  },

  embeddableMetadata: {
    name: 'Beta Inc',
    notes: 'Former client considering re-engagement'
  }
}

// Row 3 (Gamma LLC)
{
  chunkType: 'record',
  recordId: '3',
  recordType: 'customer',
  tableName: 'customers',
  rowNumber: 3,

  content: 'Table: customers\nName: Gamma LLC\nNotes: New customer with growth potential',

  filterableMetadata: {
    id: 3,
    email: 'gamma@example.com',
    status: 'active',
    revenue: 750000
  },

  embeddableMetadata: {
    name: 'Gamma LLC',
    notes: 'New customer with growth potential'
  }
}
```

### Example 2: CSV with Large Cell

**Input CSV**:

```csv
id,product_name,short_desc,full_description
1,Widget Pro,"Premium widget","<5000 word detailed product description...>"
```

**Main Row Chunk**:

```typescript
{
  chunkType: 'record',
  recordId: '1',
  recordType: 'product',
  tableName: 'products',
  rowNumber: 1,

  content: 'Table: products\nProduct Name: Widget Pro\nShort Description: Premium widget',

  filterableMetadata: {
    id: 1,
    hasLargeContent: true
  },

  embeddableMetadata: {
    product_name: 'Widget Pro',
    short_desc: 'Premium widget'
  }
}
```

**Large Cell Chunks**:

```typescript
// Chunk 1 of full_description
{
  chunkType: 'field',
  recordId: '1',
  recordType: 'product',
  tableName: 'products',
  rowNumber: 1,
  fieldName: 'full_description',
  chunkOffset: 0,
  parentChunkId: '<main-chunk-id>',

  content: '<First 3000 chars of full_description with overlap...>',

  filterableMetadata: {
    id: 1,
    fieldName: 'full_description',
    chunkOffset: 0
  }
}

// More chunks for remaining content...
```

### CSV Mapping Algorithm

```typescript
interface CSVMappingConfig {
  hasHeader: boolean; // Does first row contain headers?
  delimiter: string; // ',' or '\t' or ';'
  maxRecordTokens: number; // 1000
  maxCellTokens: number; // 500
  chunkSize: number; // 800
  chunkOverlap: number; // 200
}

async function mapCSVToChunks(
  csvFilePath: string,
  config: CSVMappingConfig,
  fieldRules: FieldClassificationRules,
): Promise<SearchChunk[]> {
  const chunks: SearchChunk[] = [];

  // Step 1: Parse CSV and detect schema
  const { headers, rows } = await parseCSV(csvFilePath, config);
  const columnTypes = inferColumnTypes(rows, headers);

  // Step 2: Create optional table schema chunk
  const tableSchemaChunk = createTableSchemaChunk(headers, columnTypes, rows.length);
  chunks.push(tableSchemaChunk);

  // Step 3: Classify columns (filterable vs. embeddable)
  const { filterable, embeddable, hybrid } = classifyColumns(headers, columnTypes, fieldRules);

  // Step 4: Process each row
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    const rowData = Object.fromEntries(headers.map((h, i) => [h, row[i]]));

    // Build embeddable content for row
    const embeddableContent = buildRowContent(rowData, embeddable, hybrid);
    const contentTokens = estimateTokens(embeddableContent);

    // Check if any cell is too large
    const largeCells = findLargeCells(rowData, embeddable, config.maxCellTokens);

    if (largeCells.length === 0 && contentTokens <= config.maxRecordTokens) {
      // Simple case: entire row fits in one chunk
      chunks.push(createRowChunk(rowData, rowIndex + 1, filterable, embeddable, embeddableContent));
    } else {
      // Complex case: chunk large cells separately
      const mainContent = buildRowContent(
        rowData,
        embeddable.filter((col) => !largeCells.includes(col)),
        hybrid,
      );
      const mainChunk = createRowChunk(rowData, rowIndex + 1, filterable, embeddable, mainContent);
      chunks.push(mainChunk);

      // Create cell chunks for large cells
      for (const columnName of largeCells) {
        const cellValue = rowData[columnName];
        const cellChunks = chunkLargeCell(
          columnName,
          cellValue,
          rowData['id'] || rowIndex,
          mainChunk._id,
          rowIndex + 1,
          config,
        );
        chunks.push(...cellChunks);
      }
    }
  }

  return chunks;
}
```

---

## Excel Mapping

### Strategy

**Multi-Sheet Handling**:

- Each sheet → separate table namespace
- Sheet name → stored in `tableName` field
- Same row-level chunking as CSV per sheet
- Cross-sheet references → stored in `schemaMetadata.foreignKeys`

### Example: Multi-Sheet Excel Workbook

**Workbook Structure**:

- Sheet 1: "Customers" (100 rows, 8 columns)
- Sheet 2: "Orders" (500 rows, 10 columns)
- Sheet 3: "Products" (50 rows, 6 columns)

**Mapping Strategy**:

1. Each sheet → separate set of row chunks with unique `tableName`
2. Optional sheet metadata chunks for each sheet
3. Cross-sheet relationships via `foreignKeys` in schema

**Sheet Metadata Chunk** (Customers sheet):

```typescript
{
  chunkType: 'table_schema',
  tableName: 'Customers',
  recordType: 'sheet_metadata',

  content: 'Sheet: Customers\nColumns: CustomerID, Name, Email, Status, Revenue, Region, Created, Notes\nRow count: 100',

  schemaMetadata: {
    sheetName: 'Customers',
    sheetIndex: 0,
    columns: [
      { name: 'CustomerID', type: 'integer', description: 'Unique customer ID' },
      { name: 'Name', type: 'string', description: 'Company name' },
      { name: 'Email', type: 'string', description: 'Contact email' },
      { name: 'Status', type: 'enum', enumValues: ['active', 'inactive'] },
      { name: 'Revenue', type: 'number', description: 'Annual revenue' },
      { name: 'Region', type: 'enum', enumValues: ['US-West', 'US-East', 'EU', 'APAC'] },
      { name: 'Created', type: 'date', description: 'Account creation date' },
      { name: 'Notes', type: 'text', description: 'Customer notes' }
    ],
    rowCount: 100,
    primaryKey: 'CustomerID'
  }
}
```

**Row Chunk** (from Customers sheet):

```typescript
{
  chunkType: 'record',
  recordId: '12345',
  recordType: 'customer',
  tableName: 'Customers',
  sheetName: 'Customers',
  rowNumber: 5,

  content: 'Sheet: Customers\nName: Acme Corp\nRegion: US-West\nNotes: Long-term partner with high satisfaction',

  filterableMetadata: {
    CustomerID: 12345,
    Email: 'acme@example.com',
    Status: 'active',
    Revenue: 1000000,
    Region: 'US-West',
    Created: '2020-01-15'
  },

  embeddableMetadata: {
    Name: 'Acme Corp',
    Notes: 'Long-term partner with high satisfaction'
  }
}
```

**Sheet Metadata Chunk** (Orders sheet):

```typescript
{
  chunkType: 'table_schema',
  tableName: 'Orders',
  recordType: 'sheet_metadata',

  content: 'Sheet: Orders\nColumns: OrderID, CustomerID, OrderDate, Amount, Status, ShippingAddress, Product, Quantity\nRow count: 500',

  schemaMetadata: {
    sheetName: 'Orders',
    sheetIndex: 1,
    columns: [
      { name: 'OrderID', type: 'string', description: 'Unique order ID' },
      { name: 'CustomerID', type: 'integer', description: 'Foreign key to Customers' },
      { name: 'OrderDate', type: 'date', description: 'Order placement date' },
      { name: 'Amount', type: 'number', description: 'Total order amount' },
      { name: 'Status', type: 'enum', enumValues: ['pending', 'shipped', 'delivered', 'cancelled'] },
      { name: 'ShippingAddress', type: 'text', description: 'Delivery address' },
      { name: 'Product', type: 'string', description: 'Product name' },
      { name: 'Quantity', type: 'integer', description: 'Order quantity' }
    ],
    rowCount: 500,
    primaryKey: 'OrderID',
    foreignKeys: [
      { field: 'CustomerID', references: 'Customers.CustomerID' }
    ]
  }
}
```

**Row Chunk** (from Orders sheet):

```typescript
{
  chunkType: 'record',
  recordId: 'ORD-789',
  recordType: 'order',
  tableName: 'Orders',
  sheetName: 'Orders',
  rowNumber: 42,

  content: 'Sheet: Orders\nOrder ID: ORD-789\nProduct: Widget Pro\nQuantity: 10\nShipping: 123 Main St, San Francisco, CA 94102',

  filterableMetadata: {
    OrderID: 'ORD-789',
    CustomerID: 12345,  // Foreign key
    OrderDate: '2025-12-15',
    Amount: 299.90,
    Status: 'shipped',
    Quantity: 10
  },

  embeddableMetadata: {
    Product: 'Widget Pro',
    ShippingAddress: '123 Main St, San Francisco, CA 94102'
  }
}
```

### Excel-Specific Considerations

**Formulas**:

- Store evaluated value, not formula (unless formula is semantically meaningful)
- Option: Store formula in `metadata` for audit trail

**Cell Formatting**:

- Extract formatted value (e.g., "$1,000.00" → store both `1000` for filtering and "$1,000.00" for display)
- Date formatting: normalize to ISO 8601

**Merged Cells**:

- Store value on first cell, mark others as merged references

**Charts/Images**:

- Extract as separate image artifacts (not covered here, see image extraction task)

**Named Ranges**:

- Store in `schemaMetadata.namedRanges` for cross-reference

### Excel Mapping Algorithm

```typescript
interface ExcelMappingConfig {
  maxRecordTokens: number; // 1000
  maxCellTokens: number; // 500
  chunkSize: number; // 800
  chunkOverlap: number; // 200
  extractFormulas: boolean; // Store formulas in metadata?
}

async function mapExcelToChunks(
  excelFilePath: string,
  config: ExcelMappingConfig,
  fieldRules: FieldClassificationRules,
): Promise<SearchChunk[]> {
  const chunks: SearchChunk[] = [];

  // Step 1: Parse Excel workbook
  const workbook = await parseExcel(excelFilePath);

  // Step 2: Process each sheet
  for (const sheet of workbook.sheets) {
    const { name, headers, rows, columnTypes } = await parseSheet(sheet);

    // Step 3: Create sheet metadata chunk
    const sheetMetadata = createSheetMetadataChunk(
      name,
      headers,
      columnTypes,
      rows.length,
      detectForeignKeys(sheet, workbook),
    );
    chunks.push(sheetMetadata);

    // Step 4: Classify columns
    const { filterable, embeddable, hybrid } = classifyColumns(headers, columnTypes, fieldRules);

    // Step 5: Process each row (same logic as CSV)
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex];
      const rowData = Object.fromEntries(headers.map((h, i) => [h, row[i]]));

      // Check for large cells
      const largeCells = findLargeCells(rowData, embeddable, config.maxCellTokens);

      if (largeCells.length === 0) {
        // Simple case: entire row fits
        const content = buildRowContent(rowData, embeddable, hybrid);
        chunks.push(
          createRowChunk(
            rowData,
            rowIndex + 1,
            filterable,
            embeddable,
            content,
            name, // Sheet name
          ),
        );
      } else {
        // Complex case: chunk large cells
        const mainContent = buildRowContent(
          rowData,
          embeddable.filter((col) => !largeCells.includes(col)),
          hybrid,
        );
        const mainChunk = createRowChunk(
          rowData,
          rowIndex + 1,
          filterable,
          embeddable,
          mainContent,
          name,
        );
        chunks.push(mainChunk);

        // Create cell chunks
        for (const columnName of largeCells) {
          const cellValue = rowData[columnName];
          const cellChunks = chunkLargeCell(
            columnName,
            cellValue,
            rowData['id'] || rowIndex,
            mainChunk._id,
            rowIndex + 1,
            config,
          );
          chunks.push(...cellChunks);
        }
      }
    }
  }

  return chunks;
}
```

---

## Retrieval Patterns

### Pattern 1: Exact Match (Filterable Fields)

**Query**: "Find customers with revenue > $500,000"

**Strategy**: Filter-only, no vector search

```typescript
db.searchChunks.find({
  tenantId: 'tenant-123',
  indexId: 'index-456',
  chunkType: 'record',
  tableName: 'customers',
  'filterableMetadata.revenue': { $gte: 500000 },
});
```

### Pattern 2: Semantic Search (Embeddable Fields)

**Query**: "Find customers in technology sector"

**Strategy**: Vector search on embeddable content

```typescript
// Step 1: Generate query embedding
const queryEmbedding = await embedText('Find customers in technology sector');

// Step 2: Vector similarity search
const results = await vectorStore.search({
  tenantId: 'tenant-123',
  indexId: 'index-456',
  embedding: queryEmbedding,
  filter: {
    chunkType: 'record',
    tableName: 'customers',
  },
  topK: 20,
});
```

### Pattern 3: Hybrid Query (Filter + Semantic)

**Query**: "Find active customers interested in AI"

**Strategy**: Filter + vector search

```typescript
// Step 1: Generate query embedding
const queryEmbedding = await embedText('customers interested in AI');

// Step 2: Hybrid search (filter + vector)
const results = await vectorStore.search({
  tenantId: 'tenant-123',
  indexId: 'index-456',
  embedding: queryEmbedding,
  filter: {
    chunkType: 'record',
    tableName: 'customers',
    'filterableMetadata.status': 'active', // Exact filter
  },
  topK: 20,
});
```

### Pattern 4: Hierarchical Query (Retrieve Parent + Children)

**Query**: "Find order ORD-789 with all line items"

**Strategy**: Retrieve parent chunk → fetch children

```typescript
// Step 1: Find parent chunk
const parentChunk = await db.searchChunks.findOne({
  tenantId: 'tenant-123',
  indexId: 'index-456',
  chunkType: 'record',
  recordId: 'ORD-789',
});

// Step 2: Fetch child chunks (array elements, large fields)
const childChunks = await db.searchChunks.find({
  tenantId: 'tenant-123',
  indexId: 'index-456',
  parentChunkId: parentChunk._id,
});

// Step 3: Reconstruct full record
const fullRecord = reconstructRecord(parentChunk, childChunks);
```

### Pattern 5: Cross-Table Query (Join)

**Query**: "Find all orders for customer 'Acme Corp'"

**Strategy**: Two-stage retrieval

```typescript
// Step 1: Find customer by name (semantic search)
const customerResults = await vectorStore.search({
  tenantId: 'tenant-123',
  indexId: 'index-456',
  embedding: await embedText('Acme Corp'),
  filter: {
    chunkType: 'record',
    tableName: 'Customers',
  },
  topK: 1,
});

const customerId = customerResults[0].filterableMetadata.CustomerID;

// Step 2: Find orders by CustomerID (filter)
const orderResults = await db.searchChunks.find({
  tenantId: 'tenant-123',
  indexId: 'index-456',
  chunkType: 'record',
  tableName: 'Orders',
  'filterableMetadata.CustomerID': customerId,
});
```

---

## Summary

| Format    | Main Chunk Granularity | Large Field Handling              | Array Handling                    | Cross-References                |
| --------- | ---------------------- | --------------------------------- | --------------------------------- | ------------------------------- |
| **JSON**  | Object/record          | Chunk + Link (parentChunkId)      | Array elements as separate chunks | JSON path ($.parent.child)      |
| **CSV**   | Row                    | Chunk large cells (parentChunkId) | N/A (flat structure)              | Foreign keys in metadata        |
| **Excel** | Row per sheet          | Chunk large cells (parentChunkId) | N/A (flat structure)              | Foreign keys + sheet references |

**Key Takeaways**:

1. **Filterable vs. Embeddable** is the critical design decision
2. **Row-level chunking** is the default for tables
3. **Large fields** use Chunk + Link pattern with `parentChunkId`
4. **Arrays** get individual chunks for granular retrieval
5. **Hybrid queries** (filter + semantic) provide best retrieval quality

**Next Steps** (Task #21): Design chunking strategy for large structured content fields with concrete token limits and overlap logic.
