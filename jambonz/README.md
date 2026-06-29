# Jambonz configuration (preferred SIP/media layer)

This service is the **call-control webhook** Jambonz calls on every inbound call.
Jambonz itself (the SIP/media stack) is installed separately. This folder
documents exactly how to wire Jambonz to URL Networks and to this service.

> Verified against docs.jambonz.org (June 2026) and the official
> `jambonz/retell-sip-integration-example` repo.

## What runs where

```
Caller → URL Networks trunk
       → Jambonz SBC (drachtio + rtpengine, sbc-inbound)
       → Jambonz feature-server  ──HTTP webhook──►  THIS service (/jambonz/inbound)
                                                     │
                                                     └─ POST Retell /v2/register-phone-call
       ← feature-server dials  sip:{call_id}@sip.retellai.com  (the `dial` verb we return)
       ↔ rtpengine bridges RTP between caller and Retell
```

## 1. Install Jambonz (single VPS = "jambonz mini")

There is **no official public docker-compose** for a full single-VPS Jambonz.
Use one of the supported paths (see docs/SETUP.md for the click-by-click):

- **jambonz mini** VM image / Debian-package install — all components on one box
  (drachtio, rtpengine, sbc-inbound, sbc-outbound, feature-server, api-server,
  webapp, mysql, redis, influxdb). Good for up to ~50 concurrent calls.
- A **self-hosting license key** (keyed to your domain) is required; a free
  non-commercial tier exists.

## 2. Create the Carrier (URL Networks trunk)

Portal → **Carriers → Add Carrier**. Pick the trunk type that matches what URL
Networks gives you:

| URL Networks auth model | Jambonz trunk type | What to fill in |
|---|---|---|
| They send calls **from fixed IP(s)** | **IP trunk** | Inbound tab: their signaling IP(s)/CIDR. Outbound tab: their gateway IP/DNS. No credentials. |
| They challenge **inbound** with digest auth | **Auth trunk** | Inbound tab: the username/password you hand URL Networks. |
| They only allow **SIP registration** (you register to them) | **Registration trunk** | Outbound/Registration tab: provider username + password, check **"Require SIP Register"**, set **SIP Realm** = URL Networks realm, add their SIP gateway DNS. |

> **Registration is supported** — Jambonz can REGISTER outbound to a provider
> that only allows registration. This is the most likely setup since 3CX was
> registering to URL Networks today: reuse those exact credentials here.

Transport: set the gateway to `udp` (or `tcp`) per `SIP_TRANSPORT`. URL Networks
typically uses UDP/5060.

## 3. Create the Application

Portal → **Applications → Add Application**:

- **Calling webhook** → `https://caller.yourdomain.com/jambonz/inbound` — method **POST**
  (POST is required so the full inbound SIP INVITE arrives under the `sip` key).
- **Call status webhook** → `https://caller.yourdomain.com/jambonz/status` — POST.
- **Webhook security** (optional): set HTTP Basic auth with any username and
  password = your `JAMBONZ_WEBHOOK_SECRET`, or enable HMAC signing and validate
  the `Jambonz-Signature` header. This service checks Basic/Bearer when
  `JAMBONZ_WEBHOOK_SECRET` is set.
- Speech (TTS): configure a Google/AWS speech credential under **Speech** so the
  `say` fallback (`ERROR_FALLBACK_MODE=play_message`) can speak.

## 4. Route the DID to the Application

- If calls arrive from a **carrier IP/registration**: Portal → **Phone Numbers →
  Add Number**, enter your URL Networks DID, select the Carrier, and assign the
  Application from step 3.
- If calls arrive as a **SIP device registration** (no static IP, like LiveKit):
  set the **Account → "Application for SIP device calls"** to this Application.

## 5. What this service returns

On `/jambonz/inbound` we register the call with Retell and return a single
`dial` verb that bridges to the dynamic Retell SIP URI:

```json
[
  {
    "verb": "dial",
    "callerId": "+61400000000",
    "answerOnBridge": true,
    "anchorMedia": true,
    "referHook": "/jambonz/refer",
    "actionHook": "/jambonz/dial-action",
    "timeout": 30,
    "headers": { "X-Retell-Call-Id": "call_abc123" },
    "target": [
      { "type": "sip", "sipUri": "sip:call_abc123@sip.retellai.com" }
    ]
  }
]
```

On Retell failure we return the configured fallback (`hangup`, spoken `say` +
`hangup`, or `dial` to `BACKUP_NUMBER`).

## ⚠️ Retell SIP host: `sip.retellai.com` vs LiveKit

Current Retell docs say dial **`sip:{call_id}@sip.retellai.com`**. The official
Jambonz example repo still uses `sip:{call_id}@5t4n6j0wnrl.sip.livekit.cloud`
(Retell runs on LiveKit under the hood). We default to the **documented**
`sip.retellai.com` via `RETELL_SIP_DOMAIN`. If dials 404/480, flip
`RETELL_SIP_DOMAIN` to the LiveKit host and re-test — see docs/TROUBLESHOOTING.md.
