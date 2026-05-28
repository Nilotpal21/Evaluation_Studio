# Grok Realtime S2S Voice - Implementation Context

**Date**: 2026-04-02
**Status**: IN PROGRESS - Tool execution response issue
**Branch**: feat/grok-realtime-s2s-voice
**Latest Commit**: 8492bee73

---

## Current Issue

**Symptom**: Grok goes silent after tool execution (e.g., `search_hotels`)

- Call progresses normally through handoff from TravelDesk_Supervisor → Sales_Agent
- Sales_Agent asks for travel details (origin, destination, dates, guests)
- When user provides all details, Sales_Agent says: "Searching top hotels in Paris for April 4-7"
- After `search_hotels` tool executes successfully, **Grok becomes mute** - no response

**Root Cause**: Grok Realtime API requires explicit `response.create` trigger after tool results to continue conversation, unlike OpenAI which continues automatically.

**Latest Fix Applied** (commit 8492bee73):

- Added code to send `response.create` after every tool result for Grok
- Changed from checking `isGrokProvider` (scope issue) to checking `s2sProvider === 's2s:grok'` directly
- Location: `apps/runtime/src/services/voice/korevg/korevg-router.ts` line ~1884

**Problem**: tsx watch mode not picking up file changes

- Code changes are in the file on disk/container
- But the running process hasn't reloaded
- Manual restart needed: `/app/stop-runtime.sh` then `/app/start-runtime.sh`

---

## Implementation Summary

### Files Modified

1. **apps/runtime/src/services/voice/korevg/grok-llm-payload.ts** (NEW - 127 lines)
   - Generates Jambonz-compatible llm verb payload for Grok telephony
   - `buildGrokLlmVerbPayload()` - builds initial session config
   - Grok-specific: voice IDs (ara, eve, leo, rex, sal), VAD config, organizationId

2. **apps/runtime/src/**tests**/grok-llm-payload.test.ts** (NEW - 181 lines)
   - 10 test scenarios for Grok payload generation

3. **apps/studio/src/components/deployments/channels/GrokS2SFields.tsx** (NEW - 138 lines)
   - Studio UI for Grok configuration in channel creation
   - Voice selection, model, temperature, VAD settings

4. **apps/runtime/src/services/voice/korevg/korevg-router.ts** (MODIFIED)
   - Line 777: `isGrokProvider` detection
   - Line 780-786: Use `buildGrokLlmVerbPayload()` for Grok
   - Line 1822-1860: Handoff flow - `conversation.item.create` + `response.create` for Grok
   - Line 1884-1897: Tool result flow - send `response.create` after tool execution for Grok
   - Line 1760, 1915: Fixed logging to show "grok" instead of "openai"

5. **apps/runtime/src/routes/tenant-service-instances.ts** (MODIFIED)
   - Added 's2s:grok' to VALID_SERVICE_TYPES, serviceTypeEnum, listServiceInstancesQuerySchema

6. **apps/runtime/src/services/voice/korevg/s2s-google-event-handler.ts** (MODIFIED)
   - Fixed `buildOpenAIToolResponse()` and `buildGoogleToolResponse()` - removed command wrapper
   - These return raw data, `buildKorevgToolOutputCommand()` handles wrapping

7. **apps/admin/src/components/VoiceServicesPage.tsx** (MODIFIED)
   - Added Grok voice options to Admin voice services page

---

## Grok API Behavioral Differences from OpenAI

### 1. Mid-Call Session Updates (Agent Handoffs)

**OpenAI**: Sending `session.update` with new instructions → LLM automatically starts responding
**Grok**: Requires:

1. `session.update` with new instructions
2. `conversation.item.create` with a user message (e.g., "Go ahead.")
3. `response.create` with `{modalities: ['text', 'audio']}`

**Implementation**: Lines 1822-1860 in korevg-router.ts

### 2. Tool Result Handling

**OpenAI**: After tool result sent → LLM automatically continues
**Grok**: Requires explicit `response.create` after tool result to trigger continuation

**Implementation**: Lines 1884-1897 in korevg-router.ts (THIS IS THE CURRENT ISSUE)

### 3. Voice IDs

- **OpenAI**: alloy, echo, fable, onyx, nova, shimmer
- **Grok**: ara (default), eve, leo, rex, sal

### 4. Event Names

Same as OpenAI:

- `response.output_audio_transcript.delta`
- `response.function_call_arguments.done`
- `session.updated`
- `response.done`

---

## Network Architecture

**Dual Network Setup** (CRITICAL):

- **ABL Network** (172.19.0.x): Runtime, Studio, Admin, MongoDB, Redis, ClickHouse
- **SAVG Network** (172.15.0.x): FreeSWITCH, savg-apps (Jambonz feature-server), Drachtio, RTPEngine

**savg-apps Container**: Has interfaces on BOTH networks

- 172.19.0.5 (ABL) - for Runtime communication
- 172.15.0.9 (SAVG) - for FreeSWITCH/Drachtio communication

**FreeSWITCH**: Connected to BOTH networks (after fix)

