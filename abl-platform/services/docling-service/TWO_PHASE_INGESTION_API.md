# Two-Phase Ingestion API Design

**Date**: 2026-02-23
**Purpose**: Allow users to review and approve auto-detected schema before finalizing ingestion

## Problem Statement

Auto-detection of schemas, foreign keys, and field classifications can have errors:

- Primary key detection might be wrong (e.g., detecting `order_number` instead of `order_id`)
- Foreign key detection might find false positives (e.g., `year` column matches `customer_id` values by coincidence)
- Field classification might misclassify (e.g., `address` detected as filterable-only instead of embeddable)

**Solution**: Two-phase API where Phase 1 analyzes and returns schema, Phase 2 finalizes ingestion after user review.

---

## API Design

### Phase 1: Schema Analysis (Review Mode)

**Purpose**: Upload file, analyze schema, return detected metadata for user review WITHOUT creating chunks or embeddings.

```typescript
POST /api/v1/indexes/:indexId/ingest/analyze

Headers:
  Authorization: Bearer <token>
  Content-Type: multipart/form-data

Request Body:
  file: <binary>
  options: {
    detectForeignKeys: true,
    sampleRowCount: 10  // Number of sample rows to return
  }

Response (200 OK):
{
  "analysisId": "analysis_abc123",  // Use this ID in Phase 2
  "format": "csv",
  "filename": "customers.csv",
  "tables": [
    {
      "tableName": "customers",
      "rowCount": 1523,
      "columns": [
        {
          "name": "id",
          "type": "number",
          "nullable": false,
          "unique": true,
          "enumValues": null,
          "isFilterable": true,
          "isEmbeddable": false,
          "description": "Customer ID",
          "confidence": 1.0,  // Confidence in type detection (0.0-1.0)
          "suggestedCorrections": []  // Alternative classifications
        },
        {
          "name": "name",
          "type": "string",
          "nullable": false,
          "unique": false,
          "enumValues": null,
          "isFilterable": true,
          "isEmbeddable": true,
          "description": "Customer name",
          "confidence": 0.95,
          "suggestedCorrections": []
        },
        {
          "name": "status",
          "type": "string",
          "nullable": false,
          "unique": false,
          "enumValues": ["active", "inactive", "pending"],
          "isFilterable": true,
          "isEmbeddable": false,
          "description": "Account status",
          "confidence": 1.0,
          "suggestedCorrections": []
        },
        {
          "name": "revenue",
          "type": "number",
          "nullable": true,
          "unique": false,
          "enumValues": null,
          "isFilterable": true,
          "isEmbeddable": false,
          "description": "Annual revenue",
          "confidence": 1.0,
          "suggestedCorrections": []
        },
        {
          "name": "description",
          "type": "string",
          "nullable": true,
          "unique": false,
          "enumValues": null,
          "isFilterable": false,
          "isEmbeddable": true,
          "description": "Company description",
          "confidence": 0.9,
          "suggestedCorrections": [
            {
              "field": "isFilterable",
              "suggestedValue": true,
              "reason": "Short descriptions (< 100 chars) can be filterable"
            }
          ]
        }
      ],
      "primaryKey": {
        "detected": "id",
        "confidence": 1.0,
        "alternatives": []
      },
      "sampleData": [
        {
          "id": 1,
          "name": "Acme Corp",
          "status": "active",
          "revenue": 1000000,
          "description": "Technology company specializing in AI solutions."
        },
        // ... 9 more sample rows
      ]
    }
  ],
  "foreignKeyDetections": [
    {
      "sourceTable": "orders",
      "sourceField": "customer_id",
      "targetTable": "customers",
      "targetField": "id",
      "confidence": 0.85,
      "detectionMethod": "naming_convention",
      "sampleMatches": [
        {"sourceValue": 12345, "targetValue": 12345, "matched": true},
        {"sourceValue": 67890, "targetValue": 67890, "matched": true}
      ],
      "issues": []  // Potential problems (e.g., "3% of values don't match")
    }
  ],
  "recommendations": [
    {
      "type": "warning",
      "message": "Column 'customer_id' has 3% null values - consider marking as nullable",
      "table": "orders",
      "column": "customer_id"
    },
    {
      "type": "info",
      "message": "Table 'customers' has a large 'notes' column (avg 5000 chars) - will be chunked",
      "table": "customers",
      "column": "notes"
    }
  ],
  "estimatedCosts": {
    "totalChunks": 2500,  // Estimated chunks to be created
    "embeddingTokens": 1200000,  // Total tokens for embeddings
    "estimatedEmbeddingCost": "$0.12",  // Based on OpenAI pricing
    "estimatedStorageMB": 45
  }
}
```

