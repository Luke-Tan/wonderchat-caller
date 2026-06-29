import express from "express";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { logger, callLogger } from "./logger.js";
import { metrics } from "./metrics.js";
import { retellReachable } from "./retell.js";
import { handleInbound, isAuthorized, type JambonzVerb } from "./jambonz.js";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// Attach a per-request internal id used to correlate every log line for a call.
app.use((req, _res, next) => {
  (req as any).internalId = randomUUID();
  next();
});

// ── Health ───────────────────────────────────────────────────────────────────
app.get("/health", async (_req, res) => {
  const retellOk = await retellReachable().catch(() => false);
  const status = retellOk ? 200 : 503;
  res.status(status).json({
    status: retellOk ? "ok" : "degraded",
    service: "retell-sip-middleware",
    version: config.version,
    checks: {
      node: true,
      retell_api_reachable: retellOk,
    },
    timestamp: new Date().toISOString(),
  });
});

// ── Metrics ──────────────────────────────────────────────────────────────────
app.get("/metrics", (_req, res) => {
  res.setHeader("Content-Type", "text/plain; version=0.0.4");
  res.send(metrics.render());
});

// ── Jambonz inbound call hook ─────────────────────────────────────────────────
app.post("/jambonz/inbound", async (req, res) => {
  if (!isAuthorized(req)) {
    logger.warn({ ip: req.ip }, "rejected unauthorized /jambonz/inbound");
    return res.status(401).json([{ verb: "hangup" }]);
  }
  const internalId = (req as any).internalId as string;
  const log = callLogger({ call_id_internal: internalId, source_ip: req.ip });
  metrics.callStarted();

  let verbs: JambonzVerb[];
  try {
    verbs = await handleInbound(req.body ?? {}, log);
  } catch (err) {
    // Defensive: handleInbound already converts known failures to fallbacks,
    // so reaching here means an unexpected bug — never 500 a live call.
    log.error({ err_message: (err as Error).message }, "unhandled inbound error");
    verbs = [{ verb: "hangup" }];
  }
  res.json(verbs);
});

// ── Jambonz dial action (fires when the dial/bridge completes) ────────────────
app.post("/jambonz/dial-action", (req, res) => {
  const b = req.body ?? {};
  const dialStatus = b.dial_call_status; // completed | failed | busy | no-answer
  if (dialStatus === "completed") metrics.inc("sip_dial_success_total");
  else metrics.inc("sip_dial_failure_total");

  metrics.callEnded(Number(b.duration ?? 0));
  callLogger({ sip_call_id: b.call_sid }).info(
    {
      dial_status: dialStatus,
      dial_sip_status: b.dial_sip_status,
      hangup_reason: b.dial_call_status,
      duration: b.duration,
    },
    "dial completed",
  );
  // Returning an empty array lets the call end naturally.
  res.json([]);
});

// ── Jambonz REFER hook (Retell-initiated transfers) ───────────────────────────
app.post("/jambonz/refer", (req, res) => {
  const b = req.body ?? {};
  callLogger({ sip_call_id: b.call_sid }).info(
    { refer_to: b.refer_details?.refer_to ?? b.refer_to },
    "received SIP REFER from Retell",
  );
  // Default: let Jambonz handle the transfer per the Refer-To target.
  res.json({ action: "accept" });
});

// ── Jambonz call status callbacks ─────────────────────────────────────────────
app.post("/jambonz/status", (req, res) => {
  const b = req.body ?? {};
  callLogger({ sip_call_id: b.call_sid }).debug(
    { call_status: b.call_status, sip_status: b.sip_status },
    "call status update",
  );
  res.sendStatus(200);
});

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: "not_found", path: req.path });
});

const server = app.listen(config.port, () => {
  logger.info(
    {
      port: config.port,
      env: config.nodeEnv,
      retell_base: config.retell.apiBaseUrl,
      retell_sip_domain: config.retell.sipDomain,
      fallback_mode: config.fallback.mode,
    },
    "retell-sip-middleware listening",
  );
});

// Graceful shutdown so in-flight calls/log flushes complete.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    logger.info({ signal: sig }, "shutting down");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