- 172.15.0.8 (SAVG) - primary interface
- 172.19.0.11 (ABL) - added via `docker network connect abl-platform_abl-network freeswitch --ip 172.19.0.11`
- Without both interfaces, savg-apps couldn't connect back to FreeSWITCH

---

## Testing Procedure

1. **Create Grok S2S credentials in Admin**:
   - Navigate to Admin → Voice Services
   - Add service type: `s2s:grok`
   - Provide xAI API key (starts with `xai-`)
   - Optionally provide organizationId

2. **Configure Channel in Studio**:
   - Create/Edit channel → Voice tab
   - Select "Grok Realtime" as provider
   - Choose voice: ara/eve/leo/rex/sal
   - Configure VAD threshold, silence duration, prefix padding
   - Save channel

3. **Test Call**:
   - Dial DID number (e.g., 9885)
   - Call should route to Grok channel
   - TravelDesk_Supervisor greets caller
   - Handoff to Sales_Agent works (after fix at commit c1771d10f)
   - Sales_Agent asks for travel details
   - **CURRENT ISSUE**: After providing details, tool execution (search_hotels) completes but Grok doesn't speak

---

## Logs to Check

**Runtime logs**: `/app/abl-platform/logs/runtime-*.log` (inside downloads-runtime-1 container)
Key log patterns:

```
[VOICE_MODE] Voice config before resolution ... s2sProvider=s2s:grok
[S2S] Grok Realtime configuration  model=grok-2-1212 voice=leo
[S2S] Tool call received  toolName=search_hotels provider=grok
[S2S] After tool result ... s2sProvider=s2s:grok  # Should appear but doesn't
[S2S:Grok] Sending response.create after tool result  # Should appear but doesn't
```

**FreeSWITCH logs**: `docker exec freeswitch tail -200 /usr/local/freeswitch/log/freeswitch.log`
Key patterns:

```
grok_glue.cpp:413 grok_s2s_send_client_event sending response.create
grok_glue.cpp:209 grok server event (grok_s2s): {"type":"response.output_audio_transcript.delta"
```

**Feature-server logs**: `docker exec savg-apps pm2 logs feature-server`

---

## Next Steps to Resolve

1. **Verify tsx watch reload**:

   ```bash
   docker exec downloads-runtime-1 /app/stop-runtime.sh
   docker exec downloads-runtime-1 /app/start-runtime.sh
   ```

2. **Make test call and check for new logs**:
   - Should see `[S2S] After tool result ... s2sProvider=s2s:grok`
   - Should see `[S2S:Grok] Sending response.create after tool result`

3. **If logs appear but Grok still silent**:
   - Check FreeSWITCH logs for response.create being sent to Grok
   - Check if Grok API returns any error events
   - May need to investigate xAI API docs for additional requirements

4. **Alternative approaches if response.create doesn't work**:
   - Try sending `conversation.item.create` with user message after tool result (like handoff flow)
   - Check if tool response format needs adjustment for Grok
   - Investigate if Grok has different expectations for function_call_output structure

---

## Code References

**Primary file**: `apps/runtime/src/services/voice/korevg/korevg-router.ts`

**Key variables**:

- `s2sProvider` - The provider string ('s2s:grok', 's2s:google', 's2s:openai')
- `isGoogleProvider` - Boolean for Google/Gemini detection
- `isGrokProvider` - Boolean for Grok detection (line 777)

**Important**: Use `s2sProvider === 's2s:grok'` in WebSocket message handlers, not `isGrokProvider`, due to closure scope issues.

**xAI Realtime API docs**: https://docs.x.ai/developers/rest-api-reference/inference/voice#realtime

---

## Commits History

- `85f0549a5` - Initial Grok integration (grok-llm-payload, UI fields)
- `3f846ded2` - Fixed voice IDs (Grok voices, not OpenAI)
- `71ce90d60` - (REVERTED) Incorrect tool response wrapping
- `61b968102` - Fixed double-wrapping issue in tool responses
- `3690c5871` - First attempt at handoff response.create (bare format)
- `c1771d10f` - Fixed handoff with structured response.create (includes instructions, temperature)
- `8492bee73` - Added response.create after tool results (CURRENT - NOT YET WORKING)

---

## Known Working vs Not Working

**✅ Working**:

- Initial greeting from TravelDesk_Supervisor
- Handoff to Sales_Agent (after structured response.create fix)
- Sales_Agent asks for travel details
- Tool calls are being triggered (`search_hotels`, `__set_context__`)
- Tool execution completes successfully
- Provider detection logs show "grok" correctly

**❌ Not Working**:

- Grok doesn't respond after tool execution (search_hotels, search_packages, etc.)
- Goes silent after saying status message like "Searching top hotels in Paris for April 4-7"
- No transcript deltas or audio after tool result

**🔍 Suspected Issue**:

- tsx watch not reloading after file changes
- OR response.create alone isn't sufficient (may need conversation.item.create first like handoff flow)
- OR tool response format needs Grok-specific handling
