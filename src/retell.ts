import { config } from "./config.js";
import { logger } from "./logger.js";

/**
 * Retell API client.
 *
 * Flow (verified against docs.retellai.com, June 2026):
 *   POST {base}/v2/register-phone-call
 *     headers: Authorization: Bearer <RETELL_API_KEY>
 *     body:    { agent_id, direction, from_number?, to_number?, metadata?,
 *                retell_llm_dynamic_variables? }
 *   -> 201 { call_id, call_status: "registered", ... }
 *
 * The response does NOT contain a ready-made SIP URI. We construct it as:
 *   sip:{call_id}@sip.retellai.com
 *
 * The call MUST be dialed to that URI within 5 MINUTES of registration or
 * Retell drops it with `registered_call_timeout`.
 *
 * Docs:
 *   https://docs.retellai.com/api-references/register-phone-call
 *   https://docs.retellai.com/deploy/custom-telephony
 */

export type RegisterRetellCallInput = {
  fromNumber: string;
  toNumber: string;
  direction: "inbound";
  metadata?: Record<string, unknown>;
  /** Injected into the Response Engine prompt/tool descriptions. */
  dynamicVariables?: Record<string, string>;
};

export type RegisterRetellCallOutput = {
  callId: string;
  sipUri: string;
  /** Epoch ms after which the SIP URI is considered expired (best effort). */
  expiresAt: number;
  /** Raw response for logging/debugging. */
  raw: unknown;
};

export class RetellError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "RetellError";
  }
}

/** Build the dynamic SIP URI dialed for a registered call. */
export function buildRetellSipUri(callId: string): string {
  if (!callId || typeof callId !== "string") {
    throw new RetellError(`Cannot build SIP URI from invalid call_id: ${callId}`);
  }
  return `sip:${callId}@${config.retell.sipDomain}`;
}

/**
 * Register an inbound call with Retell and return the dynamic SIP URI to dial.
 * Throws RetellError on network failure, non-2xx, or malformed responses so the
 * caller can apply the configured fallback behaviour.
 */
export async function registerRetellCall(
  input: RegisterRetellCallInput,
  opts: { timeoutMs?: number } = {},
): Promise<RegisterRetellCallOutput> {
  const url = `${config.retell.apiBaseUrl.replace(/\/$/, "")}/v2/register-phone-call`;
  const body = {
    agent_id: config.retell.agentId,
    direction: input.direction,
    from_number: input.fromNumber || undefined,
    to_number: input.toNumber || undefined,
    metadata: input.metadata,
    retell_llm_dynamic_variables: input.dynamicVariables,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.retell.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    // (1) Retell API unavailable / network error / timeout.
    throw new RetellError(
      `Retell API request failed: ${(err as Error).message}`,
    );
  } finally {
    clearTimeout(timeout);
  }

  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    // (3) Malformed (non-JSON) response.
    throw new RetellError("Retell returned non-JSON response", res.status, text);
  }

  if (!res.ok) {
    // (2) Non-2xx response.
    throw new RetellError(
      `Retell register-phone-call returned ${res.status}`,
      res.status,
      json,
    );
  }

  const callId: string | undefined = json?.call_id;
  if (!callId) {
    // (3) Missing call_id => malformed for our purposes.
    throw new RetellError("Retell response missing call_id", res.status, json);
  }

  const out: RegisterRetellCallOutput = {
    callId,
    sipUri: buildRetellSipUri(callId),
    expiresAt: Date.now() + config.retell.sipUriTtlSeconds * 1000,
    raw: json,
  };

  logger.info(
    { retell_call_id: callId, retell_sip_uri: out.sipUri },
    "registered Retell call",
  );
  return out;
}

/** Lightweight reachability probe for /health (does not register a call). */
export async function retellReachable(timeoutMs = 3000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Hitting the API host with auth; any HTTP response (even 4xx) means reachable.
    const res = await fetch(`${config.retell.apiBaseUrl.replace(/\/$/, "")}/v2/list-agents`, {
      method: "GET",
      headers: { Authorization: `Bearer ${config.retell.apiKey}` },
      signal: controller.signal,
    });
    return res.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