### Phase 2: Finalize Ingestion (Approved Schema)

**Purpose**: User reviews Phase 1 response, makes corrections, then submits for final ingestion.

```typescript
POST /api/v1/indexes/:indexId/ingest/finalize

Headers:
  Authorization: Bearer <token>
  Content-Type: application/json

Request Body:
{
  "analysisId": "analysis_abc123",  // From Phase 1
  "approvedSchema": {
    "tables": [
      {
        "tableName": "customers",
        "columns": [
          {
            "name": "id",
            "type": "number",
            "nullable": false,
            "unique": true,
            "isFilterable": true,
            "isEmbeddable": false
          },
          {
            "name": "name",
            "type": "string",
            "nullable": false,
            "isFilterable": true,
            "isEmbeddable": true
          },
          {
            "name": "status",
            "type": "string",
            "nullable": false,
            "isFilterable": true,
            "isEmbeddable": false,
            "enumValues": ["active", "inactive", "pending"]
          },
          {
            "name": "revenue",
            "type": "number",
            "nullable": true,
            "isFilterable": true,
            "isEmbeddable": false
          },
          {
            "name": "description",
            "type": "string",
            "nullable": true,
            "isFilterable": false,
            "isEmbeddable": true
          }
        ],
        "primaryKey": "id"
      }
    ],
    "foreignKeys": [
      {
        "sourceTable": "orders",
        "sourceField": "customer_id",
        "targetTable": "customers",
        "targetField": "id"
      }
    ]
  },
  "options": {
    "generateEmbeddings": true,
    "deduplicateContent": true,
    "includeTableMetadata": true,
    "chunkingStrategy": "smart"  // 'all_rows', 'smart', 'sample_only'
  }
}

Response (202 Accepted - Async Job):
{
  "jobId": "job_xyz789",
  "status": "processing",
  "estimatedDurationMs": 45000,
  "statusUrl": "/api/v1/jobs/job_xyz789/status"
}

Response (200 OK - when complete):
{
  "success": true,
  "documentId": "doc_123",
  "chunksCreated": 2487,
  "relationshipsCreated": 543,
  "embeddingsGenerated": 2487,
  "processingTimeMs": 42300,
  "metadata": {
    "tables": [
      {
        "name": "customers",
        "rowCount": 1523,
        "chunksCreated": 1523,
        "largeFieldsChunked": 234
      }
    ]
  }
}
```

---

## User Flow

### JSON Ingestion

