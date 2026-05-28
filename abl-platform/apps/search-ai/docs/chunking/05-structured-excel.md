# Excel Spreadsheets - Multi-Sheet Processing

**Applies To:** Excel (.xlsx, .xls), Google Sheets exports
**Strategy:** One sheet = one table (metadata-only chunking per sheet)
**Worker:** `structured-data-ingestion-worker.ts`

---

## Overview

Excel spreadsheets are processed as **collections of CSV tables** — one table per sheet. Each sheet follows the exact same pipeline as CSV files, using metadata-only chunking for 99.9% chunk reduction.

**Architecture:**

```
Excel File → Parse Sheets → For Each Sheet → CSV Pipeline
     ↓            ↓               ↓                ↓
  Multiple     Sheet 1         Treat as        Same as CSV
  sheets       Sheet 2         separate         (1 metadata
               Sheet 3         table           chunk per sheet)
```

**Key Concept:** **1 Sheet = 1 Table = 1 Metadata Chunk**

---

## Multi-Sheet Processing

### Pipeline Overview

```
┌─────────────────────────┐
│ 1. Parse Excel File     │ → Extract all sheets
└──────────┬──────────────┘
           │
           ▼
┌─────────────────────────┐
│ 2. For Each Sheet:      │
│                         │
│    a. Extract rows      │ → Parse sheet data
│    b. Analyze schema    │ → Type detection, FK detection
│    c. Create metadata   │ → 1 chunk per sheet
│       chunk             │
│    d. Store in          │ → ClickHouse storage
│       ClickHouse        │
│    e. Embed metadata    │ → Vector embedding
└──────────┬──────────────┘
           │
           ▼
┌─────────────────────────┐
│ 3. Detect Cross-Sheet   │ → Find relationships between sheets
│    Foreign Keys         │
└─────────────────────────┘
```

---

## Stage 1: Excel Parsing

**Library:** `exceljs` or `xlsx`

**Process:**

1. **Load Excel File**

   ```typescript
   import * as Excel from 'exceljs';

   const workbook = new Excel.Workbook();
   await workbook.xlsx.load(fileBuffer);
   ```

2. **Extract All Sheets**

   ```typescript
   const sheets: ParsedTable[] = [];

   workbook.eachSheet((worksheet, sheetId) => {
     const sheetName = worksheet.name;
     const rows: any[][] = [];

     // Extract rows
     worksheet.eachRow((row, rowNumber) => {
       if (rowNumber === 1) {
         // First row = headers
         headers = row.values as string[];
       } else {
         // Data rows
         rows.push(row.values);
       }
     });

     sheets.push({
       headers,
       rows,
       format: 'excel',
       metadata: {
         sheetName,
         sheetIndex: sheetId,
       },
     });
   });
   ```

3. **Validate Sheet Data**

   ```typescript
   for (const sheet of sheets) {
     // Skip empty sheets
     if (sheet.rows.length === 0) {
       console.warn(`Sheet "${sheet.metadata.sheetName}" is empty, skipping`);
       continue;
     }

     // Validate headers
     if (!sheet.headers || sheet.headers.length === 0) {
       throw new Error(`Sheet "${sheet.metadata.sheetName}" has no headers`);
     }
   }
   ```

---

## Stage 2: Per-Sheet Processing

**Each sheet is processed as an independent CSV table.**

**For complete details, see:** [CSV Tables Guide](./02-structured-csv.md)

### Processing Steps (Per Sheet)

1. **Schema Analysis**
   - Detect column types (integer, decimal, string, date, boolean, enum)
   - Calculate statistics (uniqueCount, nullCount, avgLength)
   - Identify primary key candidates
   - Mark embeddable and filterable columns

2. **Foreign Key Detection (Within Sheet)**
   - Detect `*_id` columns
   - Validate against other sheets (if available)

3. **Metadata Chunking**
   - Create 1 metadata chunk per sheet
   - Include: schema, sample rows (10-20), statistics
   - No individual row chunks

4. **ClickHouse Storage**
   - Store all rows in `structured_data` table
   - Table ID per sheet: `${fileId}_${sheetName}`
   - Store metadata in `table_metadata` table

