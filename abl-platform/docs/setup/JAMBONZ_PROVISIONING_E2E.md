# Jambonz Voice Channel Provisioning — E2E Test Report & API Reference

## Overview

This document covers the end-to-end testing of the Jambonz (KoreVG) voice gateway provisioning
feature in abl-platform. It includes all APIs tested, credentials used, and results.

---

## Environment

| Service | URL                          |
| ------- | ---------------------------- |
| Runtime | `http://localhost:3112`      |
| Studio  | `http://localhost:5173`      |
| Jambonz | `https://korevg-dev.kore.ai` |
| Twilio  | `https://api.twilio.com`     |

---

## Credentials Reference

### Runtime `.env` (apps/runtime/.env)

```env
# Jambonz
JAMBONZ_BASE_API_URL=https://korevg-dev.kore.ai/api/v1
JAMBONZ_ACCOUNT_SID=4493a42d-719c-4692-85f7-9a16a95b1e73        # bhanu-local account
JAMBONZ_API_KEY=cddf92b6-e284-4672-a7bb-b46fc601bc2a             # account-level API key
JAMBONZ_VOIP_CARRIER_SID=9ae06096-88b8-4ee6-8ab1-944ff0115327   # bhanu-local-twilio-trunk
JAMBONZ_SERVICE_PROVIDER_ID=4bdf9ce1-d312-4d71-8bbf-95da7bcb7e48
JAMBONZ_SERVICE_PROVIDER_API_KEY=4c694695-6400-4d82-b092-730c8c22af17

# Twilio
TWILIO_ACCOUNT_SID=ACc518be9a6f916431ecfd8d7d9f471b2e
TWILIO_AUTH_TOKEN=86a0bdcbb29352a9697cda93b9d51be2
TWILIO_API_KEY=SK790f74f8fc9203f93d35257df3165d26
TWILIO_API_SECRET=Oi3W2gmpWDUVEYwjcZoBCQti4w8UVP4R
TWILIO_TWIML_APP_SID=AP687700eb5b78ae32543862b710d1c3fe

# Runtime public URL (used for Jambonz webhook URL)
RUNTIME_BASE_URL=http://localhost:3112
```

### Jambonz Account Details

| Field                    | Value                                                         |
| ------------------------ | ------------------------------------------------------------- |
| Account Name             | `bhanu-local`                                                 |
| Account SID              | `4493a42d-719c-4692-85f7-9a16a95b1e73`                        |
| Account API Key          | `cddf92b6-e284-4672-a7bb-b46fc601bc2a`                        |
| Service Provider         | `KORE`                                                        |
| Service Provider SID     | `4bdf9ce1-d312-4d71-8bbf-95da7bcb7e48`                        |
| Service Provider API Key | `4c694695-6400-4d82-b092-730c8c22af17` (from portal Settings) |

### VoIP Carrier Created (bhanu-local-twilio-trunk)

| Field       | Value                                       |
| ----------- | ------------------------------------------- |
| Carrier SID | `9ae06096-88b8-4ee6-8ab1-944ff0115327`      |
| Name        | `bhanu-local-twilio-trunk`                  |
| Account     | `bhanu-local`                               |
| Inbound IPs | Twilio SIP signaling IPs (8 IPs, see below) |
| Outbound    | `pstn.twilio.com:5060`                      |

---

## One-Time Setup: Creating the Jambonz VoIP Carrier

A VoIP Carrier in Jambonz is the SIP trunk configuration that links a phone number to a
PSTN provider (Twilio). It must be created once per Jambonz account before phone number
assignment can work.

### Step 1 — Create the carrier (requires Service Provider API key)

```bash
curl -X POST "https://korevg-dev.kore.ai/api/v1/ServiceProviders/{serviceProviderId}/VoipCarriers" \
  -H "Authorization: Bearer {serviceProviderApiKey}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "bhanu-local-twilio-trunk",
    "account_sid": "{accountSid}",
    "e164_leading_plus": true,
    "requires_register": false,
    "dtmf_type": "rfc2833",
    "is_active": true
  }'
# Response: { "sid": "9ae06096-88b8-4ee6-8ab1-944ff0115327" }
```

