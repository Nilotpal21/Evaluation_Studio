# Voice Metrics Implementation Plan

## Overview

This document outlines the implementation plan for tracking 10 key voice interaction metrics in the ABL Platform. Each metric is designed to answer a specific operational or quality question about voice channel performance.

| ID  | Customer Query                                                                     | Metric                               | Target  | Status     |
| --- | ---------------------------------------------------------------------------------- | ------------------------------------ | ------- | ---------- |
| 201 | What's our word error rate for voice interactions?                                 | WER                                  | < 10%   | ✅ Done    |
| 202 | How natural does our TTS voice sound to customers?                                 | Mean Opinion Score (Proxy + Network) | > 4.0   | ✅ Done    |
| 203 | What's the end-to-end voice response latency?                                      | User speech end → agent speech start | < 800ms | ✅ Done    |
| 204 | Are customers interrupting the agent because it talks too long?                    | Barge-in detection rate              | —       | ✅ Done    |
| 205 | How much dead air is in our voice conversations?                                   | Silence duration as % of call        | < 3%    | ✅ Done    |
| 206 | What's our voice containment rate?                                                 | Voice session containment tracking   | —       | ✅ Done    |
| 207 | Are callers hanging up before the agent finishes?                                  | Voice call abandonment rate          | —       | ✅ Done    |
| 208 | Is ASR accuracy worse for certain accents or languages?                            | WER segmented by language/accent     | —       | 🔲 Pending |
| 209 | How often do callers fall back to pressing buttons instead of speaking?            | DTMF fallback rate                   | —       | ✅ Done    |
| 210 | Are there cascade failures: bad audio → wrong ASR → wrong intent → wrong response? | ASR cascade failure detection        | —       | ✅ Done    |

---

## Infrastructure

The platform captures the following data points that serve as the foundation for these metrics:

| Layer         | What Exists                                                                                                                                                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trace Events  | `voice_session_start`, `voice_session_end`, `voice_turn`, `voice_stt`, `voice_tts`, `voice_barge_in`                                                                                                                                         |
| Timing        | `VoiceTimingBreakdown` with `sttLatency`, `llmLatency`, `ttsLatency`, `ttsFirstChunkLatency`, `totalLatency`                                                                                                                                 |
| STT Data      | `transcript`, `confidence`, `language_code` from Deepgram via `verb:hook`                                                                                                                                                                    |
| TTS Data      | `firstChunkMs`, `connectionMs`, `durationMs`, `streaming`, `provider`, `voice`, `chunks`                                                                                                                                                     |
| Session Data  | `disposition` (completed / abandoned / transferred), `isComplete`, `isEscalated`, `turnCount`, `channel`                                                                                                                                     |
| KoreVG Events | `verb:status` (start-playback, stop-playback, synthesized-audio), `call:status`, `tts:streaming-event`                                                                                                                                       |
| HEP / Homer   | heplify-server receives HEP from drachtio (SIP signaling, homer-id 10) and rtpengine (RTCP reports, homer-id 11). All data stored in Homer's database. Homer API v3 provides per-call SIP traces, QoS/RTCP quality data, and PCAP downloads. |
| Storage       | ClickHouse (trace_events, metrics, messages), MongoDB (sessions), Redis (live traces), Homer (SIP transactions, RTCP/QoS data)                                                                                                               |

### HEP Data Available via Homer API

heplify-server collects the following RTCP/RTP quality data per call, all queryable through Homer's API v3:

| QoS Metric                 | What it captures                                                  |
| -------------------------- | ----------------------------------------------------------------- |
| RTCP Jitter                | Inter-packet arrival variation (ms) — higher = choppier audio     |
| RTCP Packet Loss           | Cumulative packets not delivered — higher = garbled/missing audio |
| RTCP DLSR                  | Delay since last sender report — round-trip delay estimate        |
| SIP Session Response Delay | INVITE → 200 OK latency — SIP call setup time                     |
| SIP Method/Response Counts | INVITE, BYE, CANCEL, 200, 486, 487, etc. — signaling statistics   |

The **SIP Call-ID** (`sip_callid`) already captured in ABL's `session:new` payload is the join key to query Homer for per-call quality data.

From jitter + packet loss, a **network MOS** score (1.0–4.5 scale) is computed using the ITU-T G.107 E-model:

- R-factor = 93.2 − jitter_impact − packet_loss_impact
- MOS = 1 + 0.035R + R(R−60)(100−R)×7×10⁻⁶

Homer's API v3 endpoints used:

- `POST /api/v3/auth` — authentication (env vars: `HOMER_BASE_URL`, `HOMER_USERNAME`, `HOMER_PASSWORD`)
- `POST /api/v3/call/transaction` — SIP transaction ladder with signaling details and RTCP QoS reports
- `POST /api/v3/call/report/qos` — per-call QoS data (jitter, packet loss, MOS)
- `POST /api/v3/export/call/messages/pcap` — downloadable PCAP for deep inspection

The KoreVG-api-server already proxies the SIP trace and PCAP endpoints via `/RecentCalls/:call_id` and `/RecentCalls/:call_id/:method/pcap`.

---

## Architecture: Metrics Collection & Storage Flow

This section provides a complete view of how all 10 voice metrics are collected, processed, and stored.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          VOICE CALL COMPONENTS                               │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────┐      SIP/RTP       ┌──────────────┐     HEP Protocol    ┌─────────┐
│   Caller    │ ◄─────────────────► │   Jambonz    │ ───────────────────► │  Homer  │
│  (Phone)    │                     │  (SIP/Media) │                      │   DB    │
└─────────────┘                     └──────────────┘                      └─────────┘
                                           │                                    │
                                           │ WebSocket                          │
                                           │ (verb:hook, call:status)          │
                                           ▼                                    │
                                    ┌──────────────────────────┐               │
                                    │   KorevgSession          │               │
                                    │     (Runtime)            │               │
                                    │                          │               │
                                    │ ┌──────────────────────┐ │               │
                                    │ │ Metric Collection:   │ │               │
                                    │ │                      │ │               │
                                    │ │ 203: E2E Latency     │ │ ◄─────────────┘
                                    │ │   (per-turn timing)  │ │   API Calls:
                                    │ │                      │ │   - QoS/RTCP
                                    │ │ 204: Barge-in        │ │   - Network MOS
                                    │ │   (speech-bargein-   │ │   - SIP disconnect
                                    │ │    detected events)  │ │
                                    │ │                      │ │
                                    │ │ 205: Silence         │ │
                                    │ │   (accumulate agent/ │ │
                                    │ │    user/processing/  │ │
                                    │ │    silence time)     │ │
                                    │ │                      │ │
                                    │ │ 206: Containment     │ │
                                    │ │   (track completion/ │ │
                                    │ │    escalation/       │ │
                                    │ │    abandonment)      │ │
                                    │ │                      │ │
                                    │ │ 207: Abandonment     │ │
                                    │ │   (phase tracking +  │ │
                                    │ │    Homer disconnect  │ │
                                    │ │    attribution)      │ │
                                    │ │                      │ │
                                    │ │ 209: DTMF Fallback   │ │
                                    │ │   (detect data.digits│ │
                                    │ │    vs data.speech)   │ │
                                    │ └──────────────────────┘ │
                                    └──────────────────────────┘
                                               │
                              ┌────────────────┼────────────────┐
                              │                │                │
                              ▼                ▼                ▼
                    ┌─────────────────┐ ┌──────────────┐ ┌─────────────────┐
                    │ ASR Analyzer    │ │ Cascade      │ │ TTS Analyzer    │
                    │                 │ │ Detector     │ │                 │
                    │ 201: ASR Quality│ │              │ │ 202: TTS MOS    │
                    │   - Repetition  │ │ 210: Cascade │ │   - Proxy MOS   │
                    │   - Hesitation  │ │   - Network  │ │   - Network MOS │
                    │   - Correction  │ │   - ASR conf │ │   - Delivery    │
                    │   - Clarity     │ │   - Repetition│ │   - TTFB avg   │
                    │   - Confidence  │ │   - Short resp│ │   - Connection │
                    │   - Overall     │ │   - Clarify   │ │   - Chunks     │
                    │     score 0-100 │ │   - Risk 0-1  │ │                │
                    └─────────────────┘ └──────────────┘ └─────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│               TRACE EVENT EMISSION (per-metric breakdown)                    │
