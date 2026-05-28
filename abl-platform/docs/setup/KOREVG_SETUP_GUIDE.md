# KoreVG / Jambonz Voice Channel Setup Guide

This guide explains how to configure ABL Platform to use KoreVG (Jambonz) as a voice gateway.
It covers environment setup, the provisioning flow, and how authentication works.

---

## Overview

ABL Platform integrates with Jambonz (KoreVG) to handle inbound voice calls. The architecture is:

- **One Jambonz account per environment** (dev, staging, prod) — pre-created by the platform team
- **One Jambonz Application per channel connection** — auto-created when a voice `ChannelConnection` is created via the API
- **One Twilio phone number per channel connection** — purchased or selected from existing inventory via the Studio UI and auto-assigned to the Twilio SIP Trunk
- **One shared VoIP Carrier per Jambonz account** — links Twilio SIP trunks to Jambonz, created once by infra

When a call arrives at the phone number → Twilio routes it through the SIP Trunk → Jambonz VoIP Carrier receives it → Jambonz dispatches to the matching Application → Jambonz opens a WebSocket to ABL Runtime → ABL processes the call with the configured agent.

---

## 1. Environment Variables

These must be set in `apps/runtime/.env` (or injected via Kubernetes secrets in production).

### Required — Jambonz

| Variable                   | Description                                                                        |
| -------------------------- | ---------------------------------------------------------------------------------- |
| `JAMBONZ_BASE_API_URL`     | Jambonz REST API base URL, e.g. `https://korevg-dev.kore.ai/api/v1`                |
| `JAMBONZ_ACCOUNT_SID`      | The Jambonz account SID for this environment (from Jambonz portal → Account → SID) |
| `JAMBONZ_API_KEY`          | Account-level API key (from Jambonz portal → Account → API Keys)                   |
| `JAMBONZ_VOIP_CARRIER_SID` | SID of the VoIP Carrier linked to Twilio (see One-Time Setup below)                |

### Required — Twilio

| Variable               | Description                                                                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TWILIO_ACCOUNT_SID`   | Twilio account SID (`ACxxxxxxx`)                                                                                                                                              |
| `TWILIO_AUTH_TOKEN`    | Twilio auth token                                                                                                                                                             |
| `TWILIO_API_KEY`       | Twilio API key SID (`SKxxxxxxx`) — needed for token generation                                                                                                                |
| `TWILIO_API_SECRET`    | Twilio API key secret                                                                                                                                                         |
| `TWILIO_TRUNK_SID`     | Twilio Elastic SIP Trunk SID (`TKxxxxxxx`) — when set, both purchased and pre-existing numbers are auto-assigned to this trunk on channel creation and unassigned on deletion |
| `TWILIO_TWIML_APP_SID` | TwiML App SID (`APxxxxxxx`) — needed for outbound calling only                                                                                                                |

### Required — Runtime

| Variable                  | Description                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RUNTIME_PUBLIC_BASE_URL` | Public-facing URL of the runtime (e.g. `https://runtime.yourdomain.com`). Used to build the Jambonz WebSocket callback URL. Must be reachable from Jambonz servers. |

> **Note:** `RUNTIME_BASE_URL` is the fallback if `RUNTIME_PUBLIC_BASE_URL` is not set.
> In production you must set `RUNTIME_PUBLIC_BASE_URL` to a hostname that Jambonz can reach.

### Required — LiveDial (Studio Softphone)

| Variable                 | Description                                                                                                                                                                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JAMBONZ_SBC_WS_ADDRESS` | Comma-separated SBC host(s) for WebRTC SIP over WebSocket, e.g. `sbc.example.com` or `sbc1.example.com,sbc2.example.com`. Used by both the runtime (to build `wss://` URLs in the softphone-config endpoint) and Studio (for CSP `connect-src` headers). |
| `JAMBONZ_SBC_WS_PORT`    | WebSocket port on the SBC for SIP signaling. Default: `8443`. Combined with `JAMBONZ_SBC_WS_ADDRESS` to form `wss://<host>:<port>` URLs.                                                                                                                 |

> **Note:** `JAMBONZ_SBC_WS_ADDRESS` is set in the shared config schema (`packages/config/src/env-mapping.ts` → `voice.jambonz.sbcWsAddress`). This is separate from `JAMBONZ_SBC_ADDRESS` which is used for SIP trunk address display in the channel configuration UI.
> `JAMBONZ_SBC_WS_PORT` is read directly from `process.env` in both `apps/runtime/src/routes/voice.ts` and `apps/studio/src/proxy.ts`.

