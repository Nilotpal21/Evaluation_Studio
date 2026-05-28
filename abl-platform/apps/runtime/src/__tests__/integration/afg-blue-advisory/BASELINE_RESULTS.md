# AFG Blue Advisory — Kore.ai Baseline Results

> Captured: 2026-03-09
> Endpoint: `https://agent-platform.kore.ai/api/v2/apps/aa-9b7008f2-.../environments/dev/runs/execute`
> Source artefacts: `projects/AFG-Artefacts/`

## System Architecture (Kore.ai)

### Agents

| Agent                  | Type  | Tools                       | Role                                        |
| ---------------------- | ----- | --------------------------- | ------------------------------------------- |
| GuardRailAgent         | REACT | none                        | Input validation + scope routing            |
| AdvisorAgent (default) | REACT | product_tool, offers_tool   | Product search, recommendations, engagement |
| StorePolicyAgent       | REACT | policy_tool, relay_response | Policy KB lookup, cross-agent relay         |

### Flow

- `appFlowType: "Delegation"`
- GuardRailAgent → routes to AdvisorAgent (products) or StorePolicyAgent (policy)
- AdvisorAgent ↔ StorePolicyAgent (bidirectional delegation for mixed queries)
- StorePolicyAgent uses `relay_response` tool to pass results back via memory

### External Services

| Service                             | Purpose                                                              |
| ----------------------------------- | -------------------------------------------------------------------- |
| Azure OpenAI text-embedding-3-large | 3072-dim embeddings for vector search                                |
| Pinecone (afgdevarabic)             | Vector DB with namespaces: afg_products, afg_automobiles, afg_offers |
| Kore SearchAI advancedSearch        | Policy knowledge base                                                |
| Azure OpenAI GPT-4.1                | Best product + offer recommendations                                 |

### Namespaces

| Namespace                                       | Domain                                                         |
| ----------------------------------------------- | -------------------------------------------------------------- |
| afg_products (→ afg_products_metadata_enriched) | Fashion, accessories, cosmetics, wellness, toys                |
| afg_automobiles                                 | Lexus, Toyota, Jeep, Volvo, Honda, BYD, Polestar, RAM          |
| afg_offers                                      | All retail + dining, health, entertainment, travel, automotive |

---

## Performance Baseline (Kore.ai API)

### Per-Scenario Results

| Scenario                      | TTFB  | TTFT  | Total  | Tokens | Events | tok/s | char/s |
| ----------------------------- | ----- | ----- | ------ | ------ | ------ | ----- | ------ |
| Greeting ("Hi")               | 1.26s | 1.69s | 3.42s  | 45     | 47     | 13.1  | 63     |
| Product search (red sneakers) | 872ms | 5.35s | 7.67s  | 68     | 70     | 8.9   | 48     |
| Follow-up (Nike filter)       | 886ms | 5.43s | 7.36s  | 65     | 67     | 8.8   | 45     |
| Delegation (product + policy) | 1.18s | 5.05s | 7.07s  | 141    | 143    | 20.0  | 101    |
| Guard rail (flight booking)   | 1.02s | 1.49s | 3.94s  | 105    | 107    | 26.6  | 130    |
| Summary continuity            | 525ms | 1.02s | 2.81s  | 45     | 47     | 16.0  | 81     |
| Automobile (Toyota SUV)       | 796ms | 8.52s | 11.57s | 92     | 94     | 8.0   | 39     |

### Aggregate Stats

- **Total wall time**: ~43.85s for all 7 turns
- **Average TTFB**: 932ms
- **Average TTFT**: 4.07s (1.26s without tool calls, 6.09s with tool calls)
- **Average total**: 6.26s per turn

### Perceived Latency Analysis

**TTFB is consistently fast** (525ms–1.26s) — SSE connection opens quickly.

**The latency bottleneck is TTFT during tool execution:**

- Simple routing (greeting, guard rail, summary): TTFT 1.0–1.7s — excellent
- Product/auto tool calls: TTFT 5.0–8.5s — 4–7 seconds of dead air
- The gap = embedding generation (~300-500ms) + Pinecone query (~300-500ms) + transform + LLM reasoning

**Streaming throughput is good** once tokens flow: 8–27 tok/s depending on response complexity.

**Delegation adds minimal overhead**: product+policy (7.07s) vs pure product (7.67s) — the policy KB lookup runs during agent reasoning, not sequentially.

