# Manual Pipeline Test Plan — Travel (TravelDesk) Bot

> End-to-end manual verification of all analytics pipelines using the travel agent suite.

---

## Overview

**9 pipeline definitions** are seeded into MongoDB (sentiment, intent, quality+outcome, hallucination, knowledge-gap, guardrail, friction, anomaly, drift). Docker-compose has **no Kafka**, so pipelines are triggered via **Restate direct invocation** after creating test sessions.

**Entry point**: `travel/TravelDesk_Supervisor` — routes to 10 specialist agents with 36+ mock tools that return realistic travel data (flights, hotels, bookings, refunds).

### Pipeline Coverage

| Pipeline                | Type                      | Trigger                                                 | Activity                | ClickHouse Table                              |
| ----------------------- | ------------------------- | ------------------------------------------------------- | ----------------------- | --------------------------------------------- |
| Sentiment Analysis      | `sentiment_analysis`      | kafka: `abl.session.ended`                              | `compute-sentiment`     | `conversation_sentiment`, `message_sentiment` |
| Intent Classification   | `intent_classification`   | kafka: `abl.session.ended`                              | `compute-intent`        | `intent_classifications`                      |
| Quality Evaluation      | `quality_evaluation`      | kafka: `abl.session.ended` (filter: `status=completed`) | `compute-quality`       | `quality_evaluations`                         |
| Outcome Classification  | (part of quality)         | (same as quality)                                       | (same as quality)       | `conversation_outcomes`                       |
| Hallucination Detection | `hallucination_detection` | kafka: `abl.session.ended` (filter: `status=completed`) | `conversation-analyzer` | `hallucination_evaluations`                   |
| Knowledge Gap           | `knowledge_gap`           | kafka: `abl.session.ended` (filter: `status=completed`) | `conversation-analyzer` | `knowledge_gap_evaluations`                   |
| Guardrail Analysis      | `guardrail_analysis`      | kafka: `abl.session.ended` (filter: `status=completed`) | `conversation-analyzer` | `guardrail_evaluations`                       |
| Friction Detection      | `friction_detection`      | kafka: `abl.session.ended` (filter: `status=completed`) | `compute-statistical`   | `friction_detections`                         |
| Anomaly Detection       | `anomaly_detection`       | schedule: hourly                                        | `compute-statistical`   | `anomaly_detections`                          |
| Drift Detection         | `drift_detection`         | schedule: daily                                         | `compute-statistical`   | `drift_detections`                            |

### Travel Agent Suite

| Agent                   | Role                                          | Mock Tools                                                                                                          |
| ----------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `TravelDesk_Supervisor` | Routes to specialists based on intent         | —                                                                                                                   |
| `Welcome_Agent`         | Greeting, returning user detection            | `check_returning_user`, `get_user_context`                                                                          |
| `Authentication_Agent`  | Email code or booking ref auth                | `verify_email`, `send_verification_code`, `verify_code` (code: `123456`), `lookup_booking`                          |
| `Sales_Agent`           | Search flights/hotels/packages, create quotes | `search_flights` (3 results), `search_hotels` (3 results), `search_packages`, `create_quote`, `start_payment`       |
| `Booking_Manager`       | View/change/cancel/upgrade bookings           | `list_user_bookings` (2 bookings), `get_booking_details`, `modify_booking`, `cancel_booking`, `get_upgrade_options` |
| `Payment_Agent`         | Quote validation → payment → confirmation     | `validate_quote`, `start_payment`, `check_payment_status`, `send_confirmation`                                      |
| `Fee_Calculator`        | Delegate: modification fees                   | `get_modification_fee`, `calculate_price_difference`                                                                |
| `Refund_Processor`      | Delegate: cancellation refunds                | `calculate_refund` ($245), `process_refund`                                                                         |
| `Live_Agent_Transfer`   | Human handoff (always available, "Sarah M.")  | `check_agent_availability`, `create_transfer_ticket`, `initiate_transfer`                                           |
| `Farewell_Agent`        | Rating collection + goodbye                   | `submit_feedback`                                                                                                   |
| `Fallback_Handler`      | Clarify unclear intents (2 rounds max)        | `analyze_message`, `get_common_queries`                                                                             |

---

## Phase 0: Infrastructure Setup

### 0.1 Start Docker Services

```bash
docker compose up -d mongo clickhouse redis restate
```

Verify health:

```bash
docker compose ps
# Expected: mongo (27018), clickhouse (8124), redis (6380), restate (9070/8090)
```

### 0.2 Build the Platform

```bash
pnpm build
```

### 0.3 Seed All Pipeline Definitions + ClickHouse Tables

```bash
CLICKHOUSE_URL=http://localhost:8124 pnpm tsx scripts/seed-pipelines.ts
```

Expected output — 9 definitions + 9 configs = 18 records:

```
--- Seeding Pipelines (tenant: tenant-dev-001) ---
  Initializing ClickHouse analytics tables...
  ClickHouse analytics tables ready.
  Seeding pipeline definitions...
    Definition: Sentiment Analysis (builtin:sentiment-analysis)
    Definition: Intent Classification (builtin:intent-classification)
    Definition: Quality Evaluation (builtin:quality-evaluation)
    Definition: Hallucination Detection (builtin:hallucination-detection)
    Definition: Knowledge Gap Analysis (builtin:knowledge-gap-analysis)
    Definition: Guardrail Analysis (builtin:guardrail-analysis)
    Definition: Friction Detection (builtin:friction-detection)
    Definition: Anomaly Detection (builtin:anomaly-detection)
    Definition: Drift Detection (builtin:drift-detection)
  Seeding default pipeline configs...
    Config: sentiment_analysis (tenant: tenant-dev-001, enabled: false)
    Config: intent_classification (tenant: tenant-dev-001, enabled: false)
    Config: quality_evaluation (tenant: tenant-dev-001, enabled: false)
    Config: hallucination_detection (tenant: tenant-dev-001, enabled: false)
    Config: knowledge_gap (tenant: tenant-dev-001, enabled: false)
    Config: guardrail_analysis (tenant: tenant-dev-001, enabled: false)
    Config: friction_detection (tenant: tenant-dev-001, enabled: false)
    Config: anomaly_detection (tenant: tenant-dev-001, enabled: false)
    Config: drift_detection (tenant: tenant-dev-001, enabled: false)

Pipeline seed complete! (18 records upserted)
```

Verify ClickHouse tables:

```bash
curl -s "http://localhost:8124/?query=SHOW+TABLES+FROM+abl_platform+FORMAT+PrettyCompact"
```

### 0.4 Start Runtime

```bash
cd apps/runtime && pnpm dev
# → http://localhost:3112
```

### 0.5 Start Pipeline Engine + Register with Restate

```bash
# Terminal 2
cd packages/pipeline-engine && pnpm dev
# → http://localhost:9080
```

Register with Restate:

```bash
curl -X POST http://localhost:9070/deployments \
  -H 'Content-Type: application/json' \
  -d '{"uri": "http://host.docker.internal:9080"}'
```

Verify registration:

```bash
curl -s http://localhost:9070/deployments | jq '.deployments[].services[].name'
# Should list: PipelineTrigger, PipelineRun, ActivityRouter,
# ComputeSentimentService, ComputeIntentService, ComputeQualityService,
# ConversationAnalyzerService, ComputeStatisticalService, etc.
```

### 0.6 Set Up Auth + Enable Pipelines

```bash
# Generate JWT (adjust JWT_SECRET to match your .env)
export JWT_SECRET="your-jwt-secret"
export TOKEN=$(node -e "console.log(require('jsonwebtoken').sign({sub:'test-user',role:'ADMIN',tenantId:'tenant-dev-001'},'${JWT_SECRET}',{expiresIn:3600}))")
export PROJECT_ID="your-project-id"   # From MongoDB: db.projects.findOne()._id
export TENANT_ID="tenant-dev-001"
```

Enable all kafka-triggered pipelines:

```bash
for PIPELINE in sentiment_analysis intent_classification quality_evaluation \
  hallucination_detection knowledge_gap guardrail_analysis friction_detection; do
  curl -s -X PATCH "http://localhost:3112/api/projects/${PROJECT_ID}/pipeline-config/${PIPELINE}/toggle" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{"enabled": true}'
  echo " → ${PIPELINE}"
done
```

> **Note**: Anomaly and drift pipelines are schedule-triggered (hourly/daily), not session-triggered. They run on pre-aggregated materialized views, not individual conversations. They are tested separately in Phase 5.

### 0.7 Verify Travel Supervisor Loads

```bash
node -e "
const ws = new (require('ws'))('ws://localhost:3112/ws?token=${TOKEN}');
ws.on('message', d => {
  const m = JSON.parse(d);
  console.log(m.type, m.sessionId || '');
  if (m.type === 'info') ws.send(JSON.stringify({type:'load_agent',agentPath:'travel/TravelDesk_Supervisor'}));
  if (m.type === 'agent_loaded') { console.log('SUCCESS - Session:', m.sessionId); ws.close(); }
  if (m.type === 'error') { console.error('FAIL:', m); ws.close(); }
});
"
```

---

## Phase 1: Create Test Sessions

Create **7 sessions** with distinct conversation patterns. Each targets specific pipeline behaviors.

For each session:

1. Open WebSocket → `load_agent` with `travel/TravelDesk_Supervisor` → get `sessionId`
2. Send messages (wait for `response_end` between each)
3. Close session via REST API
4. Record the `sessionId`

### WebSocket Connection Template