└─────────────────────────────────────────────────────────────────────────────┘

  KorevgSession.emitVoiceTraceEvent()
         │
         ├──► voice_session_start
         │    └─ Call metadata, timestamp
         │
         ├──► voice_stt (per-turn)
         │    ├─ 201: transcript, confidence, language
         │    └─ 209: inputMethod (dtmf vs speech)
         │
         ├──► voice_tts (per-turn)
         │    ├─ 202: chunks, TTFB, connectionMs
         │    └─ 202: streaming flag, provider, voice
         │
         ├──► voice_turn (per-turn)
         │    ├─ 203: E2E latency (speech end → TTS start)
         │    ├─ 204: bargeIn flag (true/false)
         │    └─ 209: inputMethod flag
         │
         ├──► voice_barge_in (per-interruption)
         │    └─ 204: type (speech/dtmf), timing, count
         │
         ├──► voice_tts_quality (session-end)
         │    ├─ 202: avgProxyMos (TTS delivery quality)
         │    ├─ 202: avgCombinedMos (proxy + network)
         │    ├─ 202: avgTtfbMs (first byte latency)
         │    ├─ 202: outboundNetworkMos (from Homer RTCP)
         │    └─ 202: ttsQualityTurns count
         │
         ├──► voice_asr_quality (session-end)
         │    ├─ 201: overallScore (0-100 quality)
         │    ├─ 201: signals (5 individual scores)
         │    ├─ 201: issues (detected problems)
         │    ├─ 201: detectorType (normalized/semantic)
         │    └─ 201: totalTurns analyzed
         │
         ├──► voice_asr_cascade (per-problematic-turn)
         │    ├─ 210: cascadeRisk (low/medium/high)
         │    ├─ 210: riskScore (0-1 scale)
         │    ├─ 210: contributingFactors (array)
         │    ├─ 210: rootCause (network/asr/mixed)
         │    ├─ 210: networkQuality (good/degraded/poor)
         │    └─ 210: recommendation (actionable text)
         │
         └──► voice_session_end (session-end)
              ├─ 203: avgE2eLatencyMs, p95, e2eMeasuredTurns
              ├─ 204: bargeInCount, bargeInRate
              ├─ 205: callDurationMs, agentSpeakingMs, userSpeakingMs
              ├─ 205: processingMs, silenceMs, silencePercent
              ├─ 206: sessionOutcome (completed/escalated/abandoned)
              ├─ 206: isComplete, isEscalated flags
              ├─ 207: abandonedPhase (greeting/conversation/escalation)
              ├─ 207: sipDisconnectInitiator (caller/callee/network)
              ├─ 207: sipStatusCode, sipDisconnectReason
              ├─ 209: dtmfTurnCount, dtmfFallbackRate
              ├─ 210: cascadeRiskTurns
              └─ Homer data: inboundNetworkMos, jitter, packetLoss

┌─────────────────────────────────────────────────────────────────────────────┐
│                          STORAGE LAYER                                       │
└─────────────────────────────────────────────────────────────────────────────┘

            TraceEvent Object
                   │
                   ▼
         ┌─────────────────┐
         │   TraceStore    │ ◄─── WebSocket Subscriptions
         │  (In-Memory)    │      (Studio real-time view)
         │  Ring Buffer    │
         └─────────────────┘
                   │
                   ▼
      ┌──────────────────────┐
      │ ClickHouseTraceStore │
      │  BufferedWriter      │
      │  (10K rows / 5s)     │
      └──────────────────────┘
                   │
                   │ Compress + Encrypt
                   ▼
      ┌──────────────────────────────────────────────────────┐
      │           ClickHouse: abl_platform.traces            │
      ├──────────────────────────────────────────────────────┤
      │  Columns:                                            │
      │   • event_type:                                      │
      │      - voice_session_start                           │
      │      - voice_stt          (203, 209)                 │
      │      - voice_tts          (202)                      │
      │      - voice_turn         (203, 204, 209)            │
      │      - voice_barge_in     (204)                      │
      │      - voice_tts_quality  (202)                      │
      │      - voice_asr_quality  (201)                      │
      │      - voice_asr_cascade  (210)                      │
      │      - voice_session_end  (all metrics summary)      │
      │                                                      │
      │   • data (encrypted JSON):                           │
      │      Contains metric-specific fields per event       │
      │                                                      │
      │  Partition: BY toYYYYMM(timestamp)                  │
      │  Order: (tenant_id, session_id, timestamp)          │
      └──────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                         UI DATA RETRIEVAL                                    │
