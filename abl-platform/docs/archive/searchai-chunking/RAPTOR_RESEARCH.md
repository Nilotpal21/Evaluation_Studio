# RAPTOR: Comprehensive Research Analysis

## Recursive Abstractive Processing for Tree-Organized Retrieval

**Research Date**: 2026-02-12
**Paper**: https://arxiv.org/abs/2401.18059 (ICLR 2024)
**Official Implementation**: https://github.com/parthsarthi03/raptor (MIT License, 1.58k stars)

---

## 1. What is RAPTOR? Core Concept and Architecture

### Core Concept

RAPTOR addresses a fundamental limitation in traditional Retrieval-Augmented Generation (RAG) systems: **they only retrieve short contiguous chunks from a retrieval corpus, limiting holistic understanding of the overall document context.**

Traditional RAG retrieves from a flat collection of document chunks, which works well for specific facts but fails when questions require understanding:

- Document-level themes and summaries
- Cross-document reasoning
- Multi-hop inference
- Hierarchical relationships between concepts

### Architecture Overview

RAPTOR builds a **recursive tree structure** with multiple levels of abstraction through a bottom-up process:

1. **Segment** documents into chunks (100 tokens, preserving sentence boundaries)
2. **Embed** chunks using embedding model (paper uses SBERT multi-qa-mpnet-base-cos-v1)
3. **Cluster** embeddings using Gaussian Mixture Models (GMMs) with soft clustering
4. **Summarize** each cluster using LLM (paper uses GPT-3.5-turbo)
5. **Recursively repeat** steps 2-4 on summaries until convergence (typically 3 layers)
6. **Store all nodes** (original chunks + summaries at all levels) in vector database

At inference time, queries retrieve from the entire tree structure, accessing both detailed chunks (leaf nodes) and high-level summaries (parent nodes).

---

## 2. How Does Hierarchical Chunking with Summarization Work?

### Clustering Algorithm (GMM with UMAP)

RAPTOR uses **Gaussian Mixture Models** for soft clustering, allowing chunks to belong to multiple clusters with probability distributions:

**Key algorithmic details**:

- **UMAP dimensionality reduction** applied before clustering to handle high-dimensional embeddings
- **Variable n_neighbors** parameter for hierarchical structure:
  - Higher values → global clusters first
  - Lower values → local, fine-grained clusters
- **BIC (Bayesian Information Criterion)** determines optimal cluster count: `BIC = ln(N)k - 2ln(L̂)`
- **Expectation-Maximization** estimates GMM parameters (means, covariances, mixture weights)
- **Probability distribution**: `P(x) = Σ(k=1 to K) πₖN(x; μₖ, Σₖ)`

**Cluster statistics from paper**:

- Average cluster size: **6.7 nodes**
- Clusters adaptively sized: `n_clusters = min(10, len(current_texts) // 2)`

### Recursive Summarization Process

**Per-cluster summarization**:

1. Gather all text from cluster members
2. If cluster exceeds token threshold, recursively apply clustering within cluster
3. Generate summary using LLM with summarization prompt
4. Create parent node with metadata: `{level: N, origin: "summary", parent_id: cluster_id}`
5. Link parent to all child nodes in cluster

**Compression statistics** (from paper):
| Dataset | Avg Summary | Avg Child | Avg Children | Compression Ratio |
|---------|-------------|-----------|--------------|-------------------|
| QuALITY | 124.4 tokens | 87.9 tokens | 5.7 nodes | 0.28 |
| NarrativeQA | 129.7 tokens | 85.5 tokens | 6.8 nodes | 0.27 |
| QASPER | 145.9 tokens | 86.2 tokens | 5.7 nodes | 0.35 |

**Overall compression**: 72% average (0.28 summary-to-child ratio)

**Tree structure**:

- **Level 0**: Original document chunks (leaf nodes)
- **Level 1**: Cluster summaries of original chunks
- **Level 2**: Summaries of summaries (higher abstraction)
- **Level N**: Single root summary (entire document)

**Termination**: Stops when only one cluster remains or insufficient nodes for meaningful clustering (`<= reduction_dimension + 1`)

---

## 3. How Does Tree-Based Retrieval Work? (Search Strategy)