```javascript
const ws = new (require('ws'))(`ws://localhost:3112/ws?token=${TOKEN}`);
ws.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.type === 'info') {
    ws.send(JSON.stringify({ type: 'load_agent', agentPath: 'travel/TravelDesk_Supervisor' }));
  }
  if (m.type === 'agent_loaded') {
    console.log('Session:', m.sessionId);
    // Send first message:
    ws.send(JSON.stringify({ type: 'send_message', sessionId: m.sessionId, text: 'YOUR MESSAGE' }));
  }
  if (m.type === 'response_end') {
    console.log('Agent:', m.fullText);
    // Send next message or close
  }
});
```

---

### S1: Happy Booking Flow (Resolved)

**Route**: Supervisor → `Sales_Agent` → `Payment_Agent`
**Purpose**: Positive sentiment, clear booking intent, high quality, `contained_resolved` outcome

**Messages** (wait for agent response between each):

```
1. "Hi, I'd like to book a flight from New York to Los Angeles for next week"
2. "The Delta flight at $285 looks great, I'll take that one"
3. "Yes, please create a quote for that flight"
4. "Yes, go ahead and process the payment"
5. "Thanks so much, this was really easy!"
```

**Close** — `disposition: "completed"`:

```bash
curl -X POST "http://localhost:3112/api/projects/${PROJECT_ID}/sessions/${S1_ID}/close" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"disposition": "completed"}'
```

**Expected pipeline results**:

| Pipeline      | Expected                                                      |
| ------------- | ------------------------------------------------------------- |
| Sentiment     | Positive trajectory, no frustration                           |
| Intent        | `new_booking` / `flight_booking` / `travel_search`            |
| Quality       | High overall score (helpful, accurate, resolved)              |
| Outcome       | `contained_resolved`, method=`llm_evaluated`, goal_achieved=1 |
| Hallucination | Low/no hallucination (mock tools return real data)            |
| Knowledge Gap | No gaps detected (agent had tools to answer)                  |
| Guardrail     | No violations                                                 |
| Friction      | Low friction score                                            |

---

### S2: Frustrated Complaint (Escalated)

**Route**: Supervisor → `Live_Agent_Transfer`
**Purpose**: Strong negative sentiment, frustration, escalated outcome, guardrail test

**Messages**:

```
1. "I am absolutely furious! My flight was cancelled without any notice and nobody has contacted me! This is completely unacceptable!"
2. "I've been a loyal customer for years and this is how you treat me? I want to speak to a manager immediately!"
3. "I don't care about your automated system, connect me to a real person right now!"
```

**Close** — `disposition: "transferred"`:

```bash
curl -X POST "http://localhost:3112/api/projects/${PROJECT_ID}/sessions/${S2_ID}/close" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"disposition": "transferred"}'
```

**Expected pipeline results**:

| Pipeline      | Expected                                                           |
| ------------- | ------------------------------------------------------------------ |
| Sentiment     | Negative avg (<-0.3), declining trajectory, frustration_detected=1 |
| Intent        | `complaint` / `escalation` / `human_transfer`                      |
| Quality       | Lower score (couldn't resolve, escalated)                          |
| Outcome       | `escalated`, method=`heuristic` (escalation traces present)        |
| Hallucination | N/A or low (short interaction)                                     |
| Knowledge Gap | Possible gap (couldn't handle complaint)                           |
| Guardrail     | Check for tone handling                                            |
| Friction      | Moderate-high friction (user frustration)                          |

---

### S3: Booking Management — Change Dates (Resolved)

**Route**: Supervisor → `Authentication_Agent` → `Booking_Manager` (→ `Fee_Calculator` delegate)
**Purpose**: Multi-agent handoff, neutral sentiment, booking management intent, context preservation

**Messages**:

```
1. "I need to change the dates on my existing flight booking"
2. "I'll verify with my booking reference: BK-12345, last name Doe"
3. "I'd like to change my flight to March 21st please"
4. "Yes, I accept the $50 change fee"
5. "Great, thank you!"
```

**Close** — `disposition: "completed"`:

```bash
curl -X POST "http://localhost:3112/api/projects/${PROJECT_ID}/sessions/${S3_ID}/close" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"disposition": "completed"}'
```

**Expected pipeline results**:

| Pipeline      | Expected                                                      |
| ------------- | ------------------------------------------------------------- |
| Sentiment     | Neutral to slightly positive                                  |
| Intent        | `manage_booking` / `booking_modification` / `date_change`     |
| Quality       | Good score (resolved efficiently across agents)               |
| Outcome       | `contained_resolved`, method=`llm_evaluated`, goal_achieved=1 |
| Hallucination | Low (tool-backed responses)                                   |
| Knowledge Gap | No gaps                                                       |
| Guardrail     | No violations                                                 |
| Friction      | Low (smooth multi-agent flow)                                 |

---

### S4: Confused Customer (Unresolved)

**Route**: Supervisor → `Fallback_Handler` (2 rounds max)
**Purpose**: Friction detection, unclear intent, unresolved outcome

**Messages**:

```
1. "umm I'm not really sure what I need help with"
2. "No, none of those options are what I'm looking for"
3. "I still don't understand, this doesn't help"
4. "Never mind, forget it"
```

**Close** — `disposition: "completed"`:

```bash
curl -X POST "http://localhost:3112/api/projects/${PROJECT_ID}/sessions/${S4_ID}/close" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"disposition": "completed"}'
```

**Expected pipeline results**:

| Pipeline      | Expected                                                        |
| ------------- | --------------------------------------------------------------- |
| Sentiment     | Slightly negative, possible frustration                         |
| Intent        | Low confidence, unclear / `general_help`                        |
| Quality       | Lower score (couldn't help customer)                            |
| Outcome       | `contained_unresolved`, method=`llm_evaluated`, goal_achieved=0 |
| Hallucination | Low (fallback doesn't generate claims)                          |
| Knowledge Gap | Possible gap (couldn't determine customer need)                 |
| Guardrail     | No violations                                                   |
| Friction      | **High friction score** (repetition, confusion, no resolution)  |

---

### S5: Cancellation with Refund (Resolved)

**Route**: Supervisor → `Authentication_Agent` → `Booking_Manager` (→ `Refund_Processor` delegate)
**Purpose**: Cancellation intent, delegation chain, resolved outcome

**Messages**:

```
1. "I need to cancel my flight booking"
2. "My email is john@example.com"
3. "The verification code is 123456"
4. "Cancel booking BK-LM-12345 please"
5. "Yes, I understand the cancellation fee. Please proceed with the refund."
6. "Thanks for processing that"
```

**Close** — `disposition: "completed"`:

```bash
curl -X POST "http://localhost:3112/api/projects/${PROJECT_ID}/sessions/${S5_ID}/close" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"disposition": "completed"}'
```

**Expected pipeline results**:

| Pipeline      | Expected                                                      |
| ------------- | ------------------------------------------------------------- |
| Sentiment     | Neutral                                                       |
| Intent        | `cancellation` / `booking_cancellation`                       |
| Quality       | Good score (handled cancellation properly)                    |
| Outcome       | `contained_resolved`, method=`llm_evaluated`, goal_achieved=1 |
| Hallucination | Low (tool-backed refund amounts)                              |
| Knowledge Gap | No gaps                                                       |
| Guardrail     | No violations                                                 |
| Friction      | Low (smooth flow despite cancellation)                        |

---

### S6: Abandoned Session

**Route**: Supervisor → `Welcome_Agent` (returns to supervisor, no follow-up)
**Purpose**: Abandoned outcome via heuristic, minimal data

**Messages**:

```
1. "Hello"
```

(Wait for response, then close immediately without further interaction)

**Close** — `disposition: "abandoned"`:

```bash
curl -X POST "http://localhost:3112/api/projects/${PROJECT_ID}/sessions/${S6_ID}/close" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"disposition": "abandoned"}'
```

**Expected pipeline results**:

| Pipeline      | Expected                                                                      |
| ------------- | ----------------------------------------------------------------------------- |
| Sentiment     | Neutral (only 1 message)                                                      |
| Intent        | `greeting` or low confidence                                                  |
| Quality       | **Skipped** — event filter `payload.status == 'completed'` excludes abandoned |
| Outcome       | `abandoned`, method=`heuristic`                                               |
| Hallucination | **Skipped** (same event filter)                                               |
| Knowledge Gap | **Skipped**                                                                   |
| Guardrail     | **Skipped**                                                                   |
| Friction      | **Skipped**                                                                   |

> **Note**: Only sentiment and intent pipelines trigger for non-completed sessions. Quality, hallucination, knowledge-gap, guardrail, and friction all have `eventFilter: payload.status == 'completed'`.

---

### S7: Multi-Turn Search Without Booking (Partial)

**Route**: Supervisor → `Sales_Agent`
**Purpose**: Context preservation across turns, partial outcome, knowledge gap (didn't complete)

**Messages**:

```
1. "I'm looking at flights from New York to Paris for next month"
2. "What hotels are available in Paris?"
3. "Do you have any package deals for New York to Paris?"
4. "Hmm, let me think about it. I'll come back later."
5. "Bye"
```

**Close** — `disposition: "completed"`:

```bash
curl -X POST "http://localhost:3112/api/projects/${PROJECT_ID}/sessions/${S7_ID}/close" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"disposition": "completed"}'
```

**Expected pipeline results**:

| Pipeline      | Expected                                                     |
| ------------- | ------------------------------------------------------------ |
| Sentiment     | Neutral, stable trajectory                                   |
| Intent        | `travel_search` / `new_booking`                              |
| Quality       | Moderate score (helpful but no conversion)                   |
| Outcome       | `contained_partial`, method=`llm_evaluated`, goal_achieved=0 |
| Hallucination | Low (search results from tools)                              |
| Knowledge Gap | Possible (customer left without deciding)                    |
| Guardrail     | No violations                                                |
| Friction      | Low-moderate                                                 |

---

## Phase 2: Trigger Pipelines

Since there's no Kafka in docker-compose, trigger via **Restate HTTP ingress** (port `8090`).

### 2.1 Trigger Function

```bash
trigger_pipelines() {
  local SESSION_ID=$1
  local STATUS=$2        # "completed" or "abandoned"
  local DISPOSITION=$3   # "completed", "abandoned", "transferred"
  local MSG_COUNT=$4
  local END_REASON=${5:-"user_close"}

  echo "───────────────────────────────────────────"
  echo "Triggering pipelines for session ${SESSION_ID}"
  echo "  status=${STATUS}, disposition=${DISPOSITION}, messages=${MSG_COUNT}"

  curl -s -X POST "http://localhost:8090/PipelineTrigger/handleEvent" \
    -H "Content-Type: application/json" \
    -d '{
      "eventId": "test-evt-'${SESSION_ID:0:8}'",
      "type": "session.ended",
      "tenantId": "'${TENANT_ID}'",
      "projectId": "'${PROJECT_ID}'",
      "sessionId": "'${SESSION_ID}'",
      "agentName": "TravelDesk_Supervisor",
      "channel": "web_debug",
      "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%S.000Z)'",
      "payload": {
        "status": "'${STATUS}'",
        "disposition": "'${DISPOSITION}'",
        "messageCount": '${MSG_COUNT}',
        "endReason": "'${END_REASON}'"
      }
    }' | jq .
  echo ""
}
```

### 2.2 Trigger Each Session

```bash
# S1: Happy booking (completed)
trigger_pipelines "${S1_ID}" "completed" "completed" 10