└─────────────────────────────────────────────────────────────────────────────┘

    Studio UI (Browser)
           │
           │ GET /api/runtime/sessions/:id
           ▼
    ┌──────────────┐
    │ Studio API   │  Query ClickHouse for all voice_* events
    └──────────────┘  for the session
           │
           ▼
    ┌──────────────────────┐
    │ SessionSummaryPanel  │ ──► Extract & Display Metrics:
    │ (Voice Tab)          │
    └──────────────────────┘
           │
           ├──► 201: ASR Quality Card
           │    └─ Overall score, signals breakdown, issues
           │
           ├──► 202: TTS Quality Card
           │    └─ MOS scores (proxy, network, combined), TTFB
           │
           ├──► 203: E2E Response Latency Chart
           │    └─ Per-turn bars with color thresholds
           │
           ├──► 204: Barge-in Events List
           │    └─ Type, timing, count, rate
           │
           ├──► 205: Call Activity Breakdown
           │    └─ Stacked bar: agent/user/silence time
           │
           ├──► 206: Containment Badge
           │    └─ Completed/Escalated/Abandoned status
           │
           ├──► 207: Call Phase & Abandonment
           │    └─ Phase progression, disconnect attribution
           │
           ├──► 208: Language/Accent Segmentation
           │    └─ 🔲 Pending: Dashboard aggregation view
           │
           ├──► 209: DTMF Fallback Card
           │    └─ DTMF count, rate, per-turn indicators
           │
           └──► 210: ASR Cascade Detection Card
                └─ Risk summary, problematic turns, root causes
