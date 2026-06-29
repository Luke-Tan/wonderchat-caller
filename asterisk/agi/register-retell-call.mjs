#!/usr/bin/env node
/**
 * Asterisk AGI script: register an inbound call with Retell and hand the
 * dynamic SIP URI back to the dialplan.
 *
 * Invoked from extensions.conf:
 *   AGI(register-retell-call.mjs,${CALLER_NUM},${DID},${UNIQUEID})
 *
 * Sets dialplan variables via AGI:
 *   RETELL_CALL_ID   - the Retell call_id
 *   RETELL_SIP_URI   - sip:{call_id}@{RETELL_SIP_DOMAIN}
 *   RETELL_ERROR     - non-empty on any failure (dialplan branches to fallback)
 *
 * Pure Node (>=18), no deps: AGI speaks a simple line protocol over stdin/stdout.
 * Reads RETELL_* from the Asterisk process environment.
 */

const RETELL_API_KEY = process.env.RETELL_API_KEY;
const RETELL_AGENT_ID = process.env.RETELL_AGENT_ID;
const RETELL_API_BASE_URL = (process.env.RETELL_API_BASE_URL || "https://api.retellai.com").replace(/\/$/, "");
const RETELL_SIP_DOMAIN = process.env.RETELL_SIP_DOMAIN || "sip.retellai.com";

function agiLog(msg) {
  // Goes to the Asterisk CLI / full log.
  process.stdout.write(`VERBOSE "${String(msg).replace(/"/g, "'")}" 1\n`);
}

// Send one AGI command and await its numeric result line.
function agi(cmd) {
  return new Promise((resolve) => {
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        process.stdin.off("data", onData);
        resolve(buf.slice(0, nl));
      }
    };
    process.stdin.on("data", onData);
    process.stdout.write(cmd.endsWith("\n") ? cmd : cmd + "\n");
  });
}

function setVar(name, value) {
  // Escape quotes/newlines so the value survives the AGI line protocol.
  const safe = String(value).replace(/\n/g, " ").replace(/"/g, "'");
  return agi(`SET VARIABLE ${name} "${safe}"`);
}

async function readAgiEnv() {
  // Asterisk sends "agi_*: value" lines terminated by a blank line.
  return new Promise((resolve) => {
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString();
      if (buf.includes("\n\n")) {
        process.stdin.off("data", onData);
        const env = {};
        for (const line of buf.split("\n")) {
          const m = line.match(/^agi_(\w+):\s*(.*)$/);
          if (m) env[m[1]] = m[2];
        }
        resolve(env);
      }
    };
    process.stdin.on("data", onData);
  });
}

async function registerRetell(fromNumber, toNumber, uniqueId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${RETELL_API_BASE_URL}/v2/register-phone-call`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${RETELL_API_KEY}`,
      },
      body: JSON.stringify({
        agent_id: RETELL_AGENT_ID,
        direction: "inbound",
        from_number: fromNumber || undefined,
        to_number: toNumber || undefined,
        metadata: { asterisk_unique_id: uniqueId },
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Retell ${res.status}: ${text.slice(0, 200)}`);
    const json = JSON.parse(text);
    if (!json.call_id) throw new Error("missing call_id in Retell response");
    return json.call_id;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  process.stdin.setEncoding("utf8");
  await readAgiEnv();

  // AGI args land in process.argv after the script path.
  const [fromNumber = "", toNumber = "", uniqueId = ""] = process.argv.slice(2);

  if (!RETELL_API_KEY || !RETELL_AGENT_ID) {
    agiLog("RETELL_API_KEY / RETELL_AGENT_ID not set in environment");
    await setVar("RETELL_ERROR", "config_missing");
    process.exit(0);
  }

  try {
    const callId = await registerRetell(fromNumber, toNumber, uniqueId);
    const sipUri = `sip:${callId}@${RETELL_SIP_DOMAIN}`;
    agiLog(`Retell registered call_id=${callId} -> ${sipUri}`);
    await setVar("RETELL_CALL_ID", callId);
    await setVar("RETELL_SIP_URI", sipUri);
    await setVar("RETELL_ERROR", "");
  } catch (err) {
    agiLog(`Retell registration failed: ${err.message}`);
    await setVar("RETELL_ERROR", "register_failed");
  }
  process.exit(0);
}

main().catch((e) => {
  agiLog(`AGI fatal: ${e.message}`);
  process.exit(0);
});