# S2: Frustrated complaint (transferred/escalated)
trigger_pipelines "${S2_ID}" "completed" "transferred" 6

# S3: Booking management — change dates (completed)
trigger_pipelines "${S3_ID}" "completed" "completed" 10

# S4: Confused customer (completed but unresolved)
trigger_pipelines "${S4_ID}" "completed" "completed" 8

# S5: Cancellation with refund (completed)
trigger_pipelines "${S5_ID}" "completed" "completed" 12

# S6: Abandoned
trigger_pipelines "${S6_ID}" "abandoned" "abandoned" 2 "timeout"

# S7: Multi-turn search, no buy (completed)
trigger_pipelines "${S7_ID}" "completed" "completed" 10
```

### 2.3 Wait for Processing

Pipeline execution is async. Wait ~60-90 seconds for LLM calls to complete.

Check Restate for invocation status:

```bash
curl -s http://localhost:9070/invocations | jq '.invocations[] | {id: .id, target: .target, status: .status}'
```

Check pipeline run records in MongoDB:

```bash
mongosh "mongodb://abl_admin:abl_dev_password@localhost:27018/abl_platform?authSource=admin" \
  --eval "db.pipeline_run_records.find({tenantId:'tenant-dev-001'}).sort({createdAt:-1}).limit(20).toArray()" \
  --quiet | jq '.[] | {_id, pipelineId: .pipelineId, status, createdAt}'