```

### Metrics Collection Summary

**KorevgSession (Direct Collection):**

- ✅ 203: E2E Latency (per-turn timing)
- ✅ 204: Barge-in Detection (speech-bargein-detected events)
- ✅ 205: Silence Duration (accumulate agent/user/processing/silence time)
- ✅ 206: Containment Rate (track completion/escalation/abandonment)
- ✅ 207: Call Abandonment (phase tracking + Homer disconnect attribution)
- ✅ 209: DTMF Fallback (detect data.digits vs data.speech)

**Specialized Analyzers:**

- ✅ 201: ASR Quality (ASR Analyzer - multi-signal analysis)
- ✅ 202: TTS MOS (TTS Analyzer - proxy + network MOS)
- ✅ 210: Cascade Detection (Cascade Detector - multi-signal risk scoring)

**Pending Implementation:**

- 🔲 208: Language/Accent Segmentation (ClickHouse aggregation + Dashboard)

**Storage Model:**

- Per-event storage: Each metric datapoint stored as a trace event in ClickHouse
- Event-driven: Metrics calculated real-time during call, emitted as events
- Encrypted: All trace event `data` payloads compressed then encrypted
- Buffered writes: Events batched (10K rows or 5s) for efficient ClickHouse insertion

---

## Metric Details

### 201 — Word Error Rate (WER) ✅

**Target:** < 10%

**Status:** ✅ Fully implemented.

**Challenge:** WER requires a reference transcript (ground truth) to compute `(Substitutions + Deletions + Insertions) / Total Words`. The platform does not have ground-truth transcripts — Deepgram provides a confidence score, not a WER value.

**✅ Implemented — Multi-Signal ASR Quality Score:**

Comprehensive ASR quality scoring without ground truth using pluggable detection architecture. Combines 5 signals with weighted scoring to produce 0-100 quality score:

1. **Repetition (25% weight)** — Detects repeated phrases using normalized string similarity with language-specific normalization (Latin, CJK, RTL, Indic scripts) and Jaccard similarity on token sets. High repetition indicates ASR confusion.
2. **Hesitation (15% weight)** — Detects filler words (um, uh, er, etc.) in multiple languages suggesting poor recognition quality.
3. **Correction (25% weight)** — Detects user correction patterns ("no, wait, I said...") indicating ASR errors.
4. **Clarity (20% weight)** — Flags short/fragmented transcripts (1-2 words) suggesting poor audio quality or ASR issues.
5. **Confidence (15% weight)** — Uses ASR confidence scores from Deepgram (inverted: low confidence = high issue score).

**Overall Score:** Weighted average producing 0-100 score where 100 = perfect quality.

**Pluggable Architecture:**

- Interface-based design (`IRepetitionDetector`) allows switching detection methods via environment variable
- **Normalized detector** (default): Fast string similarity with language-specific normalization
- **Semantic detector** (stub): Future ML-based embeddings for paraphrase detection
- **Hybrid detector** (stub): Combines both approaches for balanced speed and accuracy
- Factory pattern with `REPETITION_DETECTOR_TYPE` environment variable

**Trace events:**

- `voice_asr_quality` emitted at session end with: `overallScore`, `signals` (5 individual signal scores), `issues` (detected problems with severity), `totalTurns`, `detectorType`, `metadata`

**UI display:** ASR Quality card in Voice tab with intuitive design:

- Overall quality score (0-100) with color-coded gauge (green ≥85, amber 70-84, red <70)
- **Quality Metrics section** (higher = better): ASR Confidence %, Speech Clarity %
- **Issue Detection section** (lower = better): Repetition %, Hesitation %, Correction %
- Color-coded progress bars with standard UX patterns
- Issues list with severity badges (high/medium/low) and descriptions
- Detector type and turn count metadata

**Key design decision:** Metrics display transformed for intuitive UX. Backend signals represent "badness levels" (0 = good, 1 = bad), but UI flips confidence and clarity to show quality (higher = better) while keeping issue rates as-is (lower = better). This follows industry standard dashboard patterns.

**Where:** `repetition-detector.ts` (interface), `normalized-repetition-detector.ts` (361 lines, core implementation), `semantic-repetition-detector.ts` (stub), `hybrid-repetition-detector.ts` (stub), `repetition-detector-factory.ts` (factory), `voice-quality-analyzer.ts` (354 lines, 5-signal scoring), `korevg-session.ts` (ASR turn tracking, session-end analysis), `voice-trace.ts` (voice_asr_quality event type), `SessionSummaryPanel.tsx` (intuitive UI card), `types/index.ts` (type definitions).

---

### 202 — TTS Mean Opinion Score (MOS) ✅

**Target:** > 4.0

**Status:** ✅ Fully implemented (both dimensions complete).

**✅ Implemented — Dimension 2 — Network delivery quality:**

Inbound and outbound network MOS computed from RTCP jitter + packet loss via Homer API using ITU-T G.107 E-model. R-factor, jitter (ms), and packet loss displayed in the Voice tab's Network Quality card with MOS gauge visualization.

**✅ Implemented — Dimension 1 — TTS application quality (proxy score):**

Synthetic quality score (1.0–4.5 scale) computed from application-level signals:

- **TTS TTFB** — TTS-specific delays only (excludes LLM latency to avoid double-counting with silence breakdown)
  - **Streaming mode:** TTS connection time (measured on initial connection and reconnections)
  - **Non-streaming mode:** Actual TTS audio synthesis latency from start-playback event
  - < 300ms: Excellent (no penalty)
  - 300–800ms: Good (0.0–0.8 penalty)
  - > 800ms: Poor (0.8–1.8 penalty)
- **Connection latency** — TTS provider session establishment time
  - Tracked per-turn: `turnTtsConnectionMs` captures reconnections during call
  - Falls back to cached `ttsConnectionMs` if no reconnection occurred
  - < 200ms: Excellent (no penalty)
  - 200–500ms: Good (0.0–0.3 penalty)
  - > 500ms: Poor (0.3–0.8 penalty)
- **Chunk consistency** (streaming mode only) — Number of TTS chunks delivered
  - 0 chunks: Major quality issue (-1.5 penalty)
  - 1–2 chunks: Potential choppiness (-0.4 penalty)
  - ≥ 3 chunks: Good consistency (no penalty)
- **TTS errors** — Provider failures or stream retries (-1.0 penalty per error)
- **Barge-in signals** — User interruptions during agent speech (-0.2 penalty)

**Combined TTS MOS:** Weighted blend: 60% proxy MOS + 40% network MOS (outbound RTCP data). Falls back to proxy MOS only if network data unavailable.

**Trace events:**

- `voice_tts_quality` emitted per turn with: `proxyMos`, `ttsTotalTtfb`, `ttsFirstChunkMs`, `ttsConnectionMs`, `llmFirstChunkMs`, `chunkCount`, `streaming`, `hasError`, `bargeInOnTurn`
- Session-level aggregation in `voice_session_end`: `avgProxyMos`, `avgCombinedTtsMos`, `avgTtfbMs`, `ttsErrorCount`, `ttsQualityTurns`

**UI display:** TTS Quality card in Voice tab showing:

- Combined MOS (proxy + network) with color-coded gauge
- Proxy MOS (application-level quality)
- Network MOS (RTCP outbound quality)
- Average TTFB (TTS-specific delays only, shown in milliseconds)
- TTS error count with warning badge

**Implementation details:**

- **Per-turn connection tracking:** `turnTtsConnectionMs` captures reconnection latency when TTS stream closes/reopens during call
- **Stream reconnection detection:** When `stream_open` event occurs with buffered chunks, connection time is attributed to current turn
- **TTFB calculation:** Streaming mode uses TTS connection time only (not LLM latency); non-streaming uses actual audio synthesis latency
- **Homer RTCP integration:** Fixed dual Call-ID fallback (tries both `sipCallId` and `rtpCallId`) to ensure RTCP data capture

**Where:** `korevg-session.ts` (lines 97-206: proxy MOS scoring functions, lines 249-255: per-turn connection tracking, lines 676-698: stream reconnection detection, lines 1254-1283: TTFB calculation and trace emission, lines 1754-1779: session aggregation), `voice-trace.ts` (voice_tts_quality event type), `homer-client.ts` (dual Call-ID fallback for RTCP), `SessionSummaryPanel.tsx` (TTS Quality card with 4 metrics including avgTtfbMs).

**Optional enhancement — Post-call survey:**

Optional IVR or SMS survey after call end. Store the caller's rating (1–5) as a `voice_survey` trace event for calibrating the computed scores.

---

### 203 — End-to-End Voice Response Latency ✅

**Target:** < 800ms (user speech end → agent speech start)

**Status:** ✅ Implemented.

`verbHookArrivalTime` → first audio output tracked per turn. Streaming mode: measures to first LLM chunk (TTS tokens sent). Non-streaming mode: measures to `start-playback` verb:status. `timing.e2e` added to `voice_turn` trace event. `avgE2eLatencyMs` and `e2eMeasuredTurns` included in `voice_session_end`. UI displays per-turn latency bars with color-coded thresholds (< 800ms green, < 1500ms amber, ≥ 1500ms red) and a visual legend.

**Where:** `korevg-session.ts`, `SessionSummaryPanel.tsx`.

---

### 204 — Barge-in Detection Rate ✅

**Status:** ✅ Implemented.

Detects `speech-bargein-detected` and `dtmf-bargein-detected` verb:status events from Jambonz. Emits `voice_barge_in` trace event with type (speech/dtmf), agent speaking duration, and cumulative count. `bargeIn` flag added to `voice_turn`. `bargeInCount` and `bargeInRate` included in `voice_session_end`. UI displays Barge-in Events card with count, rate, and per-event details. Timeline shows ⚡ icon on barge-in turns with dedicated `voice_barge_in` nodes.

**Where:** `korevg-session.ts`, `SessionSummaryPanel.tsx`, `useSessionDetail.ts`, `AgentConversationTree.tsx`.

---

### 205 — Silence Duration as % of Call ✅

**Target:** < 3%

**Status:** ✅ Implemented.

Event-based silence tracking with three components:

1. **Processing silence** — E2E latency accumulated per turn when first TTS tokens sent (streaming) or `start-playback` received (non-streaming).
2. **Dead air** — gaps between `lastTtsActivityTime` (last agent audio stop) and next `verb:hook` arrival minus estimated user speaking time.
3. **Trailing silence** — gap after last TTS activity to call end (>500ms threshold).

Agent speaking derived as residual (`callDuration − silence − userSpeaking`) to avoid word-count overestimation. User speaking estimated from transcript word count at ~150 WPM. `callDurationMs` recorded at WebSocket close (before Homer delay).

UI: Call Activity stacked bar (Agent / User / Silence), Silence Breakdown sub-card (Processing + Dead Air = Silence total with derived rounding). Summary header shows "Duration" instead of "Latency" for voice sessions.

**Where:** `korevg-session.ts`, `SessionSummaryPanel.tsx`.

---

### 206 — Voice Containment Rate

**Status:** ✅ Implemented.

**Definition:** Containment = voice session resolved without human handoff or escalation. Tracks whether the AI agent successfully handled the customer's request (contained) vs. needing to transfer to a human agent (not contained).

**What was done:**

- **Session outcome tracking:** Added `sessionOutcome` state machine in `korevg-session.ts` that tracks:
  - `completed` — Agent triggered a `complete` action (AI successfully resolved the issue)
  - `escalated` — Agent triggered an `escalate` action (transferred to human)
  - `abandoned` — User hung up before completion
- **Action detection:** Parses ABL action responses to detect `action.type === 'complete'` and `action.type === 'escalate'`
- **Fallback logic:** Uses Homer disconnect data when outcome is unclear (checks SIP disconnect initiator and reason)
- **Trace event enrichment:** `voice_session_end` now includes `sessionOutcome` and `isContained` (boolean) fields
- **UI display:** Added Containment metric card to Voice tab in Studio with:
  - Color-coded status (green for contained, amber for escalated, red for abandoned)
  - Clear labels: "Contained" / "Escalated" / "Abandoned"
  - Subtitle showing AI resolved vs human transfer vs user hung up
- **Agent schema migration:** Fixed 47 compilation errors in TravelDesk Travel project by updating 11 agents to new ABL schema (removed deprecated `MODE:`, added `REASONING:` declarations)

**Where:** `korevg-session.ts` (outcome tracking), `SessionSummaryPanel.tsx` (UI display).

---

### 207 — Voice Call Abandonment Rate

**Status:** ✅ Implemented.

**Definition:** Tracks when and where users abandon calls to understand abandonment patterns. Uses a 4-phase model: `greeting` → `conversation` → `transfer` → `farewell`.

**What was done:**

- **4-Phase State Machine:** Flexible phase tracking with multi-level detection:
  - `greeting`: Session start until first user speech (speech or DTMF)
  - `conversation`: Default phase for main agent interactions
  - `transfer`: Detected when handoff to human agent is initiated (via `handoff_from` context or `escalate` action)
  - `farewell`: Detected when agent returns `complete` action
- **Phase detection methods (in priority order):**
  1. **Action-based detection:** Monitors agent action types (`complete` → farewell, `escalate` → transfer)
  2. **Handoff context detection:** Checks for `handoff_from` in stateUpdates context (e.g., "handoff_from: supervisor")
  3. **Pattern-based agent detection (fallback):** Matches agent names against patterns (`live_agent_transfer`, `escalate`, `farewell`, `goodbye`, etc.)
- **First user speech tracking:** Automatically transitions from `greeting` to `conversation` when user provides first input
- **Transfer abandonment logic:** When user hangs up during transfer phase:
  - If caller disconnects → `sessionOutcome: abandoned` (Option A: user didn't complete transfer)
  - If platform disconnects → `sessionOutcome: escalated` (transfer completed successfully)
- **Trace event enrichment:** `voice_session_end` now includes:
  - `callPhase`: Current phase when call ended
  - `currentAgent`: Name of the active agent
  - `sessionOutcome`: completed / abandoned / escalated
  - `abandonedDuringGreeting`: Boolean flag for greeting-phase abandonment
  - `abandonedDuringConversation`: Boolean flag for conversation-phase abandonment
  - `abandonedDuringTransfer`: Boolean flag for transfer-phase abandonment (users gave up waiting for human)
- **Disconnect attribution:** SIP disconnect initiator, method, status code from Homer
  - Increased Homer wait time from 3s to 5s to ensure BYE message is indexed before query
  - Prevents "unknown" disconnect initiator due to timing issues
- **UI display:** Call Phase metric card in Call Overview section showing:
  - Current phase label (Greeting / Conversation / Transfer / Farewell)
  - Active agent name when available
  - Color-coded warning for abandonment with contextual message ("User hung up waiting for human agent", etc.)
  - Disconnect initiator in "Disconnect By" field

**Where:** `korevg-session.ts` (phase state machine, action/handoff detection, containment logic), `SessionSummaryPanel.tsx` (UI display).

---

### 208 — WER Segmented by Language/Accent

**Status:** Raw data is already available. The `language_code` and `confidence` fields are captured per turn in `voice_stt` events. The caller's phone number (with country code) is available in `callInfo.from`.

**Homer enhancement:** RTCP quality data from Homer can be segmented by caller region. If a specific country/carrier segment shows low ASR confidence AND low inbound network MOS, the root cause is network quality rather than ASR weakness. This distinction helps avoid incorrectly attributing poor accuracy to the ASR provider when the real issue is degraded caller audio.

**Changes needed:**

- Derive `callerCountry` from the SIP `From` number's country code at session start and include it in `voice_stt` events
- Optionally geolocate `originatingSipIp` for region or accent inference
- At session end, include `inboundNetworkMos` from RTCP data to allow segmenting accuracy by network quality
- Create ClickHouse aggregation queries: average confidence grouped by `language_code`, `callerCountry`, and `inboundNetworkMos` band (good > 3.5, degraded 2.5–3.5, poor < 2.5), plus low-confidence turn rate per segment

**Where:** Minor enrichment in `korevg-session.ts` (caller country derivation); ClickHouse queries and Studio dashboard.

---

### 209 — DTMF Fallback Rate

**Status:** ✅ Implemented.

Jambonz bargeIn input expanded to `['speech', 'digits']` with DTMF-specific config. The `handleVerbHook` in `korevg-session.ts` detects `data.digits` (DTMF) vs `data.speech` and tracks input method per turn.

**Key implementation note:** Jambonz uses `'digits'` as the input type identifier (not `'dtmf'`). The initial implementation used `'dtmf'` which was silently ignored by Jambonz. This was discovered by comparing with sample apps in `korevg-client-apps/server-bargein-gather.js`. DTMF config properties (`interDigitTimeout`, `minDigits`, `finishOnKey`, `numDigits`) are also required for reliable digit collection.

**Homer note:** Homer captures SIP INFO DTMF and RFC 2833/4733 RTP DTMF events in the signaling. This provides a secondary confirmation source for DTMF events and their timing, useful for validating that the application-level DTMF detection is capturing all events.

**What was done:**

- Added `'digits'` to the bargeIn input array in `verb-builder.ts` (both streaming `buildStreamingConfig` and non-streaming `gather()`)
- Added DTMF config: `interDigitTimeout: 2`, `minDigits: 1`, `finishOnKey: '#'`, `numDigits: 12`
- In `korevg-session.ts` verb:hook handler, check for `data.digits` alongside `data.speech` and flag `inputMethod: 'dtmf' | 'speech'`
- Track cumulative `dtmfTurnCount` and emit `dtmfFallbackRate` in `voice_session_end`
- Added `inputMethod` field to `voice_stt` and `voice_turn` trace events
- UI: DTMF Input card in Call Overview, DTMF Fallback detail card, amber/Hash icon for DTMF in STT bars and timeline tree
- STT confidence calculation filters out DTMF turns to avoid skewing ASR quality metrics

**Where:** `verb-builder.ts`, `korevg-session.ts`, `SessionSummaryPanel.tsx`, `useSessionDetail.ts`, `AgentConversationTree.tsx`.

---

### 210 — ASR Cascade Failure Detection

**Status:** ✅ Implemented.

**Definition:** Detecting the failure chain where bad network → bad audio → wrong ASR → wrong intent → wrong response.

**Homer enhancement:** Network quality from RTCP data provides the **root cause** in the cascade chain. The detector can attribute failures to network issues vs ASR model issues.

**Implementation:** Multi-signal risk scoring system with weighted factors:

**5 Detection Signals:**

1. **Network Quality** (35% weight) - From Homer RTCP inbound MOS: poor (<2.5), degraded (2.5-3.5), good (≥3.5)
2. **ASR Confidence** (20-35% weight) - Very low (<0.5), low (<0.7), with consecutive tracking
3. **User Repetition** (25% weight) - History-based detection across last 5 substantive turns, skips filler words
4. **Minimal Response** (15% weight) - User gives ≤2 words after agent spoke >50 words
5. **Agent Clarification** (20% weight) - Detects patterns: "could you repeat", "didn't catch", "did you mean"

**Risk Scoring:**

- Low (< 0.4): Normal variation, no event emitted
- Medium (0.4-0.7): Potential cascade, emit trace event
- High (≥ 0.7): Clear cascade pattern, emit trace event

**Root Cause Attribution:**

- `network`: Poor/degraded network quality detected
- `asr`: Low confidence, repetition, or clarity issues without network problems
- `mixed`: Both network and ASR issues present
- `unknown`: No specific root cause identified (low-risk turns)

**Key Features:**

- History-based repetition detection (looks back 5 turns)
- Filters out short filler words ("what", "yes", "no") from history
- Regex-based clarification pattern matching
- Word count (not character count) for response length analysis
- Only emits events for medium/high risk (reduces noise)

**UI Display:**

- Card shows only problematic turns (medium/high risk)
- Risk summary with counts
- Per-turn details: score, factors, root cause, transcript, recommendation
- Color-coded severity (red=high, amber=medium)
- Actionable recommendations for each root cause type

**Where:** `asr-cascade-detector.ts` (detector implementation), `voice-trace.ts` (event type), `korevg-session.ts` (integration), `SessionSummaryPanel.tsx` (UI card), `types/index.ts` (trace event type).

---

## HEP Integration Pattern

All metrics that use RTCP/QoS data follow the same integration pattern — a single Homer API dependency.

**Post-call enrichment at session end:**

1. In `korevg-session.ts`, when `handleClose()` fires, before emitting `voice_session_end`:
2. Authenticate with Homer API (`POST /api/v3/auth`) to get a bearer token
3. Query Homer API (`POST /api/v3/call/report/qos`) for per-call RTCP QoS data (jitter, packet loss) filtered by the session's `sip_callid`
4. Compute inbound network MOS (caller → platform) and outbound network MOS (platform → caller) using the E-model
5. Query Homer API (`POST /api/v3/call/transaction`) for SIP signaling to determine disconnect initiator and terminal SIP status
6. Attach the results to the `voice_session_end` trace event and pass relevant values to the quality analyzers

**Fallback:** If Homer is unreachable, the metrics degrade gracefully — RTCP-dependent fields are set to `null`, and all application-level signals (confidence, barge-in, silence, etc.) continue to work independently.

**New runtime dependency:** `korevg-session.ts` requires access to Homer API (`HOMER_BASE_URL`, `HOMER_USERNAME`, `HOMER_PASSWORD`). The existing KoreVG-api-server homer-utils module (`homer-utils.js`) can be adapted or its logic replicated in the ABL runtime.

---

## New Trace Event Types

| Event Type          | When Emitted                         | Key Data Fields                                                                                                             | Status     |
| ------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `voice_barge_in`    | On barge-in detected                 | type (speech/dtmf), agentSpeakingDurationMs, cumulative count                                                               | ✅ Done    |
| `voice_tts_quality` | After each TTS delivery              | proxyMos, ttsTotalTtfb, ttsFirstChunkMs, ttsConnectionMs, llmFirstChunkMs, chunkCount, streaming, hasError, bargeInOnTurn   | ✅ Done    |
| `voice_asr_quality` | At session end                       | overallScore, signals (repetition, hesitation, correction, clarity, confidence), issues, totalTurns, detectorType, metadata | ✅ Done    |
| `voice_asr_cascade` | After turn if risk is medium or high | cascadeRisk, contributing signals, networkQuality                                                                           | 🔲 Pending |
| `voice_call_status` | On terminal call:status from KoreVG  | SIP status, reason, call duration                                                                                           | 🔲 Pending |

**Existing events enriched:**

| Event                                | New Fields                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Status     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| `voice_turn`                         | `e2eLatencyMs`, `inputMethod`, `bargeIn`                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | ✅ Done    |
| `voice_stt`                          | `inputMethod`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | ✅ Done    |
| `voice_session_end`                  | `bargeInCount`, `bargeInRate`, `dtmfTurnCount`, `dtmfFallbackRate`, `avgE2eLatencyMs`, `e2eMeasuredTurns`, `callDurationMs`, `silenceMs`, `silencePercent`, `processingSilenceMs`, `deadAirMs`, `userSpeakingMs`, `sipDisconnectInitiator`, `sipStatusCode`, `sipDisconnectReason`, `inboundNetworkMos`, `outboundNetworkMos`, `avgJitterMs`, `totalPacketLoss`, `avgProxyMos`, `avgCombinedTtsMos`, `avgTtfbMs`, `ttsErrorCount`, `ttsQualityTurns`, `sessionOutcome`, `isContained`, `callPhase`, `currentAgent` | ✅ Done    |
| `voice_session_end` (pending fields) | `callerCountry`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 🔲 Pending |
| `voice_session_start`                | `sipSetupLatencyMs` (from Homer QoS data)                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 🔲 Pending |

---

## Storage

A new `voice_call_metrics` ClickHouse table stores per-call aggregate metrics. This table is populated by a session-end summarizer that consolidates per-turn trace events into a single row per call.

**Key columns:**

| Category        | Fields                                                                           |
| --------------- | -------------------------------------------------------------------------------- |
| Identity        | tenant_id, session_id, call_sid, sip_callid, timestamp                           |
| Call-level      | call_duration_ms, turn_count, channel, disposition, abandoned_phase              |
| Latency         | avg_e2e_latency_ms, p95_e2e_latency_ms, sip_setup_latency_ms, avg_stt_confidence |
| ASR Quality     | low_confidence_turns, cascade_risk_turns, repetition_count                       |
| DTMF            | dtmf_turn_count                                                                  |
| Barge-in        | barge_in_count                                                                   |
| Silence         | agent_speaking_ms, user_speaking_ms, processing_ms, silence_ms, silence_percent  |
| TTS Quality     | proxy_mos_score, delivery_mos, combined_mos, avg_tts_ttfb_ms, tts_error_count    |
| Network Quality | inbound_network_mos, outbound_network_mos, avg_jitter_ms, total_packet_loss      |
| Disconnect      | sip_disconnect_initiator, sip_status_code, sip_disconnect_reason                 |
| Metadata        | language_code, caller_country, streaming_mode, stt_provider, tts_provider        |

Partitioned by month, ordered by (tenant_id, timestamp, session_id).

---

## Files Modified or Created

| File                                                       | Nature of Change                                                                                                                                                                                                                                                                                               | Status     |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `korevg-session.ts`                                        | E2E latency, barge-in detection, silence accumulators, DTMF detection, post-call Homer API queries for SIP disconnect and network MOS, TTS proxy MOS calculation, avgTtfbMs tracking with per-turn connection time, call phase state machine, session outcome tracking, ASR turn tracking and quality analysis | ✅ Done    |
| `verb-builder.ts`                                          | Added `'digits'` to bargeIn/gather input arrays, DTMF config props                                                                                                                                                                                                                                             | ✅ Done    |
| `homer-client.ts`                                          | Homer API v3 client (auth, QoS, SIP transactions, dual Call-ID fallback, E-model MOS, disconnect attribution)                                                                                                                                                                                                  | ✅ Done    |
| `voice-trace.ts`                                           | Registered `voice_barge_in`, `voice_tts_quality`, `voice_asr_quality` trace event types                                                                                                                                                                                                                        | ✅ Done    |
| `korevg-router.ts`                                         | Extracted `sbc_callid` from `session:new` payload                                                                                                                                                                                                                                                              | ✅ Done    |
| Studio `SessionSummaryPanel.tsx`                           | Voice tab with all implemented metrics (E2E, barge-in, silence, DTMF, TTS quality with avgTtfbMs, network MOS, containment, call phase, termination, ASR quality)                                                                                                                                              | ✅ Done    |
| Studio `useSessionDetail.ts`                               | Timeline tree for voice events including barge-in, DTMF icons                                                                                                                                                                                                                                                  | ✅ Done    |
| Studio `AgentConversationTree.tsx`                         | Hash icon for DTMF, ⚡ icon for barge-in                                                                                                                                                                                                                                                                       | ✅ Done    |
| Studio `types/index.ts`                                    | New trace event types for UI (voice_tts_quality, voice_asr_quality)                                                                                                                                                                                                                                            | ✅ Done    |
| `packages/i18n/locales/en/studio.json`                     | Added `"duration"` translation key                                                                                                                                                                                                                                                                             | ✅ Done    |
| **New:** `observability/repetition-detector.ts`            | Interface for pluggable repetition detection                                                                                                                                                                                                                                                                   | ✅ Done    |
| **New:** `observability/normalized-repetition-detector.ts` | Normalized string similarity with language-specific handling                                                                                                                                                                                                                                                   | ✅ Done    |
| **New:** `observability/semantic-repetition-detector.ts`   | Stub for future ML-based embeddings                                                                                                                                                                                                                                                                            | ✅ Done    |
| **New:** `observability/hybrid-repetition-detector.ts`     | Stub for combined approach                                                                                                                                                                                                                                                                                     | ✅ Done    |
| **New:** `observability/repetition-detector-factory.ts`    | Factory with environment variable switching                                                                                                                                                                                                                                                                    | ✅ Done    |
| **New:** `observability/voice-quality-analyzer.ts`         | 5-signal ASR quality scoring (WER proxy)                                                                                                                                                                                                                                                                       | ✅ Done    |
| **New:** `observability/asr-cascade-detector.ts`           | Cascade failure detection logic                                                                                                                                                                                                                                                                                | 🔲 Pending |
| ClickHouse migration                                       | `voice_call_metrics` table creation                                                                                                                                                                                                                                                                            | 🔲 Pending |
| **New:** Studio analytics dashboard component              | Charts and filters for all 10 metrics                                                                                                                                                                                                                                                                          | 🔲 Pending |

---

## Implementation Phases

| Phase   | Metrics                                                  | Timeline  | Effort                                                         | Impact                                      | Status  |
| ------- | -------------------------------------------------------- | --------- | -------------------------------------------------------------- | ------------------------------------------- | ------- |
| **1**   | 203 (E2E Latency), 204 (Barge-in)                        | 1–2 weeks | Low                                                            | High — immediate actionable insights        | ✅ Done |
| **2**   | 205 (Silence %), 209 (DTMF)                              | 2–3 weeks | Medium                                                         | High — operational quality visibility       | ✅ Done |
| **2.5** | Homer integration module                                 | 1 week    | Medium                                                         | Foundation — enables RTCP/QoS data          | ✅ Done |
| **3**   | 206 (Containment), 207 (Abandonment with phase tracking) | 1–2 weeks | Low–Medium — call phase state machine + outcome detection      | High — containment and abandonment analysis | ✅ Done |
| **4**   | 202 (TTS MOS — both dimensions)                          | 1–2 weeks | Low — proxy MOS + avgTtfbMs tracking + network MOS integration | Medium — TTS vendor selection data          | ✅ Done |
| **5**   | 201 (WER proxy with multi-signal analysis)               | 1–2 weeks | Medium — pluggable detector architecture with 5-signal scoring | Medium — ASR quality visibility             | ✅ Done |
| **6**   | 208 (WER by language), 210 (Cascade)                     | 1–2 weeks | Low–Medium — ClickHouse aggregation + cascade risk scoring     | Medium — quality improvement signals        | 🔲 Next |

**Total estimated timeline:** 7–10 weeks across all phases.

Note: Phase 4 is significantly simplified compared to an approach without HEP. The RTCP-based network MOS replaces the need for audio capture infrastructure (NISQA sidecar or RTP tap), reducing effort from 3–4 weeks to 1–2 weeks.

---

## Dependencies and Risks

| Risk                                                                                                 | Mitigation                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Homer unavailable during post-call enrichment                                                        | Graceful fallback — RTCP-dependent fields set to `null`; all application-level metrics (confidence, barge-in, silence, latency) continue independently |
| User speaking duration cannot be measured precisely (KoreVG does not expose speech-start timestamps) | Use word-count-based estimation; supplement with RTCP silence indicators from inbound stream; refine when upstream support is added                    |
| WER without ground truth is inherently approximate                                                   | Multi-signal approach (confidence + repetition + clarification + inbound network MOS) provides practical accuracy; dual-ASR can be added later         |
| Network MOS is not TTS naturalness MOS — it measures delivery quality, not synthesis quality         | Combined two-dimensional score (proxy MOS + network MOS) addresses both; post-call survey provides subjective calibration data                         |
| DTMF input may conflict with speech recognition during simultaneous input                            | Configure KoreVG to prioritize speech over DTMF when both detected in same window                                                                      |
| ClickHouse schema migration needed before metrics can be stored                                      | Include migration in Phase 1 alongside first three metrics                                                                                             |
| Homer API latency may delay session-end processing                                                   | Query Homer asynchronously after emitting core `voice_session_end`; enrich via a follow-up `voice_network_quality` event if needed                     |
| RTCP data granularity — Homer aggregates RTCP per-call, not per-turn                                 | Use call-level RTCP averages for session metrics; per-turn network quality requires real-time HEP WebSocket integration (future enhancement)           |

---

## Implementation Status

_Last updated: 2026-03-05 (post-201 ASR Quality completion)_

### Progress Summary

| Category                 | Count | Details                                              |
| ------------------------ | ----- | ---------------------------------------------------- |
| ✅ Fully implemented     | 9     | 201, 202, 203, 204, 205, 206, 207, 209, Homer module |
| ⚡ Partially implemented | 0     | —                                                    |
| 🔲 Not started           | 2     | 208, 210                                             |

### Studio UI (Voice tab) — visible only for voice sessions

- **Call Overview:** Duration, Turns, Caller, Disconnect, Containment, Call Phase, Avg E2E Latency, Barge-in count/rate, DTMF Input count/rate
- **ASR Quality:** Overall quality score (0-100) gauge, Quality Metrics (ASR Confidence %, Speech Clarity %), Issue Detection (Repetition %, Hesitation %, Correction %), Issues list with severity badges, detector type and turn count
- **TTS Quality:** Combined MOS gauge (proxy + network), Proxy MOS, Network MOS, Average TTFB (TTS-specific delays), TTS error count
- **Network Quality (MOS):** Inbound/outbound MOS gauges, R-factor, jitter, packet loss
- **E2E Response Latency:** Per-turn latency bars with color-coded legend (< 800ms green, < 1500ms amber, ≥ 1500ms red)
- **Barge-in Events:** Summary + per-event detail cards
- **DTMF Fallback:** Summary (count/rate) + per-turn detail cards with digits
- **Call Activity:** Stacked bar (Agent / User / Silence) with Silence Breakdown sub-card (Processing E2E + Dead Air)
- **Speech-to-Text:** Avg confidence, provider, language, per-utterance confidence bars (DTMF turns shown with amber Hash icon)
- **Text-to-Speech:** Total audio, avg TTFB, avg connection time, streaming/non-streaming breakdown, per-synthesis latency bars
- **Call Termination:** Disconnect initiator, SIP method/status/reason, Homer availability

### Key Implementation Notes

- **Summary header:** For voice sessions, "Latency" is replaced with "Duration" showing `callDurationMs` from `voice_session_end`. Non-voice sessions continue to show "Latency".
- **Homer dual Call-ID:** SBC→FS `callId` for SIP transactions, Caller→SBC `sbcCallId` for RTCP/QoS. 3-second post-call delay for Homer indexing.
- **Jambonz DTMF:** Uses `'digits'` (not `'dtmf'`) as input type. Requires `interDigitTimeout`, `minDigits`, `finishOnKey`, `numDigits` config.
- **Silence tracking:** Event-based (not residual). Processing silence = E2E latency. Dead air = gaps between TTS activity and user speech. Agent speaking derived as residual to avoid word-count overestimation.
- **Homer env vars:** `HOMER_API_BASE_URL`, `HOMER_USERNAME`, `HOMER_PASSWORD`

---

## Next Steps

### Phase 6 — ASR Segmentation (2–3 days)

**Priority: Medium** — Provides language/accent-specific quality analysis to identify ASR weaknesses by segment

**Metrics to implement:**

1. **208 (WER by language/accent):** ✅ Backend ready, UI pending
   - ClickHouse aggregation queries on top of Metric 201's `voice_asr_quality` data
   - Segment ASR quality score by: `language_code`, `callerCountry`, `inboundNetworkMos` band
   - Derive `callerCountry` from SIP `From` number country code at session start
   - Dashboard showing quality breakdown: average score per language, low-quality turn rate per segment
   - Correlate with network MOS to distinguish ASR weakness from network degradation
   - Example: If Spanish calls show low quality BUT good network MOS → ASR issue; if low quality AND poor network → root cause is caller audio quality

2. **210 (ASR Cascade Detection):** ✅ Completed
   - Multi-signal risk scoring from converging quality signals
   - Network quality as root cause indicator (from RTCP data)
   - Cascade chain: bad network → bad audio → wrong ASR → wrong intent → wrong response
   - Emits `voice_asr_cascade` trace event when risk is medium or high
   - Risk factors: low confidence + repetition + clarification + poor network MOS + short utterances
   - Implemented in `observability/asr-cascade-detector.ts` module
   - Integrated into `korevg-session.ts` with per-turn risk assessment
   - UI card shows problematic turns with root cause attribution

**Implementation approach:**

- Metric 208: Minimal code changes (country derivation in korevg-session.ts), primarily ClickHouse queries and Studio dashboard component
- Metric 210: ✅ Complete - Backend and UI fully implemented

---

### Cross-Cutting Infrastructure (ongoing)

**These enhancements benefit all metrics:**

1. **ClickHouse `voice_call_metrics` table** — per-call aggregate metrics for dashboards
   - Single row per call with all metrics consolidated
   - Partitioned by month, ordered by (tenant_id, timestamp, session_id)
   - Enables trend analysis and alerting

2. **Studio analytics dashboard** — trend charts for all metrics
   - Filterable by agent, time range, language, call outcome
   - MOS trends, latency percentiles, containment rate over time
   - DTMF fallback rate by agent, barge-in patterns
   - Drill-down from aggregates to individual calls

3. **OTEL span attributes** — alerting integration
   - Threshold-based alerts for degraded metrics
   - Example: Alert if avg E2E latency > 1.5s or MOS < 3.5 for more than 10% of calls

4. **Post-call survey** (optional) — MOS calibration
   - IVR or SMS survey after call end
   - Store caller's rating (1–5) as `voice_survey` trace event
   - Correlate with computed MOS to calibrate proxy scores

---

### Summary of Completed Work

**10 metrics implemented (9 fully complete, 1 in progress):**

- ✅ 201: ASR Quality (multi-signal WER proxy with pluggable detection architecture)
- ✅ 202: TTS MOS (proxy + network) with avgTtfbMs
- ✅ 203: E2E voice response latency
- ✅ 204: Barge-in detection rate
- ✅ 205: Silence duration as % of call
- ✅ 206: Voice containment rate
- ✅ 207: Voice call abandonment rate with phase tracking
- 🔲 208: WER segmented by language/accent (ClickHouse aggregation on top of 201's data)
- ✅ 209: DTMF fallback rate
- ✅ 210: ASR cascade failure detection (multi-signal risk scoring with root cause attribution)
- ✅ Homer integration module (RTCP/QoS data, network MOS, disconnect attribution)

**Remaining metric (1):**

- 🔲 208: WER segmented by language/accent - ClickHouse queries + dashboard

**Total estimated timeline for remaining work:** 2–3 days (primarily dashboard work)

---

### Key Implementation Notes

- **Metric 201 ASR Quality:** Pluggable architecture with environment variable switching (`REPETITION_DETECTOR_TYPE`). Normalized detector (default) uses Jaccard similarity with language-specific normalization. UI metrics transformed for intuitive display (confidence/clarity flipped to show quality, issue rates kept as-is).
- **Metric 202 avgTtfbMs:** Tracks TTS-specific delays only (connection time), excludes LLM latency to avoid double-counting with silence breakdown processing time
- **Per-turn connection tracking:** `turnTtsConnectionMs` captures reconnection latency when TTS stream closes/reopens during call due to inactivity
- **Homer dual Call-ID fallback:** Tries both `sipCallId` and `rtpCallId` to ensure RTCP data capture works regardless of which Call-ID rtpengine is using
- **Stream reconnection attribution:** When `stream_open` occurs with buffered chunks, connection time is attributed to the current turn (not amortized)
- **ASR quality UI design:** Backend signals represent "badness levels" (0-1 scale where 0 = good), but UI transforms confidence and clarity to quality percentages (higher = better) for standard dashboard UX. Issue rates (repetition, hesitation, correction) remain as-is (lower = better).