### Step 2 — Add Twilio inbound SIP gateway IPs

Twilio's SIP signaling IPs must be whitelisted as inbound gateways on the carrier:

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

---

## Getting a JWT for Testing

The runtime has a dev-login endpoint (non-production only):

```bash
curl -X POST http://localhost:3112/api/auth/dev-login \
  -H "Content-Type: application/json" \
  -d '{"email": "bhanuraja1997@gmail.com", "name": "Bhanu"}'

# Response:
# {
#   "accessToken": "<JWT>",
#   "tenantId": "019c603f-3e9b-72bd-b979-60747fb0940e",
#   "role": "OWNER"
# }
```

Token expires in 24 hours.

---

## Runtime APIs Tested

### 1. Auth — Dev Login

```
POST /api/auth/dev-login
Body: { "email": "string", "name": "string" }
Response: { "accessToken": "JWT", "tenantId": "...", "role": "OWNER" }
```

### 2. Voice Capabilities

```
GET /api/voice/capabilities
Auth: Bearer {JWT}
Response: { "twilio": true, "deepgram": false, "elevenlabs": false, "fullVoice": false }
```

Twilio is `true` when `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` + `TWILIO_API_KEY` + `TWILIO_API_SECRET` are all set.

### 3. List Twilio Phone Numbers

```
GET /api/voice/twilio/phone-numbers
Auth: Bearer {JWT}
Response: { "phoneNumbers": [{ "sid": "...", "phoneNumber": "+1...", "friendlyName": "..." }] }
```

Works with just `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` (no API key required).
Returns all 500 phone numbers on the Twilio account.

### 4. Create Voice Channel Connection (triggers Jambonz provisioning)

```
POST /api/v1/channel-connections
Auth: Bearer {JWT}
Body:
{
  "project_id": "019c603c-ff4c-7642-8a85-ca3bfea02114",
  "channel_type": "voice_pipeline",           // or "voice_realtime"
  "external_identifier": "+12792042441",       // Twilio phone number
  "display_name": "My Voice Channel",
  "config": {
    "asrVendor": "deepgram",
    "asrLanguage": "en-US",
    "ttsVendor": "elevenlabs",
    "inboundAuthToken": "your-secret-token"
  }
}
Response (201):
{
  "success": true,
  "connection": {
    "id": "019c7e5d-701d-7614-b455-ff01a6052802",
    "channelType": "voice_pipeline",
    "externalIdentifier": "+12792042441",
    "config": {
      "asrVendor": "deepgram",
      "asrLanguage": "en-US",
      "ttsVendor": "elevenlabs",
      "inboundAuthToken": "your-secret-token",
      "jambonzApplicationSid": "1c74dfc7-5f3a-4dec-90c5-f54cfd8ef572",  // ← created by provisioning
      "jambonzPhoneNumberSid": "52c00cca-abd4-4ac8-bca1-9478054b3875"   // ← created by provisioning
    },
    ...
  }
}
```

**What happens internally on CREATE:**

1. Channel connection saved to MongoDB
2. `JambonzProvisioningService.createApplication()` called → `POST /Applications` on Jambonz
3. If `JAMBONZ_VOIP_CARRIER_SID` is configured: `addPhoneNumber()` called → `POST /PhoneNumbers`
4. Both SIDs written back to `config.jambonzApplicationSid` and `config.jambonzPhoneNumberSid`
5. On failure: Jambonz application rolled back, DB record deleted, 502 returned

**Jambonz WebSocket URL generated:**

```
wss://{RUNTIME_BASE_URL_host}/ws/korevg/{connectionId}
```

### 5. Update Voice Channel Connection

```
PATCH /api/v1/channel-connections/{id}
Auth: Bearer {JWT}
Body:
{
  "display_name": "Updated Name",
  "config": {
    "asrVendor": "google",
    "asrLanguage": "en-US",
    "ttsVendor": "google",
    "jambonzApplicationSid": "1c74dfc7-..."   // must pass existing SID
  }
}
Response: { "success": true, "connection": { ... } }
```

**What happens internally on UPDATE:**