```

---

## Phase 3: Verify Results — Kafka-Triggered Pipelines

### 3.1 Sentiment Analysis

**Tables**: `conversation_sentiment` (1 row/session), `message_sentiment` (1 row/message)

```bash
# Conversation-level sentiment
curl -s "http://localhost:8124" --data-urlencode "query=
SELECT
  session_id,
  agent_name,
  avg_sentiment,
  start_sentiment,
  end_sentiment,
  sentiment_trajectory,
  frustration_detected,
  frustration_turn_count
FROM abl_platform.conversation_sentiment
WHERE tenant_id = 'tenant-dev-001'
ORDER BY processed_at DESC
LIMIT 10
FORMAT PrettyCompact"
```

**Expected**:

| Session             | avg_sentiment | trajectory          | frustration |
| ------------------- | ------------- | ------------------- | ----------- |
| S1 (happy booking)  | > 0.3         | improving or stable | 0           |
| S2 (frustrated)     | < -0.3        | declining           | 1           |
| S3 (change dates)   | ~0 to 0.3     | stable              | 0           |
| S4 (confused)       | < 0           | declining           | 0 or 1      |
| S5 (cancellation)   | ~0            | stable              | 0           |
| S6 (abandoned)      | ~0            | stable              | 0           |
| S7 (search, no buy) | ~0            | stable              | 0           |

```bash
# Message-level sentiment (spot-check S2 for frustration)
curl -s "http://localhost:8124" --data-urlencode "query=
SELECT turn_index, role, sentiment_score, sentiment_label, frustration_flag
FROM abl_platform.message_sentiment
WHERE tenant_id = 'tenant-dev-001' AND session_id = '${S2_ID}'
ORDER BY turn_index
FORMAT PrettyCompact"
```

### 3.2 Intent Classification

**Table**: `intent_classifications` (1 row/session)

```bash
curl -s "http://localhost:8124" --data-urlencode "query=
SELECT
  session_id,
  intent_label,
  intent_category,
  confidence,
  sub_intents,
  is_multi_intent
FROM abl_platform.intent_classifications
WHERE tenant_id = 'tenant-dev-001'
ORDER BY processed_at DESC
LIMIT 10
FORMAT PrettyCompact"
```

**Expected**:

| Session             | Expected Intent                                    | Confidence |
| ------------------- | -------------------------------------------------- | ---------- |
| S1 (happy booking)  | `flight_booking` / `new_booking` / `travel_search` | > 0.8      |
| S2 (frustrated)     | `complaint` / `escalation`                         | > 0.8      |
| S3 (change dates)   | `booking_modification` / `manage_booking`          | > 0.7      |
| S4 (confused)       | unclear / `general_help`                           | < 0.5      |
| S5 (cancellation)   | `cancellation` / `booking_cancellation`            | > 0.8      |
| S6 (abandoned)      | `greeting`                                         | low        |
| S7 (search, no buy) | `travel_search`                                    | > 0.7      |

### 3.3 Quality Evaluation

**Table**: `quality_evaluations` (1 row/session, only `status=completed`)

```bash
curl -s "http://localhost:8124" --data-urlencode "query=
SELECT
  session_id,
  overall_score,
  helpfulness,
  accuracy,
  professionalism,
  flagged
FROM abl_platform.quality_evaluations
WHERE tenant_id = 'tenant-dev-001'
ORDER BY processed_at DESC
LIMIT 10
FORMAT PrettyCompact"
```

**Expected** (S6 will not have a row — abandoned, filter skips it):

| Session             | overall_score | Notes                                |
| ------------------- | ------------- | ------------------------------------ |
| S1 (happy booking)  | > 4.0         | Fully resolved, efficient            |
| S2 (frustrated)     | 2.0 – 3.5     | Escalated, couldn't resolve directly |
| S3 (change dates)   | > 3.5         | Successfully modified booking        |
| S4 (confused)       | < 3.0         | Couldn't help the customer           |
| S5 (cancellation)   | > 3.5         | Handled cancellation properly        |
| S7 (search, no buy) | 3.0 – 4.0     | Helpful but no conversion            |

### 3.4 Outcome Classification (NEW)

**Table**: `conversation_outcomes` (1 row/session)

```bash
curl -s "http://localhost:8124" --data-urlencode "query=
SELECT
  session_id,
  outcome,
  outcome_method,
  confidence,
  goal_detected,
  goal_achieved,
  outcome_reasoning
