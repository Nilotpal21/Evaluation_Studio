# AgenticAI → ABL Migration: Architecture & Design Blueprint

## Executive Summary

This document provides a comprehensive architectural blueprint for migrating the AgenticAI multi-agent platform to ABL (Agent Business Language), ensuring full backward compatibility while enabling the new ABL runtime to execute existing AgenticAI applications.

**Objective**: Replace the AgenticAI graph-based runtime with ABL's unified runtime while:

1. Maintaining 100% backward compatibility for existing APIs
2. Enabling existing apps to run without modification
3. Providing a superior LLM routing and model registry
4. Supporting full MCP protocol
5. Enabling gradual migration path

---

## Table of Contents

1. [Current State Analysis](#1-current-state-analysis)
2. [Target Architecture](#2-target-architecture) _(Split Design/Deployment + Runtime)_
3. [Component Mapping](#3-component-mapping)
4. [Runtime Execution Model](#4-runtime-execution-model)
5. [State Management & Checkpointing](#5-state-management--checkpointing)
6. [Tool Execution Architecture](#6-tool-execution-architecture)
7. [LLM Routing & Model Registry](#7-llm-routing--model-registry)
8. [MCP Protocol Integration](#8-mcp-protocol-integration)
9. [API Compatibility Layer](#9-api-compatibility-layer)
10. [Streaming Architecture](#10-streaming-architecture)
11. [Multi-Tenant Isolation](#11-multi-tenant-isolation)
12. [GALE Integration](#12-gale-integration)
13. [Data Model Mapping](#13-data-model-mapping)
14. [Deployment Topologies](#14-deployment-topologies)
15. [Migration Strategy](#15-migration-strategy)
16. [Verification & Testing](#16-verification--testing)

---

## 1. Current State Analysis

### 1.1 AgenticAI Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        AgenticAI Platform                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐             │
│  │   Server App    │  │   Engine App    │  │    Tool App     │             │
│  │   (Port 3000)   │  │   (Port 3001)   │  │   (Port 3112)   │             │
│  │                 │  │                 │  │                 │             │
│  │ • REST APIs     │  │ • Graph Compile │  │ • Tool Exec     │             │
│  │ • WebSocket     │  │ • Graph Invoke  │  │ • MCP Tools     │             │
│  │ • CRUD Ops      │  │ • Graph Engine  │  │ • Inline Tools  │             │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘             │
│           │                    │                    │                       │
│           └────────────────────┼────────────────────┘                       │
│                                │                                            │
│  ┌─────────────────────────────┴─────────────────────────────────────────┐ │
│  │                        Shared Libraries                                │ │
│  │                                                                        │ │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐   │ │
│  │  │ GALE     │ │ Config   │ │ Utils    │ │ Auth/JWT │ │ Feature  │   │ │
│  │  │ Integr.  │ │ Service  │ │ & DTOs   │ │ Service  │ │ Flags    │   │ │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘   │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                         Data Layer                                       ││
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                  ││
│  │  │   MongoDB    │  │    Redis     │  │  RabbitMQ    │                  ││
│  │  │  (Primary)   │  │   (Cache)    │  │   (Queue)    │                  ││
│  │  └──────────────┘  └──────────────┘  └──────────────┘                  ││
│  └─────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 AgenticAI Core Components

| Component           | Technology                | Purpose                               |
| ------------------- | ------------------------- | ------------------------------------- |
| **Graph Engine**    | StateGraph                | Agent orchestration, state management |
| **Checkpointing**   | MongoDB/Redis             | State persistence across turns        |
| **Tool Execution**  | BaseToolFactory hierarchy | Tool invocation with factories        |
| **LLM Integration** | Direct provider SDKs      | Model calls                           |
| **Streaming**       | Graph stream API          | Real-time responses                   |
| **Multi-Agent**     | Supervisor/Worker pattern | Agent coordination                    |

### 1.3 ABL Current Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           ABL Platform                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                      @abl/compiler Package                               ││
│  │                                                                          ││
│  │  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐               ││
│  │  │  DSL Parser   │  │  IR Compiler  │  │  Constructs   │               ││
│  │  │               │  │               │  │  Executors    │               ││
│  │  └───────┬───────┘  └───────┬───────┘  └───────┬───────┘               ││
│  │          │                  │                  │                        ││
│  │          └──────────────────┼──────────────────┘                        ││
│  │                             │                                           ││
│  │  ┌──────────────────────────┴──────────────────────────────────────┐   ││
│  │  │                    Platform Layer                                │   ││
│  │  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐           │   ││
│  │  │  │ Base     │ │  Stores  │ │   NLU    │ │ Security │           │   ││
│  │  │  │ Runtime  │ │ (Memory) │ │  Engine  │ │  (PII)   │           │   ││
│  │  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘           │   ││
│  │  │  ┌──────────┐ ┌──────────┐ ┌──────────┐                        │   ││
│  │  │  │  Voice   │ │ Digital  │ │ Workflow │                        │   ││
│  │  │  │ Runtime  │ │ Runtime  │ │ Runtime  │                        │   ││
│  │  │  └──────────┘ └──────────┘ └──────────┘                        │   ││
│  │  └─────────────────────────────────────────────────────────────────┘   ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                      apps/platform                                       ││
│  │  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐               ││
│  │  │  REST APIs    │  │   WebSocket   │  │   Services    │               ││
│  │  │  (Express)    │  │   Handlers    │  │  (Auth, etc)  │               ││
│  │  └───────────────┘  └───────────────┘  └───────────────┘               ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                         Data Layer                                       ││
│  │  ┌──────────────┐  ┌──────────────┐                                    ││
│  │  │  SQLite/     │  │    Redis     │                                    ││
│  │  │  PostgreSQL  │  │  (Optional)  │                                    ││
│  │  └──────────────┘  └──────────────┘                                    ││
│  └─────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Target Architecture

### 2.1 Split Architecture Overview

The platform is split into two independently deployable services:

1. **Design & Deployment Service** (Studio/Platform API)
   - User-facing web application and API
   - Agent design, editing, versioning
   - Project management, deployment pipelines
   - Analytics, monitoring dashboards
   - Technology: **Next.js App Router** (full-stack)

2. **Runtime Service** (Execution Engine)
   - Long-running agent execution
   - WebSocket connections for streaming
   - Checkpointing, state management
   - Tool execution, LLM orchestration
   - Technology: **Node.js + Express** (or standalone process)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    ABL Platform - Split Architecture                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                 DESIGN & DEPLOYMENT SERVICE                             │ │
│  │                    (Next.js App Router)                                 │ │
│  │                                                                         │ │
│  │  ┌───────────────────────────────────────────────────────────────────┐ │ │
│  │  │                      Web Application                               │ │ │
│  │  │                                                                    │ │ │
│  │  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐            │ │ │
│  │  │  │   Studio     │  │   Agent      │  │   Analytics  │            │ │ │
│  │  │  │   Editor     │  │   Debugger   │  │   Dashboard  │            │ │ │
│  │  │  └──────────────┘  └──────────────┘  └──────────────┘            │ │ │
│  │  │                                                                    │ │ │
│  │  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐            │ │ │
│  │  │  │  Deployment  │  │   Version    │  │   Settings   │            │ │ │
│  │  │  │   Manager    │  │   Control    │  │    & Auth    │            │ │ │
│  │  │  └──────────────┘  └──────────────┘  └──────────────┘            │ │ │
│  │  └───────────────────────────────────────────────────────────────────┘ │ │
│  │                                                                         │ │
│  │  ┌───────────────────────────────────────────────────────────────────┐ │ │
│  │  │                      API Routes (Next.js)                          │ │ │
│  │  │                                                                    │ │ │
│  │  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐   │ │ │
│  │  │  │  /api/projects  │  │  /api/agents    │  │  /api/tools     │   │ │ │
│  │  │  │  CRUD, search   │  │  CRUD, compile  │  │  CRUD, MCP      │   │ │ │
│  │  │  └─────────────────┘  └─────────────────┘  └─────────────────┘   │ │ │
│  │  │                                                                    │ │ │
│  │  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐   │ │ │
│  │  │  │  /api/deploy    │  │  /api/versions  │  │  /api/analytics │   │ │ │
│  │  │  │  publish, env   │  │  git-like ops   │  │  traces, metrics│   │ │ │
│  │  │  └─────────────────┘  └─────────────────┘  └─────────────────┘   │ │ │
│  │  │                                                                    │ │ │
│  │  │  ┌─────────────────────────────────────────────────────────────┐ │ │ │
│  │  │  │  /api/v1/*  (AgenticAI Compatibility Layer)                  │ │ │ │
│  │  │  │  • Translates legacy requests → Runtime Service              │ │ │ │
│  │  │  │  • Converts AgenticAI configs → ABL format                   │ │ │ │
│  │  │  │  • Maps responses back to legacy format                      │ │ │ │
│  │  │  └─────────────────────────────────────────────────────────────┘ │ │ │
│  │  └───────────────────────────────────────────────────────────────────┘ │ │
│  │                                                                         │ │
│  │  ┌───────────────────────────────────────────────────────────────────┐ │ │
│  │  │                      Data Layer (Design-time)                      │ │ │
│  │  │                                                                    │ │ │
│  │  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐            │ │ │
│  │  │  │  PostgreSQL  │  │    Redis     │  │   S3/Blob    │            │ │ │
│  │  │  │  (Metadata)  │  │   (Cache)    │  │  (Assets)    │            │ │ │
│  │  │  └──────────────┘  └──────────────┘  └──────────────┘            │ │ │
│  │  └───────────────────────────────────────────────────────────────────┘ │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│                            │ gRPC / HTTP │                                  │
│                            │  (Internal) │                                  │
│                            ▼             ▼                                  │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                     RUNTIME SERVICE                                     │ │
│  │                 (Node.js + Express / Standalone)                        │ │
│  │                                                                         │ │
│  │  ┌───────────────────────────────────────────────────────────────────┐ │ │
│  │  │                      API Gateway Layer                             │ │ │
│  │  │                                                                    │ │ │
│  │  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐   │ │ │
│  │  │  │  /runtime/exec  │  │  /runtime/ws    │  │  /runtime/hooks │   │ │ │
│  │  │  │  Start session  │  │  WebSocket      │  │  Twilio, etc.   │   │ │ │
│  │  │  └─────────────────┘  └─────────────────┘  └─────────────────┘   │ │ │
│  │  │                                                                    │ │ │
│  │  │  ┌─────────────────┐  ┌─────────────────┐                        │ │ │
│  │  │  │  /runtime/chk   │  │  /runtime/state │                        │ │ │
│  │  │  │  Checkpoints    │  │  Session state  │                        │ │ │
│  │  │  └─────────────────┘  └─────────────────┘                        │ │ │
│  │  └───────────────────────────────────────────────────────────────────┘ │ │
│  │                                                                         │ │
│  │  ┌───────────────────────────────────────────────────────────────────┐ │ │
│  │  │                    ABL Execution Engine                            │ │ │
│  │  │                                                                    │ │ │
│  │  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐            │ │ │
│  │  │  │  Scripted    │  │  Reasoning   │  │  Supervisor  │            │ │ │
│  │  │  │  Executor    │  │  Executor    │  │  Executor    │            │ │ │
│  │  │  └──────────────┘  └──────────────┘  └──────────────┘            │ │ │
│  │  │                                                                    │ │ │
│  │  │  ┌──────────────────────────────────────────────────────────────┐│ │ │
│  │  │  │              Construct Executor                               ││ │ │
│  │  │  │  (Flow, Gather, Reasoning, NLU, Handoff, Delegate)           ││ │ │
│  │  │  └──────────────────────────────────────────────────────────────┘│ │ │
│  │  └───────────────────────────────────────────────────────────────────┘ │ │
│  │                                                                         │ │
│  │  ┌───────────────────────────────────────────────────────────────────┐ │ │
│  │  │                    State & Session Manager                         │ │ │
│  │  │                                                                    │ │ │
│  │  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐            │ │ │
│  │  │  │ Checkpointer │  │ Conversation │  │    Trace     │            │ │ │
│  │  │  │ (Redis/Mongo)│  │    Store     │  │    Store     │            │ │ │
│  │  │  └──────────────┘  └──────────────┘  └──────────────┘            │ │ │
│  │  └───────────────────────────────────────────────────────────────────┘ │ │
│  │                                                                         │ │
│  │  ┌───────────────────────────────────────────────────────────────────┐ │ │
│  │  │                      Tool Execution Layer                          │ │ │
│  │  │                                                                    │ │ │
│  │  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐            │ │ │
│  │  │  │   Unified    │  │    MCP       │  │   HTTP/API   │            │ │ │
│  │  │  │ Tool Router  │  │   Client     │  │   Executor   │            │ │ │
│  │  │  └──────────────┘  └──────────────┘  └──────────────┘            │ │ │
│  │  │                                                                    │ │ │
│  │  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐            │ │ │
│  │  │  │   Inline     │  │    GALE      │  │   Sandbox    │            │ │ │
│  │  │  │   Executor   │  │ Tool Fetcher │  │  (JS/Sandbox)│            │ │ │
│  │  │  └──────────────┘  └──────────────┘  └──────────────┘            │ │ │
│  │  └───────────────────────────────────────────────────────────────────┘ │ │
│  │                                                                         │ │
│  │  ┌───────────────────────────────────────────────────────────────────┐ │ │
│  │  │                      LLM Layer                                     │ │ │
│  │  │                                                                    │ │ │
│  │  │  ┌─────────────────────────────────────────────────────────────┐ │ │ │
│  │  │  │                    Model Registry                            │ │ │ │
│  │  │  │  • Dynamic model catalog (GALE + local)                     │ │ │ │
│  │  │  │  • Capability-based routing                                  │ │ │ │
│  │  │  │  • Cost/latency optimization                                 │ │ │ │
│  │  │  │  • Fallback chains                                           │ │ │ │
│  │  │  └─────────────────────────────────────────────────────────────┘ │ │ │
│  │  │                                                                    │ │ │
│  │  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐            │ │ │
│  │  │  │  Anthropic   │  │   OpenAI     │  │   Google     │            │ │ │
│  │  │  │  Provider    │  │  Provider    │  │  Provider    │            │ │ │
│  │  │  └──────────────┘  └──────────────┘  └──────────────┘            │ │ │
│  │  └───────────────────────────────────────────────────────────────────┘ │ │
│  │                                                                         │ │
│  │  ┌───────────────────────────────────────────────────────────────────┐ │ │
│  │  │                      Data Layer (Runtime)                          │ │ │
│  │  │                                                                    │ │ │
│  │  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐            │ │ │
│  │  │  │    Redis     │  │   MongoDB    │  │  RabbitMQ    │            │ │ │
│  │  │  │ (Cache/Lock) │  │(Checkpoints) │  │  (Async)     │            │ │ │
│  │  │  └──────────────┘  └──────────────┘  └──────────────┘            │ │ │
│  │  └───────────────────────────────────────────────────────────────────┘ │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Service Responsibilities

| Aspect              | Design & Deployment Service      | Runtime Service               |
| ------------------- | -------------------------------- | ----------------------------- |
| **Primary Role**    | Authoring, management, analytics | Execution, state, streaming   |
| **Technology**      | Next.js 14+ App Router           | Node.js + Express             |
| **Scaling**         | Horizontal (stateless)           | Horizontal + sticky sessions  |
| **State**           | Stateless (DB-backed)            | Stateful (session affinity)   |
| **Latency**         | Standard web (~100ms)            | Low latency (<50ms for voice) |
| **Connection Type** | HTTP/REST                        | WebSocket + HTTP              |
| **Deployment**      | Vercel / Edge / Container        | Container / VM / K8s          |

### 2.3 Communication Patterns

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Service Communication Patterns                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. DESIGN → RUNTIME (Deployment Flow)                                      │
│  ───────────────────────────────────────                                    │
│                                                                              │
│     Studio                Design Service              Runtime Service       │
│        │                       │                           │                 │
│        │  Save Agent           │                           │                 │
│        │──────────────────────►│                           │                 │
│        │                       │  Compile to IR            │                 │
│        │                       │────────────────┐          │                 │
│        │                       │◄───────────────┘          │                 │
│        │                       │                           │                 │
│        │  Click "Deploy"       │                           │                 │
│        │──────────────────────►│                           │                 │
│        │                       │  POST /runtime/deploy     │                 │
│        │                       │  {ir, version, config}    │                 │
│        │                       │──────────────────────────►│                 │
│        │                       │                           │  Load IR        │
│        │                       │                           │────────┐        │
│        │                       │                           │◄───────┘        │
│        │                       │         200 OK            │                 │
│        │                       │◄──────────────────────────│                 │
│        │    Deploy success     │                           │                 │
│        │◄──────────────────────│                           │                 │
│                                                                              │
│                                                                              │
│  2. CLIENT → RUNTIME (Execution Flow)                                       │
│  ────────────────────────────────────                                       │
│                                                                              │
│     Client                Design Service              Runtime Service       │
│        │                       │                           │                 │
│        │  GET /api/session     │                           │                 │
│        │──────────────────────►│                           │                 │
│        │                       │  POST /runtime/session    │                 │
│        │                       │──────────────────────────►│                 │
│        │                       │  {sessionId, wsUrl}       │                 │
│        │                       │◄──────────────────────────│                 │
│        │   {sessionId, wsUrl}  │                           │                 │
│        │◄──────────────────────│                           │                 │
│        │                                                   │                 │
│        │  WebSocket connect                                │                 │
│        │──────────────────────────────────────────────────►│                 │
│        │                       ◄────── Streaming ──────────│                 │
│        │◄──────────────────────────────────────────────────│                 │
│                                                                              │
│                                                                              │
│  3. ANALYTICS FLOW                                                          │
│  ─────────────────                                                          │
│                                                                              │
│     Runtime                                        Design Service           │
│        │                                                │                    │
│        │  Batch traces/metrics every N seconds          │                    │
│        │  POST /api/ingest/traces                       │                    │
│        │───────────────────────────────────────────────►│                    │
│        │                                                │  Store in          │
│        │                                                │  PostgreSQL        │
│        │                                                │────────┐           │
│        │                                                │◄───────┘           │
│        │                                                │                    │
│        │  Real-time debug (optional)                    │                    │
│        │  WebSocket /api/debug/ws                       │                    │
│        │───────────────────────────────────────────────►│                    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.4 Why This Split?

| Concern                   | Unified                             | Split (Recommended)                            |
| ------------------------- | ----------------------------------- | ---------------------------------------------- |
| **Scaling**               | Must scale together                 | Scale independently based on load              |
| **Deployment**            | Single deploy, single failure point | Deploy Studio without affecting running agents |
| **Technology**            | Constrained to one stack            | Best tool for each job                         |
| **Voice Latency**         | Web framework overhead              | Optimized runtime path                         |
| **Long-running Sessions** | Competes with web traffic           | Dedicated resources                            |
| **Development**           | Coupled releases                    | Independent team velocity                      |
| **Edge Deployment**       | Difficult                           | Studio at edge, Runtime at region              |

### 2.5 Next.js for Design Service

```
apps/studio/                          # Next.js 14+ App Router
├── app/
│   ├── layout.tsx                    # Root layout with providers
│   ├── page.tsx                      # Landing / dashboard
│   ├── (auth)/
│   │   ├── login/page.tsx
│   │   └── register/page.tsx
│   ├── projects/
│   │   ├── page.tsx                  # Project list
│   │   └── [projectId]/
│   │       ├── page.tsx              # Project overview
│   │       ├── agents/
│   │       │   ├── page.tsx          # Agent list
│   │       │   └── [agentId]/
│   │       │       ├── page.tsx      # Agent editor
│   │       │       └── debug/page.tsx # Agent debugger
│   │       ├── deploy/page.tsx       # Deployment manager
│   │       └── analytics/page.tsx    # Traces, metrics
│   └── api/                          # API Routes
│       ├── projects/route.ts
│       ├── agents/route.ts
│       ├── deploy/route.ts
│       ├── v1/                       # AgenticAI compat layer
│       │   ├── apps/route.ts
│       │   └── agents/route.ts
│       └── runtime/                  # Proxy to Runtime Service
│           └── [...path]/route.ts    # Forward to runtime
├── lib/
│   ├── runtime-client.ts             # Client for Runtime Service
│   ├── compiler.ts                   # Uses @abl/compiler
│   └── db.ts                         # Prisma client
└── components/
    ├── editor/                       # Monaco-based DSL editor
    ├── flow-graph/                   # Visual agent graph
    └── debugger/                     # Real-time debugger
```

### 2.6 Node.js for Runtime Service

```
apps/runtime/                         # Node.js + Express
├── src/
│   ├── index.ts                      # Entry point
│   ├── server.ts                     # Express + WebSocket setup
│   ├── routes/
│   │   ├── exec.ts                   # POST /runtime/exec
│   │   ├── session.ts                # Session management
│   │   ├── checkpoint.ts             # Checkpoint CRUD
│   │   └── hooks.ts                  # Twilio, webhook handlers
│   ├── websocket/
│   │   ├── handler.ts                # WebSocket message router
│   │   ├── voice-stream.ts           # Voice media handling
│   │   └── chat-stream.ts            # Chat streaming
│   ├── execution/
│   │   ├── runtime-manager.ts        # Runtime lifecycle
│   │   ├── session-store.ts          # In-memory + Redis sessions
│   │   └── ir-loader.ts              # Load compiled IR
│   ├── llm/
│   │   ├── router.ts                 # Model routing
│   │   └── providers/                # Provider adapters
│   ├── tools/
│   │   ├── router.ts                 # Tool routing
│   │   ├── mcp-client.ts             # MCP connections
│   │   └── gale-fetcher.ts           # GALE tool loading
│   └── observability/
│       ├── tracer.ts                 # OpenTelemetry
│       └── metrics.ts                # Prometheus metrics
└── package.json
```

---

## 3. Component Mapping

### 3.1 Agent Type Mapping

| AgenticAI Role        | ABL Agent Type          | Mapping Strategy                           |
| --------------------- | ----------------------- | ------------------------------------------ |
| **SUPERVISOR**        | `supervisor`            | Direct mapping - routes to child agents    |
| **WORKER**            | `reasoning`             | Map tools, system prompt → reasoning block |
| **DELEGATION_WORKER** | `reasoning`             | Add delegate() calls to other agents       |
| **PROCESSOR**         | `scripted`              | Convert to deterministic flow steps        |
| **PROXY_WORKER**      | `reasoning` + HTTP tool | Create HTTP tool binding for proxy calls   |

### 3.2 Structural Mapping

```
AgenticAI App                          ABL App
─────────────────────────────────────────────────────────────────────
agenticApp {                     →    app my_app {
  _id: "app_123"                        name: "My App"
  name: "My App"                        entry: orchestrator
  entryAgent: "orchestrator"            agents: [orchestrator, worker1, worker2]
  agents: [...]                       }
}

Agent (SUPERVISOR) {             →    supervisor orchestrator {
  name: "orchestrator"                  agents: [worker1, worker2]
  role: "SUPERVISOR"                    strategy: semantic
  workers: ["worker1", "worker2"]       model: "claude-sonnet-4"
  routingConfig: {                      routing {
    strategy: "semantic"                  when "booking" -> worker1
  }                                       when "support" -> worker2
}                                       }
                                      }

Agent (WORKER) {                 →    agent worker1 {
  name: "worker1"                       name: "Booking Worker"
  role: "WORKER"                        reasoning {
  systemPrompt: "You are..."              tools: [search, book]
  tools: [search, book]                   model: "claude-sonnet-4"
  maxTurns: 20                            constraints {
}                                           max_turns: 20
                                          }
                                          system_prompt: "You are..."
                                        }
                                      }

Agent (PROCESSOR) {              →    agent processor1 {
  name: "processor1"                    name: "Data Processor"
  role: "PROCESSOR"                     scripted {
  systemPrompt: "Process..."              flow {
}                                           step process {
                                              prompt("Process the input")
                                              transition -> done
                                            }
                                          }
                                        }
                                      }
```

### 3.3 Tool Mapping

```
AgenticAI Tool                         ABL Tool Definition
─────────────────────────────────────────────────────────────────────
{                                →    tool search_flights {
  name: "search_flights"                description: "Search for flights"
  type: "LIBRARY"
  libraryToolId: "gale_tool_123"        gale {
  inputSchema: {...}                      tool_id: "gale_tool_123"
}                                       }
                                      }

{                                →    tool calculate_price {
  name: "calculate_price"               description: "Calculate total price"
  type: "INLINE"                        params {
  language: "javascript"                  items: array
  code: "..."                             discount: number?
  inputSchema: {...}                    }
}                                       javascript {
                                          const total = items.reduce(...);
                                          return { price: total };
                                        }
                                      }

{                                →    tool external_api {
  name: "external_api"                  description: "Call external API"
  type: "MCP"
  mcpServer: "api_server"               mcp {
  mcpTool: "fetch_data"                   server: "api_server"
}                                         tool: "fetch_data"
                                        }
                                      }
```

---

## 4. Runtime Execution Model

### 4.1 Execution Flow Comparison

```
AgenticAI (Graph Engine)                ABL (Construct Executor)
─────────────────────────────────────────────────────────────────────

1. Compile Graph                        1. Load IR / Parse DSL
   ┌──────────────────┐                    ┌──────────────────┐
   │ StateGraph.compile()               │  │ compileABLtoIR() │
   └──────────┬───────┘                    └──────────┬───────┘
              │                                       │
              ▼                                       ▼
2. Create Checkpointer                  2. Initialize Runtime
   ┌──────────────────┐                    ┌──────────────────┐
   │ MongoDBSaver or                    │  │ BaseRuntime +    │
   │ RedisSaver                         │  │ Checkpointer     │
   └──────────┬───────┘                    └──────────┬───────┘
              │                                       │
              ▼                                       ▼
3. Invoke Graph                         3. Execute Construct
   ┌──────────────────┐                    ┌──────────────────┐
   │ graph.invoke({                     │  │ executor.execute │
   │   messages: [...]                  │  │   (context)      │
   │ })                                 │  │                  │
   └──────────┬───────┘                    └──────────┬───────┘
              │                                       │
              ▼                                       ▼
4. Node Execution Loop                  4. Construct Loop
   ┌──────────────────┐                    ┌──────────────────┐
   │ for node in graph:                 │  │ while (!done):   │
   │   state = node(state)              │  │   action = step()│
   │   checkpoint(state)                │  │   checkpoint()   │
   └──────────┬───────┘                    └──────────┬───────┘
              │                                       │
              ▼                                       ▼
5. Tool Execution                       5. Tool Execution
   ┌──────────────────┐                    ┌──────────────────┐
   │ ToolNode.invoke()                  │  │ ToolExecutor     │
   │                                    │  │   .execute()     │
   └──────────────────┘                    └──────────────────┘
```

### 4.2 State Mapping

```typescript
// AgenticAI State (Graph Engine)
interface AgenticState {
  messages: BaseMessage[]; // Graph engine message format
  sender: string; // Current agent
  next: string; // Next agent/node
  context: Record<string, unknown>; // Shared context
  // Custom fields per app...
}

// ABL State
interface AgentState {
  currentStep: string; // Current flow step
  context: Record<string, unknown>; // Agent context (mapped from AgenticAI)
  collectedFields: Record<string, unknown>; // Gather results
  lastIntent?: IntentResult; // NLU result
  turnCount: number; // Turn counter
  flags: Record<string, boolean>; // Control flags
  errors: ErrorInfo[]; // Error stack
}

// Mapping Function
function mapAgenticStateToABL(agenticState: AgenticState): AgentState {
  return {
    currentStep: agenticState.next || 'start',
    context: {
      ...agenticState.context,
      _messages: agenticState.messages, // Preserve for compat
      _sender: agenticState.sender,
    },
    collectedFields: extractCollectedFields(agenticState),
    turnCount: countUserMessages(agenticState.messages),
    flags: {},
    errors: [],
  };
}
```

### 4.3 Message Format Mapping

```typescript
// AgenticAI Message (Graph Engine)
interface AgenticMessage {
  type: 'human' | 'ai' | 'tool' | 'system';
  content: string | ContentBlock[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

// ABL Message
interface ABLMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: LLMToolCall[];
  toolResults?: LLMToolResult[];
}

// Bidirectional Mapping
function agenticToABL(msg: AgenticMessage): ABLMessage {
  return {
    role: mapRole(msg.type),
    content: extractText(msg.content),
    toolCalls: msg.tool_calls?.map(mapToolCall),
  };
}

function ablToAgentic(msg: ABLMessage): AgenticMessage {
  return {
    type: mapRoleReverse(msg.role),
    content: msg.content,
    tool_calls: msg.toolCalls?.map(mapToolCallReverse),
  };
}
```

---

## 5. State Management & Checkpointing

### 5.1 Checkpointing Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Unified Checkpointing System                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                    Checkpointer Interface                                ││
│  │                                                                          ││
│  │  • save(sessionId, checkpoint, options)                                  ││
│  │  • load(sessionId, options) → Checkpoint | null                         ││
│  │  • delete(sessionId)                                                     ││
│  │  • fork(sourceSession, newSession) → Checkpoint                         ││
│  │  • list(options) → Checkpoint[]                                          ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐             │
│  │ Memory          │  │ Redis           │  │ MongoDB         │             │
│  │ Checkpointer    │  │ Checkpointer    │  │ Checkpointer    │             │
│  │                 │  │                 │  │                 │             │
│  │ • Development   │  │ • Production    │  │ • Production    │             │
│  │ • Testing       │  │ • Fast access   │  │ • Full query    │             │
│  │ • Single node   │  │ • TTL support   │  │ • Analytics     │             │
│  │                 │  │ • Distributed   │  │ • Long-term     │             │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘             │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                    Checkpoint Data Structure                             ││
│  │                                                                          ││
│  │  {                                                                       ││
│  │    id: string,              // Unique checkpoint ID                      ││
│  │    sessionId: string,       // Session identifier                        ││
│  │    agentName: string,       // Current agent                             ││
│  │    agentVersion: string,    // Agent version                             ││
│  │    state: AgentState,       // Full agent state                          ││
│  │    messages: Message[],     // Conversation history                      ││
│  │    context: {},             // Execution context                         ││
│  │    parentId?: string,       // For branching                             ││
│  │    metadata: {                                                           ││
│  │      currentStep: string,                                                ││
│  │      turnCount: number,                                                  ││
│  │      totalTokens: number,                                                ││
│  │      tenantId: string,      // Multi-tenant isolation                    ││
│  │    },                                                                    ││
│  │    createdAt: Date,                                                      ││
│  │    expiresAt: Date,         // TTL                                       ││
│  │  }                                                                       ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                    AgenticAI Compatibility                               ││
│  │                                                                          ││
│  │  AgenticAI Checkpoint Format:                                            ││
│  │  {                                                                       ││
│  │    thread_id: string,       →  sessionId                                ││
│  │    checkpoint_ns: string,   →  agentName                                ││
│  │    channel_values: {        →  state + messages                         ││
│  │      messages: [],                                                       ││
│  │      sender: string,                                                     ││
│  │      next: string,                                                       ││
│  │    },                                                                    ││
│  │    channel_versions: {},    →  metadata.versions                        ││
│  │    versions_seen: {},                                                    ││
│  │  }                                                                       ││
│  │                                                                          ││
│  │  Adapter converts between formats transparently                          ││
│  └─────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────┘
```

### 5.2 Checkpoint Flow

```
User Message → Runtime
                 │
                 ▼
         ┌───────────────┐
         │ Load Last     │
         │ Checkpoint    │
         └───────┬───────┘
                 │
                 ▼
         ┌───────────────┐
         │ Restore State │
         │ & Messages    │
         └───────┬───────┘
                 │
                 ▼
    ┌────────────────────────┐
    │   Execute Constructs   │
    │   (potentially multiple│
    │    steps per turn)     │
    └────────────┬───────────┘
                 │
                 ▼
         ┌───────────────┐
         │ Save New      │
         │ Checkpoint    │
         └───────┬───────┘
                 │
                 ▼
            Response
```

---

## 6. Tool Execution Architecture

### 6.1 Unified Tool Execution

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Tool Execution Architecture                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                    Unified Tool Router                                   ││
│  │                                                                          ││
│  │  • Resolves tool by name → executor                                      ││
│  │  • Handles tool type detection                                           ││
│  │  • Manages execution context                                             ││
│  │  • Applies rate limiting & circuit breakers                              ││
│  └──────────────────────────────┬──────────────────────────────────────────┘│
│                                 │                                            │
│         ┌───────────────────────┼───────────────────────────────┐           │
│         │                       │                               │           │
│         ▼                       ▼                               ▼           │
│  ┌──────────────┐       ┌──────────────┐               ┌──────────────┐    │
│  │   MCP Tool   │       │  HTTP Tool   │               │ Inline Tool  │    │
│  │   Executor   │       │  Executor    │               │  Executor    │    │
│  │              │       │              │               │              │    │
│  │ • Full MCP   │       │ • REST calls │               │ • JS sandbox │    │
│  │   protocol   │       │ • Auth       │               │ • Sandboxed  │    │
│  │ • Resources  │       │ • Retry      │               │ • Isolated   │    │
│  │ • Prompts    │       │ • Timeout    │               │              │    │
│  └──────────────┘       └──────────────┘               └──────────────┘    │
│         │                       │                               │           │
│         ▼                       ▼                               ▼           │
│  ┌──────────────┐       ┌──────────────┐               ┌──────────────┐    │
│  │  MCP Server  │       │  Lambda      │               │   GALE       │    │
│  │   Manager    │       │  Executor    │               │ Tool Fetcher │    │
│  │              │       │              │               │              │    │
│  │ • Lifecycle  │       │ • AWS SDK    │               │ • Cached     │    │
│  │ • Multi-srv  │       │ • Async      │               │ • Versioned  │    │
│  │ • Health     │       │              │               │              │    │
│  └──────────────┘       └──────────────┘               └──────────────┘    │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                    Tool Definition Sources                               ││
│  │                                                                          ││
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                  ││
│  │  │   ABL DSL    │  │    GALE      │  │    MCP       │                  ││
│  │  │  Inline Def  │  │  Tool Lib    │  │  Discovery   │                  ││
│  │  └──────────────┘  └──────────────┘  └──────────────┘                  ││
│  │                                                                          ││
│  │  Merged into unified ToolDefinition format with:                         ││
│  │  • name, description                                                     ││
│  │  • inputSchema (JSON Schema)                                             ││
│  │  • binding (http/mcp/lambda/sandbox/gale)                               ││
│  │  • auth requirements                                                     ││
│  └─────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────┘
```

### 6.2 Tool Type Hierarchy

```
AgenticAI ToolFactory                   ABL ToolExecutor
─────────────────────────────────────────────────────────────────────

BaseToolFactory                    →    ToolBindingExecutor
├── WorkerToolFactory              →    ├── reasoning agent tools
├── SupervisorToolFactory          →    ├── supervisor routing tools
├── ProcessorToolFactory           →    ├── (handled in flow)
├── DelegationWorkerToolFactory    →    ├── delegate() construct
└── MCPToolFactory                 →    └── MCPToolExecutor

Tool Execution Flow:
1. LLM returns tool_use
2. Router matches tool name → executor
3. Executor validates input schema
4. Executor invokes tool (with timeout, retry)
5. Result formatted as ToolMessage
6. Continue execution loop
```

---

## 7. LLM Routing & Model Registry

### 7.1 Model Registry Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Model Registry Architecture                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                    Model Registry Core                                   ││
│  │                                                                          ││
│  │  Models stored with:                                                     ││
│  │  • Capabilities (streaming, tools, vision, structured output)           ││
│  │  • Pricing (input/output per 1M tokens)                                 ││
│  │  • Limits (RPM, TPM, context window)                                    ││
│  │  • Performance (latency, throughput, reliability)                       ││
│  │  • Provider info                                                         ││
│  └──────────────────────────────┬──────────────────────────────────────────┘│
│                                 │                                            │
│  ┌──────────────────────────────┼──────────────────────────────────────────┐│
│  │                    Model Sources                                         ││
│  │                                                                          ││
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                  ││
│  │  │   Built-in   │  │    GALE      │  │   Tenant     │                  ││
│  │  │   Models     │  │ Integration  │  │   Custom     │                  ││
│  │  │              │  │              │  │              │                  ││
│  │  │ • Claude 4   │  │ • Enterprise │  │ • Private    │                  ││
│  │  │ • GPT-4o     │  │   models     │  │   endpoints  │                  ││
│  │  │ • Gemini 2.5 │  │ • Org limits │  │ • Custom     │                  ││
│  │  │ • etc.       │  │ • Quotas     │  │   models     │                  ││
│  │  └──────────────┘  └──────────────┘  └──────────────┘                  ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                    Intelligent Router                                    ││
│  │                                                                          ││
│  │  Routing Factors:                                                        ││
│  │  ┌────────────────────────────────────────────────────────────────────┐ ││
│  │  │  1. Task Requirements                                              │ ││
│  │  │     • Required capabilities (tools, vision, streaming)             │ ││
│  │  │     • Context size needed                                          │ ││
│  │  │     • Output complexity                                            │ ││
│  │  │                                                                    │ ││
│  │  │  2. Constraints                                                    │ ││
│  │  │     • Max cost per request                                         │ ││
│  │  │     • Max latency                                                  │ ││
│  │  │     • Required reliability                                         │ ││
│  │  │                                                                    │ ││
│  │  │  3. Preferences                                                    │ ││
│  │  │     • Preferred providers                                          │ ││
│  │  │     • Preferred tier (fast/balanced/powerful)                      │ ││
│  │  │     • Tenant-specific settings                                     │ ││
│  │  └────────────────────────────────────────────────────────────────────┘ ││
│  │                                                                          ││
│  │  Routing Algorithm:                                                      ││
│  │  1. Filter by required capabilities                                      ││
│  │  2. Filter by constraints                                                ││
│  │  3. Score remaining by preferences                                       ││
│  │  4. Select highest score                                                 ││
│  │  5. Generate fallback chain                                              ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                    Fallback Chain                                        ││
│  │                                                                          ││
│  │  Primary Model Failed → Try Fallback 1 → Try Fallback 2 → Error         ││
│  │                                                                          ││
│  │  Fallback Strategy:                                                      ││
│  │  • Same provider, different tier                                         ││
│  │  • Different provider, same tier                                         ││
│  │  • Any available with required capabilities                              ││
│  └─────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────┘
```

### 7.2 Model Selection Flow

```
Agent Request
      │
      ▼
┌─────────────────┐
│ Extract Model   │
│ Requirements    │
│ from Agent IR   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐     ┌─────────────────┐
│ Check Agent     │────▶│ Use Specified   │
│ Specifies Model │ Yes │ Model Directly  │
└────────┬────────┘     └─────────────────┘
         │ No
         ▼
┌─────────────────┐
│ Build Task      │
│ Requirements    │
│ • capabilities  │
│ • constraints   │
│ • preferences   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Model Registry  │
│ .getModelForTask│
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Return Model +  │
│ Fallback Chain  │
└─────────────────┘
```

---

## 8. MCP Protocol Integration

### 8.1 Full MCP Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     MCP Protocol Integration                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                    MCP Server Manager                                    ││
│  │                                                                          ││
│  │  Responsibilities:                                                       ││
│  │  • Server lifecycle management (start/stop/restart)                      ││
│  │  • Connection pooling                                                    ││
│  │  • Health monitoring                                                     ││
│  │  • Automatic reconnection                                                ││
│  │  • Tool/resource/prompt aggregation                                      ││
│  └──────────────────────────────┬──────────────────────────────────────────┘│
│                                 │                                            │
│  ┌──────────────────────────────┼──────────────────────────────────────────┐│
│  │                    MCP Clients (per server)                              ││
│  │                                                                          ││
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                  ││
│  │  │   Client 1   │  │   Client 2   │  │   Client N   │                  ││
│  │  │  (stdio)     │  │   (sse)      │  │  (stdio)     │                  ││
│  │  └──────────────┘  └──────────────┘  └──────────────┘                  ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                    Protocol Implementation                               ││
│  │                                                                          ││
│  │  Lifecycle:                                                              ││
│  │  ┌────────────────────────────────────────────────────────────────────┐ ││
│  │  │ initialize → initialized → [operations] → shutdown                 │ ││
│  │  └────────────────────────────────────────────────────────────────────┘ ││
│  │                                                                          ││
│  │  Tools:                                                                  ││
│  │  ┌────────────────────────────────────────────────────────────────────┐ ││
│  │  │ tools/list     → List available tools                              │ ││
│  │  │ tools/call     → Execute a tool                                    │ ││
│  │  └────────────────────────────────────────────────────────────────────┘ ││
│  │                                                                          ││
│  │  Resources:                                                              ││
│  │  ┌────────────────────────────────────────────────────────────────────┐ ││
│  │  │ resources/list      → List available resources                     │ ││
│  │  │ resources/read      → Read resource content                        │ ││
│  │  │ resources/subscribe → Subscribe to resource updates                │ ││
│  │  └────────────────────────────────────────────────────────────────────┘ ││
│  │                                                                          ││
│  │  Prompts:                                                                ││
│  │  ┌────────────────────────────────────────────────────────────────────┐ ││
│  │  │ prompts/list → List available prompts                              │ ││
│  │  │ prompts/get  → Get prompt with arguments                           │ ││
│  │  └────────────────────────────────────────────────────────────────────┘ ││
│  │                                                                          ││
│  │  Sampling (reverse direction - server requests LLM from client):        ││
│  │  ┌────────────────────────────────────────────────────────────────────┐ ││
│  │  │ sampling/createMessage → Server requests LLM completion            │ ││
│  │  └────────────────────────────────────────────────────────────────────┘ ││
│  │                                                                          ││
│  │  Notifications:                                                          ││
│  │  ┌────────────────────────────────────────────────────────────────────┐ ││
│  │  │ notifications/tools/list_changed     → Tool list changed           │ ││
│  │  │ notifications/resources/list_changed → Resource list changed       │ ││
│  │  │ notifications/resources/updated      → Resource content changed    │ ││
│  │  │ notifications/prompts/list_changed   → Prompt list changed         │ ││
│  │  │ notifications/progress               → Progress update             │ ││
│  │  └────────────────────────────────────────────────────────────────────┘ ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                    Transport Layer                                       ││
│  │                                                                          ││
│  │  ┌──────────────────────────┐  ┌──────────────────────────┐            ││
│  │  │       STDIO              │  │        SSE               │            ││
│  │  │                          │  │                          │            ││
│  │  │ • spawn child process    │  │ • HTTP EventSource       │            ││
│  │  │ • stdin/stdout JSON-RPC  │  │ • POST for requests      │            ││
│  │  │ • stderr for logs        │  │ • SSE for responses      │            ││
│  │  └──────────────────────────┘  └──────────────────────────┘            ││
│  └─────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────┘
```

### 8.2 MCP Tool Integration with ABL

```
ABL Agent with MCP Tools
─────────────────────────────────────────────────────────────────────

agent data_analyst {
  reasoning {
    tools: [query_database, analyze_data, generate_chart]

    // MCP tool bindings
    mcp_servers: [
      { name: "postgres", command: "mcp-postgres", args: ["--db", "analytics"] },
      { name: "charts", url: "https://charts.internal/mcp" }
    ]
  }
}

Execution Flow:
1. Agent starts → MCP Server Manager connects to configured servers
2. tools/list called → Tools registered in agent's tool registry
3. Agent requests tool_use → Router detects MCP tool
4. tools/call sent to appropriate server
5. Result returned as ToolMessage
6. Notifications handled (tool list changes, etc.)
```

---

## 9. API Compatibility Layer

### 9.1 API Routing Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     API Compatibility Layer                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                    Incoming Request                                      ││
│  │                                                                          ││
│  │  POST /api/v1/run                                                        ││
│  │  POST /api/v1/compile                                                    ││
│  │  POST /api/v1/invoke                                                     ││
│  │  GET  /api/v1/apps/:id                                                   ││
│  │  ...                                                                     ││
│  └──────────────────────────────┬──────────────────────────────────────────┘│
│                                 │                                            │
│                                 ▼                                            │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                    Compatibility Router                                  ││
│  │                                                                          ││
│  │  1. Detect request version (v1 = AgenticAI, v2 = ABL native)           ││
│  │  2. Extract auth context (JWT, API key)                                 ││
│  │  3. Route to appropriate handler                                         ││
│  └──────────────────────────────┬──────────────────────────────────────────┘│
│                                 │                                            │
│         ┌───────────────────────┴───────────────────────────────┐           │
│         │                                                       │           │
│         ▼                                                       ▼           │
│  ┌──────────────────────────┐                   ┌──────────────────────────┐│
│  │    V1 Compat Handler     │                   │    V2 Native Handler     ││
│  │                          │                   │                          ││
│  │  • Parse AgenticAI req   │                   │  • ABL native format     ││
│  │  • Convert config → ABL  │                   │  • Direct execution      ││
│  │  • Execute in ABL runtime│                   │                          ││
│  │  • Convert response      │                   │                          ││
│  └──────────────┬───────────┘                   └──────────────────────────┘│
│                 │                                                            │
│                 ▼                                                            │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                    Request/Response Mapping                              ││
│  │                                                                          ││
│  │  AgenticAI Request          →       ABL Request                          ││
│  │  ─────────────────────────────────────────────────────────              ││
│  │  {                          →       {                                    ││
│  │    appId: "app_123",        →         projectId: "app_123",             ││
│  │    sessionId: "sess_456",   →         sessionId: "sess_456",            ││
│  │    input: "Hello",          →         message: "Hello",                 ││
│  │    context: {...},          →         context: {...},                   ││
│  │    stream: true             →         streaming: true                   ││
│  │  }                          →       }                                    ││
│  │                                                                          ││
│  │  ABL Response               →       AgenticAI Response                   ││
│  │  ─────────────────────────────────────────────────────────              ││
│  │  {                          →       {                                    ││
│  │    sessionId: "...",        →         sessionId: "...",                 ││
│  │    response: "...",         →         output: "...",                    ││
│  │    actions: [...],          →         toolCalls: [...],                 ││
│  │    usage: {...}             →         usage: {...}                      ││
│  │  }                          →       }                                    ││
│  └─────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────┘
```

### 9.2 Endpoint Mapping

| AgenticAI Endpoint         | ABL Equivalent                         | Mapping Notes           |
| -------------------------- | -------------------------------------- | ----------------------- |
| `POST /api/v1/run`         | `POST /api/v2/sessions/:id/message`    | Combined compile+invoke |
| `POST /api/v1/compile`     | `POST /api/v2/projects/:id/compile`    | Generate IR from config |
| `POST /api/v1/invoke`      | `POST /api/v2/sessions/:id/message`    | Direct message send     |
| `GET /api/v1/apps`         | `GET /api/v2/projects`                 | CRUD operations         |
| `GET /api/v1/agents`       | `GET /api/v2/projects/:id/agents`      | Agent management        |
| `GET /api/v1/tools`        | `GET /api/v2/projects/:id/tools`       | Tool definitions        |
| `GET /api/v1/sessions/:id` | `GET /api/v2/sessions/:id`             | Session state           |
| `GET /api/v1/runs/:id`     | `GET /api/v2/sessions/:id/runs/:runId` | Run history             |
| `WebSocket /chat`          | `WebSocket /ws/sdk`                    | Real-time streaming     |

---

## 10. Streaming Architecture

### 10.1 Stream Event Mapping

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Streaming Architecture                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                    ABL Internal Events                                   ││
│  │                                                                          ││
│  │  • text_delta        - Streaming text chunk                              ││
│  │  • tool_use_start    - Starting tool execution                           ││
│  │  • tool_use_delta    - Tool input streaming                              ││
│  │  • tool_use_end      - Tool execution complete                           ││
│  │  • message_start     - Begin message                                     ││
│  │  • message_end       - End message with usage                            ││
│  │  • agent_handoff     - Switching to different agent                      ││
│  │  • flow_step         - Flow step transition                              ││
│  │  • error             - Error occurred                                    ││
│  └──────────────────────────────┬──────────────────────────────────────────┘│
│                                 │                                            │
│                                 ▼                                            │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                    Stream Event Mapper                                   ││
│  │                                                                          ││
│  │  Maps ABL events → AgenticAI stream format                               ││
│  └──────────────────────────────┬──────────────────────────────────────────┘│
│                                 │                                            │
│                                 ▼                                            │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                    AgenticAI Stream Events                               ││
│  │                                                                          ││
│  │  • response_start    - Begin streaming response                          ││
│  │  • response_chunk    - Text chunk                                        ││
│  │  • tool_start        - Tool execution starting                           ││
│  │  • tool_end          - Tool execution complete with result               ││
│  │  • response_end      - End streaming with full output                    ││
│  │  • error             - Error event                                       ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                    Event Mapping Table                                   ││
│  │                                                                          ││
│  │  ABL Event             →    AgenticAI Event                              ││
│  │  ───────────────────────────────────────────────────────────            ││
│  │  message_start         →    response_start                               ││
│  │  text_delta            →    response_chunk                               ││
│  │  tool_use_start        →    tool_start                                   ││
│  │  tool_use_end          →    tool_end                                     ││
│  │  message_end           →    response_end                                 ││
│  │  agent_handoff         →    (embedded in response_chunk)                 ││
│  │  error                 →    error                                        ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                    Transport Options                                     ││
│  │                                                                          ││
│  │  ┌──────────────────────────┐  ┌──────────────────────────┐            ││
│  │  │       WebSocket          │  │     Server-Sent Events   │            ││
│  │  │                          │  │                          │            ││
│  │  │ • Bidirectional          │  │ • Unidirectional         │            ││
│  │  │ • Full duplex            │  │ • HTTP compatible        │            ││
│  │  │ • Lower latency          │  │ • Simpler deployment     │            ││
│  │  └──────────────────────────┘  └──────────────────────────┘            ││
│  └─────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 11. Multi-Tenant Isolation

### 11.1 Tenant Isolation Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Multi-Tenant Isolation                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                    Request Context                                       ││
│  │                                                                          ││
│  │  Every request carries:                                                  ││
│  │  • tenantId (from JWT or API key)                                       ││
│  │  • userId (from JWT)                                                     ││
│  │  • projectId (from request path)                                        ││
│  │  • permissions (from role)                                               ││
│  └──────────────────────────────┬──────────────────────────────────────────┘│
│                                 │                                            │
│                                 ▼                                            │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                    Isolation Layers                                      ││
│  │                                                                          ││
│  │  ┌───────────────────────────────────────────────────────────────────┐  ││
│  │  │  Layer 1: API Gateway                                             │  ││
│  │  │  • Extract tenant from auth token                                 │  ││
│  │  │  • Validate tenant exists and is active                           │  ││
│  │  │  • Apply tenant-specific rate limits                              │  ││
│  │  └───────────────────────────────────────────────────────────────────┘  ││
│  │                                                                          ││
│  │  ┌───────────────────────────────────────────────────────────────────┐  ││
│  │  │  Layer 2: Resource Guard Middleware                               │  ││
│  │  │  • Verify resource belongs to tenant                              │  ││
│  │  │  • Prevent cross-tenant access                                    │  ││
│  │  │  • Scope all queries to tenant                                    │  ││
│  │  └───────────────────────────────────────────────────────────────────┘  ││
│  │                                                                          ││
│  │  ┌───────────────────────────────────────────────────────────────────┐  ││
│  │  │  Layer 3: Database RLS                                            │  ││
│  │  │  • Prisma RLS extension enforces tenant filter                    │  ││
│  │  │  • All queries automatically scoped                               │  ││
│  │  │  • Impossible to access other tenant data                         │  ││
│  │  └───────────────────────────────────────────────────────────────────┘  ││
│  │                                                                          ││
│  │  ┌───────────────────────────────────────────────────────────────────┐  ││
│  │  │  Layer 4: Runtime Isolation                                       │  ││
│  │  │  • BaseRuntime carries TenantContext                              │  ││
│  │  │  • assertTenantAccess() on sensitive operations                   │  ││
│  │  │  • scopeToTenant() for queries                                    │  ││
│  │  └───────────────────────────────────────────────────────────────────┘  ││
│  │                                                                          ││
│  │  ┌───────────────────────────────────────────────────────────────────┐  ││
│  │  │  Layer 5: Cache Isolation                                         │  ││
│  │  │  • Redis keys prefixed with tenantId                              │  ││
│  │  │  • Checkpoints scoped to tenant                                   │  ││
│  │  │  • Model registry supports tenant-specific models                 │  ││
│  │  └───────────────────────────────────────────────────────────────────┘  ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                    Tenant Mapping                                        ││
│  │                                                                          ││
│  │  AgenticAI: accountId  →  ABL: organizationId (tenantId)                ││
│  │                                                                          ││
│  │  All entities carry tenant identifier:                                   ││
│  │  • Project.organizationId                                               ││
│  │  • Agent.organizationId                                                 ││
│  │  • Session.organizationId                                               ││
│  │  • Checkpoint.metadata.tenantId                                         ││
│  └─────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 12. GALE Integration

### 12.1 GALE Service Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     GALE Integration                                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                    GALE Service                                          ││
│  │                                                                          ││
│  │  Endpoints:                                                              ││
│  │  ┌────────────────────────────────────────────────────────────────────┐ ││
│  │  │  Tool Library                                                      │ ││
│  │  │  • GET /tools/library          → List tool library                 │ ││
│  │  │  • GET /tools/:id              → Get tool definition               │ ││
│  │  │  • POST /tools/:id/execute     → Execute library tool              │ ││
│  │  └────────────────────────────────────────────────────────────────────┘ ││
│  │                                                                          ││
│  │  ┌────────────────────────────────────────────────────────────────────┐ ││
│  │  │  Model Registry                                                    │ ││
│  │  │  • GET /models                 → List available models             │ ││
│  │  │  • GET /models/:id             → Get model details                 │ ││
│  │  │  • GET /models/integrated      → Get org's integrated models       │ ││
│  │  └────────────────────────────────────────────────────────────────────┘ ││
│  │                                                                          ││
│  │  ┌────────────────────────────────────────────────────────────────────┐ ││
│  │  │  Authentication                                                    │ ││
│  │  │  • POST /auth/validate-key     → Validate API key                  │ ││
│  │  │  • GET /auth/context           → Get user/org context              │ ││
│  │  └────────────────────────────────────────────────────────────────────┘ ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                    Tool Caching Strategy                                 ││
│  │                                                                          ││
│  │  Cache Layers:                                                           ││
│  │  ┌────────────────────────────────────────────────────────────────────┐ ││
│  │  │  L1: In-Memory (LRU)                                               │ ││
│  │  │  • Fast access for hot tools                                       │ ││
│  │  │  • Limited size per process                                        │ ││
│  │  │  • TTL: 5 minutes                                                  │ ││
│  │  └────────────────────────────────────────────────────────────────────┘ ││
│  │                                                                          ││
│  │  ┌────────────────────────────────────────────────────────────────────┐ ││
│  │  │  L2: Redis                                                         │ ││
│  │  │  • Distributed cache                                               │ ││
│  │  │  • Shared across instances                                         │ ││
│  │  │  • TTL: 1 hour                                                     │ ││
│  │  └────────────────────────────────────────────────────────────────────┘ ││
│  │                                                                          ││
│  │  Cache Key: `gale:tool:{toolId}:{version}`                               ││
│  │                                                                          ││
│  │  Skip Cache When:                                                        ││
│  │  • Tool status = CONFIGURED or IN_DEVELOPMENT                           ││
│  │  • Force refresh requested                                               ││
│  │  • Cache miss                                                            ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                    Model Registry Integration                            ││
│  │                                                                          ││
│  │  Sync Strategy:                                                          ││
│  │  1. On startup: Fetch all integrated models from GALE                   ││
│  │  2. Periodic refresh (every 15 minutes)                                 ││
│  │  3. On-demand refresh when model not found                              ││
│  │                                                                          ││
│  │  Model Info from GALE:                                                   ││
│  │  • Model ID, name, provider                                             ││
│  │  • Capabilities (tools, vision, streaming)                              ││
│  │  • Quotas and limits                                                    ││
│  │  • Pricing (if available)                                               ││
│  └─────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 13. Data Model Mapping

### 13.1 Schema Mapping

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Data Model Mapping                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  AgenticAI (MongoDB)                        ABL (Prisma/PostgreSQL)          │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                              │
│  agenticApp                        →        Project                          │
│  ├── _id                           →        ├── id                           │
│  ├── name                          →        ├── name                         │
│  ├── accountId                     →        ├── organizationId               │
│  ├── description                   →        ├── description                  │
│  └── createdAt/updatedAt           →        └── createdAt/updatedAt          │
│                                                                              │
│  Agent                             →        Agent (new table)                │
│  ├── _id                           →        ├── id                           │
│  ├── appId                         →        ├── projectId                    │
│  ├── name                          →        ├── name                         │
│  ├── role                          →        ├── type (supervisor/reasoning)  │
│  ├── systemPrompt                  →        ├── systemPrompt                 │
│  ├── model                         →        ├── model                        │
│  ├── tools[]                       →        ├── tools (JSON)                 │
│  ├── workers[]                     →        ├── childAgents (JSON)           │
│  └── routingConfig                 →        └── routingConfig (JSON)         │
│                                                                              │
│  AgentVersion                      →        AgentVersion (new table)         │
│  ├── agentId                       →        ├── agentId                      │
│  ├── version                       →        ├── version                      │
│  ├── config (JSON)                 →        ├── ir (JSON - compiled IR)      │
│  └── publishedAt                   →        └── publishedAt                  │
│                                                                              │
│  Session                           →        AgentSession                     │
│  ├── _id                           →        ├── id                           │
│  ├── appId                         →        ├── projectId                    │
│  ├── userId                        →        ├── userId                       │
│  └── metadata                      →        └── metadata                     │
│                                                                              │
│  Run                               →        SessionRun (new table)           │
│  ├── _id                           →        ├── id                           │
│  ├── sessionId                     →        ├── sessionId                    │
│  ├── input                         →        ├── input                        │
│  ├── output                        →        ├── output                       │
│  ├── status                        →        ├── status                       │
│  └── agentName                     →        └── agentName                    │
│                                                                              │
│  Tool                              →        Tool (new table)                 │
│  ├── _id                           →        ├── id                           │
│  ├── appId                         →        ├── projectId                    │
│  ├── name                          →        ├── name                         │
│  ├── type                          →        ├── type                         │
│  ├── inputSchema                   →        ├── inputSchema (JSON)           │
│  └── code/config                   →        └── binding (JSON)               │
│                                                                              │
│  Checkpoint (MongoDB)              →        Checkpoint (Redis/Postgres)      │
│  ├── thread_id                     →        ├── sessionId                    │
│  ├── checkpoint_ns                 →        ├── agentName                    │
│  ├── channel_values                →        ├── state + messages (JSON)      │
│  └── channel_versions              →        └── metadata                     │
│                                                                              │
│  Environment                       →        Environment (new table)          │
│  ├── appId                         →        ├── projectId                    │
│  ├── name                          →        ├── name                         │
│  ├── status (draft/published)      →        ├── status                       │
│  └── variables                     →        └── variables (JSON)             │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 13.2 New Prisma Models Required

```prisma
// Additional models for ABL schema

model Agent {
  id              String          @id @default(cuid())
  projectId       String
  project         Project         @relation(fields: [projectId], references: [id])

  name            String
  type            String          // 'supervisor' | 'reasoning' | 'scripted'
  displayName     String?
  description     String?
  systemPrompt    String?
  model           String?

  tools           String?         // JSON array of tool names
  childAgents     String?         // JSON array of child agent names
  routingConfig   String?         // JSON routing configuration
  constraints     String?         // JSON constraints

  ir              String?         // Compiled IR (JSON)

  createdAt       DateTime        @default(now())
  updatedAt       DateTime        @updatedAt

  versions        AgentVersion[]

  @@unique([projectId, name])
  @@index([projectId])
}

model AgentVersion {
  id              String          @id @default(cuid())
  agentId         String
  agent           Agent           @relation(fields: [agentId], references: [id])

  version         Int
  ir              String          // Compiled IR (JSON)
  dsl             String?         // Original DSL (for reference)

  status          String          @default("draft") // 'draft' | 'published'
  publishedAt     DateTime?

  createdAt       DateTime        @default(now())

  @@unique([agentId, version])
  @@index([agentId])
}

model Tool {
  id              String          @id @default(cuid())
  projectId       String
  project         Project         @relation(fields: [projectId], references: [id])

  name            String
  displayName     String?
  description     String?
  type            String          // 'inline' | 'http' | 'mcp' | 'lambda' | 'gale'

  inputSchema     String?         // JSON Schema
  binding         String?         // JSON binding config (endpoint, code, etc.)
  auth            String?         // JSON auth config

  createdAt       DateTime        @default(now())
  updatedAt       DateTime        @updatedAt

  @@unique([projectId, name])
  @@index([projectId])
}

model SessionRun {
  id              String          @id @default(cuid())
  sessionId       String
  session         AgentSession    @relation(fields: [sessionId], references: [id])

  agentName       String
  input           String
  output          String?

  status          String          @default("pending") // pending | running | completed | failed
  errorMessage    String?

  startedAt       DateTime        @default(now())
  completedAt     DateTime?

  tokens          Int?
  cost            Float?

  @@index([sessionId])
}

model Environment {
  id              String          @id @default(cuid())
  projectId       String
  project         Project         @relation(fields: [projectId], references: [id])

  name            String
  status          String          @default("draft") // 'draft' | 'published'

  variables       String?         // JSON key-value pairs
  secrets         String?         // Encrypted JSON

  publishedAt     DateTime?

  createdAt       DateTime        @default(now())
  updatedAt       DateTime        @updatedAt

  @@unique([projectId, name])
  @@index([projectId])
}
```

---

## 14. Deployment Topologies

### 14.1 Deployment Options

The split architecture supports multiple deployment topologies based on scale and requirements:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Deployment Topology Options                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  OPTION 1: DEVELOPMENT / SINGLE-TEAM                                        │
│  ─────────────────────────────────────                                      │
│  Both services in same process (monolith mode)                              │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐│
│  │  Single Node.js Process                                                 ││
│  │                                                                         ││
│  │  ┌─────────────────────────────────────────────────────────────────┐  ││
│  │  │  Next.js Custom Server                                           │  ││
│  │  │                                                                  │  ││
│  │  │  ┌──────────────────────┐  ┌──────────────────────────────────┐ │  ││
│  │  │  │  Next.js App Router  │  │  Runtime (same process)          │ │  ││
│  │  │  │  • Studio UI         │  │  • Execution engine              │ │  ││
│  │  │  │  • API Routes        │  │  • WebSocket (ws on :3001)       │ │  ││
│  │  │  │  • /api/*            │  │  • In-memory sessions            │ │  ││
│  │  │  └──────────────────────┘  └──────────────────────────────────┘ │  ││
│  │  └─────────────────────────────────────────────────────────────────┘  ││
│  │                                                                         ││
│  │  Benefits: Simple setup, single deploy, shared memory                   ││
│  │  Drawbacks: Can't scale independently, single point of failure          ││
│  └────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  ───────────────────────────────────────────────────────────────────────────│
│                                                                              │
│  OPTION 2: PRODUCTION / SCALE-OUT                                           │
│  ─────────────────────────────────                                          │
│  Fully separated services                                                    │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐│
│  │  Design Service (Vercel / Edge / K8s)                                   ││
│  │                                                                         ││
│  │  ┌─────────────────────────────────────────────────────────────────┐  ││
│  │  │  Next.js (Serverless / Container)                                │  ││
│  │  │  • studio.platform.com                                           │  ││
│  │  │  • Edge-deployed (global CDN)                                    │  ││
│  │  │  • Stateless, auto-scaling                                       │  ││
│  │  └─────────────────────────────────────────────────────────────────┘  ││
│  │                                │                                        ││
│  │                    ┌───────────▼───────────┐                           ││
│  │                    │  Internal LB/gRPC     │                           ││
│  │                    └───────────┬───────────┘                           ││
│  └────────────────────────────────┼────────────────────────────────────────┘│
│                                   │                                         │
│  ┌────────────────────────────────▼────────────────────────────────────────┐│
│  │  Runtime Service (K8s / ECS / GKE)                                      ││
│  │                                                                         ││
│  │  ┌─────────────────────────────────────────────────────────────────┐  ││
│  │  │  Node.js Cluster (Container)                                     │  ││
│  │  │  • runtime.platform.com                                          │  ││
│  │  │  • Sticky sessions (IP hash)                                     │  ││
│  │  │  • Horizontal scaling                                            │  ││
│  │  │  • Regional deployment                                           │  ││
│  │  └─────────────────────────────────────────────────────────────────┘  ││
│  │                                                                         ││
│  │  Benefits: Independent scaling, isolated failures, optimal per service ││
│  │  Drawbacks: More infra, network latency between services               ││
│  └────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  ───────────────────────────────────────────────────────────────────────────│
│                                                                              │
│  OPTION 3: HYBRID / ENTERPRISE                                              │
│  ────────────────────────────────                                           │
│  Edge design + Regional runtimes                                            │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐│
│  │  Global Edge (Vercel/Cloudflare)                                        ││
│  │  ┌──────────────────────────────────────────────────────────────────┐  ││
│  │  │  Next.js Edge Functions                                           │  ││
│  │  │  • Static assets (CDN)                                            │  ││
│  │  │  • API Routes (edge, <50ms global)                                │  ││
│  │  │  • Auth, routing, project metadata                                │  ││
│  │  └──────────────────────────────────────────────────────────────────┘  ││
│  └────────────────────────────────────────────────────────────────────────┘│
│                        │               │               │                    │
│                 US-WEST│        EU-WEST│        AP-EAST│                    │
│                        ▼               ▼               ▼                    │
│  ┌─────────────────────┬───────────────┬───────────────────────────────────┐│
│  │  Regional Runtime   │  Regional     │  Regional Runtime                 ││
│  │  Cluster (US)       │  Runtime (EU) │  Cluster (APAC)                   ││
│  │  • Low latency      │  • GDPR       │  • Data residency                 ││
│  │  • Voice <50ms      │    compliant  │  • Local regulations              ││
│  └─────────────────────┴───────────────┴───────────────────────────────────┘│
│                                                                              │
│  Benefits: Global low latency, data residency, compliance                   │
│  Drawbacks: Complex deployment, multi-region data sync                      │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 14.2 Development Mode (Option 1) Implementation

```typescript
// apps/studio/server.ts - Combined development server

import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { WebSocketServer } from 'ws';
import { createRuntimeServer } from '../runtime/src/server.js';

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    const parsedUrl = parse(req.url!, true);

    // Route runtime requests to runtime handlers
    if (parsedUrl.pathname?.startsWith('/runtime/')) {
      return runtimeHandler(req, res);
    }

    // Everything else goes to Next.js
    return handle(req, res, parsedUrl);
  });

  // WebSocket server for real-time
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => handleWebSocket(ws));

  // Runtime engine (in-process)
  const runtime = createRuntimeServer({ inProcess: true });

  server.listen(3000, () => {
    console.log('> Dev server ready on http://localhost:3000');
  });
});
```

### 14.3 Production Mode (Option 2) Infrastructure

```yaml
# deploy/kubernetes/design-service.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: design-service
spec:
  replicas: 3
  selector:
    matchLabels:
      app: design-service
  template:
    metadata:
      labels:
        app: design-service
    spec:
      containers:
        - name: design
          image: platform/design:latest
          ports:
            - containerPort: 3000
          env:
            - name: RUNTIME_URL
              value: 'http://runtime-service:3001'
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: db-secret
                  key: url
          resources:
            limits:
              memory: '512Mi'
              cpu: '500m'
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: runtime-service
spec:
  replicas: 5
  selector:
    matchLabels:
      app: runtime-service
  template:
    metadata:
      labels:
        app: runtime-service
    spec:
      containers:
        - name: runtime
          image: platform/runtime:latest
          ports:
            - containerPort: 3001
          env:
            - name: REDIS_URL
              valueFrom:
                secretKeyRef:
                  name: redis-secret
                  key: url
            - name: MONGO_URL
              valueFrom:
                secretKeyRef:
                  name: mongo-secret
                  key: url
          resources:
            limits:
              memory: '1Gi'
              cpu: '1000m'
---
# Sticky sessions for WebSocket
apiVersion: v1
kind: Service
metadata:
  name: runtime-service
spec:
  type: ClusterIP
  sessionAffinity: ClientIP
  sessionAffinityConfig:
    clientIP:
      timeoutSeconds: 3600
  ports:
    - port: 3001
      targetPort: 3001
  selector:
    app: runtime-service
```

### 14.4 Service Discovery & Communication

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Service Communication                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Design → Runtime Communication:                                            │
│  ────────────────────────────────                                           │
│                                                                              │
│  1. gRPC (Recommended for production)                                       │
│     ┌──────────────────────────────────────────────────────────────────┐   │
│     │  Design Service                Runtime Service                    │   │
│     │      │                              │                             │   │
│     │      │── CreateSession() ──────────►│                             │   │
│     │      │◄─ SessionCreated ───────────│                             │   │
│     │      │                              │                             │   │
│     │      │── DeployAgent(ir) ──────────►│                             │   │
│     │      │◄─ DeploymentStatus ─────────│                             │   │
│     │      │                              │                             │   │
│     │      │── GetSessionState() ────────►│                             │   │
│     │      │◄─ SessionState ─────────────│                             │   │
│     └──────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  2. HTTP/REST (Simpler, development-friendly)                               │
│     • POST /runtime/sessions - Create session                               │
│     • POST /runtime/deploy - Deploy agent IR                                │
│     • GET  /runtime/sessions/:id/state - Get state                         │
│     • POST /runtime/sessions/:id/message - Send message                    │
│                                                                              │
│  Client → Runtime (Direct for streaming):                                   │
│  ─────────────────────────────────────────                                  │
│                                                                              │
│     ┌──────────────────────────────────────────────────────────────────┐   │
│     │  Client                     Design          Runtime               │   │
│     │    │                          │                │                  │   │
│     │    │── GET /api/session ─────►│                │                  │   │
│     │    │                          │── Create ─────►│                  │   │
│     │    │                          │◄─ SessionInfo ─│                  │   │
│     │    │◄─ {sessionId, wsUrl} ────│                │                  │   │
│     │    │                                           │                  │   │
│     │    │══ WebSocket ws://runtime/ws/:sessionId ══►│                  │   │
│     │    │◄══════════ Streaming events ══════════════│                  │   │
│     └──────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 14.5 Enterprise Option Deep Dive (Option 3)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     ENTERPRISE MULTI-REGION ARCHITECTURE                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                     GLOBAL EDGE LAYER                                   │ │
│  │                  (Vercel / Cloudflare Workers)                          │ │
│  │                                                                         │ │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │ │
│  │  │  Edge Functions (deployed to 300+ PoPs globally)                 │  │ │
│  │  │                                                                  │  │ │
│  │  │  • studio.platform.com - React UI (static + ISR)                │  │ │
│  │  │  • Auth middleware (JWT validation, session check)              │  │ │
│  │  │  • API rate limiting (per-tenant, globally synced)              │  │ │
│  │  │  • Request routing (geo-aware runtime selection)                │  │ │
│  │  │  • Project metadata cache (Redis @ edge)                        │  │ │
│  │  │                                                                  │  │ │
│  │  │  Latency: <50ms globally for UI/API routes                      │  │ │
│  │  └─────────────────────────────────────────────────────────────────┘  │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│                    │                    │                    │               │
│                    │ Geo-Route          │ Geo-Route          │ Geo-Route    │
│                    ▼                    ▼                    ▼               │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                     REGIONAL RUNTIME CLUSTERS                         │  │
│  │                                                                       │  │
│  │  ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐     │  │
│  │  │   US-WEST-2      │ │   EU-WEST-1      │ │   AP-NORTHEAST-1 │     │  │
│  │  │   (Oregon)       │ │   (Ireland)      │ │   (Tokyo)        │     │  │
│  │  │                  │ │                  │ │                  │     │  │
│  │  │ Runtime Pods:    │ │ Runtime Pods:    │ │ Runtime Pods:    │     │  │
│  │  │ • 5-20 (auto)    │ │ • 3-10 (auto)    │ │ • 3-10 (auto)    │     │  │
│  │  │ • Sticky sessions│ │ • GDPR compliant │ │ • APAC data res. │     │  │
│  │  │ • Voice <30ms    │ │ • Voice <40ms    │ │ • Voice <40ms    │     │  │
│  │  │                  │ │                  │ │                  │     │  │
│  │  │ Tenants:         │ │ Tenants:         │ │ Tenants:         │     │  │
│  │  │ • US customers   │ │ • EU customers   │ │ • APAC customers │     │  │
│  │  │ • Default region │ │ • GDPR required  │ │ • China alt path │     │  │
│  │  └──────────────────┘ └──────────────────┘ └──────────────────┘     │  │
│  │                                                                       │  │
│  │  Each region has:                                                     │  │
│  │  • Redis cluster (sessions, cache, pub/sub)                          │  │
│  │  • MongoDB replica set (checkpoints)                                  │  │
│  │  • RabbitMQ (async jobs)                                              │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│                    │                    │                    │               │
│                    └────────────────────┼────────────────────┘               │
│                                         │                                    │
│                                         ▼                                    │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                     GLOBAL DATA PLANE                                  │  │
│  │                                                                       │  │
│  │  ┌──────────────────────────────────────────────────────────────┐   │  │
│  │  │  Primary Database (PostgreSQL - CockroachDB / AlloyDB)       │   │  │
│  │  │  • Multi-region replication                                   │   │  │
│  │  │  • Project metadata, agent definitions, user data            │   │  │
│  │  │  • Read replicas in each region                              │   │  │
│  │  │  • Write quorum for consistency                              │   │  │
│  │  └──────────────────────────────────────────────────────────────┘   │  │
│  │                                                                       │  │
│  │  ┌──────────────────────────────────────────────────────────────┐   │  │
│  │  │  Analytics Data Warehouse (BigQuery / Snowflake)             │   │  │
│  │  │  • Trace aggregation from all regions                        │   │  │
│  │  │  • Cross-tenant analytics                                    │   │  │
│  │  │  • ML/AI training data                                       │   │  │
│  │  └──────────────────────────────────────────────────────────────┘   │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### Enterprise Geo-Routing Logic

```typescript
// apps/studio/middleware.ts - Edge middleware for geo-routing

import { NextRequest, NextResponse } from 'next/server';
import { geolocation } from '@vercel/edge';

const RUNTIME_REGIONS = {
  'US': 'https://runtime-us.platform.com',
  'EU': 'https://runtime-eu.platform.com',
  'APAC': 'https://runtime-apac.platform.com',
};

const GDPR_COUNTRIES = ['DE', 'FR', 'IT', 'ES', 'NL', 'BE', 'AT', 'PL', ...];

export function middleware(request: NextRequest) {
  const geo = geolocation(request);
  const tenantRegion = request.headers.get('x-tenant-region');

  // Tenant-configured region takes precedence (compliance)
  if (tenantRegion) {
    return routeToRegion(tenantRegion, request);
  }

  // GDPR countries must use EU region
  if (GDPR_COUNTRIES.includes(geo.country)) {
    return routeToRegion('EU', request);
  }

  // Geo-based routing for lowest latency
  const region = determineRegion(geo.country, geo.latitude, geo.longitude);
  return routeToRegion(region, request);
}

function determineRegion(country: string, lat: number, lon: number): string {
  // Americas → US
  if (['US', 'CA', 'MX', 'BR', 'AR', ...].includes(country)) return 'US';
  // Europe, Africa, Middle East → EU
  if (['GB', 'DE', 'FR', 'ZA', 'AE', ...].includes(country)) return 'EU';
  // Asia Pacific → APAC
  return 'APAC';
}
```

#### Enterprise Data Residency

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     DATA RESIDENCY MODEL                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Data Classification:                                                        │
│  ────────────────────                                                       │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐│
│  │  GLOBAL DATA (replicated everywhere)                                    ││
│  │  • Project definitions (agents, tools, configs)                         ││
│  │  • User accounts & authentication                                       ││
│  │  • Billing & subscription data                                          ││
│  │  • Aggregated analytics (no PII)                                        ││
│  └────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐│
│  │  REGIONAL DATA (stays in region)                                        ││
│  │  • Conversation history & transcripts                                   ││
│  │  • Checkpoints (user state, PII)                                        ││
│  │  • Audit logs with user data                                            ││
│  │  • Voice recordings (if enabled)                                        ││
│  │  • Tool execution results                                               ││
│  └────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐│
│  │  TENANT-SPECIFIC (customer choice)                                      ││
│  │  • Custom encryption keys (BYOK)                                        ││
│  │  • Dedicated database instances                                         ││
│  │  • VPC peering / private link                                           ││
│  └────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  Tenant Configuration:                                                       │
│  ─────────────────────                                                      │
│                                                                              │
│  model Organization {                                                        │
│    ...                                                                       │
│    dataResidency   String   @default("US")  // US | EU | APAC              │
│    forceRegion     Boolean  @default(false) // Override geo-routing         │
│    encryptionKey   String?  // Customer-managed key ARN                     │
│    dedicatedDb     Boolean  @default(false) // Isolated database            │
│  }                                                                           │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### Enterprise Compliance Features

| Requirement | Implementation                                     |
| ----------- | -------------------------------------------------- |
| **GDPR**    | EU region, data deletion APIs, consent tracking    |
| **SOC 2**   | Audit logging, access controls, encryption at rest |
| **HIPAA**   | BAA support, PHI isolation, dedicated tenancy      |
| **PCI-DSS** | Tokenization, no card storage in checkpoints       |
| **FedRAMP** | US-only region, GovCloud option                    |

---

### 14.6 Environment Configuration

```bash
# .env.development (Option 1: Combined)
NODE_ENV=development
PORT=3000
RUNTIME_MODE=embedded
DATABASE_URL=postgresql://localhost:5432/abl_dev
REDIS_URL=redis://localhost:6379

# .env.production.design (Option 2: Design Service)
NODE_ENV=production
PORT=3000
RUNTIME_URL=https://runtime.internal.platform.com
DATABASE_URL=postgresql://prod-db:5432/abl
REDIS_URL=redis://prod-cache:6379
VERCEL_EDGE=1

# .env.production.runtime (Option 2: Runtime Service)
NODE_ENV=production
PORT=3001
MONGO_URL=mongodb://prod-mongo:27017/abl_checkpoints
REDIS_URL=redis://prod-cache:6379
GALE_API_URL=https://gale.internal.platform.com
LLM_PROVIDER_KEYS=... # Encrypted
```

---

## 15. Migration Strategy

### 15.1 Phased Migration Approach

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Migration Phases                                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Phase 1: Foundation (2 weeks)                                              │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Implement persistent checkpointing (Redis + MongoDB)                     │
│  • Extend Prisma schema with new models                                     │
│  • Implement GALE service integration layer                                 │
│  • Add model registry with GALE sync                                        │
│                                                                              │
│  Deliverables:                                                              │
│  □ Checkpointer interface + Redis/MongoDB implementations                  │
│  □ GALE tool fetcher with caching                                           │
│  □ GALE model registry integration                                          │
│  □ Database migrations for new models                                       │
│                                                                              │
│  ───────────────────────────────────────────────────────────────────────────│
│                                                                              │
│  Phase 2: Config Converter (1 week)                                         │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • AgenticAI config parser                                                  │
│  • Agent type mapping (SUPERVISOR/WORKER → supervisor/reasoning)           │
│  • Tool definition conversion                                               │
│  • Routing rule translation                                                 │
│  • ABL DSL or IR generation                                                 │
│                                                                              │
│  Deliverables:                                                              │
│  □ AgenticAIConverter class                                                 │
│  □ Tool mapping utilities                                                   │
│  □ Routing rule converter                                                   │
│  □ Unit tests for all conversions                                           │
│                                                                              │
│  ───────────────────────────────────────────────────────────────────────────│
│                                                                              │
│  Phase 3: Runtime Integration (2 weeks)                                     │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Integrate checkpointing into BaseRuntime                                 │
│  • Add multi-agent supervisor execution                                     │
│  • Implement delegation/handoff between agents                              │
│  • State mapping between AgenticAI and ABL formats                          │
│                                                                              │
│  Deliverables:                                                              │
│  □ BaseRuntime with checkpointing                                           │
│  □ SupervisorExecutor with routing                                          │
│  □ Agent delegation mechanism                                               │
│  □ State mapper utilities                                                   │
│                                                                              │
│  ───────────────────────────────────────────────────────────────────────────│
│                                                                              │
│  Phase 4: API Compatibility (1 week)                                        │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • /api/v1/run endpoint stub                                                │
│  • /api/v1/compile endpoint stub                                            │
│  • /api/v1/invoke endpoint stub                                             │
│  • Request/response mappers                                                 │
│  • Streaming event translation                                              │
│                                                                              │
│  Deliverables:                                                              │
│  □ Compatibility router                                                     │
│  □ All V1 endpoint stubs                                                    │
│  □ Event stream mapper                                                      │
│  □ Integration tests                                                        │
│                                                                              │
│  ───────────────────────────────────────────────────────────────────────────│
│                                                                              │
│  Phase 5: Full MCP Protocol (1 week)                                        │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Complete MCP client implementation                                       │
│  • Server lifecycle management                                              │
│  • Resources and prompts support                                            │
│  • Sampling request handling                                                │
│                                                                              │
│  Deliverables:                                                              │
│  □ Full MCP protocol implementation                                         │
│  □ MCP server manager                                                       │
│  □ Integration with tool execution                                          │
│  □ MCP tool tests                                                           │
│                                                                              │
│  ───────────────────────────────────────────────────────────────────────────│
│                                                                              │
│  Phase 6: Testing & Validation (1 week)                                     │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • End-to-end tests with real AgenticAI configs                            │
│  • Performance benchmarking                                                 │
│  • Streaming compatibility verification                                     │
│  • Multi-tenant isolation tests                                             │
│  • Rollback procedure documentation                                         │
│                                                                              │
│  Deliverables:                                                              │
│  □ E2E test suite                                                           │
│  □ Performance benchmarks                                                   │
│  □ Migration runbook                                                        │
│  □ Rollback procedures                                                      │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘

Total Estimated Time: 8 weeks
```

### 15.2 Rollback Strategy

```
Rollback Points:
─────────────────────────────────────────────────────────────────────

1. API Gateway Level
   • Feature flag to route traffic to old or new system
   • Instant rollback with no data loss

2. Database Level
   • Keep MongoDB running in parallel during migration
   • Sync writes to both systems
   • Rollback = switch read source

3. Runtime Level
   • Both runtimes can coexist
   • Route by app ID or tenant

4. Session Level
   • Checkpoints stored in compatible format
   • Sessions can resume on either system
```

### 15.3 What Needs To Be Done Now (Immediate Priorities)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     IMMEDIATE PRIORITIES (WEEK 1-2)                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐│
│  │  PRIORITY 1: PROJECT STRUCTURE SETUP                                    ││
│  │  ──────────────────────────────────────                                ││
│  │                                                                         ││
│  │  □ Create apps/studio/ (Next.js 14 App Router)                         ││
│  │    • npx create-next-app@latest apps/studio --typescript --app         ││
│  │    • Configure Tailwind, ESLint, path aliases                          ││
│  │    • Set up Prisma client sharing from apps/platform                   ││
│  │                                                                         ││
│  │  □ Create apps/runtime/ (Node.js + Express)                            ││
│  │    • Initialize package.json with TypeScript                           ││
│  │    • Set up Express + ws for WebSocket                                 ││
│  │    • Import @abl/compiler for runtime execution                        ││
│  │                                                                         ││
│  │  □ Update pnpm-workspace.yaml                                           ││
│  │    • Add apps/studio and apps/runtime                                   ││
│  │                                                                         ││
│  │  □ Development mode setup (combined server)                             ││
│  │    • apps/studio/server.ts with embedded runtime                       ││
│  │    • Single `pnpm dev` command                                          ││
│  └────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐│
│  │  PRIORITY 2: CORE RUNTIME COMPLETION                                    ││
│  │  ───────────────────────────────────                                   ││
│  │                                                                         ││
│  │  □ Complete checkpointing implementation                                ││
│  │    ✓ Checkpointer interface (DONE)                                     ││
│  │    ✓ MemoryCheckpointer (DONE)                                         ││
│  │    ✓ RedisCheckpointer (DONE)                                          ││
│  │    □ MongoDBCheckpointer (for AgenticAI compat)                        ││
│  │    □ Integration with BaseRuntime                                       ││
│  │                                                                         ││
│  │  □ Model Registry integration                                           ││
│  │    ✓ ModelRegistry class (DONE)                                        ││
│  │    □ GALE provider (sync models from GALE)                             ││
│  │    □ Provider adapters (OpenAI, Anthropic, Google, Azure)              ││
│  │    □ Cost/latency tracking                                              ││
│  │                                                                         ││
│  │  □ MCP Protocol completion                                              ││
│  │    ✓ Protocol types (DONE)                                             ││
│  │    ✓ MCPClient (DONE)                                                  ││
│  │    ✓ MCPServerManager (DONE)                                           ││
│  │    □ SSE transport                                                      ││
│  │    □ Resources and prompts support                                      ││
│  └────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐│
│  │  PRIORITY 3: AGENTICAI COMPATIBILITY                                    ││
│  │  ────────────────────────────────                                      ││
│  │                                                                         ││
│  │  □ Config Converter                                                     ││
│  │    □ Parse AgenticAI app config JSON                                   ││
│  │    □ Map agent types (SUPERVISOR→supervisor, etc.)                     ││
│  │    □ Convert tool definitions                                           ││
│  │    □ Generate ABL IR directly                                           ││
│  │                                                                         ││
│  │  □ API Stubs (in apps/studio/app/api/v1/)                              ││
│  │    □ POST /api/v1/run                                                   ││
│  │    □ POST /api/v1/compile                                               ││
│  │    □ POST /api/v1/invoke                                                ││
│  │    □ Request/response mappers                                           ││
│  │                                                                         ││
│  │  □ State Format Adapter                                                 ││
│  │    □ AgenticAI checkpoint → ABL checkpoint                             ││
│  │    □ ABL checkpoint → AgenticAI response                               ││
│  └────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐│
│  │  PRIORITY 4: STREAMING & WEBSOCKET                                      ││
│  │  ─────────────────────────────────                                     ││
│  │                                                                         ││
│  │  □ Runtime WebSocket handler                                            ││
│  │    □ Session management (create, resume, destroy)                      ││
│  │    □ Message protocol (send, receive, events)                          ││
│  │    □ Streaming event emission                                           ││
│  │                                                                         ││
│  │  □ Event mapper                                                         ││
│  │    □ ABL events → AgenticAI stream format                              ││
│  │    □ Error event handling                                               ││
│  └────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 15.4 Production Rollout Plan

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     PRODUCTION ROLLOUT TIMELINE                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  PHASE 0: FOUNDATION (Weeks 1-3)                                            │
│  ═══════════════════════════════                                            │
│                                                                              │
│  Week 1: Project Setup                                                       │
│  ─────────────────────                                                      │
│  • Create apps/studio and apps/runtime scaffolding                          │
│  • Set up development mode (combined server)                                │
│  • Configure CI/CD pipelines for both services                              │
│  • Set up staging environment (single region)                               │
│                                                                              │
│  Week 2: Core Runtime                                                        │
│  ────────────────────                                                       │
│  • Complete checkpointing with MongoDB support                              │
│  • Integrate checkpointing into BaseRuntime                                 │
│  • Model registry with GALE sync                                            │
│  • Basic WebSocket handler                                                   │
│                                                                              │
│  Week 3: Compatibility Layer                                                 │
│  ────────────────────────────                                               │
│  • AgenticAI config converter                                               │
│  • V1 API stubs (run, compile, invoke)                                      │
│  • State format adapters                                                     │
│  • Event stream mapper                                                       │
│                                                                              │
│  Milestone: Run ONE AgenticAI app on ABL runtime locally                    │
│                                                                              │
│  ───────────────────────────────────────────────────────────────────────────│
│                                                                              │
│  PHASE 1: STAGING VALIDATION (Weeks 4-5)                                    │
│  ═══════════════════════════════════════                                    │
│                                                                              │
│  Week 4: Staging Deployment                                                  │
│  ──────────────────────────                                                 │
│  • Deploy apps/studio to Vercel (staging)                                   │
│  • Deploy apps/runtime to staging K8s cluster                               │
│  • Set up PostgreSQL, Redis, MongoDB in staging                             │
│  • Configure feature flags for traffic routing                              │
│                                                                              │
│  Week 5: Integration Testing                                                 │
│  ────────────────────────────                                               │
│  • Import 5 representative AgenticAI apps                                   │
│  • Run E2E tests against staging                                            │
│  • Performance benchmarking (compare to AgenticAI)                          │
│  • Fix compatibility issues                                                  │
│                                                                              │
│  Milestone: 5 apps running in staging with full feature parity              │
│                                                                              │
│  ───────────────────────────────────────────────────────────────────────────│
│                                                                              │
│  PHASE 2: CANARY PRODUCTION (Weeks 6-8)                                     │
│  ═══════════════════════════════════════                                    │
│                                                                              │
│  Week 6: Infrastructure                                                      │
│  ──────────────────────                                                     │
│  • Production infrastructure setup (US region)                              │
│  • SSL certificates, domain configuration                                   │
│  • Monitoring, alerting, logging (DataDog/Grafana)                          │
│  • Backup and disaster recovery                                              │
│                                                                              │
│  Week 7: Canary Rollout (1% traffic)                                        │
│  ────────────────────────────────────                                       │
│  • Route 1% of traffic to ABL runtime                                       │
│  • Monitor error rates, latency, success rate                               │
│  • Compare AgenticAI vs ABL metrics side-by-side                            │
│  • Fix any production issues                                                 │
│                                                                              │
│  Week 8: Expanded Canary (10% traffic)                                      │
│  ──────────────────────────────────────                                     │
│  • Increase to 10% traffic                                                  │
│  • Onboard 2-3 pilot customers (opt-in)                                     │
│  • Gather feedback, iterate                                                  │
│  • Prepare rollback procedures                                               │
│                                                                              │
│  Milestone: 10% production traffic on ABL, no regressions                   │
│                                                                              │
│  ───────────────────────────────────────────────────────────────────────────│
│                                                                              │
│  PHASE 3: GRADUAL ROLLOUT (Weeks 9-12)                                      │
│  ═════════════════════════════════════                                      │
│                                                                              │
│  Week 9-10: 50% Traffic                                                      │
│  ───────────────────────                                                    │
│  • Increase to 25%, then 50%                                                │
│  • All new tenants default to ABL                                           │
│  • Migrate high-value customers (with their consent)                        │
│  • Studio UI for agent editing (basic)                                       │
│                                                                              │
│  Week 11-12: 100% Traffic                                                    │
│  ─────────────────────────                                                  │
│  • Complete migration to 100%                                               │
│  • Deprecation notices for AgenticAI APIs                                   │
│  • Final AgenticAI → ABL sync                                               │
│  • Documentation and training                                                │
│                                                                              │
│  Milestone: All production traffic on ABL runtime                           │
│                                                                              │
│  ───────────────────────────────────────────────────────────────────────────│
│                                                                              │
│  PHASE 4: MULTI-REGION ENTERPRISE (Weeks 13-16)                             │
│  ═══════════════════════════════════════════════                            │
│                                                                              │
│  Week 13-14: EU Region                                                       │
│  ─────────────────────                                                      │
│  • Deploy runtime cluster to EU-WEST-1                                      │
│  • Configure geo-routing for GDPR compliance                                │
│  • Migrate EU tenants                                                        │
│  • Data residency verification                                               │
│                                                                              │
│  Week 15-16: APAC Region + Edge                                             │
│  ──────────────────────────────                                             │
│  • Deploy runtime cluster to AP-NORTHEAST-1                                 │
│  • Deploy Studio to Vercel Edge (global)                                    │
│  • Configure global load balancing                                          │
│  • Enterprise compliance certification                                       │
│                                                                              │
│  Milestone: Global multi-region production deployment                        │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 15.5 Risk Mitigation

| Risk                           | Probability | Impact   | Mitigation                                  |
| ------------------------------ | ----------- | -------- | ------------------------------------------- |
| **Checkpoint incompatibility** | Medium      | High     | Dual-write to both formats during migration |
| **Streaming format mismatch**  | Medium      | Medium   | Comprehensive event mapping tests           |
| **Latency regression**         | Low         | High     | Performance gates in CI, canary metrics     |
| **Data loss during migration** | Low         | Critical | Shadow mode, dual-write, verified backups   |
| **GALE integration failures**  | Medium      | Medium   | Fallback to local model registry            |
| **MCP tool breakage**          | Medium      | Medium   | Tool-by-tool validation before migration    |

### 15.6 Success Criteria

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     SUCCESS CRITERIA                                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  FUNCTIONALITY                                                               │
│  □ 100% of AgenticAI apps run on ABL without modification                  │
│  □ All V1 API endpoints return compatible responses                        │
│  □ Streaming events match AgenticAI format exactly                         │
│  □ Checkpoints persist and resume correctly                                │
│  □ Multi-agent handoffs work correctly                                      │
│                                                                              │
│  PERFORMANCE                                                                 │
│  □ P50 latency within 5% of AgenticAI                                      │
│  □ P99 latency within 10% of AgenticAI                                     │
│  □ Voice latency <50ms (edge-to-runtime)                                   │
│  □ No throughput regression                                                 │
│                                                                              │
│  RELIABILITY                                                                 │
│  □ 99.9% uptime during migration                                            │
│  □ Zero data loss                                                           │
│  □ <5 minute rollback capability                                            │
│  □ All critical alerts addressed <15 minutes                               │
│                                                                              │
│  CUSTOMER IMPACT                                                             │
│  □ Zero breaking changes for existing integrations                         │
│  □ All pilot customers approve before GA                                   │
│  □ Documentation complete before 100% rollout                              │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 15.7 Team Structure & Responsibilities

| Role                     | Responsibilities                                     | Required Skills                     |
| ------------------------ | ---------------------------------------------------- | ----------------------------------- |
| **Tech Lead**            | Architecture decisions, code review, risk management | ABL runtime, distributed systems    |
| **Runtime Engineer (2)** | Checkpointing, execution engine, streaming           | Node.js, TypeScript, Redis, MongoDB |
| **Frontend Engineer**    | Studio UI (Next.js), agent editor, debugger          | React, Next.js, TypeScript          |
| **DevOps Engineer**      | K8s, CI/CD, monitoring, multi-region                 | Kubernetes, Terraform, DataDog      |
| **QA Engineer**          | E2E tests, performance tests, compatibility          | Test automation, performance tools  |

---

## 16. Verification & Testing

### 16.1 Test Matrix

| Test Category         | Test Cases                      | Coverage Target  |
| --------------------- | ------------------------------- | ---------------- |
| **Config Conversion** | All agent types, tools, routing | 100%             |
| **API Compatibility** | All V1 endpoints                | 100%             |
| **State Management**  | Save/load/fork checkpoints      | 100%             |
| **Streaming**         | All event types                 | 100%             |
| **Tool Execution**    | Inline, HTTP, MCP, GALE         | 100%             |
| **Multi-Agent**       | Supervisor routing, delegation  | 100%             |
| **Multi-Tenant**      | Isolation, scoping              | 100%             |
| **Model Registry**    | Selection, fallback, GALE sync  | 100%             |
| **Performance**       | Latency, throughput             | < 10% regression |

### 16.2 Verification Checklist

```
□ AgenticAI supervisor config converts correctly
□ AgenticAI worker config converts correctly
□ AgenticAI processor config converts correctly
□ AgenticAI tools map to ABL tools
□ Routing rules translate correctly
□ /api/v1/run works with existing clients
□ /api/v1/compile returns valid graph ID
□ /api/v1/invoke executes correctly
□ Streaming events match AgenticAI format
□ Checkpoints persist across restarts
□ Sessions resume correctly
□ Multi-agent handoff works
□ Tool calls execute correctly
□ MCP tools work end-to-end
□ GALE tools fetch and execute
□ Model selection uses registry
□ Fallback chains work
□ Tenant isolation enforced
□ Performance within targets
□ No data loss during migration
```

---

## Appendix A: Glossary

| Term           | Definition                                                 |
| -------------- | ---------------------------------------------------------- |
| **ABL**        | Agent Business Language - the DSL for defining agents      |
| **AgenticAI**  | The existing multi-agent platform being migrated           |
| **IR**         | Intermediate Representation - compiled agent specification |
| **Checkpoint** | Saved state of an agent session                            |
| **GALE**       | External tool library and model registry service           |
| **MCP**        | Model Context Protocol - standard for tool integration     |
| **Construct**  | Reusable execution unit in ABL (flow, gather, reasoning)   |

---

## Appendix B: File Structure

```
packages/compiler/src/
├── compat/
│   ├── index.ts
│   ├── agenticai-converter.ts      # Config → ABL conversion
│   ├── api-stub.ts                 # V1 API compatibility
│   ├── state-mapper.ts             # State format mapping
│   └── event-mapper.ts             # Stream event mapping
├── platform/
│   ├── checkpointing/
│   │   ├── index.ts
│   │   ├── checkpointer.ts         # Interface
│   │   ├── memory-checkpointer.ts  # Dev/test
│   │   ├── redis-checkpointer.ts   # Production
│   │   └── mongodb-checkpointer.ts # Production
│   ├── model-registry/
│   │   ├── index.ts
│   │   ├── registry.ts             # Core registry
│   │   ├── gale-provider.ts        # GALE sync
│   │   └── router.ts               # Intelligent routing
│   ├── mcp/
│   │   ├── index.ts
│   │   ├── protocol.ts             # Type definitions
│   │   ├── client.ts               # MCP client
│   │   ├── server-manager.ts       # Server lifecycle
│   │   └── transport.ts            # Stdio/SSE
│   └── gale/
│       ├── index.ts
│       ├── gale-service.ts         # GALE API client
│       └── tool-cache.ts           # Tool caching

# ══════════════════════════════════════════════════════════════════════════════
# SPLIT ARCHITECTURE SERVICES
# ══════════════════════════════════════════════════════════════════════════════

apps/studio/                         # DESIGN & DEPLOYMENT SERVICE (Next.js)
├── app/
│   ├── layout.tsx                   # Root layout with providers
│   ├── page.tsx                     # Dashboard
│   ├── (auth)/
│   │   ├── login/page.tsx
│   │   └── register/page.tsx
│   ├── projects/
│   │   ├── page.tsx                 # Project list
│   │   └── [projectId]/
│   │       ├── page.tsx             # Project overview
│   │       ├── agents/              # Agent editor
│   │       ├── deploy/page.tsx      # Deployment manager
│   │       └── analytics/page.tsx   # Traces, metrics
│   └── api/
│       ├── projects/route.ts        # Project CRUD
│       ├── agents/route.ts          # Agent CRUD
│       ├── deploy/route.ts          # Deployment API
│       ├── v1/                      # AgenticAI compat layer
│       │   ├── apps/route.ts
│       │   ├── agents/route.ts
│       │   ├── run/route.ts         # POST /api/v1/run
│       │   ├── compile/route.ts     # POST /api/v1/compile
│       │   └── invoke/route.ts      # POST /api/v1/invoke
│       └── runtime/
│           └── [...path]/route.ts   # Proxy to Runtime Service
├── lib/
│   ├── runtime-client.ts            # Client for Runtime Service
│   ├── compiler.ts                  # Uses @abl/compiler
│   └── db.ts                        # Prisma client
├── components/
│   ├── editor/                      # Monaco-based DSL editor
│   ├── flow-graph/                  # Visual agent graph
│   └── debugger/                    # Real-time debugger
├── server.ts                        # Custom server (dev mode combined)
└── prisma/
    └── schema.prisma                # Design-time schema

apps/runtime/                        # RUNTIME SERVICE (Node.js + Express)
├── src/
│   ├── index.ts                     # Entry point
│   ├── server.ts                    # Express + WebSocket setup
│   ├── routes/
│   │   ├── exec.ts                  # POST /runtime/exec
│   │   ├── session.ts               # Session management
│   │   ├── checkpoint.ts            # Checkpoint CRUD
│   │   ├── deploy.ts                # POST /runtime/deploy
│   │   └── hooks.ts                 # Twilio, webhook handlers
│   ├── websocket/
│   │   ├── handler.ts               # WebSocket message router
│   │   ├── voice-stream.ts          # Voice media handling
│   │   └── chat-stream.ts           # Chat streaming
│   ├── execution/
│   │   ├── runtime-manager.ts       # Runtime lifecycle
│   │   ├── session-store.ts         # In-memory + Redis sessions
│   │   └── ir-loader.ts             # Load compiled IR
│   ├── llm/
│   │   ├── router.ts                # Model routing
│   │   └── providers/               # Provider adapters
│   ├── tools/
│   │   ├── router.ts                # Tool routing
│   │   ├── mcp-client.ts            # MCP connections
│   │   └── gale-fetcher.ts          # GALE tool loading
│   └── observability/
│       ├── tracer.ts                # OpenTelemetry
│       └── metrics.ts               # Prometheus metrics
└── package.json

deploy/                              # DEPLOYMENT CONFIGURATIONS
├── kubernetes/
│   ├── design-service.yaml
│   ├── runtime-service.yaml
│   └── ingress.yaml
├── docker/
│   ├── Dockerfile.studio
│   └── Dockerfile.runtime
└── terraform/
    ├── main.tf
    ├── studio.tf
    └── runtime.tf
```

---

_Document Version: 1.0_
_Last Updated: 2026-02-08_