### Optional

| Variable                           | Description                                                                         |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| `JAMBONZ_SERVICE_PROVIDER_ID`      | Service Provider SID — only needed for creating VoIP carriers (one-time infra task) |
| `JAMBONZ_SERVICE_PROVIDER_API_KEY` | SP-level API key — only needed for creating VoIP carriers                           |

---

## 2. One-Time Infrastructure Setup: VoIP Carrier

A **VoIP Carrier** in Jambonz is the SIP configuration that tells Jambonz which IP addresses are
trusted inbound SIP sources (Twilio's signaling IPs) and where to send outbound SIP (Twilio's
PSTN gateway). This is created **once per Jambonz account** by the platform/infra team.

You need the Service Provider API key (different from the account-level key) to create carriers.

### Step 1 — Create the carrier

```bash
curl -X POST "https://korevg-dev.kore.ai/api/v1/ServiceProviders/{serviceProviderId}/VoipCarriers" \
  -H "Authorization: Bearer {serviceProviderApiKey}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "env-name-twilio-trunk",
    "account_sid": "{accountSid}",
    "e164_leading_plus": true,
    "requires_register": false,
    "dtmf_type": "rfc2833",
    "is_active": true
  }'
# Response: { "sid": "..." }  ← use this as JAMBONZ_VOIP_CARRIER_SID
```

### Step 2 — Add Twilio inbound SIP gateway IPs

```bash
TWILIO_IPS=("54.172.60.0" "54.244.51.0" "54.171.127.192" "35.156.191.128"
            "54.65.63.192" "54.169.127.128" "54.252.254.64" "177.71.206.192")

for IP in "${TWILIO_IPS[@]}"; do
  curl -X POST "https://korevg-dev.kore.ai/api/v1/SipGateways" \
    -H "Authorization: Bearer {serviceProviderApiKey}" \
    -H "Content-Type: application/json" \
    -d "{
      \"voip_carrier_sid\": \"{voipCarrierSid}\",
      \"ipv4\": \"$IP\",
      \"netmask\": 32,
      \"port\": 5060,
      \"protocol\": \"udp\",
      \"inbound\": true,
      \"outbound\": false,
      \"is_active\": true
    }"
done
```

### Step 3 — Add Twilio outbound SIP gateway

```bash
curl -X POST "https://korevg-dev.kore.ai/api/v1/SipGateways" \
  -H "Authorization: Bearer {serviceProviderApiKey}" \
  -H "Content-Type: application/json" \
  -d '{
    "voip_carrier_sid": "{voipCarrierSid}",
    "ipv4": "pstn.twilio.com",
    "netmask": 32,
    "port": 5060,
    "protocol": "udp",
    "inbound": false,
    "outbound": true,
    "is_active": true
  }'
```

Set the returned carrier SID as `JAMBONZ_VOIP_CARRIER_SID`.

---

## 3. Creating a Voice Channel Connection

### Step 1 — Create the connection via API

Create a voice channel connection. This auto-provisions a Jambonz Application.
The `external_identifier` is a unique **connection name** (not a phone number).

#### Channel types

| `channel_type`   | Description                                                         |
| ---------------- | ------------------------------------------------------------------- |
| `voice_pipeline` | STT → Agent → TTS pipeline (non-realtime, uses Deepgram/ElevenLabs) |
| `voice_realtime` | Realtime voice (e.g. OpenAI Realtime API)                           |

#### API call

```
POST /api/v1/channel-connections
Authorization: Bearer <your-jwt-token>
Content-Type: application/json
```

```json
{
  "project_id": "019c603c-ff4c-7642-8a85-ca3bfea02114",
  "channel_type": "voice_pipeline",
  "external_identifier": "pipeline-voice-prod",
  "display_name": "My Voice Channel",
  "config": {
    "asrVendor": "deepgram",
    "asrLanguage": "en-US",
    "ttsVendor": "elevenlabs"
  }
}
```

**Fields:**

- `external_identifier` — a unique connection name (e.g. `pipeline-voice-prod`). Used as the
  connection identifier in the system. **Not the phone number.**
- `config.asrVendor` / `asrLanguage` — speech recognition settings (applied in Jambonz application)
- `config.ttsVendor` — text-to-speech vendor