RAPTOR implements two retrieval strategies:

### Strategy 1: Collapsed Tree (Recommended, Better Performance)

**Algorithm**:

1. Flatten entire tree to single layer (all nodes regardless of level)
2. Compute cosine similarity between query embedding and all node embeddings
3. Rank nodes by similarity score
4. Retrieve top-k nodes until token budget reached (2000 tokens for GPT, 400 for UnifiedQA)

**Advantages**:

- More flexible—can retrieve nodes from any level
- Better performance in benchmarks
- Simpler implementation

**Layer distribution in retrieved results**: 18.5% to 57% of retrieved nodes come from **non-leaf layers** (not just original chunks)

### Strategy 2: Tree Traversal

**Algorithm**:

1. Start at root or specified layer
2. Compute query embedding
3. For each layer (up to d layers):
   - Calculate embeddings for current node list
   - Rank by cosine similarity
   - Select top-k nodes (or threshold-based filtering)
   - Expand to children for next layer
4. Concatenate selected nodes across all layers

**Selection modes**:

- **Top-k mode**: Fixed number of nodes per layer
- **Threshold mode**: Filter nodes where `similarity > threshold`

**Configuration parameters**:

```python
class TreeRetrieverConfig:
    tokenizer: str = "cl100k_base"
    threshold: float = 0.5  # similarity cutoff
    top_k: int = 5  # nodes per layer
    num_layers: int = 3  # traversal depth
    start_layer: int = 0  # beginning layer
```

---

## 4. Comparison with Flat Chunking (Traditional RAG)

### Quantitative Performance Gains

**QASPER F-1 Match Scores** (Question Answering on Scientific Papers):
| Model | BM25 | DPR | RAPTOR | Improvement |
|-------|------|-----|--------|-------------|
| GPT-3 | 46.6% | 51.3% | **53.1%** | +1.8pp |
| GPT-4 | 50.2% | 53.0% | **55.7%** | +2.7pp |
| UnifiedQA | 26.4% | 32.1% | **36.6%** | +4.5pp |

**QuALITY Accuracy** (Long Document Understanding):
| Model | BM25 | DPR | RAPTOR | Improvement |
|-------|------|-----|--------|-------------|
| GPT-3 | 57.3% | 60.4% | **62.4%** | +2.0pp |
| UnifiedQA | 49.9% | 53.9% | **56.6%** | +2.7pp |

**State-of-the-Art Results**:

- QuALITY with GPT-4: **82.6% accuracy** (vs 62.3% previous best, +20pp absolute)
- QASPER with GPT-4: **55.7% F-1** (vs 53.9% previous best)
- QuALITY-HARD subset: **76.2%** (vs 54.7% previous best, +21.5pp)

**NarrativeQA (UnifiedQA)**:
| Metric | BM25 | DPR | RAPTOR | Improvement |
|--------|------|-----|--------|-------------|
| ROUGE-L | 23.52% | 29.56% | **30.87%** | +1.31pp |
| BLEU-1 | 17.73% | 22.84% | **23.50%** | +0.66pp |
| METEOR | 13.98% | 18.44% | **19.20%** | +0.76pp |

### Qualitative Advantages

**When RAPTOR excels**:

- **Summarization queries**: "What is the main theme of this document?"
- **Multi-step reasoning**: Questions requiring synthesis across multiple sections
- **Document-level understanding**: High-level concepts vs. specific facts
- **Cross-section inference**: Connecting information from different parts

**When flat chunking is sufficient**:

- Fact lookup: "What is the capital of France?"
- Specific entity extraction: "List all dates mentioned"
- Single-paragraph answers
- Short documents (<5k tokens)

### Ablation Study Results

**Clustering vs Contiguous Windowing**:

- RAPTOR (GMM clustering): **56.6% accuracy**
- Recency-based tree (window=7): **55.8% accuracy**
- **Insight**: Semantic clustering > sequential windowing

**Full Tree vs Single Layer** (Story 3 results):

- Full 3-layer tree: **73.68%**
- Layer 0 only (original chunks): **66.6%**
- Layer 2 only (high-level summaries): **61.1%**
- **Insight**: Multi-level retrieval critical for performance