```typescript
// Step 1: Upload JSON for analysis
const analyzeResponse = await fetch('/api/v1/indexes/idx_123/ingest/analyze', {
  method: 'POST',
  body: formData, // Contains customers.json
});

const analysis = await analyzeResponse.json();
// {
//   analysisId: "analysis_abc",
//   tables: [...],
//   foreignKeyDetections: [...],
//   recommendations: [...]
// }

// Step 2: User reviews in UI
// - Check detected columns
// - Verify primary key
// - Review foreign keys
// - Adjust field classifications

// Step 3: Submit approved schema
const finalizeResponse = await fetch('/api/v1/indexes/idx_123/ingest/finalize', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    analysisId: analysis.analysisId,
    approvedSchema: {
      tables: analysis.tables.map((table) => ({
        ...table,
        columns: table.columns.map((col) => {
          // User can override classifications
          if (col.name === 'address') {
            return { ...col, isEmbeddable: true }; // Override
          }
          return col;
        }),
      })),
      foreignKeys: analysis.foreignKeyDetections.filter((fk) => fk.confidence > 0.8),
    },
    options: { generateEmbeddings: true },
  }),
});

const job = await finalizeResponse.json();
// { jobId: "job_xyz", status: "processing" }

// Step 4: Poll for completion
const statusResponse = await fetch(`/api/v1/jobs/${job.jobId}/status`);
const status = await statusResponse.json();
// { status: "completed", chunksCreated: 2487 }
```

### CSV Ingestion (Same Pattern)

```typescript
// Step 1: Analyze
const csvAnalysis = await analyzeCSV('customers.csv');

// Step 2: Review
// - Check column types (did it detect dates correctly?)
// - Verify primary key
// - Check for foreign keys to other tables

// Step 3: Finalize
await finalizeIngestion(csvAnalysis.analysisId, approvedSchema);
```

### Excel Ingestion (Multi-Sheet)

```typescript
// Step 1: Analyze
const excelAnalysis = await analyzeExcel('workbook.xlsx');
// {
//   tables: [
//     { tableName: "Customers", rowCount: 100, columns: [...] },
//     { tableName: "Orders", rowCount: 500, columns: [...] }
//   ],
//   foreignKeyDetections: [
//     { sourceTable: "Orders", sourceField: "customer_id", targetTable: "Customers", ... }
//   ]
// }

// Step 2: Review (multi-sheet)
// - Review each sheet separately
// - Verify cross-sheet foreign keys

// Step 3: Finalize
await finalizeIngestion(excelAnalysis.analysisId, approvedSchema);
```

---

## Backend Implementation

### Phase 1: Analysis Endpoint

