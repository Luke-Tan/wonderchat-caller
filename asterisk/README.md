# Asterisk path (alternative SIP/media layer)

Use this instead of Jambonz when you want a **single self-contained container**
with no external license. Asterisk does the SIP/RTP; a tiny Node **AGI** script
(`agi/register-retell-call.mjs`) calls the Retell API per call and hands back the
dynamic SIP URI for the dialplan to `Dial()`.

```
Caller → URL Networks → Asterisk (PJSIP, registers to URL Networks)
       → dialplan [from-url-networks]
       → AGI register-retell-call.mjs → POST Retell /v2/register-phone-call
       → Dial(PJSIP/retell/sip:{call_id}@sip.retellai.com)
       ↔ Asterisk bridges RTP between caller and Retell
```

## Files

| File | Purpose |
|---|---|
| `pjsip.conf` | Registration trunk to URL Networks + Retell outbound endpoint + Retell IP identify. |
| `extensions.conf` | Dialplan: AGI → Dial dynamic URI → fallback. |
| `agi/register-retell-call.mjs` | Node AGI: registers call, sets `RETELL_SIP_URI`. |
| `rtp.conf` | RTP port range (keep in sync with the firewall + `.env`). |
| `docker-compose.asterisk.yml` | Runs Asterisk with host networking. |

## Tradeoff vs Jambonz

- **Asterisk pro:** one container, no license, fully self-hosted, easy to run on
  a small VPS. The whole flow (register + dial) lives in `.conf` + one AGI file.
- **Asterisk con:** dialplan + AGI is less ergonomic than returning JSON verbs;
  call-control logic is split between `extensions.conf` and Node. Debugging
  SIP/RTP is the classic Asterisk experience.
- **Jambonz pro:** call control is plain JSON over HTTP to this repo's Node
  service — the same `src/` runs the logic, tests, metrics, `/health`. Cleaner
  for a TS workflow. **Con:** heavier stack + self-host license.

**Recommendation:** Jambonz if you want the Node service to own call control and
you're OK installing the Jambonz stack; Asterisk if you want the smallest,
most self-contained box. Both dial the identical dynamic Retell SIP URI.

## Node in the Asterisk container

The AGI is `.mjs`, so the Asterisk image needs Node ≥18. The Alpine
`andrius/asterisk` image doesn't ship Node. Either:

1. **Bake a custom image** (recommended):
   ```Dockerfile
   FROM andrius/asterisk:20-current
   RUN apk add --no-cache nodejs
   ```
   Build it and point the compose `image:` at your tag.
2. Or rewrite the AGI in a language already in the image (e.g. a shell + `curl`
   + `jq` AGI) — the registration is a single POST, so this is viable.

Make the AGI executable: `chmod +x agi/register-retell-call.mjs`.

## Configure & run

1. Fill `../.env` (SIP_* for URL Networks, RETELL_* for Retell, PUBLIC_IP).
2. The `${...}` placeholders in `pjsip.conf` are **not** auto-substituted by
   Asterisk. Either render them before mounting (envsubst) or hardcode the
   values for your box. Quick render:
   ```bash
   set -a; . ../.env; set +a
   envsubst < pjsip.conf > pjsip.rendered.conf   # then mount the rendered file
   ```
3. `docker compose -f docker-compose.asterisk.yml up -d`
4. Verify registration: `docker exec -it <ctr> asterisk -rx "pjsip show registrations"`
   — the URL Networks line should be **Registered**.
5. Place a test call. Watch: `docker exec -it <ctr> asterisk -rvvv`.

See `../docs/TROUBLESHOOTING.md` for SIP auth, one-way audio, and dial-failure
debugging.