---

## 5. Benefits (Benchmarks and Performance)

### Proven Benefits

1. **+20% absolute accuracy improvement** on QuALITY benchmark (GPT-4)
2. **State-of-the-art results** on complex reasoning tasks
3. **Holistic document understanding** vs chunk-level retrieval
4. **Multi-level abstraction** enables different query types
5. **Linear scalability** with document length (confirmed up to 78k tokens)
6. **Flexible retrieval** from any tree level based on query needs

### Performance Characteristics

**Retrieval quality**:

- **18.5-57% of retrieved nodes** come from non-leaf layers (summaries)
- Shows system actively uses hierarchical structure, not just leaf nodes
- Balanced mix of specific details and high-level context

**Hallucination rate**:

- **4% of summaries** contain minor hallucinations
- No observed propagation to parent nodes
- No measurable impact on QA task performance
- Comparable to flat RAG hallucination rates

**Best with powerful LLMs**:

- GPT-4 shows strongest improvements
- UnifiedQA shows moderate gains
- Smaller models benefit less (summary quality dependency)

---

## 6. Costs (Compute, Latency, Storage)

### Build-Time Costs (One-Time, Preprocessing)

**LLM API calls for summarization**:

- **Per document**: N_clusters × N_layers API calls
- **Example**: 100 chunks → ~20 clusters (Layer 1) → ~4 clusters (Layer 2) → 1 cluster (Layer 3)
  - Total: ~25 summarization calls
- **Token cost**: If average 500 tokens per summary with GPT-3.5-turbo:
  - Input: ~25 × 500 = 12,500 tokens
  - Output: ~25 × 130 = 3,250 tokens
  - Cost: ~$0.01 per document (GPT-3.5-turbo rates)
  - Cost: ~$0.15 per document (GPT-4 rates)

**Embedding generation**:

- **All nodes embedded**: Original chunks + all summary levels
- **Example**: 100 original → 20 L1 summaries → 4 L2 summaries → 1 L3 summary = **125 embeddings**
- **Overhead vs flat RAG**: 25% more embeddings (125 vs 100)
- **Cost**: Minimal with modern embedding APIs (~$0.0001 per 1k tokens)

**Clustering computation**:

- **GMM + UMAP**: Runs on CPU, relatively lightweight
- **Tested on consumer hardware**: M1 Mac with 16GB RAM
- **Time complexity**: O(N log N) per layer
- **Example**: ~5-10 seconds per layer for 100 chunks

**Total build time** (estimated):

- Small document (100 chunks): **2-5 minutes**
- Large document (1000 chunks): **20-40 minutes**
- Primarily bottlenecked by LLM API latency

### Query-Time Costs (Per Query)

**Collapsed tree retrieval**:

- **Similarity computation**: Cosine similarity across all nodes
- **Overhead vs flat RAG**: 25% more similarity computations (125 vs 100 embeddings)
- **Time**: <100ms additional (negligible)

**Tree traversal retrieval**:

- **Layer-by-layer similarity**: More compute than collapsed
- **Time**: 200-500ms per layer × 3 layers = 600-1500ms
- **Not recommended**: Worse performance + higher latency

**Query embedding**: Same as flat RAG (1 embedding per query)

**LLM generation**: Same context size limits (2k-4k tokens), no additional cost

**Total query latency overhead**: **<200ms** (using collapsed tree)

### Storage Costs

**Vector database storage**:

- **Overhead**: 25% more vectors than flat RAG (all tree nodes)
- **Example**:
  - Flat RAG: 100 chunks × 768 dims = 76,800 floats = 307KB
  - RAPTOR: 125 nodes × 768 dims = 96,000 floats = 384KB
  - **Overhead**: +77KB (+25%)

**Metadata storage**:

- Parent-child relationships
- Layer information
- Origin tracking (original vs summary)
- **Overhead**: Minimal (<1KB per document)

**Total storage overhead**: **~25-30% vs flat RAG**

### Cost Summary Table