```typescript
async function handleAnalyzeRequest(req: Request): Promise<AnalysisResponse> {
  const { file, options } = req.body;

  // Step 1: Parse file
  const parsedData = await parseFile(file, req.file.mimetype, req.file.originalname);

  // Step 2: Analyze schema
  const schema = await analyzeSchema(parsedData);

  // Step 3: Generate analysis ID and cache results
  const analysisId = generateAnalysisId();
  await cacheAnalysisResults(analysisId, {
    parsedData,
    schema,
    timestamp: Date.now(),
    expiresAt: Date.now() + 3600000, // 1 hour TTL
  });

  // Step 4: Estimate costs
  const estimates = estimateIngestionCosts(parsedData, schema);

  // Step 5: Generate recommendations
  const recommendations = generateRecommendations(parsedData, schema);

  return {
    analysisId,
    format: parsedData.format,
    filename: parsedData.filename,
    tables: schema.tables.map((table) => ({
      ...table,
      sampleData: table.sampleData.slice(0, options.sampleRowCount || 10),
    })),
    foreignKeyDetections: schema.foreignKeyDetections,
    recommendations,
    estimatedCosts: estimates,
  };
}

function estimateIngestionCosts(
  parsedData: ParsedData,
  schema: SchemaAnalysisResult,
): CostEstimate {
  let totalChunks = 0;
  let totalTokens = 0;

  for (const table of parsedData.tables) {
    const tableSchema = schema.tables.find((t) => t.tableName === table.name)!;
    const embeddableColumns = tableSchema.columns.filter((c) => c.isEmbeddable);

    // Estimate tokens per row
    const avgTokensPerRow = estimateAvgTokensPerRow(table.rows, embeddableColumns);

    // Check if rows need field chunking
    const avgFieldSizes = calculateAvgFieldSizes(table.rows, embeddableColumns);
    const largeFieldCount = avgFieldSizes.filter((size) => size > MAX_FIELD_TOKENS).length;

    // Estimate chunks per row
    const chunksPerRow = 1 + largeFieldCount * 2; // Main chunk + avg 2 chunks per large field

    totalChunks += table.rows.length * chunksPerRow;
    totalTokens += table.rows.length * avgTokensPerRow;
  }

  const embeddingCost = (totalTokens / 1000000) * 0.1; // $0.10 per 1M tokens (OpenAI pricing)
  const storageMB = totalChunks * 0.015; // Avg 15 KB per chunk

  return {
    totalChunks,
    embeddingTokens: totalTokens,
    estimatedEmbeddingCost: `$${embeddingCost.toFixed(2)}`,
    estimatedStorageMB: Math.round(storageMB),
  };
}

function generateRecommendations(
  parsedData: ParsedData,
  schema: SchemaAnalysisResult,
): Recommendation[] {
  const recommendations: Recommendation[] = [];

  for (const table of parsedData.tables) {
    const tableSchema = schema.tables.find((t) => t.tableName === table.name)!;

    for (const column of tableSchema.columns) {
      // Recommendation 1: Nullable warnings
      const nullCount = countNulls(table.rows, column.name);
      const nullPercentage = (nullCount / table.rows.length) * 100;

      if (nullPercentage > 5 && !column.nullable) {
        recommendations.push({
          type: 'warning',
          message: `Column '${column.name}' has ${nullPercentage.toFixed(1)}% null values - consider marking as nullable`,
          table: table.name,
          column: column.name,
        });
      }

      // Recommendation 2: Large field warnings
      if (column.type === 'string' && column.isEmbeddable) {
        const avgLength = calculateAvgLength(table.rows, column.name);
        if (avgLength > 2000) {
          // > 500 tokens
          recommendations.push({
            type: 'info',
            message: `Column '${column.name}' has large content (avg ${avgLength} chars) - will be chunked into multiple chunks`,
            table: table.name,
            column: column.name,
          });
        }
      }

      // Recommendation 3: Enum detection
      if (column.enumValues && column.enumValues.length <= 5) {
        recommendations.push({
          type: 'info',
          message: `Column '${column.name}' has ${column.enumValues.length} unique values - detected as enum`,
          table: table.name,
          column: column.name,
        });
      }
    }

    // Recommendation 4: Primary key warnings
    if (!tableSchema.primaryKey) {
      recommendations.push({
        type: 'warning',
        message: `Table '${table.name}' has no unique primary key - will use row index as recordId`,
        table: table.name,
      });
    }
  }

  return recommendations;
}
```

### Phase 2: Finalize Endpoint

```typescript
async function handleFinalizeRequest(req: Request): Promise<JobResponse> {
  const { analysisId, approvedSchema, options } = req.body;

  // Step 1: Retrieve cached analysis results
  const cached = await getCachedAnalysis(analysisId);
  if (!cached) {
    throw new Error('Analysis expired or not found. Please re-run Phase 1.');
  }

  // Step 2: Merge approved schema with parsed data
  const mergedSchema = mergeApprovedSchema(cached.schema, approvedSchema);

  // Step 3: Create async job
  const jobId = generateJobId();
  await createJob(jobId, {
    status: 'pending',
    tenantId: req.user.tenantId,
    indexId: req.params.indexId,
    parsedData: cached.parsedData,
    schema: mergedSchema,
    options,
  });

  // Step 4: Start background processing
  await enqueueIngestionJob(jobId);

  return {
    jobId,
    status: 'processing',
    statusUrl: `/api/v1/jobs/${jobId}/status`,
  };
}

async function processIngestionJob(jobId: string): Promise<void> {
  const job = await getJob(jobId);

  try {
    // Update status
    await updateJobStatus(jobId, 'processing');

    // Step 1: Generate chunks
    const chunks = await generateChunks(job.parsedData, job.schema, job.options);

    // Step 2: Build relationships
    const relationships = await buildRelationshipGraph(chunks, job.schema, job.options);

    // Step 3: Generate embeddings
    if (job.options.generateEmbeddings) {
      await generateEmbeddings(chunks, job.options);
    }

    // Step 4: Store
    await storeChunksAndRelationships(chunks, relationships, job.tenantId, job.indexId);

    // Step 5: Mark complete
    await updateJobStatus(jobId, 'completed', {
      chunksCreated: chunks.length,
      relationshipsCreated: relationships.length,
      embeddingsGenerated: chunks.filter((c) => c.embedding).length,
    });
  } catch (error) {
    await updateJobStatus(jobId, 'failed', { error: error.message });
    throw error;
  }
}
```

