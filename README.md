# retell-sip-middleware

Middleware that lets an existing **URL Networks** DID be answered by a **Retell
AI** voice agent — **without porting the number**. It receives the inbound SIP
call via a SIP/media layer (Jambonz preferred, Asterisk alternative), registers
the call with Retell, and bridges the caller to the dynamic Retell SIP URI.

```
Caller → URL Networks DID → SIP/media layer (Jambonz/Asterisk)
       → this Node/TS service → Retell /v2/register-phone-call
       → dial sip:{call_id}@sip.retellai.com → Retell AI ↔ two-way audio
```

## ⭐ Read this first — you may not need this middleware

Current Retell docs expose a **static** SIP host. If URL Networks can forward the
trunk to `sip:sip.retellai.com` with your DID as the called number (E.164 in the
To header), you can **import the DID in Retell, bind an agent, and skip all
custom code**. That's the simplest, most reliable path.

Use **this middleware** when you need any of:
- per-call agent selection / per-call dynamic variables / metadata at call time,
- URL Networks can't do clean elastic SIP trunking and you must dial a specific
  URI per call,
- you want full control + structured logs over every call's lifecycle.

A lighter middle ground also exists: keep the static trunk **and** add Retell's
**inbound-call webhook** to pick the agent / inject variables — see
[docs/SETUP.md](docs/SETUP.md#option-b-static-trunk--inbound-webhook).

This repo implements the **full per-call register-and-bridge** flow because the
handoff brief requires it, and documents the simpler options alongside.

## What's in here

| Path | What |
|---|---|
| `src/index.ts` | Express app: `/jambonz/inbound`, `/jambonz/dial-action`, `/jambonz/refer`, `/jambonz/status`, `/health`, `/metrics`. |
| `src/retell.ts` | Retell client — `registerRetellCall()`, `buildRetellSipUri()`. |
| `src/jambonz.ts` | Inbound parsing, `dial` verb builder, fallback verbs, webhook auth. |
| `src/config.ts` / `src/logger.ts` / `src/metrics.ts` | Env config, redacting JSON logger, Prometheus metrics. |
| `jambonz/README.md` | Wire Jambonz → URL Networks → this service (preferred). |
| `asterisk/` | Full alternative: `pjsip.conf`, `extensions.conf`, AGI, compose. |
| `docs/SETUP.md` | End-to-end VPS deployment + provider config + test plan. |
| `docs/TROUBLESHOOTING.md` | SIP/RTP/Retell failure playbook. |
| `test/` | Unit tests (Retell client, Jambonz parsing, SIP URI, fallback). |

## Quick start (local)

```bash
cp .env.example .env        # fill RETELL_API_KEY + RETELL_AGENT_ID at minimum
npm install
npm test                    # 12 unit tests
npm run dev                 # starts on :3000

# Simulate a Jambonz inbound webhook:
curl -sX POST localhost:3000/jambonz/inbound \
  -H 'content-type: application/json' \
  -d '{"call_sid":"test1","from":"+61400000000","to":"+61399999999","direction":"inbound"}' | jq
# -> [{"verb":"dial","target":[{"type":"sip","sipUri":"sip:<call_id>@sip.retellai.com"}], ...}]
```

(With a real `RETELL_API_KEY` the dial verb carries a live Retell `call_id`;
otherwise you'll get the fallback verb, which is also correct behaviour.)

## Deploy

Docker on a VPS with a public IP. The SIP/media layer needs raw UDP/TCP control —
**don't** run the SIP layer on Render/Heroku-style PaaS.

```bash
docker compose up -d --build        # the Node webhook service
# then install + point Jambonz at it  → jambonz/README.md
# or run the all-in-one Asterisk box  → asterisk/README.md
```

Full walkthrough: **[docs/SETUP.md](docs/SETUP.md)**.

## Key facts (verified against official docs, June 2026)

- Retell register endpoint: `POST https://api.retellai.com/v2/register-phone-call`,
  auth `Authorization: Bearer <key>`, returns `call_id`. Dial within **5 minutes**.
- Dynamic SIP URI: **`sip:{call_id}@sip.retellai.com`** (configurable via
  `RETELL_SIP_DOMAIN`; the Jambonz example repo uses a LiveKit host — see note in
  `jambonz/README.md`).
- Retell SIP transport: TCP recommended (UDP/TLS supported). Codecs: PCMU, PCMA,
  G.722. Whitelist Retell SBC ranges (in `asterisk/pjsip.conf` + firewall).
- Jambonz `dial` verb bridges to `target:[{type:"sip",sipUri}]` with
  `answerOnBridge:true`.

## Configuration

All via env — see [`.env.example`](.env.example). Secrets stay in `.env`
(git-ignored) and are redacted from logs.

## License

Provided as-is for the handoff. Add your preferred license before distributing.