FROM abl_platform.conversation_outcomes
WHERE tenant_id = 'tenant-dev-001'
ORDER BY processed_at DESC
LIMIT 10
FORMAT PrettyCompact"
```

**Expected**:

| Session             | outcome                | method          | goal_achieved |
| ------------------- | ---------------------- | --------------- | ------------- |
| S1 (happy booking)  | `contained_resolved`   | `llm_evaluated` | 1             |
| S2 (frustrated)     | `escalated`            | `heuristic`     | NULL          |
| S3 (change dates)   | `contained_resolved`   | `llm_evaluated` | 1             |
| S4 (confused)       | `contained_unresolved` | `llm_evaluated` | 0             |
| S5 (cancellation)   | `contained_resolved`   | `llm_evaluated` | 1             |
| S6 (abandoned)      | `abandoned`            | `heuristic`     | NULL          |
| S7 (search, no buy) | `contained_partial`    | `llm_evaluated` | 0             |

Also verify MongoDB session.outcome was updated:

```bash
mongosh "mongodb://abl_admin:abl_dev_password@localhost:27018/abl_platform?authSource=admin" \
  --eval "db.conversations.find(
    { tenantId: 'tenant-dev-001' },
    { _id: 1, status: 1, outcome: 1, disposition: 1, currentAgent: 1 }
  ).sort({ updatedAt: -1 }).limit(10).toArray()"
```

### 3.5 Hallucination Detection

**Table**: `hallucination_evaluations` (1 row/session, only `status=completed`)

```bash
curl -s "http://localhost:8124" --data-urlencode "query=
SELECT
  session_id,
  overall_score,
  flagged,
  model_id
FROM abl_platform.hallucination_evaluations
WHERE tenant_id = 'tenant-dev-001'
ORDER BY processed_at DESC
LIMIT 10
FORMAT PrettyCompact"
```

**Expected**: 6 rows (S1-S5, S7). S6 excluded (abandoned). Most sessions should have low hallucination scores since mock tools return consistent data.

### 3.6 Knowledge Gap

**Table**: `knowledge_gap_evaluations` (1 row/session, only `status=completed`)

```bash
curl -s "http://localhost:8124" --data-urlencode "query=
SELECT
  session_id,
  overall_score,
  flagged,
  model_id
FROM abl_platform.knowledge_gap_evaluations
WHERE tenant_id = 'tenant-dev-001'
ORDER BY processed_at DESC
LIMIT 10
FORMAT PrettyCompact"
```

**Expected**: S4 (confused) and possibly S7 (didn't convert) should show higher knowledge gap scores than S1/S3/S5.

### 3.7 Guardrail Analysis

**Table**: `guardrail_evaluations` (1 row/session, only `status=completed`)

```bash
curl -s "http://localhost:8124" --data-urlencode "query=
SELECT
  session_id,
  overall_score,
  flagged,
  model_id
FROM abl_platform.guardrail_evaluations
WHERE tenant_id = 'tenant-dev-001'
ORDER BY processed_at DESC
LIMIT 10
FORMAT PrettyCompact"
```

**Expected**: S2 (frustrated complaint with aggressive language) is most likely to flag guardrail concerns. Others should pass.

### 3.8 Friction Detection

**Table**: `friction_detections` (1 row/session, only `status=completed`)

```bash
curl -s "http://localhost:8124" --data-urlencode "query=
SELECT
  session_id,
  friction_score,
  flagged,
  agent_name
FROM abl_platform.friction_detections
WHERE tenant_id = 'tenant-dev-001'
ORDER BY processed_at DESC
LIMIT 10
FORMAT PrettyCompact"
```

**Expected**:

| Session             | friction_score | flagged  |
| ------------------- | -------------- | -------- |
| S1 (happy booking)  | Low            | 0        |
| S2 (frustrated)     | Moderate-high  | possible |
| S3 (change dates)   | Low            | 0        |
| S4 (confused)       | **High**       | **1**    |
| S5 (cancellation)   | Low            | 0        |
| S7 (search, no buy) | Low-moderate   | 0        |

---

## Phase 4: Verify Materialized Views + Analytics API

### 4.1 Daily Rollup Materialized Views

```bash
# Sentiment daily rollup
curl -s "http://localhost:8124" --data-urlencode "query=
SELECT * FROM abl_platform.mv_daily_sentiment
WHERE tenant_id = 'tenant-dev-001' ORDER BY day DESC LIMIT 5
FORMAT PrettyCompact"

# Intent daily distribution
curl -s "http://localhost:8124" --data-urlencode "query=
SELECT * FROM abl_platform.mv_daily_intent_distribution
WHERE tenant_id = 'tenant-dev-001' ORDER BY day DESC LIMIT 5
FORMAT PrettyCompact"

# Quality daily scores
curl -s "http://localhost:8124" --data-urlencode "query=
SELECT * FROM abl_platform.mv_daily_quality_scores
WHERE tenant_id = 'tenant-dev-001' ORDER BY day DESC LIMIT 5
FORMAT PrettyCompact"

