# RFC: LiveKit SIP Telephony Integration

**Status:** Draft
**Author:** Platform Engineering
**Date:** 2026-02-17
**Scope:** End-to-end telephony for voice AI agents via LiveKit SIP and Twilio

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Problem Statement](#2-problem-statement)
3. [Telephony Architecture Options](#3-telephony-architecture-options)
4. [Recommended Architecture: LiveKit SIP](#4-recommended-architecture-livekit-sip)
5. [End-to-End Call Flow](#5-end-to-end-call-flow)
6. [Infrastructure Requirements](#6-infrastructure-requirements)
7. [SIP Trunking Providers](#7-sip-trunking-providers)
8. [Enterprise Scalability](#8-enterprise-scalability)
9. [What Already Exists](#9-what-already-exists)
10. [What Needs to Be Built](#10-what-needs-to-be-built)
11. [Studio UI Changes](#11-studio-ui-changes)
12. [DSL & Compiler Changes](#12-dsl--compiler-changes)
13. [Security Considerations](#13-security-considerations)
14. [Rollout Plan](#14-rollout-plan)
15. [Open Questions](#15-open-questions)

---

## 1. Executive Summary

This RFC proposes adding PSTN telephony to the platform so that AI agents built with ABL DSL can accept and make phone calls. Phone callers become LiveKit room participants, flowing through the same RuntimeBridgeAgent pipeline (VAD → STT → RuntimeExecutor → TTS) used for WebRTC voice. The primary integration path is **LiveKit SIP** with **Twilio Elastic SIP Trunking** as the default provider.

Three architecture options are evaluated. The recommendation is to start with **Option A (LiveKit SIP)** for production, with **Option B (Twilio Media Streams + LiveKit Room proxy)** as a fallback for environments where SIP infrastructure is impractical.

---

## 2. Problem Statement

The platform currently supports two interaction channels:

| Channel       | Transport              | Status     |
| ------------- | ---------------------- | ---------- |
| **Web chat**  | WebSocket (text)       | Production |
| **Web voice** | LiveKit WebRTC (audio) | Production |

Missing: **PSTN telephony** — the ability for users to dial a phone number and interact with an AI agent via spoken conversation. This is a requirement for:

- Contact center automation (IVR replacement, call deflection)
- Outbound campaigns (appointment reminders, notifications)
- Accessibility (users without smartphones/browsers)
- Enterprise deployments where phone is the primary channel

---

## 3. Telephony Architecture Options

### Option A: LiveKit SIP (Native Bridge)

```
Phone → PSTN → Twilio SIP Trunk → LiveKit SIP Service → LiveKit Server (Room)
                                                              │
                                                       RuntimeBridgeAgent
                                                       (VAD → STT → LLM → TTS)
```

**How it works:** LiveKit's SIP service is a standalone Go binary that bridges SIP/RTP to WebRTC. Phone callers become regular LiveKit room participants. The existing agent pipeline works unchanged.

| Pros                                                 | Cons                                       |
| ---------------------------------------------------- | ------------------------------------------ |
| Phone callers are native room participants           | Requires host networking + public IP       |
| Agent pipeline identical to WebRTC                   | 10,001 UDP ports open (5060 + 10000-20000) |
| SIP-native features (REFER transfers, SIP INFO DTMF) | Not serverless-compatible                  |
| Best audio latency (direct bridge)                   | Additional service to deploy and monitor   |
| LiveKit Cloud option eliminates infra                | Self-hosted ops burden                     |

### Option B: Twilio Media Streams + LiveKit Room Proxy

```
Phone → PSTN → Twilio → TwiML <Stream> → WebSocket → Your Server (proxy)
                                                          │
                                                   Joins LiveKit Room
                                                   as proxy participant
                                                          │
                                                   RuntimeBridgeAgent
```

**How it works:** Twilio streams raw audio over a WebSocket to your server. Your server joins a LiveKit room as a proxy participant, publishing the caller's audio and subscribing to the agent's audio to send back to Twilio.

| Pros                                             | Cons                                          |
| ------------------------------------------------ | --------------------------------------------- |
| No LiveKit SIP service needed                    | You maintain the audio bridge code            |
| Deployable on any platform (ECS, Cloud Run, k8s) | Extra hop adds latency (~50-100ms)            |
| Standard WebSocket, no host networking           | Codec transcoding (mulaw ↔ Opus) in your code |
| Phone callers still in LiveKit rooms             | No SIP-native transfers (must use TwiML)      |

### Option C: Twilio Media Streams Direct (No LiveKit for Phone)

```
Phone → PSTN → Twilio → TwiML <Stream> → WebSocket → Your Server
                                                          │
                                                   STT → RuntimeExecutor → TTS
                                                          │
                                                   WebSocket back to Twilio
```

**How it works:** Skip LiveKit entirely for the phone channel. Your server handles STT/TTS directly against the Twilio audio stream.

| Pros                                | Cons                                            |
| ----------------------------------- | ----------------------------------------------- |
| Simplest infrastructure             | Phone callers NOT in LiveKit rooms              |
| Lowest latency for phone-only       | Separate pipeline from WebRTC voice             |
| No LiveKit dependency for telephony | No mixing of phone + WebRTC participants        |
| Full control over audio processing  | You build VAD, interruption handling, buffering |

### Recommendation

**Option A (LiveKit SIP)** for production deployments — unified room model, native SIP features, proven at scale via LiveKit Cloud.

**Option B (Twilio Media Streams proxy)** as a fallback for environments where host networking / public IPs are impractical (shared k8s clusters, serverless).

**Option C** is not recommended because it creates a divergent voice pipeline that doesn't benefit from the existing LiveKit infrastructure.

---

## 4. Recommended Architecture: LiveKit SIP

### System Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           PSTN / Mobile Network                         │
│                       (AT&T, Verizon, Vodafone, etc.)                   │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │ SS7/ISUP signaling + TDM/IP media
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     Twilio Elastic SIP Trunk                            │
│                                                                         │
│  • Owns DID phone numbers (+1-510-555-0123, etc.)                       │
│  • PSTN ↔ SIP protocol conversion                                      │
│  • Number provisioning, billing, caller ID, E911                        │
│  • Sends SIP INVITE to origination URI                                  │
│  • Receives SIP BYE/REFER for hangup/transfer                          │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │ SIP (UDP 5060 / TLS 5061)
                                 │ RTP media (UDP 10000-20000)
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     LiveKit SIP Service                                 │
│                     (livekit/sip Docker container)                       │
│                                                                         │
│  ┌───────────────┐  ┌────────────────┐  ┌─────────────────────┐        │
│  │ SIP Stack     │  │ Media Bridge   │  │ Dispatch Engine     │        │
│  │               │  │                │  │                     │        │
│  │ • INVITE/BYE  │  │ • G.711 ↔ Opus│  │ • Trunk matching    │        │
│  │ • Auth (IP/   │  │ • RTP ↔ WebRTC│  │ • Rule evaluation   │        │
│  │   digest)     │  │ • SRTP ↔ DTLS │  │ • Room assignment   │        │
│  │ • SDP nego    │  │ • DTMF relay  │  │ • Participant setup │        │
│  └───────────────┘  └────────────────┘  └─────────────────────┘        │
│                                                                         │
│  Config: api_key, api_secret, ws_url, redis.address                     │
│  Networking: host mode, public IP, UDP 5060 + 10000-20000               │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │ Redis (session state + coordination)
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     LiveKit Server (SFU)                                 │
│                                                                         │
│  • WebRTC Selective Forwarding Unit                                     │
│  • Room lifecycle: create, manage participants, destroy                 │
│  • Audio track routing between participants                             │
│  • Webhooks: room_started, participant_joined, participant_left         │
│  • Recording, egress, analytics                                         │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │ WebRTC (audio tracks)
                                 │ WebSocket (signaling + control)
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     Agent Server (Runtime)                              │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────┐       │
│  │ Worker Process (per-call isolation)                          │       │
│  │                                                              │       │
│  │  ┌──────┐   ┌──────────┐   ┌────────────────┐  ┌────────┐  │       │
│  │  │ VAD  │──▶│   STT    │──▶│ RuntimeExecutor│─▶│  TTS   │  │       │
│  │  │      │   │(Deepgram)│   │  (ABL DSL      │  │(Eleven │  │       │
│  │  │Silero│   │          │   │   engine)       │  │ Labs)  │  │       │
│  │  └──────┘   └──────────┘   └────────────────┘  └────────┘  │       │
│  │                                                              │       │
│  │  CallerContext: { phoneNumber, trunkId, channel: 'sip' }    │       │
│  └──────────────────────────────────────────────────────────────┘       │
│                                                                         │
│  Load balancing: load_fnc (CPU) + load_threshold (0.7)                  │
│  Scaling: add more agent server instances                               │
└─────────────────────────────────────────────────────────────────────────┘
```

### Key Primitives

| Primitive              | Purpose                                                            | Configuration                                                                                |
| ---------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| **Inbound SIP Trunk**  | Accept calls from a provider; maps provider IPs/numbers to LiveKit | `numbers: ["+15105550123"]`, IP allowlist                                                    |
| **Outbound SIP Trunk** | Place calls via a provider; stores auth credentials                | `address: "sip-domain"`, `authUsername`, `authPassword`                                      |
| **Dispatch Rule**      | Route inbound calls to LiveKit rooms                               | `dispatchRuleIndividual` (1:1), `dispatchRuleDirect` (shared), `dispatchRuleCallee` (by DID) |
| **SIP Participant**    | Phone caller as a room participant                                 | Auto-created by dispatch; metadata: `sip.phoneNumber`, `sip.callStatus`, etc.                |

### SIP Participant Metadata

Every SIP participant carries these attributes, readable by the agent:

| Attribute               | Description                                                   | Example               |
| ----------------------- | ------------------------------------------------------------- | --------------------- |
| `sip.callID`            | LiveKit's SIP call ID                                         | `"call_abc123"`       |
| `sip.callIDFull`        | Provider's globally unique SIP call ID                        | `"CA_xxx@twilio.com"` |
| `sip.callStatus`        | State: `active`, `automation`, `dialing`, `hangup`, `ringing` | `"active"`            |
| `sip.phoneNumber`       | Caller's phone number (E.164)                                 | `"+14155551234"`      |
| `sip.trunkID`           | SIP trunk identifier                                          | `"ST_xxxx"`           |
| `sip.trunkPhoneNumber`  | DID number called                                             | `"+15105550123"`      |
| `sip.twilio.accountSid` | Twilio account SID (Twilio only)                              | `"AC_xxxx"`           |
| `sip.twilio.callSid`    | Twilio call SID (Twilio only)                                 | `"CA_xxxx"`           |

---

## 5. End-to-End Call Flow

### 5.1 Inbound Call

```
Step 1: PSTN → Twilio
├── Caller dials +15105550123
├── Carrier routes through PSTN
├── Twilio receives call on DID
└── Twilio converts PSTN → SIP

Step 2: Twilio → LiveKit SIP
├── Twilio sends SIP INVITE to sip:<public-ip>:5060
│   From: <sip:+14155551234@twilio.com>
│   To:   <sip:+15105550123@your-ip>
│   [SDP: codec offers PCMU, PCMA, opus]
├── LiveKit SIP authenticates (IP allowlist or digest)
├── SIP service returns 100 Trying → 200 OK with SDP answer
└── RTP media channel established (G.711 μ-law, 8kHz)

Step 3: Dispatch — Room Assignment
├── SIP service evaluates dispatch rules in priority order
├── Match by: trunk ID → called number → caller pattern
├── dispatchRuleIndividual: creates room "call-+14155551234-a7f3b2"
│   (one room per caller — ideal for AI agents)
├── dispatchRuleDirect: joins shared room "support-room"
│   (conference/contact center)
└── SIP participant created with sip.* metadata

Step 4: Agent Spawn
├── LiveKit Server creates room → emits room_started webhook
├── SIP participant joins → emits participant_joined webhook
├── Agent dispatch: LiveKit Server routes to least-loaded agent server
├── Agent server spawns worker process for this call
├── RuntimeBridgeAgent joins room, subscribes to SIP participant's audio
└── Agent delivers immediate greeting (phone callers expect it)

Step 5: Steady-State Media Flow
├── Caller speaks → RTP (G.711) → Twilio → LiveKit SIP
├── SIP service transcodes: G.711 → Opus → WebRTC
├── LiveKit Server routes audio to agent's subscribed track
├── Agent pipeline: VAD → STT (Deepgram) → text
├── Text → RuntimeExecutor (ABL DSL engine) → response text
├── Response → TTS (ElevenLabs) → audio
├── Agent publishes audio track → LiveKit Server
├── Server routes to SIP participant → SIP service
├── SIP service transcodes: Opus → G.711 → RTP
└── RTP → Twilio → PSTN → caller hears response

Step 6: Termination
├── Caller hangs up → Twilio sends SIP BYE
├── LiveKit SIP removes participant → participant_left webhook
├── Agent detects empty room, cleans up session
└── Room destroyed
```

### 5.2 Outbound Call

```
Step 1: Agent initiates call
├── Agent (or API) calls CreateSIPParticipant:
│   { trunkId, phoneNumber: "+14155551234",
│     roomName: "outbound-001",
│     playDialtone: true, waitUntilAnswered: true }
└── LiveKit SIP sends SIP INVITE via outbound trunk

Step 2: Call establishment
├── Twilio authenticates outbound trunk credentials
├── Twilio routes INVITE to PSTN → phone rings
├── playDialtone: true → agent hears ringing in room
├── Callee answers → Twilio sends 200 OK
├── SIP participant joins room as "active"
└── waitUntilAnswered resolves

Step 3: Conversation
├── Same bidirectional media flow as inbound
├── Agent lets callee speak first (no auto-greeting for outbound)
└── Full RuntimeExecutor conversation loop

Step 4: Termination
├── Agent calls deleteRoom() → sends SIP BYE
├── Or callee hangs up → Twilio sends BYE → participant removed
└── Session cleanup
```

### 5.3 DTMF Handling

```
Caller presses digit → SIP INFO or RFC 2833 in-band
  → LiveKit SIP extracts digit + duration
  → LiveKit Server emits DataChannel event to room
  → Agent receives: { participant, digit: "5", code: 5 }
  → Handler: menu selection, PIN entry, phone number collection

Agent sends DTMF (e.g., navigating external IVR):
  → publishDtmf(code, digit) → LiveKit SIP
  → SIP INFO → Twilio → PSTN
```

### 5.4 Call Transfer

```
Cold transfer:
  Agent calls transferSipParticipant(participantId, "+18005551234")
  → SIP service sends SIP REFER to Twilio
  → Twilio establishes new call to target number
  → Original SIP participant removed from room

Hangup:
  Agent calls deleteRoom(roomName)
  → All participants removed
  → SIP service sends BYE to Twilio
  → Caller hears disconnect tone
```

---

## 6. Infrastructure Requirements

### 6.1 LiveKit SIP Service

| Requirement             | Details                                                     |
| ----------------------- | ----------------------------------------------------------- |
| **Runtime**             | Go binary or Docker (`livekit/sip`)                         |
| **Build deps (native)** | Go >= 1.18, `libopus-dev`, `libopusfile-dev`, `libsoxr-dev` |
| **Docker**              | `livekit/sip` image, **must use `--network host`**          |
| **Public IP**           | Required — SIP peers must connect directly, no NAT          |
| **SIP port**            | UDP 5060 (signaling), or TCP/TLS 5061 for secure trunking   |
| **RTP ports**           | UDP 10000-20000 (media), all must be open inbound           |
| **Redis**               | Required — must be the **same instance** as LiveKit Server  |
| **Health port**         | HTTP (configurable), for load balancer / k8s probes         |
| **Prometheus**          | Metrics port (configurable), for autoscaling                |
| **Memory**              | ~2-5MB per active SIP session                               |
| **CPU**                 | Audio transcoding (G.711 ↔ Opus), lightweight per call      |

**Config file (`sip-config.yaml`):**

```yaml
api_key: ${LIVEKIT_API_KEY}
api_secret: ${LIVEKIT_API_SECRET}
ws_url: wss://livekit-server.example.com
redis:
  address: redis:6379
  password: ${REDIS_PASSWORD}
  db: 0
sip_port: 5060
rtp_port: 10000-20000
health_port: 8080
prometheus_port: 6789
logging:
  level: info
```

**Deployment constraint:** Requires a bare-metal server or VM with a real public IP and host networking. Cannot run on serverless platforms (Cloud Run, Lambda), ECS with awsvpc mode, or behind a UDP load balancer for media. Recommended: EC2/GCE dedicated instances, or LiveKit Cloud (fully managed).

### 6.2 LiveKit Server (SFU)

| Requirement    | Details                                                                   |
| -------------- | ------------------------------------------------------------------------- |
| **Deployment** | Existing LiveKit Server — no SIP-specific changes                         |
| **Redis**      | Same instance as SIP service                                              |
| **Webhooks**   | Must be configured to notify agent server of room/participant events      |
| **Capacity**   | Handles 100,000+ concurrent rooms (Cloud); voice AI = 2 participants/room |

### 6.3 Redis

| Requirement       | Details                                                           |
| ----------------- | ----------------------------------------------------------------- |
| **Role**          | Session state coordination between SIP service and LiveKit Server |
| **Data per call** | ~1-2KB state                                                      |
| **Throughput**    | Standard Redis handles 100K+ ops/sec — not a bottleneck           |
| **Deployment**    | Single shared instance (or Redis Cluster for HA)                  |

### 6.4 Agent Server (Runtime)

| Requirement            | Details                                                                |
| ---------------------- | ---------------------------------------------------------------------- |
| **Model**              | Process-per-call isolation (one OS process per active call)            |
| **Recommended sizing** | 4 cores, 8GB RAM → 10-25 concurrent calls                              |
| **Scaling**            | Horizontal — add more agent server instances                           |
| **Load management**    | `load_fnc` (default: CPU utilization), `load_threshold` (default: 0.7) |
| **Crash isolation**    | Job crash affects only that call, not server or other calls            |
| **Graceful deploys**   | Active calls drain before shutdown                                     |

### 6.5 External API Services

| Service                      | Role              | Concurrency Limit           | Impact                        |
| ---------------------------- | ----------------- | --------------------------- | ----------------------------- |
| **Deepgram** (STT)           | Audio → text      | 50-500 concurrent (by plan) | Hard wall — no transcription  |
| **ElevenLabs** (TTS)         | Text → audio      | 5-100 concurrent (by plan)  | Hard wall — agent goes silent |
| **OpenAI / Anthropic** (LLM) | Text → text       | Rate-limited by tokens/min  | Latency increases             |
| **Twilio** (SIP)             | PSTN connectivity | 1-500 concurrent (by plan)  | Busy signal                   |

### 6.6 Infrastructure Topology

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Production Deployment                         │
│                                                                      │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐               │
│  │ LiveKit SIP  │   │ LiveKit SIP  │   │ LiveKit SIP  │  (2-3 inst.) │
│  │ Instance 1   │   │ Instance 2   │   │ Instance 3   │              │
│  │ Public IP A  │   │ Public IP B  │   │ Public IP C  │              │
│  │ Host network │   │ Host network │   │ Host network │              │
│  └──────┬───────┘   └──────┬───────┘   └──────┬───────┘              │
│         │                  │                  │                       │
│         └──────────────────┼──────────────────┘                      │
│                            │ Redis                                   │
│                            ▼                                         │
│                   ┌──────────────┐                                   │
│                   │   Redis      │  (Cluster or Sentinel for HA)     │
│                   │   Shared     │                                   │
│                   └──────┬───────┘                                   │
│                          │                                           │
│                          ▼                                           │
│                   ┌──────────────┐                                   │
│                   │ LiveKit SFU  │  (Standard deployment)            │
│                   │ Server       │                                   │
│                   └──────┬───────┘                                   │
│                          │                                           │
│         ┌────────────────┼────────────────┐                          │
│         ▼                ▼                ▼                           │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐                     │
│  │ Agent Srv 1│  │ Agent Srv 2│  │ Agent Srv 3│  (auto-scaled)      │
│  │ 20 calls   │  │ 20 calls   │  │ 20 calls   │                     │
│  └────────────┘  └────────────┘  └────────────┘                     │
│                                                                      │
│  Total capacity: 60 concurrent calls (scale by adding servers)       │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 7. SIP Trunking Providers

### 7.1 Supported Providers

| Provider   | Setup Complexity              | Pricing Model              | Secure Trunking | LiveKit Docs                                                                               |
| ---------- | ----------------------------- | -------------------------- | --------------- | ------------------------------------------------------------------------------------------ |
| **Twilio** | Low (dedicated LiveKit guide) | Per-minute + number rental | TLS + SRTP      | [Guide](https://docs.livekit.io/telephony/start/providers/twilio/)                         |
| **Telnyx** | Low (dedicated guide)         | Per-minute + number rental | TLS + SRTP      | [Guide](https://developers.telnyx.com/docs/voice/sip-trunking/livekit-configuration-guide) |
| **Plivo**  | Medium                        | Per-minute                 | TLS             | Manual setup                                                                               |
| **Wavix**  | Medium                        | Per-minute                 | TLS             | Manual setup                                                                               |
| **Exotel** | Medium                        | Per-minute (India-focused) | TLS             | Manual setup                                                                               |

### 7.2 Twilio Setup (Primary Provider)

**1. Create Elastic SIP Trunk:**

- Twilio Console → Elastic SIP Trunking → Trunks → Create
- Name: `"Production Agent Platform"`

**2. Configure Origination (inbound calls):**

- Add origination URI: `sip:<livekit-sip-public-ip>:5060;transport=tls`
- Priority: 10, Weight: 10

**3. Configure Termination (outbound calls):**

- Set SIP URI (auto-generated by Twilio)
- Set credentials (username/password for digest auth)
- IP Access Control: add LiveKit SIP public IPs

**4. Assign DID numbers:**

- Purchase phone numbers in Twilio Console
- Assign each number to the trunk

**5. Configure in LiveKit:**

Create inbound trunk:

```json
{
  "name": "Twilio Inbound",
  "numbers": ["+15105550123"],
  "metadata": "tenant:acme-corp"
}
```

Create dispatch rule:

```json
{
  "name": "AI Agent Calls",
  "trunk_ids": ["ST_inbound_xxxx"],
  "rule": {
    "dispatchRuleIndividual": {
      "roomPrefix": "call-"
    }
  }
}
```

Create outbound trunk:

```json
{
  "name": "Twilio Outbound",
  "address": "<twilio-termination-uri>",
  "numbers": ["+15105550123"],
  "auth_username": "<sip-username>",
  "auth_password": "<sip-password>",
  "transport": 3
}
```

### 7.3 Multi-Tenant Number Management

For enterprise multi-tenancy, each tenant gets their own:

```
Tenant: Acme Corp
├── DID: +15105550123 (main line)
├── DID: +15105550124 (support)
├── Inbound trunk: ST_acme_inbound
├── Outbound trunk: ST_acme_outbound
├── Dispatch rule: SDR_acme → roomPrefix "acme-call-"
└── Mapped to: Project "acme-agents", Deployment "production"

Tenant: Globex Inc
├── DID: +12125550100 (main)
├── Inbound trunk: ST_globex_inbound
├── Dispatch rule: SDR_globex → roomPrefix "globex-call-"
└── Mapped to: Project "globex-agents", Deployment "production"
```

The platform must maintain a mapping: **DID number → tenant → project → deployment → entry agent**.

---

## 8. Enterprise Scalability

### 8.1 Scaling Dimensions

| Component               | Scaling Method             | Limit Per Instance                 | How to Scale                      |
| ----------------------- | -------------------------- | ---------------------------------- | --------------------------------- |
| **SIP Service**         | DNS SRV records            | ~5,000 concurrent (UDP port range) | Add instances with new public IPs |
| **LiveKit SFU**         | Built-in clustering        | 100,000+ rooms                     | LiveKit Cloud or cluster nodes    |
| **Agent Server**        | Horizontal (add instances) | 10-25 concurrent calls             | Auto-scale on CPU/load_fnc        |
| **Redis**               | Cluster / Sentinel         | 100K+ ops/sec                      | Redis Cluster for HA              |
| **STT (Deepgram)**      | Provider plan              | 50-500 concurrent                  | Upgrade plan or multi-provider    |
| **TTS (ElevenLabs)**    | Provider plan              | 5-100 concurrent                   | Upgrade plan or multi-provider    |
| **LLM (OpenAI/Claude)** | Provider plan              | RPM/TPM limits                     | Multi-provider, load balance      |
| **Twilio SIP**          | Account plan               | 1-500 concurrent                   | Upgrade or multi-trunk            |

### 8.2 Capacity Planning Table

| Target           | Agent Servers  | SIP Instances | STT Plan    | TTS Plan   | Twilio Plan |
| ---------------- | -------------- | ------------- | ----------- | ---------- | ----------- |
| 50 concurrent    | 3 × (4c/8GB)   | 1             | Growth      | Starter    | Standard    |
| 200 concurrent   | 10 × (4c/8GB)  | 1             | Enterprise  | Scale      | Standard    |
| 500 concurrent   | 25 × (4c/8GB)  | 2             | Enterprise  | Enterprise | Enterprise  |
| 1,000 concurrent | 50 × (4c/8GB)  | 3             | Enterprise+ | Enterprise | Enterprise  |
| 5,000 concurrent | 250 × (4c/8GB) | 5             | Custom      | Custom     | Custom      |

### 8.3 Bottleneck Analysis

**The real scaling wall is external API concurrency, not LiveKit infrastructure.**

Each concurrent call holds 3 persistent connections:

```
Per call:
  1× STT WebSocket (streaming, always open)
  1× LLM connection (request/response per turn)
  1× TTS WebSocket (streaming per response)

1,000 concurrent calls = 3,000 external API connections
```

**Mitigation strategies:**

- Multi-provider failover (Deepgram → Google STT → Azure STT)
- Provider quota aggregation (multiple API keys)
- Local STT/TTS for cost-sensitive workloads (Whisper, Piper)
- Connection pooling where providers support it

### 8.4 Latency Budget

| Component                      | Typical Latency | Notes                                   |
| ------------------------------ | --------------- | --------------------------------------- |
| PSTN → Twilio                  | 50-150ms        | Depends on carrier                      |
| Twilio → SIP Service           | 10-30ms         | Network hop                             |
| SIP transcoding (G.711 → Opus) | 5-10ms          | Per packet                              |
| LiveKit SFU routing            | 5-10ms          | In-memory forwarding                    |
| VAD detection                  | 200-500ms       | Wait for speech end                     |
| STT (Deepgram streaming)       | 100-300ms       | Real-time streaming                     |
| LLM (GPT-4 / Claude)           | 500-2000ms      | First token latency                     |
| TTS (ElevenLabs streaming)     | 200-500ms       | First audio chunk                       |
| Return path (agent → phone)    | 30-60ms         | Reverse of above                        |
| **Total end-to-end**           | **1.1-3.5s**    | From speech end to first audio response |

The dominant factor is LLM latency. All other components combined add ~400-800ms.

---

## 9. What Already Exists

### 9.1 Runtime Architecture (Ready)

| Component              | Location                                            | Status     | Telephony Relevance                               |
| ---------------------- | --------------------------------------------------- | ---------- | ------------------------------------------------- |
| **RuntimeExecutor**    | `apps/runtime/src/services/execution/`              | Production | Core agent engine — works unchanged for voice     |
| **DeploymentResolver** | `apps/runtime/src/services/deployment-resolver.ts`  | Production | Channel wiring already designed for voice         |
| **SessionService**     | `apps/runtime/src/services/session/`                | Production | Cluster-ready sessions with Redis persistence     |
| **CallerContext**      | Session model                                       | Production | `channel` field exists, ready for `'sip'` value   |
| **LLM Wiring**         | `apps/runtime/src/services/execution/llm-wiring.ts` | Production | Provider-neutral, injectable                      |
| **Trace System**       | `TraceStore` + `TraceStoreInterface`                | Production | Deployment-enriched trace events                  |
| **Rate Limiter**       | `apps/runtime/src/middleware/rate-limiter.ts`       | Production | `HybridRateLimiter` (Redis + in-memory)           |
| **Tenant Isolation**   | Middleware + session model                          | Production | JWT + API key extraction, cross-tenant prevention |

### 9.2 Studio UI (Partial)

| Component                 | Location                                                 | Status | Notes                                                          |
| ------------------------- | -------------------------------------------------------- | ------ | -------------------------------------------------------------- |
| **Voice Services Page**   | `apps/studio/src/components/admin/VoiceServicesPage.tsx` | Exists | Deepgram, ElevenLabs, Twilio credential management             |
| **Channels Tab**          | `apps/studio/src/components/deployments/ChannelsTab.tsx` | Exists | Channel types include `voice`, `voice_livekit`, `voice_twilio` |
| **Channel Create Dialog** | Same file                                                | Exists | Voice provider selector (livekit / twilio), pipeline selector  |
| **Service Instances API** | `GET/POST/PATCH/DELETE /api/service-instances`           | Exists | Tenant-scoped credential storage                               |
| **Deployments**           | `DeploymentsPage.tsx`                                    | Exists | Environment + agent version management                         |
| **Navigation**            | `navigation-store.ts`                                    | Exists | Admin voice page route (`/admin/voice`) exists                 |

### 9.3 Config & Types (Partial)

| Component                   | Status          | Notes                                                                                                |
| --------------------------- | --------------- | ---------------------------------------------------------------------------------------------------- |
| **Channel types**           | Defined         | `'web' \| 'mobile_ios' \| 'mobile_android' \| 'voice' \| 'voice_livekit' \| 'voice_twilio' \| 'api'` |
| **Voice config schema**     | Needs extension | Exists for basic provider config; needs SIP-specific fields                                          |
| **Twilio service instance** | Exists          | Account SID + Auth Token storage via VoiceServicesPage                                               |

---

## 10. What Needs to Be Built

### 10.1 Runtime (Backend)

#### A. SIP Trunk Management Service

**Location:** `apps/runtime/src/services/telephony/sip-trunk-service.ts`

```typescript
interface SIPTrunkConfig {
  id: string;
  tenantId: string;
  projectId: string;
  provider: 'twilio' | 'telnyx' | 'plivo';
  direction: 'inbound' | 'outbound' | 'both';
  numbers: string[]; // E.164 DID numbers
  livekitTrunkId?: string; // LiveKit's trunk ID after creation
  livekitDispatchRuleId?: string; // LiveKit's dispatch rule ID
  config: {
    sipDomain?: string; // Outbound SIP domain
    authUsername?: string;
    authPassword?: string; // Encrypted via EncryptionService
    transport?: 'udp' | 'tcp' | 'tls';
    mediaEncryption?: 'off' | 'allow' | 'require';
    ipAllowlist?: string[];
  };
  status: 'active' | 'inactive' | 'error';
}
```

Responsibilities:

- CRUD operations for SIP trunk configurations
- Sync with LiveKit SIP API (create/update/delete trunks and dispatch rules)
- Number-to-tenant mapping for inbound call routing
- Credential encryption via existing `EncryptionService`

#### B. Telephony Routes

**Location:** `apps/runtime/src/routes/telephony.ts`

```
POST   /api/projects/:projectId/telephony/trunks           Create trunk
GET    /api/projects/:projectId/telephony/trunks           List trunks
GET    /api/projects/:projectId/telephony/trunks/:id       Get trunk
PATCH  /api/projects/:projectId/telephony/trunks/:id       Update trunk
DELETE /api/projects/:projectId/telephony/trunks/:id       Delete trunk
POST   /api/projects/:projectId/telephony/trunks/:id/test  Test trunk connectivity
GET    /api/projects/:projectId/telephony/numbers          List provisioned numbers
POST   /api/projects/:projectId/telephony/calls/outbound   Initiate outbound call
POST   /api/projects/:projectId/telephony/calls/:callId/transfer  Transfer call
DELETE /api/projects/:projectId/telephony/calls/:callId    Hang up call
```

#### C. SIP Call Lifecycle Handler

**Location:** `apps/runtime/src/services/telephony/sip-call-handler.ts`

Responsibilities:

- Listen for LiveKit room webhooks (room_started from SIP dispatch)
- Resolve inbound call: DID number → tenant → project → deployment → entry agent
- Spawn RuntimeBridgeAgent for the call
- Handle SIP participant metadata extraction → CallerContext
- Manage call state transitions (ringing → active → completed/transferred)
- Emit trace events with telephony context

#### D. Agent Greeting on SIP Join

**Location:** Modify `apps/runtime/src/services/voice/livekit/agent-worker.ts`

When a SIP participant joins, the agent must:

1. Detect `sip.*` attributes on the participant
2. Set `CallerContext.channel = 'sip'`
3. Immediately generate a greeting (phone callers expect it — no waiting for user speech)
4. The greeting text comes from the agent IR (`voice.greeting` or `flow[0].prompt`)

#### E. DTMF Handling

**Location:** `apps/runtime/src/services/telephony/dtmf-handler.ts`

- Subscribe to LiveKit room DTMF events
- Expose DTMF digits to RuntimeExecutor as a tool or event
- Support digit collection (multi-digit input with timeout)
- Forward DTMF from agent to SIP participant (for IVR navigation)

#### F. Outbound Call Tool

**Location:** `apps/runtime/src/services/telephony/outbound-call-tool.ts`

Expose as a runtime tool callable from ABL DSL:

```
TOOL make_phone_call
  DESCRIPTION "Place an outbound phone call"
  PARAMETERS
    phone_number: string REQUIRED
    greeting: string OPTIONAL
  EXECUTE
    TYPE: platform
    ACTION: sip.createOutboundCall
```

### 10.2 Database

#### A. New Models

```prisma
model PhoneNumber {
  id            String   @id @default(cuid())
  tenantId      String
  projectId     String
  number        String   @unique  // E.164
  provider      String             // twilio, telnyx
  providerSid   String?            // Provider's number SID
  trunkId       String?            // FK to SIPTrunk
  dispatchRuleId String?           // LiveKit dispatch rule ID
  status        String   @default("active")
  capabilities  String   @default("voice")  // voice, sms, voice+sms
  region        String?
  monthlyRate   Float?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  trunk         SIPTrunk? @relation(fields: [trunkId], references: [id])
  project       Project   @relation(fields: [projectId], references: [id])

  @@index([tenantId])
  @@index([number])
}

model SIPTrunk {
  id            String   @id @default(cuid())
  tenantId      String
  projectId     String
  name          String
  provider      String
  direction     String   @default("both")
  livekitTrunkId String?
  livekitDispatchRuleId String?
  sipDomain     String?
  authUsername   String?
  authPasswordEnc String?          // Encrypted
  transport     String   @default("tls")
  mediaEncryption String @default("allow")
  status        String   @default("active")
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  numbers       PhoneNumber[]
  project       Project @relation(fields: [projectId], references: [id])

  @@index([tenantId])
}

model CallRecord {
  id            String   @id @default(cuid())
  tenantId      String
  projectId     String
  sessionId     String
  trunkId       String
  direction     String             // inbound, outbound
  callerNumber  String
  calledNumber  String
  status        String             // ringing, active, completed, failed, transferred
  startedAt     DateTime
  answeredAt    DateTime?
  endedAt       DateTime?
  durationMs    Int?
  endReason     String?            // caller_hangup, agent_hangup, transfer, error
  transferTarget String?
  recordingUrl  String?
  metadata      String?            // JSON
  createdAt     DateTime @default(now())

  @@index([tenantId, projectId])
  @@index([sessionId])
  @@index([startedAt])
}
```

### 10.3 Configuration

#### A. Voice Schema Extension

**Location:** `packages/config/src/schemas/voice.schema.ts`

```typescript
sip: {
  enabled: boolean; // default: false
  defaultGreeting: string; // "Hello, how can I help you?"
  dtmf: {
    enabled: boolean; // default: true
    digitCollectionTimeout: number; // ms, default: 5000
    interDigitTimeout: number; // ms, default: 3000
    maxDigits: number; // default: 20
  }
  callRecording: {
    enabled: boolean;
    storageProvider: 'local' | 's3';
    retentionDays: number;
  }
  outbound: {
    enabled: boolean;
    maxConcurrentPerTenant: number; // default: 10
    defaultCallerId: string; // E.164
  }
  security: {
    transport: 'udp' | 'tcp' | 'tls'; // default: tls
    mediaEncryption: 'off' | 'allow' | 'require'; // default: require
  }
}
```

#### B. Environment Variables

```bash
# SIP Service
SIP_ENABLED=true
LIVEKIT_SIP_URL=http://sip-service:8080    # Health/API endpoint

# LiveKit (existing, shared with SIP service)
LIVEKIT_URL=wss://livekit-server.example.com
LIVEKIT_API_KEY=APIxxxxxx
LIVEKIT_API_SECRET=xxxxxxxx

# Twilio (stored encrypted per-tenant, but needed for number provisioning API)
TWILIO_ACCOUNT_SID=ACxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxx
```

---

## 11. Studio UI Changes

### 11.1 Phone Number Management Page

**Route:** `/projects/:projectId/telephony` (new ProjectPage)
**Sidebar:** Add "Telephony" item under "Build" section

#### Phone Numbers Tab

```
┌─────────────────────────────────────────────────────┐
│  Telephony                                           │
│                                                      │
│  [Phone Numbers]  [SIP Trunks]  [Call History]       │
│  ─────────────────────────────────────────────       │
│                                                      │
│  ┌───────────────────────────────────────────────┐   │
│  │  + Provision Number                           │   │
│  └───────────────────────────────────────────────┘   │
│                                                      │
│  ┌──────────────┬──────────┬───────────┬──────────┐  │
│  │ Number       │ Provider │ Status    │ Agent    │  │
│  ├──────────────┼──────────┼───────────┼──────────┤  │
│  │ +1 510 555   │ Twilio   │ ● Active  │ booking_ │  │
│  │  0123        │          │           │ agent    │  │
│  ├──────────────┼──────────┼───────────┼──────────┤  │
│  │ +1 212 555   │ Twilio   │ ● Active  │ support_ │  │
│  │  0100        │          │           │ agent    │  │
│  ├──────────────┼──────────┼───────────┼──────────┤  │
│  │ +1 310 555   │ Telnyx   │ ○ Inactive│ —        │  │
│  │  0200        │          │           │          │  │
│  └──────────────┴──────────┴───────────┴──────────┘  │
│                                                      │
│  Click a number to configure routing →               │
└─────────────────────────────────────────────────────┘
```

#### Provision Number Dialog

```
┌─────────────────────────────────────────────────┐
│  Provision Phone Number                          │
│                                                  │
│  Provider      [Twilio          ▼]               │
│                                                  │
│  Country       [United States   ▼]               │
│                                                  │
│  Area Code     [510             ]  (optional)    │
│                                                  │
│  ┌──── Available Numbers ─────────────────────┐  │
│  │  ○ +1 (510) 555-0199    Oakland, CA        │  │
│  │  ● +1 (510) 555-0201    Oakland, CA        │  │
│  │  ○ +1 (510) 555-0305    Berkeley, CA       │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  Route to      [booking_agent   ▼]               │
│  Deployment    [production      ▼]               │
│                                                  │
│         [Cancel]     [Provision Number]           │
└─────────────────────────────────────────────────┘
```

#### Number Detail / Routing Config

```
┌─────────────────────────────────────────────────┐
│  ← Back to Numbers                               │
│                                                  │
│  +1 (510) 555-0123                               │
│  Provider: Twilio  •  Status: Active             │
│                                                  │
│  ── Routing ──────────────────────────────────   │
│                                                  │
│  Deployment    [production      ▼]               │
│  Entry Agent   [booking_agent   ▼]               │
│  Greeting      [Hello! How can I help you today?]│
│                                                  │
│  ── Features ─────────────────────────────────   │
│                                                  │
│  □ Enable call recording                         │
│  ☑ Enable DTMF digit collection                  │
│  □ Enable Krisp noise cancellation               │
│                                                  │
│  ── Call Forwarding ──────────────────────────   │
│                                                  │
│  Fallback number  [+1 (510) 555-9999  ]          │
│  (if agent unavailable)                          │
│                                                  │
│        [Delete Number]     [Save Changes]        │
└─────────────────────────────────────────────────┘
```

### 11.2 SIP Trunks Tab

```
┌─────────────────────────────────────────────────┐
│  [Phone Numbers]  [SIP Trunks]  [Call History]   │
│  ─────────────────────────────────────────────   │
│                                                  │
│  ┌──── Inbound Trunks ───────────────────────┐   │
│  │                                            │   │
│  │  Twilio Inbound          ● Active          │   │
│  │  LiveKit Trunk: ST_xxx   2 numbers         │   │
│  │                                            │   │
│  └────────────────────────────────────────────┘   │
│                                                  │
│  ┌──── Outbound Trunks ──────────────────────┐   │
│  │                                            │   │
│  │  Twilio Outbound         ● Active          │   │
│  │  Domain: xxx.pstn.twilio.com               │   │
│  │                                            │   │
│  └────────────────────────────────────────────┘   │
│                                                  │
│  + Add Trunk                                     │
└─────────────────────────────────────────────────┘
```

### 11.3 Call History Tab

```
┌─────────────────────────────────────────────────────────┐
│  [Phone Numbers]  [SIP Trunks]  [Call History]           │
│  ─────────────────────────────────────────────           │
│                                                          │
│  Filter: [All ▼]  [Last 7 days ▼]  [Search...]          │
│                                                          │
│  ┌────────┬──────────┬─────────┬─────────┬────────────┐ │
│  │ Time   │ Caller   │ Number  │ Duration│ Status     │ │
│  ├────────┼──────────┼─────────┼─────────┼────────────┤ │
│  │ 2:34pm │ +1 415   │ +1 510  │ 4:23    │ Completed  │ │
│  │        │ 555-1234 │ 555-012 │         │            │ │
│  ├────────┼──────────┼─────────┼─────────┼────────────┤ │
│  │ 2:12pm │ +1 212   │ +1 510  │ 1:05    │ Transferred│ │
│  │        │ 555-5678 │ 555-012 │         │            │ │
│  ├────────┼──────────┼─────────┼─────────┼────────────┤ │
│  │ 1:55pm │ Outbound │ +1 650  │ 0:45    │ Completed  │ │
│  │        │          │ 555-900 │         │            │ │
│  └────────┴──────────┴─────────┴─────────┴────────────┘ │
│                                                          │
│  Click a row to view session trace + transcript →        │
└─────────────────────────────────────────────────────────┘
```

### 11.4 Voice Services Page Extension (Admin)

**Existing:** `VoiceServicesPage.tsx` already has Deepgram, ElevenLabs, Twilio cards.

**Add:** LiveKit SIP Service card:

```
┌─────────────────────────────────────────────────┐
│  LiveKit SIP Service                             │
│  Status: ● Connected                             │
│                                                  │
│  SIP Endpoint: sip.example.com:5060              │
│  Active Calls: 12                                │
│  Transport: TLS                                  │
│  Media: SRTP Required                            │
│                                                  │
│  [Configure]                                     │
└─────────────────────────────────────────────────┘
```

### 11.5 Navigation Changes

**File:** `apps/studio/src/store/navigation-store.ts`

Add `'telephony'` to `ProjectPage` type:

```typescript
type ProjectPage =
  | 'overview'
  | 'agents'
  | 'sessions'
  | 'traces'
  | 'deployments'
  | 'search-ai'
  | 'settings'
  | 'telephony';
```

**File:** `apps/studio/src/components/navigation/ProjectSidebar.tsx`

Add under "Build" section:

```typescript
{ icon: Phone, label: 'Telephony', page: 'telephony' }
```

### 11.6 API Client

**File:** `apps/studio/src/api/telephony.ts` (new)

```typescript
// Phone Numbers
fetchPhoneNumbers(projectId: string): Promise<PhoneNumber[]>
provisionPhoneNumber(projectId: string, opts: ProvisionOpts): Promise<PhoneNumber>
updatePhoneNumber(projectId: string, numberId: string, config: NumberConfig): Promise<PhoneNumber>
deletePhoneNumber(projectId: string, numberId: string): Promise<void>
searchAvailableNumbers(projectId: string, opts: SearchOpts): Promise<AvailableNumber[]>

// SIP Trunks
fetchSIPTrunks(projectId: string): Promise<SIPTrunk[]>
createSIPTrunk(projectId: string, config: TrunkConfig): Promise<SIPTrunk>
updateSIPTrunk(projectId: string, trunkId: string, config: Partial<TrunkConfig>): Promise<SIPTrunk>
deleteSIPTrunk(projectId: string, trunkId: string): Promise<void>
testSIPTrunk(projectId: string, trunkId: string): Promise<TrunkTestResult>

// Call History
fetchCallRecords(projectId: string, filters: CallFilters): Promise<PaginatedResult<CallRecord>>
getCallRecord(projectId: string, callId: string): Promise<CallRecordDetail>
```

---

## 12. DSL & Compiler Changes

### 12.1 Agent IR Extension

Add optional `telephony` block to `AgentIR`:

```typescript
interface AgentIR {
  // ... existing fields ...
  telephony?: {
    greeting?: string; // Initial greeting for inbound calls
    dtmf_enabled?: boolean;
    outbound_enabled?: boolean;
    transfer_targets?: TransferTarget[]; // Named transfer destinations
    call_recording?: boolean;
    max_call_duration?: number; // seconds
    inactivity_timeout?: number; // seconds of silence before hang up
  };
}

interface TransferTarget {
  name: string; // "billing", "human_agent"
  number: string; // E.164
  announcement?: string; // "I'm transferring you to billing"
}
```

### 12.2 DSL Syntax (Future)

```
AGENT support_agent
  MODEL gpt-4o

  TELEPHONY
    GREETING "Hello, thank you for calling Acme Support. How can I help you?"
    DTMF ENABLED
    MAX_DURATION 1800
    INACTIVITY_TIMEOUT 30

    TRANSFER billing "+18005551234"
      ANNOUNCEMENT "Let me transfer you to our billing department."

    TRANSFER human "+18005559999"
      ANNOUNCEMENT "I'm connecting you with a human agent now."

  FLOW
    STEP welcome
      ...
```

### 12.3 Platform Tools

Add built-in platform tools available to all agents when telephony is enabled:

| Tool                 | Description                     | Parameters                           |
| -------------------- | ------------------------------- | ------------------------------------ |
| `sip.transfer`       | Cold transfer to another number | `target: string` (name or E.164)     |
| `sip.hangup`         | End the current call            | `reason?: string`                    |
| `sip.collect_digits` | Collect DTMF digits from caller | `count: number, timeout_ms?: number` |
| `sip.send_dtmf`      | Send DTMF digits to caller      | `digits: string`                     |
| `sip.hold`           | Place caller on hold with music | `music_url?: string`                 |
| `sip.unhold`         | Resume from hold                | —                                    |
| `sip.make_call`      | Place an outbound call          | `number: string, greeting?: string`  |

---

## 13. Security Considerations

### 13.1 Transport Security

| Layer          | Requirement      | Implementation                     |
| -------------- | ---------------- | ---------------------------------- |
| SIP signaling  | TLS (port 5061)  | Trunk `transport: 'tls'`           |
| SIP media      | SRTP             | Trunk `mediaEncryption: 'require'` |
| LiveKit Server | WSS (TLS)        | Standard LiveKit TLS               |
| Redis          | TLS (if exposed) | Redis TLS configuration            |
| API            | HTTPS            | Standard platform TLS              |

### 13.2 Authentication & Authorization

| Concern              | Implementation                                                      |
| -------------------- | ------------------------------------------------------------------- |
| Inbound SIP auth     | IP allowlist (provider IPs only) + digest auth                      |
| Outbound SIP auth    | Encrypted credentials per trunk (AES-256-GCM via EncryptionService) |
| Trunk management API | JWT + RBAC (`requireWriteAccess()`)                                 |
| Number provisioning  | Admin role required                                                 |
| Outbound calls       | Per-tenant rate limit + max concurrent                              |

### 13.3 Toll Fraud Prevention

| Risk                        | Mitigation                                                 |
| --------------------------- | ---------------------------------------------------------- |
| Unauthorized outbound calls | Per-tenant concurrency limits, destination allowlist       |
| International call fraud    | Default block international, explicit allowlist per tenant |
| Excessive call duration     | `max_call_duration` in agent IR                            |
| Call forwarding loops       | Detect and break forwarding chains (max 3 hops)            |
| SIP trunk hijacking         | IP allowlist, credential rotation, monitoring              |

### 13.4 Data Privacy

| Concern                 | Implementation                                                  |
| ----------------------- | --------------------------------------------------------------- |
| Call recording consent  | Configurable per-number, announcement before recording          |
| PII in transcripts      | Existing PII detector (`pii-detector.ts`) applied to STT output |
| Call metadata retention | Configurable retention period per tenant                        |
| Number masking          | Option to mask caller ID in logs/traces                         |

---

## 14. Rollout Plan

### Phase 1: Foundation (2-3 weeks)

- [ ] Database models: `PhoneNumber`, `SIPTrunk`, `CallRecord`
- [ ] SIP trunk management service + REST API
- [ ] LiveKit SIP API integration (create/manage trunks and dispatch rules via LiveKit SDK)
- [ ] Twilio number provisioning API integration
- [ ] Studio: Telephony page with Phone Numbers and SIP Trunks tabs
- [ ] Studio: Number provisioning dialog (search + provision + assign to agent)

### Phase 2: Inbound Calls (2-3 weeks)

- [ ] SIP call lifecycle handler (webhook → room → agent spawn)
- [ ] DID → tenant → project → deployment → agent resolution
- [ ] Caller greeting on SIP participant join
- [ ] CallerContext enrichment with SIP metadata
- [ ] Trace events with telephony context (caller number, trunk, duration)
- [ ] Studio: Call History tab
- [ ] End-to-end testing with Twilio test calls

### Phase 3: Call Features (2 weeks)

- [ ] DTMF handling (receive + send + digit collection)
- [ ] Call transfer (cold transfer via SIP REFER)
- [ ] Call recording (LiveKit egress → S3)
- [ ] Platform tools: `sip.transfer`, `sip.hangup`, `sip.collect_digits`
- [ ] DSL: `TELEPHONY` block in agent IR
- [ ] Inactivity timeout (hang up after N seconds silence)

### Phase 4: Outbound Calls (1-2 weeks)

- [ ] Outbound call tool (`sip.make_call`)
- [ ] Outbound trunk credential management
- [ ] Per-tenant rate limiting for outbound
- [ ] Studio: outbound call initiation from session view

### Phase 5: Enterprise Hardening (2 weeks)

- [ ] Secure trunking (TLS + SRTP) validation
- [ ] Toll fraud prevention (destination allowlist, international blocking)
- [ ] Multi-provider support (Telnyx as secondary)
- [ ] Call analytics dashboard in Studio
- [ ] Load testing at target concurrency
- [ ] Monitoring + alerting (call failure rate, latency, queue depth)

---

## 15. Open Questions

| #   | Question                                         | Options                                                | Impact                                                  |
| --- | ------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------- |
| 1   | **LiveKit Cloud vs self-hosted SIP?**            | Cloud eliminates infra; self-hosted gives control      | Determines ops burden and Phase 1 timeline              |
| 2   | **Twilio-only or multi-provider from day 1?**    | Twilio-only simplifies; multi-provider adds resilience | API surface design, number provisioning abstraction     |
| 3   | **Call recording storage?**                      | S3, LiveKit egress, or Twilio recording                | Cost, latency, compliance                               |
| 4   | **Agent framework language?**                    | LiveKit Python agent SDK vs Node.js bridge             | Python = native LiveKit; Node.js = unified with runtime |
| 5   | **Number lifecycle ownership?**                  | Platform provisions numbers vs customer brings numbers | Billing model, Twilio sub-account structure             |
| 6   | **Option B (Twilio Media Streams) as fallback?** | Build both options vs LiveKit SIP only                 | Engineering effort vs deployment flexibility            |
| 7   | **DTMF vs speech for menu navigation?**          | DTMF-only, speech-only, or hybrid                      | UX complexity, error handling                           |
| 8   | **Call queuing?**                                | Hold music + queue position vs immediate agent         | Capacity planning, UX for high-volume deployments       |

---

## References

- [LiveKit Telephony Documentation](https://docs.livekit.io/sip/)
- [LiveKit SIP Trunk Setup](https://docs.livekit.io/telephony/start/sip-trunk-setup/)
- [LiveKit SIP GitHub Repository](https://github.com/livekit/sip)
- [LiveKit Agent Server Lifecycle](https://docs.livekit.io/agents/server/lifecycle/)
- [LiveKit Quotas and Limits](https://docs.livekit.io/deploy/admin/quotas-and-limits/)
- [Twilio Elastic SIP Trunking](https://www.twilio.com/docs/sip-trunking)
- [Twilio + LiveKit Setup Guide](https://docs.livekit.io/telephony/start/providers/twilio/)
- [Telnyx + LiveKit Configuration](https://developers.telnyx.com/docs/voice/sip-trunking/livekit-configuration-guide)
- [LiveKit SIP APIs Reference](https://docs.livekit.io/reference/telephony/sip-api/)