---

## UI Workflow

### Review Screen (Phase 1 → Phase 2)

```
┌────────────────────────────────────────────────────────────────┐
│ Schema Review: customers.csv                                    │
├────────────────────────────────────────────────────────────────┤
│                                                                 │
│ Table: customers (1,523 rows)                                  │
│                                                                 │
│ Primary Key: [id ▼]              Confidence: ●●●●● 100%        │
│                                                                 │
│ Columns:                                                        │
│ ┌────────┬────────┬──────────┬────────────┬────────────┬─────┐│
│ │ Name   │ Type   │ Nullable │ Filterable │ Embeddable │Edit ││
│ ├────────┼────────┼──────────┼────────────┼────────────┼─────┤│
│ │ id     │ number │ No       │ ✓ Yes      │ No         │ ... ││
│ │ name   │ string │ No       │ ✓ Yes      │ ✓ Yes      │ ... ││
│ │ status │ enum   │ No       │ ✓ Yes      │ No         │ ... ││
│ │ revenue│ number │ Yes      │ ✓ Yes      │ No         │ ... ││
│ │ notes  │ text   │ Yes      │ No         │ ✓ Yes      │ ... ││
│ └────────┴────────┴──────────┴────────────┴────────────┴─────┘│
│                                                                 │
│ Foreign Keys Detected:                                          │
│ ┌──────────────────────────────────────────────────────┬─────┐│
│ │ orders.customer_id → customers.id                    │ ✓   ││
│ │ Confidence: ●●●●○ 85% (naming_convention)            │     ││
│ └──────────────────────────────────────────────────────┴─────┘│
│                                                                 │
│ ⚠ Warnings:                                                     │
│ • Column 'notes' has large content (avg 4200 chars) - will be  │
│   chunked into multiple chunks for embedding                   │
│                                                                 │
│ Estimated Costs:                                                │
│ • Chunks: 2,487                                                 │
│ • Embedding tokens: 1.2M                                        │
│ • Embedding cost: $0.12                                         │
│ • Storage: 45 MB                                                │
│                                                                 │
│           [Cancel]              [Approve & Ingest] ───────────→ │
└────────────────────────────────────────────────────────────────┘
```

---

## Summary

**Benefits of Two-Phase Design**:

1. ✅ **User Control**: Review before committing to expensive ingestion
2. ✅ **Accuracy**: Correct mistakes in auto-detection
3. ✅ **Transparency**: See estimated costs before proceeding
4. ✅ **Flexibility**: Override field classifications, primary keys, foreign keys
5. ✅ **Async Processing**: Phase 2 runs in background, doesn't block UI

**When to Use Each Phase**:

- **Phase 1 only**: Quick schema inspection, cost estimation, feasibility check
- **Phase 1 → Phase 2**: Production ingestion with review
- **Phase 2 with cached schema**: Re-ingest same file with updated options

**API Endpoints Summary**:

| Endpoint                  | Purpose          | Response Time | Returns                             |
| ------------------------- | ---------------- | ------------- | ----------------------------------- |
| `POST /ingest/analyze`    | Schema detection | Fast (< 5s)   | Analysis + schema + recommendations |
| `POST /ingest/finalize`   | Start ingestion  | Instant       | Job ID (async)                      |
| `GET /jobs/:jobId/status` | Check progress   | Instant       | Job status + results                |
