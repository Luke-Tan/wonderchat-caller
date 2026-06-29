import pino from "pino";
import { config } from "./config.js";

/**
 * Structured JSON logger.
 *
 * Redaction is enforced at the logger level so that even if a secret is
 * accidentally passed inside a log object it will be masked. Never log the
 * raw RETELL_API_KEY, SIP password, or Authorization headers.
 */
export const logger = pino({
  level: config.logLevel,
  redact: {
    paths: [
      "req.headers.authorization",
      "headers.authorization",
      "*.authorization",
      "*.apiKey",
      "*.api_key",
      "*.password",
      "config.retell.apiKey",
      "config.sip.password",
      "RETELL_API_KEY",
      "SIP_PASSWORD",
    ],
    censor: "[REDACTED]",
  },
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  base: { service: "retell-sip-middleware", version: config.version },
});

/**
 * Returns a child logger bound to a single call lifecycle so that every line
 * for a given call shares the same internal id and SIP metadata.
 */
export function callLogger(fields: Record<string, unknown>) {
  return logger.child(fields);
}