5. **Embedding**
   - Generate embedding for metadata chunk
   - Enable semantic table discovery per sheet

---

## Stage 3: Cross-Sheet Foreign Key Detection

**Purpose:** Detect relationships between sheets (e.g., Orders.user_id → Users.id)

**Process:**

1. **Identify FK Candidate Columns**

   ```typescript
   for (const sheet of sheets) {
     for (const column of sheet.columns) {
       // Look for *_id columns
       if (column.name.endsWith('_id') && column.type === 'integer') {
         // Check if referenced table exists as a sheet
         const baseName = column.name.replace(/_id$/, '');
         const targetSheetName = pluralize(baseName); // user → users

         const targetSheet = sheets.find(
           (s) => s.metadata.sheetName.toLowerCase() === targetSheetName.toLowerCase(),
         );

         if (targetSheet) {
           // Validate FK relationship
           const validation = await validateForeignKey(
             sheet.rows,
             column.name,
             targetSheet.rows,
             'id',
           );

           if (validation.matchRate >= 0.9) {
             foreignKeys.push({
               sourceSheet: sheet.metadata.sheetName,
               sourceField: column.name,
               targetSheet: targetSheet.metadata.sheetName,
               targetField: 'id',
               confidence: validation.matchRate,
               detectionMethod: 'naming_convention + validation',
             });
           }
         }
       }
     }
   }
   ```

2. **Store Cross-Sheet Relationships**

   ```typescript
   // Update metadata chunks with FK information
   for (const fk of foreignKeys) {
     const sourceChunk = await SearchChunk.findOne({
       tenantId,
       indexId,
       'metadata.tableName': fk.sourceSheet,
     });

     const metadata = JSON.parse(sourceChunk.content);
     metadata.foreignKeys.push(fk);

     await sourceChunk.updateOne({
       content: JSON.stringify(metadata),
     });
   }
   ```

---

## Examples

### Example 1: E-commerce Workbook (3 sheets, 55K total rows)

**Input:** `ecommerce.xlsx`

**Sheets:**

1. **Users** (5,000 rows, 6 columns)
   - Columns: `id`, `name`, `email`, `created_at`, `status`, `country`

2. **Orders** (40,000 rows, 8 columns)
   - Columns: `order_id`, `user_id`, `product_id`, `quantity`, `price`, `total`, `status`, `created_at`

3. **Products** (10,000 rows, 7 columns)
   - Columns: `id`, `name`, `category`, `price`, `stock`, `sku`, `active`

**Foreign Keys Detected:**

- `Orders.user_id` → `Users.id` (98.5% match rate)
- `Orders.product_id` → `Products.id` (99.2% match rate)

**Processing:**

- **Time:** 8 seconds total
  - Sheet 1 (Users): 1.5s
  - Sheet 2 (Orders): 4.5s (largest)
  - Sheet 3 (Products): 2s
- **Chunks Created:** 3 (1 per sheet)
- **Embeddings:** 3
- **Storage:**
  - MongoDB: 3 SearchChunks (~15 KB)
  - ClickHouse: 55K rows (~8 MB compressed), 3 metadata rows

**Cost:**

- Embeddings: $0.003 (3 chunks)
- **vs Naive approach**: $27.50 (55K chunks)
- **Savings:** 99.989%

**Query Examples:**

**Q1:** "Find all orders for user with email alice@example.com"

```sql
SELECT
  o.order_id,
  o.product_id,
  o.total,
  o.created_at
FROM structured_data o
INNER JOIN structured_data u ON
  JSON_EXTRACT(o.row_data, '$.user_id') = JSON_EXTRACT(u.row_data, '$.id')
WHERE o.tenant_id = ? AND o.index_id = ?
  AND o.table_id = 'ecommerce_Orders'
  AND u.table_id = 'ecommerce_Users'
  AND JSON_EXTRACT(u.row_data, '$.email') = 'alice@example.com'
```

**Execution:** 45ms (2-table JOIN across 45K rows)

**Q2:** "What's the total revenue by product category?"

