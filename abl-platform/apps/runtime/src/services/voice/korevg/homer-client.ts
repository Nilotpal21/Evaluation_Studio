/**
 * Homer v3 API Client for Voice Quality Metrics
 *
 * Queries Homer's API v3 at session end to retrieve:
 * - RTCP QoS data (jitter, packet loss) → compute network MOS via E-model
 * - SIP transaction details → determine disconnect initiator and SIP status
 *
 * Two different Call-IDs are used for correlation because the SBC (B2BUA)
 * generates a new Call-ID for the downstream (SBC→FS) leg:
 *
 * 1. **sipCallId** (SBC→FS Call-ID, e.g. `535ba085-91b5-...`):
 *    Used for SIP transaction queries (BYE/disconnect attribution).
 *    Homer/heplify-server captures SIP signaling on this leg.
 *    Stored as `callInfo.callId` (from sipHeaders['call-id'] || d.call_id).
 *
 * 2. **rtpCallId** (Caller→SBC original Call-ID, e.g. `Nw7NrINTNg`):
 *    Used for RTCP/QoS queries. The SBC passes this original Call-ID to
 *    rtpengine as the session identifier, and rtpengine uses it as the
 *    correlation ID in HEP RTCP packets.
 *    Stored as `callInfo.sbcCallId` (from d.sbc_callid in session:new).
 *
 * Homer API v3 endpoints used:
 *   POST /api/v3/auth                    — JWT authentication
 *   POST /api/v3/call/report/qos         — RTCP quality data
 *   POST /api/v3/call/transaction        — SIP transaction ladder
 *
 * Environment variables:
 *   HOMER_API_BASE_URL  — e.g. https://korevg-homer-local.kore.ai/api/v3
 *   HOMER_USERNAME      — Homer login username
 *   HOMER_PASSWORD      — Homer login password
 *
 * All queries are fire-and-forget with graceful fallback: if Homer is
 * unreachable or returns errors, metrics degrade to null rather than
 * blocking call teardown.
 */

import { createLogger } from '@abl/compiler/platform';

const log = createLogger('homer-client');

// =============================================================================
// TYPES
// =============================================================================

/** RTCP quality metrics extracted from Homer QoS data */
export interface RtcpQosMetrics {
  /** Inbound: caller → platform */
  inbound: DirectionalQos | null;
  /** Outbound: platform → caller */
  outbound: DirectionalQos | null;
}

/** QoS metrics for one direction of an RTP stream */
export interface DirectionalQos {
  /** Average jitter in milliseconds */
  jitterMs: number;
  /** Cumulative packets lost */
  packetsLost: number;
  /** Total packets expected */
  packetsExpected: number;
  /** Packet loss as a fraction (0.0–1.0) */
  packetLossRate: number;
  /** Source IP */
  srcIp: string;
  /** Destination IP */
  dstIp: string;
  /** Number of RTCP reports averaged */
  reportCount: number;
}

/** Network MOS computed from RTCP data via the E-model */
export interface NetworkMos {
  /** MOS score for inbound (caller → platform), scale 1.0–4.5 */
  inbound: number | null;
  /** MOS score for outbound (platform → caller), scale 1.0–4.5 */
  outbound: number | null;
  /** R-factor for inbound direction */
  inboundRFactor: number | null;
  /** R-factor for outbound direction */
  outboundRFactor: number | null;
}

/** SIP disconnect attribution from the call transaction */
export interface SipDisconnectInfo {
  /** Who initiated the disconnect: 'caller', 'platform', or 'unknown' */
  initiator: 'caller' | 'platform' | 'unknown';
  /** Final SIP status code (e.g. 200, 487, etc.) */
  statusCode: number | null;
  /** SIP method that ended the call (e.g. BYE, CANCEL) */
  method: string | null;
  /** Human-readable reason */
  reason: string | null;
}