- If `config.jambonzApplicationSid` is present → `PUT /Applications/{sid}` on Jambonz to update ASR/TTS
- Non-fatal: update failure logged but does not fail the PATCH

### 6. Delete Voice Channel Connection

```
DELETE /api/v1/channel-connections/{id}
Auth: Bearer {JWT}
Response: { "success": true }
```

**What happens internally on DELETE:**

1. If `config.jambonzPhoneNumberSid` exists → `DELETE /PhoneNumbers/{sid}` on Jambonz
2. If `config.jambonzApplicationSid` exists → `DELETE /Applications/{sid}` on Jambonz
3. DB record status set to `inactive`
4. Non-fatal: Jambonz failures logged but do not fail the DELETE

---

## Jambonz REST APIs Used

Base URL: `https://korevg-dev.kore.ai/api/v1`
Auth: `Authorization: Bearer {apiKey}`

| Method   | Endpoint                                | Purpose                                                       |
| -------- | --------------------------------------- | ------------------------------------------------------------- |
| `POST`   | `/Applications`                         | Create voice application with ASR/TTS config + WebSocket hook |
| `GET`    | `/Applications/{sid}`                   | Get application details                                       |
| `PUT`    | `/Applications/{sid}`                   | Update ASR/TTS vendors on application                         |
| `DELETE` | `/Applications/{sid}`                   | Delete application                                            |
| `POST`   | `/PhoneNumbers`                         | Assign a phone number to an application via a carrier         |
| `DELETE` | `/PhoneNumbers/{sid}`                   | Unassign phone number                                         |
| `GET`    | `/Accounts/{accountSid}/Applications`   | List all applications                                         |
| `GET`    | `/Accounts/{accountSid}/VoipCarriers`   | List carriers (account-level)                                 |
| `POST`   | `/ServiceProviders/{spId}/VoipCarriers` | Create VoIP carrier (SP-level key required)                   |
| `GET`    | `/ServiceProviders/{spId}/VoipCarriers` | List all carriers under SP                                    |
| `POST`   | `/SipGateways`                          | Add SIP IP gateway to a carrier                               |
| `GET`    | `/Accounts/{accountSid}`                | Get account details                                           |
| `GET`    | `/Accounts/{accountSid}/ApiKeys`        | List account API keys                                         |

### Create Application Payload

```json
{
  "name": "My Voice Channel",
  "account_sid": "{accountSid}",
  "call_hook": { "url": "wss://{host}/ws/korevg/{connectionId}", "method": "POST" },
  "call_status_hook": { "url": "wss://{host}/ws/korevg/{connectionId}", "method": "POST" },
  "speech_recognizer_vendor": "deepgram",
  "speech_recognizer_language": "en-US",
  "speech_synthesis_vendor": "elevenlabs",
  "speech_synthesis_language": "en-US",
  "speech_synthesis_voice": "EXAVITQu4vr4xnSDxMaL",
  "use_for_fallback_speech": 0
}
```

### Assign Phone Number Payload

```json
{
  "account_sid": "{accountSid}",
  "application_sid": "{applicationSid}",
  "number": "+12792042441",
  "voip_carrier_sid": "{voipCarrierSid}"
}
```

---

## Twilio REST APIs Used

Base URL: `https://api.twilio.com/2010-04-01`
Auth: Basic auth — username: `accountSid`, password: `authToken`

| Method | Endpoint                                    | Purpose                            |
| ------ | ------------------------------------------- | ---------------------------------- |
| `GET`  | `/Accounts/{sid}/IncomingPhoneNumbers.json` | List all phone numbers (limit 500) |

```bash
curl -u "ACc518be9a6f916431ecfd8d7d9f471b2e:86a0bdcbb29352a9697cda93b9d51be2" \
  "https://api.twilio.com/2010-04-01/Accounts/ACc518be9a6f916431ecfd8d7d9f471b2e/IncomingPhoneNumbers.json"
```

---

## E2E Test Results