| Cost Dimension         | Flat RAG        | RAPTOR          | Overhead        |
| ---------------------- | --------------- | --------------- | --------------- |
| **Build-time LLM**     | $0              | $0.01-0.15/doc  | +$0.01-0.15/doc |
| **Build-time compute** | 10s             | 2-5min          | +100-200s       |
| **Embedding cost**     | $0.0001/doc     | $0.000125/doc   | +25%            |
| **Query latency**      | ~50ms           | ~200ms          | +150ms          |
| **Storage**            | 300KB/100chunks | 375KB/100chunks | +25%            |

---

## 7. When Is It Worth the Complexity?

### Strong Use Cases (Recommended)

**Document characteristics**:

- **Long documents** (>10k tokens, >50 chunks)
- **Complex narratives** requiring multi-level understanding
- **Technical documentation** with hierarchical structure
- **Research papers** with abstract → sections → details
- **Legal contracts** with nested clauses
- **Books and long-form content**

**Query patterns**:

- **Summarization queries**: "What is this document about?"
- **Theme extraction**: "What are the main topics?"
- **Multi-hop reasoning**: "How does X relate to Y across sections?"
- **Comparative analysis**: "Compare the approaches in section A vs B"
- **High-level strategy** > specific fact retrieval

**Business context**:

- Acceptable **build-time latency** (minutes, not seconds)
- Quality-critical applications (worth extra cost)
- Limited documents (hundreds to thousands, not millions)
- **Infrequent updates** (tree rebuild expensive)
- Users ask diverse question types (summary + detail)

### Poor Fit (Not Recommended)

**Document characteristics**:

- **Short documents** (<5k tokens, <20 chunks)
- **Simple structure** (flat articles, blog posts)
- **Frequently updated content** (news, real-time data)
- **Massive scale** (millions of documents—cost prohibitive)

**Query patterns**:

- **Fact lookup**: "What is X's phone number?"
- **Entity extraction**: "List all dates"
- **Keyword search**: "Find mentions of keyword Y"
- **Single-chunk answers**: No cross-document synthesis needed

**Business context**:

- Real-time or near-real-time ingestion required
- Cost-sensitive (high volume, low margin)
- Limited LLM budget
- Simple RAG already performs well

### Decision Framework

```
Use RAPTOR if:
✅ Long documents (>10k tokens)
✅ Complex, multi-hop queries
✅ Quality > cost trade-off acceptable
✅ Infrequent document updates
✅ Build latency tolerance (minutes)
✅ Flat RAG underperforming on summaries

Stick with flat RAG if:
❌ Short documents (<5k tokens)
❌ Simple fact retrieval
❌ Real-time ingestion needed
❌ Cost-sensitive (high volume)
❌ Flat RAG already works well
❌ Fast build time critical
```

### Cost-Benefit Break-Even Analysis

**Example scenario**: 1,000 documents, 50 queries/day

**RAPTOR additional cost**:

- Build: 1,000 × $0.05 = **$50 one-time**
- Storage: 1,000 × 75KB = 75MB ≈ **$0.01/month**
- Query: 50/day × 365 × $0.0001 = **$1.82/year**
- **Total Year 1**: ~$52

**Benefit threshold**: Worth it if improves answer quality enough to justify:

- $52 / 18,250 queries = **$0.0028 per query**
- Or saves user time worth >$52/year
- Or prevents mistakes worth >$52/year

**Verdict**: For most enterprise use cases with long documents and quality requirements, RAPTOR is cost-justified.

---

## 8. Open Source Implementations

### 1. Official Implementation (Stanford/UT Austin)

- **Repository**: https://github.com/parthsarthi03/raptor
- **Stars**: 1,580
- **License**: MIT
- **Status**: Active, paper authors maintain
- **Language**: Python 3.8+
- **Dependencies**: OpenAI API, SBERT, scikit-learn, UMAP

**Pros**:

- Reference implementation from paper authors
- Well-documented with examples
- Extensible base classes for custom models
- Includes demo.ipynb with multiple LLM options (Llama, Mistral, Gemma)

**Cons**:

- Dependency conflicts reported (Issue #37)
- Some bugs in multithreading mode (Issue #52)
- Limited production deployment guidance
- No built-in vector database integration beyond FAISS

**Basic usage**:

```python
from raptor import RetrievalAugmentation

RA = RetrievalAugmentation()
RA.add_documents(text)
RA.save("./tree")
answer = RA.answer_question(question="...")
```

### 2. LlamaIndex LlamaPack

- **Package**: `llama-index-packs-raptor`
- **Repository**: https://github.com/run-llama/llama_index
- **Status**: Production-ready
- **Integration**: Native LlamaIndex ecosystem

**Pros**:

- Production-tested framework integration
- Vector store persistence (any LlamaIndex-supported DB)
- Two retrieval modes: `tree_traversal` and `collapsed`
- Configurable `SummaryModule` with parallel processing
- Active maintenance and community support

**Cons**:

- Requires understanding LlamaIndex abstractions
- `num_workers` parameter can hit API rate limits
- Less transparent than reference implementation

**Basic usage**:

```python
from llama_index.packs.raptor import RaptorPack

pack = RaptorPack(
    documents,
    llm=llm,
    embed_model=embed_model,
    vector_store=vector_store
)
nodes = pack.run("query", mode="collapsed")
```

### 3. LangChain (Community Implementations)

- **Status**: No official LangChain integration (as of Feb 2024)
- **Community notebooks**: Various Colab notebooks exist but unmaintained
- **Recommendation**: Use official implementation or LlamaIndex instead

### 4. Custom Implementations in RAG Technique Repos

- **NirDiamant/RAG_Techniques**: https://github.com/NirDiamant/RAG_Techniques/blob/main/all_rag_techniques/raptor.ipynb
  - Educational implementation with FAISS
  - GMM clustering with PCA visualization
  - Contextual compression integration
  - Good for learning, not production

### Recommendation Matrix

| Use Case                             | Recommended Implementation                               |
| ------------------------------------ | -------------------------------------------------------- |
| **Research & experimentation**       | Official parthsarthi03/raptor                            |
| **Production with LlamaIndex stack** | llama-index-packs-raptor                                 |
| **Learning & education**             | NirDiamant/RAG_Techniques                                |
| **Custom production**                | Fork official + add vector DB                            |
| **LangChain users**                  | Wait for official support or use official implementation |

---

## 9. Handling Documents with Images

### Current State: RAPTOR Does Not Handle Images

**Key limitation**: RAPTOR was designed for **text-only documents** and has no native multimodal capabilities:

1. **Chunking**: Assumes text chunks, no image embedding
2. **Summarization**: LLM prompts expect text input only
3. **Embedding**: Uses SBERT or text embeddings, not vision encoders
4. **Retrieval**: Cosine similarity on text embeddings only

**From paper**: Tested on QuALITY, NarrativeQA, QASPER—all text-only benchmarks

### Workarounds for Image-Heavy Documents

**Option 1: Extract Text from Images (Limited)**

- Use OCR (Tesseract, AWS Textract) to extract text
- Treat images as text chunks in tree
- **Limitations**: Loses visual structure, diagrams, charts

**Option 2: Image Captioning (Better)**

- Generate captions for images using vision models (BLIP-2, GPT-4V)
- Include captions as text in chunking process
- **Limitations**: Loses fine-grained visual details, caption quality varies

**Option 3: Multimodal Embeddings (Experimental)**

- Use CLIP or similar for joint text-image embeddings
- Modify clustering to handle multimodal embeddings
- Summarize with multimodal LLM (GPT-4V)
- **Limitations**: Requires significant modifications to RAPTOR codebase

**Option 4: Separate Pipelines (Practical)**

- Run RAPTOR on text content
- Maintain separate image index (CLIP embeddings)
- Fusion retrieval: combine text + image results at query time
- **Advantages**: Clean separation, use best tool for each modality

### Alternative: ColPali for Multimodal Documents

For documents with significant visual content (PDFs with figures, diagrams, tables), consider **ColPali** instead of RAPTOR:

- Native multimodal retrieval (text + images)
- No need for OCR or captioning
- Better performance on visual-heavy documents
- See research: https://arxiv.org/abs/2407.01449

**Recommendation**:

- **Text-heavy documents** → RAPTOR
- **Visual-heavy documents** → ColPali
- **Mixed documents** → Fusion approach (RAPTOR for text + ColPali for images)

---

## 10. Production Deployment Considerations

### Infrastructure Requirements

**Compute resources (build-time)**:

- **CPU**: Sufficient for clustering (tested on M1 Mac, 16GB RAM)
- **GPU**: Optional, not required (embeddings and LLM calls via API)
- **Memory**: ~2GB per 1000 documents during build
- **Scaling**: Embarrassingly parallel per-document (process multiple docs simultaneously)

**Runtime resources (query-time)**:

- **Vector database**: Pinecone, Qdrant, Weaviate, Milvus, or Chroma
- **Embedding API**: OpenAI, Cohere, or self-hosted SBERT
- **LLM API**: OpenAI GPT-3.5/4, Anthropic Claude, or self-hosted
- **Latency target**: <500ms for retrieval + LLM generation

### Architecture Patterns

**Pattern 1: Async Build Pipeline**

```
Document Upload → Queue (SQS/RabbitMQ) → Worker (build tree) → Vector DB
```

- Decouples ingestion from build
- Handles spikes in document uploads
- Monitor build queue depth

**Pattern 2: Incremental Updates**

- **Problem**: Full tree rebuild expensive
- **Solution**: Maintain version history, rebuild only changed documents
- **Trade-off**: Stale summaries for unchanged documents (acceptable if updates infrequent)

**Pattern 3: Tiered Storage**

- **Hot tier**: Recent documents, full RAPTOR trees
- **Warm tier**: Older documents, collapsed trees only
- **Cold tier**: Archive, flat chunks only
- **Cost savings**: 60-80% reduction in storage costs

### Monitoring and Observability

**Key metrics**:

- **Build-time**:
  - Documents queued vs processed
  - Average build time per document
  - LLM API error rate
  - Clustering quality (silhouette score)
- **Query-time**:
  - Retrieval latency (p50, p95, p99)
  - Layer distribution in retrieved nodes
  - Query-to-answer latency
  - Cache hit rate (for common queries)

**Quality metrics**:

- User feedback (thumbs up/down)
- Answer correctness (eval dataset)
- Hallucination rate (human review sample)
- Coverage (% queries returning results)

### Failure Modes and Mitigations

**Issue 1: LLM API rate limits during build**

- **Mitigation**: Exponential backoff, batch processing, use multiple API keys

**Issue 2: Poor clustering quality**

- **Symptom**: Many single-node clusters or one giant cluster
- **Mitigation**: Tune `n_clusters` parameter, try different embedding models, check document quality

**Issue 3: Hallucinations in summaries**

- **Symptom**: Factually incorrect summaries
- **Mitigation**: Use higher-quality LLM (GPT-4 vs GPT-3.5), validate summaries against source, add human review for critical documents

**Issue 4: Slow retrieval at scale**

- **Symptom**: Query latency increases with corpus size
- **Mitigation**: Use approximate nearest neighbor (ANN) indexes, implement caching, consider sharding large corpora

**Issue 5: Dependency conflicts**

- **Symptom**: Installation failures (reported in GitHub issues)
- **Mitigation**: Use Docker containers, pin dependency versions, test in clean environment

### Security and Privacy

**Considerations**:

- **LLM API**: Document content sent to third-party API (OpenAI, etc.)
  - **Mitigation**: Use self-hosted LLMs for sensitive data (Llama, Mistral)
- **Embedding API**: Same concern
  - **Mitigation**: Self-host SBERT or similar
- **Vector DB**: Ensure encryption at rest and in transit
- **Access control**: Implement document-level permissions in retrieval layer

### Cost Optimization

**Strategies**:

1. **Use cheaper LLM for summarization**: GPT-3.5-turbo vs GPT-4 (10x cost difference)
2. **Cache embeddings**: Avoid re-embedding unchanged content
3. **Batch builds**: Amortize API call overhead
4. **Tiered storage**: Archive old trees, use flat chunks for cold data
5. **Rate limit protection**: Monitor and cap API usage

**Example cost projection** (1M queries/month, 10k documents):

- Build (one-time): 10,000 × $0.05 = **$500**
- Storage: 10k × 75KB = 750MB ≈ **$10/month**
- Query embeddings: 1M × $0.0001 = **$100/month**
- LLM generation: 1M × $0.002 = **$2,000/month**
- **Total**: ~$2,110/month (dominated by LLM generation, not RAPTOR overhead)

### Testing Strategy

**Unit tests**:

- Clustering algorithm correctness
- Tree construction logic
- Retrieval algorithm correctness

**Integration tests**:

- End-to-end build pipeline
- Query-to-answer flow
- Vector DB integration

**Quality tests**:

- Golden dataset with known good answers
- Regression tests on benchmark datasets (QuALITY subset)
- A/B testing vs flat RAG

**Load tests**:

- Concurrent build jobs
- Query throughput and latency
- Vector DB scaling

### Migration from Flat RAG

**Rollout Steps**:

1. **Step 1**: Deploy RAPTOR in parallel, A/B test
2. **Step 2**: Migrate subset of documents (long-form content first)
3. **Step 3**: Implement query router (RAPTOR for summary queries, flat for facts)
4. **Step 4**: Full migration or hybrid approach

**Hybrid approach** (recommended):

- Use **flat RAG** for short documents, fact retrieval
- Use **RAPTOR** for long documents, summarization queries
- Implement **query classifier** to route intelligently

---

## Key Takeaways and Recommendations

### RAPTOR is Worth It When:

✅ Working with **long, complex documents** (>10k tokens)
✅ Users ask **summarization and synthesis questions**
✅ **Quality is critical** (worth 25% extra cost/storage)
✅ Documents updated **infrequently** (rebuild cost acceptable)
✅ Have **tolerance for 2-5 minute build times**
✅ Flat RAG showing **poor performance on high-level queries**

### Stick with Flat RAG When:

❌ Short documents (<5k tokens)
❌ Simple fact lookup queries
❌ Real-time ingestion required
❌ Cost-sensitive (millions of documents)
❌ Flat RAG already performing well

### Implementation Recommendations:

1. **Start with LlamaIndex RAPTOR Pack** for quickest production deployment
2. **Use GPT-3.5-turbo** for summarization (balance cost/quality)
3. **Collapsed tree retrieval** (better than tree traversal)
4. **Monitor layer distribution** in retrieved nodes (should be 20-50% non-leaf)
5. **A/B test vs flat RAG** on your specific data/queries
6. **Implement query routing** (RAPTOR for summary, flat for facts)
7. **Consider hybrid approach** rather than full migration
8. **Budget for 25% overhead** in storage and query latency

### Open Questions for SearchAI Integration:

1. **Scale**: How many documents? (RAPTOR expensive for millions)
2. **Update frequency**: Real-time or batch? (RAPTOR favors batch)
3. **Query patterns**: More facts or summaries? (Impacts ROI)
4. **Document types**: Mostly text or multimodal? (RAPTOR text-only)
5. **Quality vs cost**: Premium tier feature or default?

### Suggested Approach for SearchAI:

**Option A: RAPTOR as Premium Feature**

- Default: Flat chunking (fast, cheap)
- Premium: RAPTOR for long documents (quality)
- Query router: Automatic or user-selectable

**Option B: Hybrid Pipeline**

- Short docs (<5k tokens): Flat chunking
- Long docs (>10k tokens): RAPTOR
- Auto-detect document type and choose strategy

**Option C: Evaluate First**

- Implement flat RAG fully
- Benchmark on test queries
- Add RAPTOR only if quality gap identified
- **Recommendation**: Start with Option C (measure before optimizing)

---

## References

1. **Paper**: Sarthi, P., et al. (2024). "RAPTOR: Recursive Abstractive Processing for Tree-Organized Retrieval." ICLR 2024. https://arxiv.org/abs/2401.18059

2. **Official Implementation**: https://github.com/parthsarthi03/raptor

3. **LlamaIndex Integration**: https://github.com/run-llama/llama_index/tree/main/llama-index-packs/llama-index-packs-raptor

4. **RAG Complexity Hierarchy**: https://jxnl.github.io/blog/writing/2024/02/28/levels-of-complexity-rag-applications/

5. **Implementation Examples**: https://github.com/NirDiamant/RAG_Techniques

---

**End of Research Document**