/** Complete Homer quality data for a call */
export interface HomerCallQuality {
  /** RTCP QoS metrics */
  qos: RtcpQosMetrics | null;
  /** Network MOS computed from QoS */
  mos: NetworkMos;
  /** SIP disconnect info */
  disconnect: SipDisconnectInfo;
  /** Whether Homer data was successfully retrieved */
  homerAvailable: boolean;
  /** Error message if Homer query failed */
  homerError?: string;
}

// =============================================================================
// CONFIGURATION
// =============================================================================

interface HomerConfig {
  baseUrl: string;
  username: string;
  password: string;
}

function getMissingHomerEnvVars(): string[] {
  const envVars = [
    ['HOMER_API_BASE_URL', process.env.HOMER_API_BASE_URL],
    ['HOMER_USERNAME', process.env.HOMER_USERNAME],
    ['HOMER_PASSWORD', process.env.HOMER_PASSWORD],
  ] as const;

  return envVars.filter(([, value]) => !value).map(([name]) => name);
}

function getHomerConfig(): HomerConfig | null {
  const baseUrl = process.env.HOMER_API_BASE_URL;
  const username = process.env.HOMER_USERNAME;
  const password = process.env.HOMER_PASSWORD;

  if (!baseUrl || !username || !password) {
    return null;
  }

  return { baseUrl, username, password };
}

// =============================================================================
// TOKEN CACHE
// =============================================================================

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

/**
 * Authenticate with Homer v3 API and cache the JWT token.
 * Token is cached for 55 minutes (Homer tokens typically last 1 hour).
 */
async function getAuthToken(config: HomerConfig): Promise<string> {
  const now = Date.now();

  // Return cached token if still valid (with 5-minute buffer)
  if (cachedToken && now < tokenExpiresAt) {
    return cachedToken;
  }

  const url = `${config.baseUrl}/auth`;
  const body = JSON.stringify({ username: config.username, password: config.password });

  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  if (!response.ok) {
    throw new Error(`Homer auth failed: HTTP ${response.status}`);
  }

  const data = (await response.json()) as { token?: string; scope?: string };
  if (!data.token) {
    throw new Error('Homer auth response missing token');
  }

  cachedToken = data.token;
  // Cache for 55 minutes
  tokenExpiresAt = now + 55 * 60 * 1000;

  log.info('[AUTH] Homer JWT token obtained');
  return cachedToken;
}

// =============================================================================
// API HELPERS
// =============================================================================

/**
 * Fetch with a timeout to prevent hanging on unreachable Homer.
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = 5000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Node 18+ native fetch supports AbortController
    const resp = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the standard Homer search request body.
 * @param callId SIP Call-ID to search for
 * @param lookbackMs How far back to search (default: 24 hours)
 */
function buildSearchBody(callId: string, lookbackMs = 24 * 3600 * 1000): Record<string, unknown> {
  const now = Date.now();
  return {
    param: {
      search: {
        '1_call': {
          callid: [callId],
        },
      },
      location: {},
      transaction: {
        call: true,
        registration: false,
        rest: false,
      },
      orlogic: false,
    },
    timestamp: {
      from: now - lookbackMs,
      to: now,
    },
  };
}

/**
 * Make an authenticated POST request to Homer v3 API.
 */