```sql
SELECT
  JSON_EXTRACT(p.row_data, '$.category') as category,
  SUM(CAST(JSON_EXTRACT(o.row_data, '$.total') AS Float64)) as revenue
FROM structured_data o
INNER JOIN structured_data p ON
  JSON_EXTRACT(o.row_data, '$.product_id') = JSON_EXTRACT(p.row_data, '$.id')
WHERE o.tenant_id = ? AND o.index_id = ?
  AND o.table_id = 'ecommerce_Orders'
  AND p.table_id = 'ecommerce_Products'
GROUP BY category
ORDER BY revenue DESC
```

**Execution:** 120ms (aggregation + JOIN)

**Q3:** Semantic query: "Show me products that are running low on stock"

```typescript
// Table discovery finds Products sheet
// Text-to-SQL generates:
SELECT *
FROM structured_data
WHERE tenant_id = ? AND index_id = ?
  AND table_id = 'ecommerce_Products'
  AND CAST(JSON_EXTRACT(row_data, '$.stock') AS Int32) < 10
ORDER BY CAST(JSON_EXTRACT(row_data, '$.stock') AS Int32) ASC
```

---

### Example 2: Financial Report (5 sheets, 100K rows)

**Input:** `quarterly_report.xlsx`

**Sheets:**

1. **Transactions** (80,000 rows)
2. **Accounts** (10,000 rows)
3. **Categories** (50 rows)
4. **Summary** (12 rows - monthly aggregates)
5. **Metadata** (5 rows - report info)

**Processing:**

- **Time:** 15 seconds
- **Chunks:** 5 (1 per sheet)
- **Storage:** ~12 MB
- **Cost:** $0.005
- **vs Naive:** $50
- **Savings:** 99.99%

**Cross-Sheet Queries:**

"Find all transactions in category 'Travel' for account 'Corporate Card'"

```sql
SELECT
  t.transaction_id,
  t.amount,
  t.date,
  t.description
FROM structured_data t
INNER JOIN structured_data a ON
  JSON_EXTRACT(t.row_data, '$.account_id') = JSON_EXTRACT(a.row_data, '$.id')
INNER JOIN structured_data c ON
  JSON_EXTRACT(t.row_data, '$.category_id') = JSON_EXTRACT(c.row_data, '$.id')
WHERE t.table_id = 'report_Transactions'
  AND a.table_id = 'report_Accounts'
  AND c.table_id = 'report_Categories'
  AND JSON_EXTRACT(a.row_data, '$.name') = 'Corporate Card'
  AND JSON_EXTRACT(c.row_data, '$.name') = 'Travel'
```

**Execution:** 180ms (3-table JOIN)

---

### Example 3: Inventory System (10 sheets, 500K rows)

**Input:** `inventory.xlsx` (large multi-sheet workbook)

**Sheets:**

- Warehouses (10 rows)
- Locations (500 rows)
- Products (50,000 rows)
- Inventory (400,000 rows)
- Suppliers (1,000 rows)
- PurchaseOrders (30,000 rows)
- Shipments (15,000 rows)
- Returns (3,000 rows)
- AuditLog (1,000 rows)
- Config (5 rows)

**Processing:**

- **Time:** 45 seconds
- **Chunks:** 10 (1 per sheet)
- **Storage:** ~50 MB
- **Cost:** $0.010
- **vs Naive:** $250
- **Savings:** 99.996%

**Foreign Keys Detected:** 12 relationships across sheets

**Complex Query:** "Find products with low inventory across all warehouses"

```sql
SELECT
  p.product_id,
  p.name,
  w.name as warehouse,
  i.quantity,
  i.reorder_point
FROM structured_data i
INNER JOIN structured_data p ON
  JSON_EXTRACT(i.row_data, '$.product_id') = JSON_EXTRACT(p.row_data, '$.id')
INNER JOIN structured_data w ON
  JSON_EXTRACT(i.row_data, '$.warehouse_id') = JSON_EXTRACT(w.row_data, '$.id')
WHERE i.table_id = 'inventory_Inventory'
  AND p.table_id = 'inventory_Products'
  AND w.table_id = 'inventory_Warehouses'
  AND CAST(JSON_EXTRACT(i.row_data, '$.quantity') AS Int32) <
      CAST(JSON_EXTRACT(i.row_data, '$.reorder_point') AS Int32)
```

**Execution:** 350ms (3-table JOIN, 450K row scan with filter)

---

## Performance Characteristics