| #   | Test                                  | API                                       | Result                                          |
| --- | ------------------------------------- | ----------------------------------------- | ----------------------------------------------- |
| 1   | Get dev JWT token                     | `POST /api/auth/dev-login`                | ✅ Token issued, 24h expiry                     |
| 2   | Check Twilio capabilities             | `GET /api/voice/capabilities`             | ✅ `twilio: true` with full creds               |
| 3   | List Twilio phone numbers             | `GET /api/voice/twilio/phone-numbers`     | ✅ 500 numbers returned                         |
| 4   | Direct Twilio API call                | `GET /IncomingPhoneNumbers.json`          | ✅ 50 numbers (no API key needed)               |
| 5   | Create voice_pipeline connection      | `POST /api/v1/channel-connections`        | ✅ Jambonz app + phone number created           |
| 6   | Verify Jambonz application created    | `GET /Accounts/{sid}/Applications`        | ✅ App with correct ASR/TTS + WebSocket URL     |
| 7   | Verify WebSocket URL                  | Jambonz app `call_hook.url`               | ✅ `wss://localhost:3112/ws/korevg/{id}`        |
| 8   | Update voice channel (ASR/TTS change) | `PATCH /api/v1/channel-connections/{id}`  | ✅ Jambonz app updated to new vendors           |
| 9   | Delete voice channel                  | `DELETE /api/v1/channel-connections/{id}` | ✅ Jambonz app + phone number deleted           |
| 10  | Rollback on phone number failure      | `POST /api/v1/channel-connections`        | ✅ Jambonz app rolled back on failure           |
| 11  | Full E2E with real phone number       | `POST /api/v1/channel-connections`        | ✅ `+12792042441` assigned, both SIDs in config |

---

## Key Notes

### Phone Number Assignment is Conditional

Phone number assignment (step 3 of provisioning) only runs when `JAMBONZ_VOIP_CARRIER_SID`
is set in the environment. Without it, the connection is created with just the Jambonz
application SID — useful for SIP-trunk-only deployments.

### Jambonz API Key Scopes

- **Account-level key** — can create/update/delete applications and phone numbers for that account
- **Service Provider-level key** — can create VoIP carriers, manage all accounts under the SP
- Portal users (`admin`, `koresupport`) are UI logins, not API keys

### RUNTIME_BASE_URL

Must be set to the publicly reachable hostname in production so the Jambonz WebSocket
callback URL (`wss://{host}/ws/korevg/{connectionId}`) is reachable from Jambonz servers.

### Twilio Credentials Source

From `koreserver/config/configs/notificationGateWay.json` (runtime-injected):

- `accountSid` → `TWILIO_ACCOUNT_SID`
- `authToken` → `TWILIO_AUTH_TOKEN`
- `apiKeySid` → `TWILIO_API_KEY`
- `apiKeySecret` → `TWILIO_API_SECRET`
- `outgoingApplicationSid` → `TWILIO_TWIML_APP_SID`

### Files Modified

| File                                                                        | Change                                                                                                    |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `packages/config/src/schemas/voice.schema.ts`                               | Added `jambonz` block to voice config schema                                                              |
| `packages/config/src/env-mapping.ts`                                        | Added `JAMBONZ_*` env var mappings                                                                        |
| `apps/runtime/src/services/voice/jambonz-provisioning.service.ts`           | New — Jambonz REST API wrapper                                                                            |
| `apps/runtime/src/__tests__/jambonz-provisioning.service.test.ts`           | New — unit tests (4 passing)                                                                              |
| `apps/runtime/src/routes/voice.ts`                                          | Added `GET /twilio/phone-numbers` endpoint                                                                |
| `apps/runtime/src/routes/channel-connections.ts`                            | Added Jambonz provisioning hooks on POST/PATCH/DELETE                                                     |
| `apps/runtime/src/services/voice/twilio-service.ts`                         | Added `isBasicConfigured()` + `getAccountCredentials()` for phone number listing without full credentials |
| `apps/studio/src/api/voice.ts`                                              | New — `listTwilioPhoneNumbers()` API client                                                               |
| `apps/studio/src/components/deployments/channels/tabs/ConfigurationTab.tsx` | VoiceFields UI overhaul — Twilio phone dropdown, ASR/TTS vendor selectors, fallback section               |
| `apps/runtime/.env`                                                         | Added Jambonz + Twilio credentials                                                                        |