async function homerPost(
  config: HomerConfig,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const token = await getAuthToken(config);
  const url = `${config.baseUrl}/${endpoint}`;

  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Homer ${endpoint}: HTTP ${response.status}`);
  }

  return response.json();
}

// =============================================================================
// QoS DATA RETRIEVAL
// =============================================================================

/**
 * Raw RTCP report entry from Homer QoS endpoint.
 * The `raw` field contains the parsed RTCP sender/receiver report.
 */
interface HomerRtcpEntry {
  srcIp: string;
  dstIp: string;
  srcPort: number;
  dstPort: number;
  raw: string | Record<string, unknown>;
  sid: string;
  create_date: string;
}

/**
 * Parsed RTCP raw data (from heplify-server HEP capture).
 * Structure varies by source but typically includes sender/receiver report fields.
 */
interface ParsedRtcpRaw {
  sender_information?: {
    ntp_timestamp_sec?: number;
    ntp_timestamp_usec?: number;
    packets?: number;
    octets?: number;
  };
  report_blocks?: Array<{
    source_ssrc?: number;
    fraction_lost?: number;
    packets_lost?: number;
    highest_seq_no?: number;
    ia_jitter?: number;
    lsr?: number;
    dlsr?: number;
  }>;
  // Short report format
  report_count?: number;
  type?: number;
  // MOS pre-computed by heplify-server (if available)
  MOS?: number;
  // Alternative field names
  ia_jitter?: number;
  fraction_lost?: number;
  packets_lost?: number;
  jitter?: number;
}

/**
 * Query Homer for RTCP QoS data for a specific call.
 */
async function fetchQosData(config: HomerConfig, callId: string): Promise<RtcpQosMetrics | null> {
  const body = buildSearchBody(callId);

  const result = (await homerPost(config, 'call/report/qos', body)) as {
    rtcp?: { data?: HomerRtcpEntry[]; total?: number };
    rtp?: { data?: HomerRtcpEntry[]; total?: number };
  };

  const rtcpData = result.rtcp?.data || [];

  if (rtcpData.length === 0) {
    log.info(`[QOS] No RTCP data found for callId=${callId}`);
    return null;
  }

  log.info(`[QOS] Found ${rtcpData.length} RTCP reports for callId=${callId}`);

  // Group RTCP reports by direction.
  // rtpengine HEP packets may have empty srcIp/dstIp, so we also group by SSRC.
  // RTCP Sender Reports (type=200) contain the sender's SSRC and receiver report blocks.
  // We group by SSRC to separate the two media streams (caller→platform, platform→caller).
  const ssrcGroups = new Map<number, { reports: ParsedRtcpRaw[]; srcIp: string; dstIp: string }>();
  const directionGroups = new Map<
    string,
    { reports: ParsedRtcpRaw[]; srcIp: string; dstIp: string }
  >();
  let usesSsrcGrouping = false;

  for (const entry of rtcpData) {
    const raw = typeof entry.raw === 'string' ? safeJsonParse(entry.raw) : entry.raw;
    if (!raw) continue;
    const parsed = raw as ParsedRtcpRaw;

    // Check if srcIp/dstIp are available
    if (entry.srcIp && entry.dstIp) {
      const key = `${entry.srcIp}->${entry.dstIp}`;
      if (!directionGroups.has(key)) {
        directionGroups.set(key, { reports: [], srcIp: entry.srcIp, dstIp: entry.dstIp });
      }
      directionGroups.get(key)!.reports.push(parsed);
    } else {
      // rtpengine HEP: group by SSRC (each media stream has a unique SSRC)
      usesSsrcGrouping = true;
      const ssrc = (parsed as Record<string, unknown>).ssrc as number;
      if (ssrc !== undefined) {
        if (!ssrcGroups.has(ssrc)) {
          ssrcGroups.set(ssrc, {
            reports: [],
            srcIp: entry.srcIp || 'unknown',
            dstIp: entry.dstIp || 'unknown',
          });
        }
        ssrcGroups.get(ssrc)!.reports.push(parsed);
      }
    }
  }

  // Pick the right grouping strategy
  const groups = usesSsrcGrouping
    ? Array.from(ssrcGroups.values()).sort((a, b) => b.reports.length - a.reports.length)
    : Array.from(directionGroups.values()).sort((a, b) => b.reports.length - a.reports.length);

  const inbound = groups.length > 0 ? aggregateRtcpReports(groups[0]) : null;
  const outbound = groups.length > 1 ? aggregateRtcpReports(groups[1]) : null;

  return { inbound, outbound };
}

/**
 * Aggregate multiple RTCP reports into a single directional QoS metric.
 */
function aggregateRtcpReports(group: {
  reports: ParsedRtcpRaw[];
  srcIp: string;
  dstIp: string;
}): DirectionalQos {
  let totalJitter = 0;
  let totalLost = 0;
  let totalExpected = 0;
  let jitterCount = 0;

  for (const report of group.reports) {
    // Try report_blocks first (standard RTCP receiver report)
    if (report.report_blocks && report.report_blocks.length > 0) {
      for (const block of report.report_blocks) {
        if (block.ia_jitter !== undefined) {
          totalJitter += block.ia_jitter;
          jitterCount++;
        }
        if (block.packets_lost !== undefined) {
          totalLost += Math.abs(block.packets_lost);
        }
        if (block.highest_seq_no !== undefined) {
          totalExpected = Math.max(totalExpected, block.highest_seq_no);
        }
      }
    }

    // Try top-level fields (alternative format)
    if (report.ia_jitter !== undefined || report.jitter !== undefined) {
      totalJitter += report.ia_jitter ?? report.jitter ?? 0;
      jitterCount++;
    }
    if (report.packets_lost !== undefined) {
      totalLost += Math.abs(report.packets_lost);
    }
  }

  // Convert jitter from timestamp units to ms
  // Standard RTCP jitter is in timestamp units (8000 Hz for G.711 = 1/8 ms)
  const avgJitterTimestampUnits = jitterCount > 0 ? totalJitter / jitterCount : 0;
  const avgJitterMs = avgJitterTimestampUnits / 8; // Convert from 8kHz timestamp units to ms

  const packetLossRate = totalExpected > 0 ? Math.min(1, totalLost / totalExpected) : 0;

  return {
    jitterMs: Math.round(avgJitterMs * 100) / 100,
    packetsLost: totalLost,
    packetsExpected: totalExpected,
    packetLossRate: Math.round(packetLossRate * 10000) / 10000,
    srcIp: group.srcIp,
    dstIp: group.dstIp,
    reportCount: group.reports.length,
  };
}

// =============================================================================
// SIP TRANSACTION / DISCONNECT ATTRIBUTION
// =============================================================================

interface HomerCallMessage {
  method?: string;
  method_text?: string;
  srcIp?: string;
  dstIp?: string;
  srcHost?: string;
  dstHost?: string;
  create_date?: number;
  micro_ts?: number;
  ruri_user?: string;
  sid?: string;
}

interface HomerTransactionResponse {
  data?: {
    calldata?: HomerCallMessage[];
    messages?: HomerCallMessage[];
    hosts?: Record<string, unknown>;
  };
  total?: number;
}

/**
 * Query Homer for the SIP transaction ladder to determine disconnect info.
 *
 * Disconnect attribution is automatic: on the SBC→FS leg captured by Homer,
 * the INVITE source IP is the SBC (upstream/caller proxy). If the BYE also
 * originates from the same IP as the INVITE, the caller hung up. If the BYE
 * comes from the FS (the INVITE destination), the platform initiated teardown.
 */
async function fetchDisconnectInfo(
  config: HomerConfig,
  callId: string,
): Promise<SipDisconnectInfo> {
  const defaultInfo: SipDisconnectInfo = {
    initiator: 'unknown',
    statusCode: null,
    method: null,
    reason: null,
  };

  try {
    const body = buildSearchBody(callId);
    const result = (await homerPost(config, 'call/transaction', body)) as HomerTransactionResponse;

    const messages = result.data?.calldata || result.data?.messages || [];

    if (messages.length === 0) {
      log.info(`[DISCONNECT] No SIP messages found for callId=${callId}`);
      return defaultInfo;
    }

    // Sort by timestamp (chronological order)
    const sorted = [...messages].sort(
      (a, b) => (a.micro_ts || a.create_date || 0) - (b.micro_ts || b.create_date || 0),
    );

    // Find the INVITE to determine the upstream (SBC/caller) IP
    const inviteMsg = sorted.find((m) => m.method === 'INVITE' || m.method_text === 'INVITE');

    // The INVITE source is the SBC (upstream/caller proxy)
    const upstreamIp = inviteMsg?.srcIp || inviteMsg?.srcHost || '';

    // Find the BYE or CANCEL message (search from the end)
    const disconnectMsg = [...sorted]
      .reverse()
      .find(
        (m) =>
          m.method === 'BYE' ||
          m.method === 'CANCEL' ||
          m.method_text === 'BYE' ||
          m.method_text === 'CANCEL',
      );

    if (!disconnectMsg) {
      log.info(`[DISCONNECT] No BYE/CANCEL found for callId=${callId}`);
      return defaultInfo;
    }

    // Determine initiator: if BYE srcIp == INVITE srcIp → caller (SBC relayed hangup)
    const byeSrcIp = disconnectMsg.srcIp || disconnectMsg.srcHost || '';
    const isCaller = upstreamIp && byeSrcIp === upstreamIp;

    log.info(
      `[DISCONNECT] BYE from ${byeSrcIp}, INVITE from ${upstreamIp} → ${isCaller ? 'caller' : 'platform'}`,
    );

    // Find the response to the BYE/CANCEL for status code
    const disconnectMethod = disconnectMsg.method || disconnectMsg.method_text || '';
    const responseMsg = sorted.find(
      (m) =>
        (m.method_text || '').match(/^\d{3}/) &&
        (m.micro_ts || m.create_date || 0) >=
          (disconnectMsg.micro_ts || disconnectMsg.create_date || 0),
    );

    const statusCode = responseMsg
      ? parseInt(
          (responseMsg.method_text || responseMsg.method || '').match(/^(\d{3})/)?.[1] || '0',
          10,
        )
      : null;

    return {
      initiator: isCaller ? 'caller' : 'platform',
      statusCode: statusCode || null,
      method: disconnectMethod,
      reason: statusCode ? `${disconnectMethod} → ${statusCode}` : disconnectMethod,
    };
  } catch (err) {
    log.warn(
      `[DISCONNECT] Failed to fetch transaction: ${err instanceof Error ? err.message : err}`,
    );
    return defaultInfo;
  }
}

// =============================================================================
// E-MODEL MOS CALCULATION (ITU-T G.107)
// =============================================================================

/**
 * Compute network MOS score from RTCP jitter and packet loss using the
 * simplified E-model (ITU-T G.107).
 *
 * R = 93.2 - Id - Ie
 * Where:
 *   Id = 0.024 * delay + 0.11 * (delay - 177.3) * H(delay - 177.3)
 *   Ie = effective equipment impairment (function of codec + packet loss)
 *
 * For simplicity, we use the voice-optimized version:
 *   R = 93.2 - jitter_factor - loss_factor
 *   jitter_factor = jitterMs * 0.5 (approximation)
 *   loss_factor = packetLossPercent * 2.5 (approximation for G.711)
 *
 * MOS = 1 + 0.035R + R(R-60)(100-R) × 7×10⁻⁶
 * Clamped to [1.0, 4.5]
 */
export function computeEModelMos(jitterMs: number, packetLossRate: number): number {
  // Packet loss as percentage (0–100)
  const packetLossPercent = packetLossRate * 100;

  // Effective latency factor from jitter
  // Jitter adds to effective delay; typical de-jitter buffer adds ~2x jitter
  const effectiveDelay = jitterMs * 2;

  // Delay impairment factor (Id)
  // Simplified: accounts for one-way delay impact on conversational quality
  let Id = 0.024 * effectiveDelay;
  if (effectiveDelay > 177.3) {
    Id += 0.11 * (effectiveDelay - 177.3);
  }

  // Equipment impairment factor (Ie-eff)
  // For G.711 codec: Ie = 0, Bpl = 25.1 (packet loss robustness factor)
  // Ie_eff = Ie + (95 - Ie) * Ppl / (Ppl + Bpl)
  // With Ie=0 for G.711: Ie_eff = 95 * Ppl / (Ppl + 25.1)
  const Ie_eff = (95 * packetLossPercent) / (packetLossPercent + 25.1);

  // R-factor
  const R = Math.max(0, 93.2 - Id - Ie_eff);

  // Convert R-factor to MOS using the standard formula
  let mos: number;
  if (R <= 0) {
    mos = 1.0;
  } else if (R >= 100) {
    mos = 4.5;
  } else {
    mos = 1 + 0.035 * R + R * (R - 60) * (100 - R) * 7e-6;
  }

  // Clamp to valid MOS range
  return Math.round(Math.max(1.0, Math.min(4.5, mos)) * 100) / 100;
}

/**
 * Compute network MOS for both directions from RTCP metrics.
 */
export function computeNetworkMos(qos: RtcpQosMetrics | null): NetworkMos {
  if (!qos) {
    return { inbound: null, outbound: null, inboundRFactor: null, outboundRFactor: null };
  }

  const inboundMos = qos.inbound
    ? computeEModelMos(qos.inbound.jitterMs, qos.inbound.packetLossRate)
    : null;

  const outboundMos = qos.outbound
    ? computeEModelMos(qos.outbound.jitterMs, qos.outbound.packetLossRate)
    : null;

  // Compute R-factors for logging/analysis
  const computeR = (jitterMs: number, packetLossRate: number): number => {
    const effectiveDelay = jitterMs * 2;
    let Id = 0.024 * effectiveDelay;
    if (effectiveDelay > 177.3) Id += 0.11 * (effectiveDelay - 177.3);
    const Ie_eff = (95 * (packetLossRate * 100)) / (packetLossRate * 100 + 25.1);
    return Math.max(0, Math.round((93.2 - Id - Ie_eff) * 100) / 100);
  };

  return {
    inbound: inboundMos,
    outbound: outboundMos,
    inboundRFactor: qos.inbound ? computeR(qos.inbound.jitterMs, qos.inbound.packetLossRate) : null,
    outboundRFactor: qos.outbound
      ? computeR(qos.outbound.jitterMs, qos.outbound.packetLossRate)
      : null,
  };
}

// =============================================================================
// MAIN PUBLIC API
// =============================================================================

/**
 * Fetch complete call quality data from Homer for a voice call.
 *
 * This is the main entry point called from `korevg-session.handleClose()`.
 * It performs all Homer queries in parallel and returns a unified result.
 *
 * Two separate Call-IDs are used because the SBC (B2BUA) re-writes Call-IDs:
 *
 * - **sipCallId** (SBC→FS leg): Used for SIP transaction queries (disconnect).
 *   Homer captures SIP signaling on this leg via heplify-server.
 *
 * - **rtpCallId** (Caller→SBC leg): Used for RTCP/QoS queries.
 *   The SBC passes this original Call-ID to rtpengine, which uses it as the
 *   HEP correlation ID for RTCP packets sent to Homer.
 *
 * Graceful fallback: if Homer is not configured, unreachable, or returns
 * errors, all metrics degrade to null and `homerAvailable: false`.
 *
 * @param sipCallId The SBC→FS SIP Call-ID (from callInfo.callId)
 * @param rtpCallId The original Caller→SBC Call-ID (from callInfo.sbcCallId) — used for RTCP
 * @returns Complete quality data or graceful fallback
 */
export async function getCallQuality(
  sipCallId: string,
  rtpCallId?: string,
): Promise<HomerCallQuality> {
  const config = getHomerConfig();

  if (!config) {
    const missingEnvVars = getMissingHomerEnvVars();
    log.info(`[HOMER] Not configured, missing env vars: ${missingEnvVars.join(', ')}`, {
      missingEnvVars,
    });
    return {
      qos: null,
      mos: { inbound: null, outbound: null, inboundRFactor: null, outboundRFactor: null },
      disconnect: { initiator: 'unknown', statusCode: null, method: null, reason: null },
      homerAvailable: false,
    };
  }

  if (!sipCallId) {
    log.warn('[HOMER] No SIP Call-ID provided, skipping quality metrics');
    return {
      qos: null,
      mos: { inbound: null, outbound: null, inboundRFactor: null, outboundRFactor: null },
      disconnect: { initiator: 'unknown', statusCode: null, method: null, reason: null },
      homerAvailable: false,
      homerError: 'No SIP Call-ID',
    };
  }

  // For RTCP queries, try both Call-IDs to find which one rtpengine is using.
  // In theory rtpCallId (sbc_callid) should be the rtpengine session tag,
  // but in practice rtpengine might be using the SIP Call-ID instead.
  const qosCallId = rtpCallId || sipCallId;

  try {
    log.info(`[HOMER] Fetching quality data: sipCallId=${sipCallId}, rtpCallId=${qosCallId}`);

    // Try primary QoS query with rtpCallId/sipCallId
    let qos = await fetchQosData(config, qosCallId).catch((err) => {
      log.warn(
        `[HOMER] QoS query with primary ID failed: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    });

    // If no QoS data found and we have both IDs, try the alternate ID
    if (!qos && rtpCallId && sipCallId !== rtpCallId) {
      log.info(`[HOMER] No QoS with rtpCallId, trying sipCallId=${sipCallId}`);
      qos = await fetchQosData(config, sipCallId).catch((err) => {
        log.warn(
          `[HOMER] QoS query with sipCallId failed: ${err instanceof Error ? err.message : err}`,
        );
        return null;
      });
    }

    // Run disconnect query in parallel with final QoS result
    const disconnect = await fetchDisconnectInfo(config, sipCallId).catch((err) => {
      log.warn(`[HOMER] Disconnect query failed: ${err instanceof Error ? err.message : err}`);
      return {
        initiator: 'unknown' as const,
        statusCode: null,
        method: null,
        reason: null,
      };
    });

    // Remove the Promise.all since we're now doing sequential QoS queries
    const [_qos, _disconnect] = await Promise.all([
      Promise.resolve(qos),
      fetchDisconnectInfo(config, sipCallId).catch((err) => {
        log.warn(`[HOMER] Disconnect query failed: ${err instanceof Error ? err.message : err}`);
        return {
          initiator: 'unknown' as const,
          statusCode: null,
          method: null,
          reason: null,
        };
      }),
    ]);

    // Compute MOS from QoS data
    const mos = computeNetworkMos(qos);

    log.info('[HOMER] Quality data retrieved', {
      sipCallId,
      rtpCallId: qosCallId,
      hasQos: !!qos,
      inboundMos: mos.inbound,
      outboundMos: mos.outbound,
      disconnectInitiator: disconnect.initiator,
    });

    return {
      qos,
      mos,
      disconnect,
      homerAvailable: true,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.warn(`[HOMER] Failed to fetch quality data: ${errMsg}`);

    return {
      qos: null,
      mos: { inbound: null, outbound: null, inboundRFactor: null, outboundRFactor: null },
      disconnect: { initiator: 'unknown', statusCode: null, method: null, reason: null },
      homerAvailable: false,
      homerError: errMsg,
    };
  }
}

// =============================================================================
// UTILITY
// =============================================================================

/**
 * Safely parse a JSON string, returning null on failure.
 */
function safeJsonParse(str: string): Record<string, unknown> | null {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

/**
 * Check if Homer is configured and reachable.
 * Useful for health checks or conditional feature flags.
 */
export async function isHomerAvailable(): Promise<boolean> {
  const config = getHomerConfig();
  if (!config) return false;

  try {
    await getAuthToken(config);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reset the cached auth token (e.g. for testing or after password rotation).
 */
export function resetHomerAuth(): void {
  cachedToken = null;
  tokenExpiresAt = 0;
}

/**
 * Record session start time — call this at the beginning of a session
 * to later calculate the lookback window more precisely.
 */
export function recordSessionStart(): number {
  return Date.now();
}
