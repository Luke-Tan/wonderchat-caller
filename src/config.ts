import "dotenv/config";

/**
 * Centralised, validated configuration loaded from environment variables.
 *
 * Anything secret (API keys, SIP passwords) lives here but must never be
 * logged directly — see logger.ts redaction rules.
 */

function req(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function opt(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

export type FallbackMode = "hangup" | "play_message" | "forward_to_backup_number";

export const config = {
  nodeEnv: opt("NODE_ENV", "development"),
  port: parseInt(opt("PORT", "3000"), 10),
  logLevel: opt("LOG_LEVEL", "info"),
  version: opt("APP_VERSION", opt("GIT_COMMIT", "dev")),
  publicBaseUrl: opt("PUBLIC_BASE_URL"),

  retell: {
    apiKey: req("RETELL_API_KEY"),
    agentId: req("RETELL_AGENT_ID"),
    apiBaseUrl: opt("RETELL_API_BASE_URL", "https://api.retellai.com"),
    // Host portion of the dynamic SIP URI returned/constructed for a registered call.
    sipDomain: opt("RETELL_SIP_DOMAIN", "sip.retellai.com"),
    // Seconds we consider a freshly-registered Retell SIP URI valid for dialing.
    sipUriTtlSeconds: parseInt(opt("RETELL_SIP_URI_TTL_SECONDS", "60"), 10),
  },

  sip: {
    providerName: opt("SIP_PROVIDER_NAME", "URL_NETWORKS"),
    username: opt("SIP_USERNAME"),
    password: opt("SIP_PASSWORD"),
    registrar: opt("SIP_REGISTRAR"),
    proxy: opt("SIP_PROXY"),
    realm: opt("SIP_REALM"),
    transport: opt("SIP_TRANSPORT", "udp"),
  },

  network: {
    publicIp: opt("PUBLIC_IP"),
    sipPort: parseInt(opt("SIP_PORT", "5060"), 10),
    rtpPortStart: parseInt(opt("RTP_PORT_START", "40000"), 10),
    rtpPortEnd: parseInt(opt("RTP_PORT_END", "60000"), 10),
  },

  fallback: {
    mode: opt("ERROR_FALLBACK_MODE", "hangup") as FallbackMode,
    backupNumber: opt("BACKUP_NUMBER"),
    message: opt(
      "ERROR_FALLBACK_MESSAGE",
      "Sorry, we are unable to connect your call right now. Please try again later.",
    ),
  },

  // Optional shared secret used to authenticate Jambonz -> middleware webhooks.
  webhookSecret: opt("JAMBONZ_WEBHOOK_SECRET"),
} as const;

export type AppConfig = typeof config;