### Per-Sheet Performance

| Sheet Size    | Parse Time | Schema Analysis | ClickHouse Insert | Chunk + Embed | Total Time |
| ------------- | ---------- | --------------- | ----------------- | ------------- | ---------- |
| **100 rows**  | 0.05s      | 0.1s            | 0.02s             | 0.05s         | 0.22s      |
| **1K rows**   | 0.1s       | 0.2s            | 0.05s             | 0.05s         | 0.4s       |
| **10K rows**  | 0.5s       | 0.5s            | 0.2s              | 0.05s         | 1.25s      |
| **100K rows** | 2.5s       | 1.5s            | 1.5s              | 0.1s          | 5.6s       |

### Multi-Sheet Performance

| Workbook       | Sheets | Total Rows | Processing Time | Chunks | Cost   |
| -------------- | ------ | ---------- | --------------- | ------ | ------ |
| **Small**      | 3      | 5K         | 2s              | 3      | $0.003 |
| **Medium**     | 5      | 50K        | 10s             | 5      | $0.005 |
| **Large**      | 10     | 500K       | 45s             | 10     | $0.010 |
| **Very Large** | 20     | 2M         | 180s            | 20     | $0.020 |

**Note:** Processing is parallelizable — sheets can be processed concurrently for faster throughput.

### Cross-Sheet Query Performance

| Query Type              | Sheets Joined | Row Scan | Execution Time |
| ----------------------- | ------------- | -------- | -------------- |
| **Simple SELECT**       | 1             | 10K      | 15ms           |
| **2-table JOIN**        | 2             | 50K      | 60ms           |
| **3-table JOIN**        | 3             | 100K     | 150ms          |
| **Aggregation + JOIN**  | 2             | 200K     | 250ms          |
| **Complex (4+ tables)** | 4+            | 500K+    | 500ms+         |

---

## Configuration

**Same as CSV** (see [CSV Tables Guide](./02-structured-csv.md), Configuration section)

```typescript
{
  excel: {
    parseFormulas: boolean;        // Default: false (values only)
    skipEmptySheets: boolean;      // Default: true
    maxSheets: number;             // Default: 50 (safety limit)
    headerRow: number;             // Default: 1 (first row)
  },
  chunking: {
    strategy: 'metadata-only',     // Always metadata-only
    sampleRowCount: 20             // Per sheet
  },
  foreignKeys: {
    autoDetect: true,
    detectCrossSheet: boolean;     // Default: true
    minMatchRate: 0.9
  }
}
```

---

## Excel-Specific Features

### 1. Formula Handling

**Problem:** Excel cells can contain formulas (e.g., `=SUM(A1:A10)`).

**Solution:**

```typescript
{
  excel: {
    parseFormulas: false; // Default: store computed values only
  }
}
```

**Options:**

- `false` (default): Store computed values (`123.45`)
- `true`: Store formula text (`=SUM(A1:A10)`)

**Recommendation:** Use `false` for data analysis (store values, not formulas).

### 2. Empty Sheet Handling

**Problem:** Excel files often have empty or template sheets.

**Solution:**

```typescript
{
  excel: {
    skipEmptySheets: true; // Default: skip sheets with no data
  }
}
```

**Detection:**

- Sheet with no rows: skip
- Sheet with only headers: skip
- Sheet with 1+ data rows: process

### 3. Multi-Sheet Workbook Size Limits

**Problem:** Very large Excel files (100+ sheets, 10M+ rows) can cause memory issues.

**Solution:**

```typescript
{
  excel: {
    maxSheets: 50,         // Limit to first 50 sheets
    maxRowsPerSheet: 1000000  // Limit to 1M rows per sheet
  }
}
```

**Recommendation:**

- For workbooks >50 sheets: split into multiple files
- For sheets >1M rows: export as CSV (more efficient)

### 4. Sheet Name as Table Name

**Naming Convention:**

```
Excel: "User Orders" (sheet name)
→ Table Name: "user_orders" (snake_case, sanitized)
→ Display Name: "User Orders" (original name)
→ Table ID: "${fileId}_user_orders"
```

**Sanitization Rules:**

