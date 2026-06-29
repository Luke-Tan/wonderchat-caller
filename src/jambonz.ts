import type { Request } from "express";
import { config } from "./config.js";
import { registerRetellCall } from "./retell.js";
import { metrics } from "./metrics.js";
import type { Logger } from "pino";

/**
 * Jambonz call-control glue.
 *
 * Jambonz POSTs a JSON body describing the inbound call and expects back an
 * ARRAY of "verb" objects executed in order. Verified shapes:
 *   - inbound payload: { call_sid, account_sid, application_sid, direction,
 *       from, to, caller_name, call_status, sip_status, sip: { headers } }
 *   - dial verb: { verb:"dial", target:[{type:"sip", sipUri}], callerId,
 *       answerOnBridge, headers, anchorMedia, referHook, actionHook }
 *   - say + hangup for spoken fallback.
 * Docs: https://docs.jambonz.org/verbs/verbs/dial , /verbs/verbs/overview
 */

export type JambonzInboundPayload = {
  call_sid?: string;
  account_sid?: string;
  application_sid?: string;
  direction?: string;
  from?: string;
  to?: string;
  caller_name?: string;
  call_status?: string;
  sip_status?: number;
  sip?: { headers?: Record<string, string>; payload?: string };
};

export type JambonzVerb = Record<string, unknown>;

/** Normalised view of the inbound call used across the handler + logs. */
export type ParsedInbound = {
  callSid: string;
  from: string;
  to: string;
  callerName?: string;
  sipHeaders: Record<string, string>;
};

export function parseInbound(body: JambonzInboundPayload): ParsedInbound {
  return {
    callSid: body.call_sid ?? "",
    from: body.from ?? "",
    to: body.to ?? "",
    callerName: body.caller_name,
    sipHeaders: body.sip?.headers ?? {},
  };
}

/** A `dial` verb that bridges the caller to the dynamic Retell SIP URI. */
export function buildDialVerb(args: {
  sipUri: string;
  callerId: string;
  retellCallId: string;
}): JambonzVerb {
  return {
    verb: "dial",
    callerId: args.callerId,
    // Ring the inbound leg; only send 200 OK once Retell answers (true bridge).
    answerOnBridge: true,
    // Anchor media on the feature server so RTP/NAT is predictable and we can
    // hang up both legs cleanly.
    anchorMedia: true,
    // Handle SIP REFER (Retell-initiated transfers) and end-of-dial status.
    referHook: "/jambonz/refer",
    actionHook: "/jambonz/dial-action",
    timeout: 30,
    headers: {
      // Round-trips the Retell call id for cross-correlation in logs/captures.
      "X-Retell-Call-Id": args.retellCallId,
    },
    target: [
      {
        type: "sip",
        sipUri: args.sipUri,
      },
    ],
  };
}

/** Spoken fallback then hangup, used when Retell registration/dial fails. */
export function buildFallbackVerbs(): JambonzVerb[] {
  switch (config.fallback.mode) {
    case "play_message":
      return [
        {
          verb: "say",
          text: config.fallback.message,
          synthesizer: { vendor: "google", language: "en-US" },
        },
        { verb: "hangup" },
      ];
    case "forward_to_backup_number":
      if (config.fallback.backupNumber) {
        return [
          {
            verb: "dial",
            answerOnBridge: true,
            target: [{ type: "phone", number: config.fallback.backupNumber }],
          },
        ];
      }
      // No backup configured -> fall through to a clean hangup.
      return [{ verb: "hangup" }];
    case "hangup":
    default:
      return [{ verb: "hangup" }];
  }
}

/**
 * Core inbound handler: register the call with Retell, then return the verb
 * array that bridges the caller. Any failure yields the configured fallback.
 */
export async function handleInbound(
  body: JambonzInboundPayload,
  log: Logger,
): Promise<JambonzVerb[]> {
  metrics.inc("inbound_calls_total");
  const call = parseInbound(body);

  log.info(
    {
      sip_call_id: call.callSid,
      caller_number: call.from,
      called_number: call.to,
    },
    "inbound call received",
  );

  try {
    const retell = await registerRetellCall({
      fromNumber: call.from,
      toNumber: call.to,
      direction: "inbound",
      metadata: {
        jambonz_call_sid: call.callSid,
        source: config.sip.providerName,
      },
    });
    metrics.inc("retell_registration_success_total");

    const dial = buildDialVerb({
      sipUri: retell.sipUri,
      callerId: call.from,
      retellCallId: retell.callId,
    });

    log.info(
      {
        sip_call_id: call.callSid,
        retell_call_id: retell.callId,
        retell_sip_uri: retell.sipUri,
        registration_status: "success",
      },
      "bridging caller to Retell",
    );
    return [dial];
  } catch (err) {
    metrics.inc("retell_registration_failure_total");
    log.error(
      {
        sip_call_id: call.callSid,
        registration_status: "failed",
        err_message: (err as Error).message,
        fallback_mode: config.fallback.mode,
      },
      "Retell registration failed — applying fallback",
    );
    return buildFallbackVerbs();
  }
}

/**
 * Optional webhook auth. Supports HTTP Basic auth (password = shared secret) as
 * the simplest cross-platform option. If JAMBONZ_WEBHOOK_SECRET is unset, auth
 * is disabled (fine when the port is firewalled to Jambonz only).
 */
export function isAuthorized(req: Request): boolean {
  if (!config.webhookSecret) return true;
  const header = req.headers.authorization ?? "";
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const pass = decoded.split(":")[1] ?? "";
    return pass === config.webhookSecret;
  }
  if (header.startsWith("Bearer ")) {
    return header.slice(7) === config.webhookSecret;
  }
  return false;
}