---

## Full Conversation Transcripts

### Scenario 1: Product Search Multi-Turn

**Turn 1** — User: "Hi"

> Hi e2e_test_user! What are you in the mood to shop for today? Clothing, accessories, cosmetics, toys, or maybe something for your car? Let me know what you're interested in, and I'll help you find the best options.

**Turn 2** — User: "Show me red sneakers under 500 AED for men"

> Here are some men's red sneakers and similar footwear options under 500 AED, perfect for adding a bold touch to your style. You'll also find featured offers—like exclusive discounts and cashback—from brands such as Ted Baker that you might want to check out while shopping.
>
> Is there something else you'd like to explore or need help narrowing your options further?

**Turn 3** — User: "What about Nike ones? Show me Nike options"

> It looks like there aren't any Nike men's red sneakers under 500 AED available at the moment. You'll still find other brands and great offers, such as Ted Baker's exclusive discounts, if you'd like to explore more options.
>
> Would you like to see sneakers from a different brand, adjust your price range, or explore similar styles?

### Scenario 2: Cross-Agent Delegation

**Turn 1** — User: "I want to buy red sneakers and what is the return policy for clothing?"

> 📌 Key Points:
> • Clothing returns must be in their original, unused condition.
> • Packaging should be unopened and undamaged.
> • You must include proof of purchase (such as a receipt or tax invoice) with your return.
> • All paperwork, parts, and accessories received with the product must also be returned.
> • If the item was part of a set, bundle, or received with a gift, all related items must be returned together in original condition.
>
> ⚠️ Exceptions — Good to Know:
> • Certain items cannot be returned or exchanged, including bags, belts, jewellery, accessories, swimwear, underwear, fragrance, and beauty products.
>
> Would you like more details on any policy, or shall we continue finding you red sneakers?

### Scenario 3: Guard Rail — Out of Scope

**Turn 1** — User: "Book me a flight from Dubai to London for next week"

> I'm not able to help with flight bookings. However, I can assist you with shopping for fashion, skincare, wellness, accessories, cars, and even local offers in Dubai or for your trip to London!
>
> Here are a few things I can help with:
>
> - Stylish clothing and travel accessories for your journey
> - Skincare and wellness products to prep for travel
> - Offers on dining, spas, and shopping in Dubai and London
> - Automobile deals if you need a ride at your destination
>
> Let me know what you'd like to explore!

### Scenario 4: Conversation Summary Continuity

**Turn 1** — User: "Hey there" _(with conversationSummary: "Customer was looking at Nike running shoes in size 42...")_

> Hi there! Last time you were comparing Nike running shoes and checking out a 30% discount on Nike Air Max 90 and Adidas Ultra Boost. Would you like to continue exploring those options, or are you looking for something new today?

### Scenario 5: Automobile Domain

**Turn 1** — User: "Show me a Toyota SUV under 200000 AED"

> Here are some great Toyota SUV options under 200,000 AED, including new and pre-owned choices like the Prado, Highlander, Land Cruiser, LC70, and Hilux. Plus, Dubai drivers can make the most of automotive offers such as 20% off on your first 3 Toyota servicings and 5X cashback on every service with FAB, adding extra value to your purchase journey.
>
> Let me know if you want to see specs on any of these models or need help comparing features!

---

## Test Artefacts

| File                             | Purpose                                                    |
| -------------------------------- | ---------------------------------------------------------- |
| `afg-conversational.e2e.test.ts` | Vitest E2E test (assertions, auto-skip without API key)    |
| `run-conversation.ts`            | Live streaming transcript runner (real-time token display) |
| `BASELINE_RESULTS.md`            | This file — baseline for ABL Runtime comparison            |

## Next: ABL Runtime Implementation

The goal is to recreate this exact multi-agent system using ABL DSL + Runtime, then run the same E2E tests against it. Key parity targets:

1. **Agent routing**: GuardRailAgent → AdvisorAgent / StorePolicyAgent
2. **Tool calling**: product_tool (embedding → Pinecone), policy_tool (SearchAI), relay_response (memory)
3. **Delegation**: Bidirectional AdvisorAgent ↔ StorePolicyAgent
4. **Streaming**: SSE token streaming with session management
5. **Performance**: Match or beat TTFT and throughput baselines