- Remove special characters: `#`, `$`, `%`, `&`, etc.
- Replace spaces with underscores: `User Orders` → `user_orders`
- Lowercase: `UserOrders` → `userorders`
- Deduplicate: `Orders`, `orders`, `ORDERS` → all become `orders_1`, `orders_2`, `orders_3`

---

## Troubleshooting

### Issue: Sheet Not Detected

**Problem:** Excel sheet not appearing in ingestion results.

**Solution:**

1. **Check if sheet is empty**: Empty sheets are skipped by default
2. **Check headers**: First row must contain column names
3. **Check sheet visibility**: Hidden sheets are processed unless explicitly excluded
4. **Check maxSheets limit**: Increase if workbook has >50 sheets

### Issue: Foreign Key Not Detected Between Sheets

**Problem:** Expected cross-sheet FK not found.

**Solution:**

1. **Check naming convention**: FK column must be `{table}_id` (e.g., `user_id`)
2. **Check target sheet name**: Must match pluralized FK base (e.g., `user_id` → `Users` or `users`)
3. **Check match rate**: Must be ≥90% for validation to pass
4. **Manual override**: Add FK in finalize phase if auto-detection fails

### Issue: Cross-Sheet Query Slow

**Problem:** JOIN query across sheets taking >1 second.

**Solution:**

1. **Add WHERE filters**: Filter before JOIN (reduces row scan)
2. **Limit result set**: Use LIMIT to reduce result size
3. **Check cardinality**: Large-to-large JOINs (100K × 100K) will be slow
4. **Consider materialized views**: Pre-compute common JOINs in ClickHouse

### Issue: Excel Formulas Not Working

**Problem:** Formula values showing as `#REF!` or `#VALUE!`

**Solution:**

1. **Set parseFormulas: false**: Store computed values, not formulas
2. **Open in Excel and recalculate**: Some formulas need manual recalc
3. **Export as CSV**: If formulas are problematic, export sheet as CSV first

### All Other Issues

**See:** [CSV Tables Guide - Troubleshooting](./02-structured-csv.md#troubleshooting)

All CSV troubleshooting applies to Excel:

- Type detection issues
- Text-to-SQL problems
- Query performance optimization
- Table discovery issues

---

## Related Documentation

- [CSV Tables Guide](./02-structured-csv.md) - **PRIMARY REFERENCE** for per-sheet processing
- [JSON Tabular Guide](./04-structured-json-tabular.md) - Similar multi-table concept
- [Architecture Overview](./10-architecture-overview.md) - Full system architecture
- [Retrieval Checklist](./20-retrieval-checklist.md) - Optimization guide

---

## Key Takeaways

**1. One Sheet = One Table = One Chunk**

- Each sheet processed independently
- Metadata-only chunking per sheet
- 99.9% chunk reduction applies per sheet

**2. Cross-Sheet Relationships Detected Automatically**

- FK detection works across sheets
- Enables multi-sheet JOINs
- 90%+ match rate required for validation

**3. Excel Processing = CSV Processing × N**

- Each sheet follows CSV pipeline exactly
- Can process sheets in parallel for speed
- Total cost = $0.001 × number of sheets

**4. Large Workbooks Supported**

- Tested up to 20 sheets, 2M rows
- Memory efficient (streaming parser)
- Scales linearly with sheet count and row count

**5. Formula Handling is Configurable**

- Default: store computed values (recommended)
- Option: store formula text (rarely needed)
- Avoid formulas with external references

**6. Cross-Sheet Queries Work Great**

- 2-table JOIN: <100ms for 50K rows
- 3-table JOIN: <200ms for 100K rows
- Text-to-SQL handles JOINs automatically

---

## Best Practices

1. **Name sheets clearly**: Use descriptive sheet names (becomes table name)
2. **Consistent naming**: Use same PK/FK naming across sheets (`id`, `user_id`)
3. **One header row**: First row should be column names
4. **No merged cells**: Keep data in standard tabular format
5. **Remove empty rows**: Clean up data before export
6. **Limit sheet count**: <20 sheets per workbook for best performance
7. **Split large datasets**: If >500K rows per sheet, consider splitting
8. **Use computed values**: Set `parseFormulas: false` for data analysis

---

**Next:** [Architecture Overview](./10-architecture-overview.md) →