# Outcome daily rollup (NEW)
curl -s "http://localhost:8124" --data-urlencode "query=
SELECT * FROM abl_platform.mv_daily_outcomes
WHERE tenant_id = 'tenant-dev-001' ORDER BY day DESC LIMIT 5
FORMAT PrettyCompact"
```

### 4.2 Pipeline Analytics API

```bash
# Sentiment summary
curl -s "http://localhost:3112/api/projects/${PROJECT_ID}/pipeline-analytics/sentiment_analysis/summary?period=7d" \
  -H "Authorization: Bearer ${TOKEN}" | jq .

# Sentiment breakdown by agent
curl -s "http://localhost:3112/api/projects/${PROJECT_ID}/pipeline-analytics/sentiment_analysis/breakdown?dimension=agent_name" \
  -H "Authorization: Bearer ${TOKEN}" | jq .

# Intent breakdown by intent label
curl -s "http://localhost:3112/api/projects/${PROJECT_ID}/pipeline-analytics/intent_classification/breakdown?dimension=intent" \
  -H "Authorization: Bearer ${TOKEN}" | jq .

# Quality summary
curl -s "http://localhost:3112/api/projects/${PROJECT_ID}/pipeline-analytics/quality_evaluation/summary?period=7d" \
  -H "Authorization: Bearer ${TOKEN}" | jq .

# Per-session quality detail
curl -s "http://localhost:3112/api/projects/${PROJECT_ID}/pipeline-analytics/quality_evaluation/conversation/${S1_ID}" \
  -H "Authorization: Bearer ${TOKEN}" | jq .

# Friction conversations (flagged)
curl -s "http://localhost:3112/api/projects/${PROJECT_ID}/pipeline-analytics/friction_detection/conversations?filter=flagged:true" \
  -H "Authorization: Bearer ${TOKEN}" | jq .

# Timeseries (daily trend)
curl -s "http://localhost:3112/api/projects/${PROJECT_ID}/pipeline-analytics/sentiment_analysis/timeseries?period=7d" \
  -H "Authorization: Bearer ${TOKEN}" | jq .
```

### 4.3 Containment Rate Query (The #1 Customer Ask)

```bash
curl -s "http://localhost:8124" --data-urlencode "query=
SELECT
  countIf(outcome LIKE 'contained%') AS contained,
  countIf(outcome = 'contained_resolved') AS resolved,
  countIf(outcome = 'contained_partial') AS partial,
  countIf(outcome = 'contained_unresolved') AS unresolved,
  countIf(outcome = 'escalated') AS escalated,
  countIf(outcome = 'abandoned') AS abandoned,
  count() AS total,
  round(countIf(outcome LIKE 'contained%') / count(), 3) AS containment_rate
FROM abl_platform.conversation_outcomes
WHERE tenant_id = 'tenant-dev-001'
FORMAT PrettyCompact"
```

**Expected** (7 sessions):

- contained: 4 (S1, S3, S5 resolved + S7 partial)
- resolved: 3 (S1, S3, S5)
- partial: 1 (S7)
- unresolved: 1 (S4)
- escalated: 1 (S2)
- abandoned: 1 (S6)
- total: 7
- containment_rate: ~0.714

---

## Phase 5: Schedule-Triggered Pipelines (Anomaly + Drift)

Anomaly and drift pipelines operate on **pre-aggregated materialized views**, not individual sessions. They require baseline data to detect deviations.

### 5.1 Prerequisite: Sufficient Baseline Data

These pipelines need data in the materialized views to work. After running Phase 1-4, you should have:

- `mv_daily_sentiment` — 1 row per day
- `mv_daily_quality_scores` — 1 row per day

For meaningful anomaly/drift detection, you'd ideally need **7+ days** of data. For a smoke test, you can trigger them manually via Restate.

### 5.2 Trigger Anomaly Detection Manually

```bash
curl -s -X POST "http://localhost:8090/PipelineTrigger/triggerManual" \
  -H "Content-Type: application/json" \
  -d '{
    "pipelineId": "builtin:anomaly-detection",
    "tenantId": "tenant-dev-001",
    "triggeredBy": "manual-test",
    "data": {
      "tenantId": "tenant-dev-001",
      "projectId": "'${PROJECT_ID}'"
    }
  }' | jq .
```

### 5.3 Trigger Drift Detection Manually

```bash
curl -s -X POST "http://localhost:8090/PipelineTrigger/triggerManual" \
  -H "Content-Type: application/json" \
  -d '{
    "pipelineId": "builtin:drift-detection",
    "tenantId": "tenant-dev-001",
    "triggeredBy": "manual-test",
    "data": {
      "tenantId": "tenant-dev-001",
      "projectId": "'${PROJECT_ID}'"
    }
  }' | jq .
```

### 5.4 Verify Results

```bash
# Anomaly detections
curl -s "http://localhost:8124" --data-urlencode "query=
SELECT * FROM abl_platform.anomaly_detections
WHERE tenant_id = 'tenant-dev-001'
ORDER BY processed_at DESC LIMIT 10
FORMAT PrettyCompact"