> **Do NOT pass `inboundAuthToken` in the request.** It is auto-generated by the server
> as a cryptographically secure 32-byte random hex string and stored in the connection config.

#### What happens on CREATE

1. A `ChannelConnection` record is created in MongoDB with the given `external_identifier`
2. A 32-byte random `inboundAuthToken` is generated
3. `POST /Applications` is called on Jambonz — creates an application with:
   - `call_hook.url`: `wss://{RUNTIME_PUBLIC_BASE_URL_host}/ws/korevg/{connectionId}?token={inboundAuthToken}`
   - ASR/TTS vendor config from `config`
4. Both Jambonz SIDs written back: `config.jambonzApplicationSid` and `config.inboundAuthToken`
5. On failure: Jambonz application is rolled back, DB record deleted, `502` returned

> **Phone number assignment at create time:** If both `JAMBONZ_VOIP_CARRIER_SID` is set and
> a valid E.164 phone number is passed as `external_identifier`, the number is also assigned to
> the Jambonz application via `POST /PhoneNumbers`. This is a legacy path — the recommended
> approach is to buy a number via the Studio UI after creation (see Step 2 below).

#### Response

```json
{
  "success": true,
  "connection": {
    "id": "019c7e5d-701d-7614-b455-ff01a6052802",
    "channelType": "voice_pipeline",
    "externalIdentifier": "pipeline-voice-prod",
    "displayName": "My Voice Channel",
    "status": "active",
    "config": {
      "asrVendor": "deepgram",
      "asrLanguage": "en-US",
      "ttsVendor": "elevenlabs",
      "jambonzApplicationSid": "1c74dfc7-5f3a-4dec-90c5-f54cfd8ef572"
    }
  }
}
```

> `inboundAuthToken` is stored in `config` server-side but is **not returned** in the response
> (treated as a secret). It is embedded in the Jambonz application webhook URL automatically.

---

### Step 2 — Buy a Twilio phone number (Studio UI)

After creating the connection, go to the **Configuration tab** in the Studio → Phone Number section.

Search for an available number by country, type (local/toll-free), and area code, then click
**Buy Selected Number**. The Studio calls:

```
GET /api/voice/twilio/available-numbers?countryCode=US&numberType=local&areaCode=415
POST /api/voice/twilio/purchase-number   body: { "phoneNumber": "+14155551234" }
```

On purchase:

1. Twilio purchases the phone number under the configured Twilio account
2. If `TWILIO_TRUNK_SID` is set, the number is immediately assigned to the Elastic SIP Trunk
   so inbound calls route to Jambonz. If not set, a warning is logged and manual assignment is needed.
3. The Studio saves `config.phoneNumber` (E.164 number) and `config.phoneNumberSid` (Twilio SID)
   to the channel connection config

> `config.phoneNumberSid` is stored at purchase time and used for automatic release on channel deletion.

When using a **pre-existing number** from the Twilio account (not purchased via ABL):

1. After Jambonz provisioning, ABL looks up the number SID from Twilio by E.164 number
2. If `TWILIO_TRUNK_SID` is set, the number is assigned to the SIP trunk (non-fatal — a warning is logged if this fails)
3. The SID is saved as `config.twilioPhoneNumberSid` (distinct from `phoneNumberSid`)
4. On channel deletion, the number is **unassigned** from the trunk but **not released** — it stays in the Twilio account

---

## 4. Setting the Routing Environment

After creating the connection and buying a phone number, set which deployment environment handles
incoming calls. In the Studio, go to the **Deployment tab** for the channel connection and select
an environment (`dev`, `staging`, or `production`).

This can also be set via API:

```
PATCH /api/v1/channel-connections/{id}
Authorization: Bearer <your-jwt-token>
```

```json
{ "environment": "production" }
```

The runtime uses a 3-tier resolution strategy:

1. **`deploymentId`** (if set) — routes to a specific deployment by ID
2. **`environment`** (if set) — routes to the latest active deployment for that environment
3. **Working copy fallback** — compiles agent DSL on the fly (dev/debug only, `allowWorkingCopy: true`)

Setting `environment` clears `deploymentId` and vice versa. Use `environment` for normal production
routing — it automatically picks up new deployments without needing to re-link the channel.

---

## 5. How Authentication Works

When a call arrives, Jambonz opens a WebSocket to:

```
wss://{runtime-host}/ws/korevg/{connectionId}?token={inboundAuthToken}
```

The runtime validates:

1. Looks up the `ChannelConnection` by `connectionId`
2. Reads `connection.config.inboundAuthToken`
3. Compares the `?token=` query param against it using `crypto.timingSafeEqual` (constant-time)
4. Rejects with `4403` if tokens don't match; in production, **rejects if no token is configured**

The token is set once at creation and embedded in the Jambonz application webhook URL automatically.
If you delete and recreate the connection, a new token is generated and the Jambonz application
is updated with the new URL.

---

## 6. Updating a Connection

```
PATCH /api/v1/channel-connections/{id}
Authorization: Bearer <your-jwt-token>
```

```json
{
  "display_name": "Updated Name",
  "config": {
    "asrVendor": "google",
    "ttsVendor": "google"
  }
}
```

On config update: if the connection has a `jambonzApplicationSid`, the Jambonz application is
updated with the new ASR/TTS vendors. The existing `inboundAuthToken` is preserved and
re-embedded in the webhook URL — you do not need to provide it.

---

## 7. Deleting a Connection

```
DELETE /api/v1/channel-connections/{id}
Authorization: Bearer <your-jwt-token>
```

On delete (all steps non-fatal — DB record is deactivated regardless):

1. If `config.phoneNumberSid` exists → Twilio phone number is released back to Twilio's pool
2. If `config.jambonzPhoneNumberSid` exists → phone number unassigned from Jambonz application
3. If `config.jambonzApplicationSid` exists → Jambonz application deleted
4. DB record status set to `inactive`

---

## 8. Getting a JWT for Testing (non-production)

```bash
curl -X POST http://localhost:3112/api/auth/dev-login \
  -H "Content-Type: application/json" \
  -d '{"email": "your@email.com", "name": "Your Name"}'
# Response: { "accessToken": "...", "tenantId": "...", "role": "OWNER" }
```

Token expires in 24 hours.

---

## 9. Troubleshooting

### Jambonz application not created

Check runtime logs for `jambonz` errors. Common causes:

- `JAMBONZ_BASE_API_URL` not set or unreachable
- `JAMBONZ_ACCOUNT_SID` or `JAMBONZ_API_KEY` wrong
- `RUNTIME_PUBLIC_BASE_URL` not set (webhook URL will be `localhost` which Jambonz can't reach)

### Phone number not routing to Jambonz after purchase

Check that `TWILIO_TRUNK_SID` is set. Without it, the purchased number is bought in Twilio but
not assigned to the SIP trunk, so calls won't reach Jambonz. Assign manually in the Twilio console
if needed, or set `TWILIO_TRUNK_SID` and re-purchase.

### Pre-existing number not routing to Jambonz after channel creation

Check runtime logs for `Twilio trunk assignment failed` — this means trunk assignment ran but errored
(e.g. number not found in Twilio account, or Twilio API error). If `TWILIO_TRUNK_SID not configured`
appears instead, set `TWILIO_TRUNK_SID` and recreate the channel connection. You can also assign
manually in the Twilio console under the number's **Voice & Fax** settings.

### Phone number not assigned in Jambonz

`JAMBONZ_VOIP_CARRIER_SID` must be set for Jambonz to know about the phone number. Without it,
Jambonz won't route inbound SIP calls to the correct application even if Twilio is configured.

### WebSocket rejected with 4403

The `?token=` in the WebSocket URL does not match `connection.config.inboundAuthToken`. This
usually means the Jambonz application was created before token auth was implemented. Delete and
recreate the connection to get a fresh token embedded in the webhook URL.

### WebSocket rejected with 4404

The `connectionId` in the URL does not match any active `ChannelConnection`. Verify the
connection exists and is `active` status.

### "Channel not configured" in production

In production, `inboundAuthToken` must be set. If it is missing (e.g. legacy connection created
before token auth), delete and recreate the connection.

---

## 10. Jambonz API Key Scopes

| Key type                   | Can do                                                               |
| -------------------------- | -------------------------------------------------------------------- |
| Account-level key          | Create/update/delete applications and phone numbers for that account |
| Service Provider-level key | Create VoIP carriers, manage all accounts under the SP               |

The SP-level key is only needed for the one-time carrier setup (Section 2).
Day-to-day provisioning uses the account-level key (`JAMBONZ_API_KEY`).