# Drift detections
curl -s "http://localhost:8124" --data-urlencode "query=
SELECT * FROM abl_platform.drift_detections
WHERE tenant_id = 'tenant-dev-001'
ORDER BY processed_at DESC LIMIT 10
FORMAT PrettyCompact"
```

> **Note**: With only 1 day of data, these may not produce meaningful results. This is expected — they're designed for ongoing monitoring, not single-day analysis.

---

## Pipeline Testability Summary

| Pipeline                | Seeded           | Trigger                | Testable       | Sessions                     |
| ----------------------- | ---------------- | ---------------------- | -------------- | ---------------------------- |
| Sentiment Analysis      | Yes              | kafka (all)            | **Full E2E**   | All 7                        |
| Intent Classification   | Yes              | kafka (all)            | **Full E2E**   | All 7                        |
| Quality Evaluation      | Yes              | kafka (completed only) | **Full E2E**   | S1-S5, S7                    |
| Outcome Classification  | Yes (in quality) | kafka (completed only) | **Full E2E**   | All 7 (heuristic for S2, S6) |
| Hallucination Detection | Yes              | kafka (completed only) | **Full E2E**   | S1-S5, S7                    |
| Knowledge Gap           | Yes              | kafka (completed only) | **Full E2E**   | S1-S5, S7                    |
| Guardrail Analysis      | Yes              | kafka (completed only) | **Full E2E**   | S1-S5, S7                    |
| Friction Detection      | Yes              | kafka (completed only) | **Full E2E**   | S1-S5, S7                    |
| Anomaly Detection       | Yes              | schedule (hourly)      | **Smoke test** | Needs baseline               |
| Drift Detection         | Yes              | schedule (daily)       | **Smoke test** | Needs baseline               |

---

## Checklist

```
Phase 0: Infrastructure
  [ ] docker compose up (mongo, clickhouse, redis, restate)
  [ ] pnpm build
  [ ] seed pipelines — CLICKHOUSE_URL=http://localhost:8124 pnpm tsx scripts/seed-pipelines.ts
  [ ] start runtime — cd apps/runtime && pnpm dev
  [ ] start pipeline engine — cd packages/pipeline-engine && pnpm dev
  [ ] register pipeline engine with Restate
  [ ] enable 7 kafka-triggered pipelines
  [ ] verify travel supervisor loads via WebSocket

Phase 1: Create Sessions
  [ ] S1: Happy booking flow → record sessionId: ________________
  [ ] S2: Frustrated complaint → record sessionId: ________________
  [ ] S3: Change dates → record sessionId: ________________
  [ ] S4: Confused customer → record sessionId: ________________
  [ ] S5: Cancellation with refund → record sessionId: ________________
  [ ] S6: Abandoned session → record sessionId: ________________
  [ ] S7: Multi-turn search → record sessionId: ________________
  [ ] Close all sessions with correct disposition

Phase 2: Trigger Pipelines
  [ ] Trigger handleEvent for all 7 sessions via Restate ingress (port 8090)
  [ ] Wait 60-90 seconds for LLM processing
  [ ] Verify pipeline run records in MongoDB (status: 'completed')

Phase 3: Verify Kafka-Triggered Pipelines
  [ ] conversation_sentiment — 7 rows, S2 negative/frustrated
  [ ] message_sentiment — per-message scores for S2
  [ ] intent_classifications — 7 rows, intents match expected
  [ ] quality_evaluations — 6 rows (no S6), scores reasonable
  [ ] conversation_outcomes — 7 rows, outcomes match expected
  [ ] MongoDB session.outcome field updated on all 7 sessions
  [ ] hallucination_evaluations — 6 rows, mostly low scores
  [ ] knowledge_gap_evaluations — 6 rows, S4 higher than others
  [ ] guardrail_evaluations — 6 rows, S2 most likely flagged
  [ ] friction_detections — 6 rows, S4 high friction flagged

Phase 4: Materialized Views + API
  [ ] mv_daily_sentiment populated
  [ ] mv_daily_intent_distribution populated
  [ ] mv_daily_quality_scores populated
  [ ] mv_daily_outcomes populated
  [ ] Pipeline analytics API returns data for all types
  [ ] Containment rate query returns ~0.714

Phase 5: Schedule-Triggered Pipelines
  [ ] Trigger anomaly detection via Restate triggerManual
  [ ] Trigger drift detection via Restate triggerManual
  [ ] Verify anomaly_detections table
  [ ] Verify drift_detections table
```

---

## Troubleshooting

| Issue                                     | Fix                                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `PipelineTrigger/handleEvent` returns 404 | Pipeline engine not registered with Restate. Re-run `curl -X POST http://localhost:9070/deployments ...`           |
| No rows in ClickHouse tables              | Check pipeline run records in MongoDB for errors. Check Restate invocations at `http://localhost:9070/invocations` |
| Quality pipeline skips a session          | Verify `payload.status` in trigger event is `"completed"` (not `"abandoned"`)                                      |
| Outcome says `heuristic_fallback`         | LLM returned invalid outcome enum. Check LLM API key is configured. Check pipeline engine logs                     |
| Session not found during pipeline         | Verify session was properly closed before triggering pipeline                                                      |
| `ECONNREFUSED :8090`                      | Restate not running. Check `docker compose ps`                                                                     |
| `ECONNREFUSED :9080`                      | Pipeline engine not running. Start with `cd packages/pipeline-engine && pnpm dev`                                  |
| Agent won't load                          | Verify `examples/travel/` directory has `.agent.abl` files                                                         |
