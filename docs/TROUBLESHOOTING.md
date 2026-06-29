# TROUBLESHOOTING — SIP / RTP / Retell

Work top-down: **registration → inbound INVITE → Retell API → SIP dial → audio**.
A call only reaches the next stage if the previous one worked, so fix in order.

Useful captures:

```bash
# Live SIP on the wire (both paths):
sudo tcpdump -n -i any -s 0 port 5060 -A | grep -E 'INVITE|REGISTER|SIP/2.0'
# Structured app logs (Jambonz path):
docker compose logs -f middleware | jq -R 'fromjson? // .'
# Asterisk live:
docker exec -it <ctr> asterisk -rvvv
docker exec -it <ctr> asterisk -rx "pjsip set logger on"
```

---

## Registration Problems

**Symptoms:** URL Networks shows not-registered · inbound calls never arrive ·
`401`/`403` on REGISTER.

**Check:**
- `SIP_USERNAME` / `SIP_PASSWORD` exactly match what 3CX used (copy, don't retype).
- `SIP_REGISTRAR`, `SIP_REALM`, `SIP_PROXY` correct; realm matches the provider's
  digest realm (watch for trailing domains).
- `SIP_TRANSPORT` matches what URL Networks accepts (usually `udp`).
- Firewall: `5060/udp` (and `/tcp`) open **outbound and inbound**.
- `PUBLIC_IP` set so Contact/Via advertise the routable IP, not a private one.
- NAT: `force_rport`/`rewrite_contact` on (Asterisk has these in `pjsip.conf`).
- Jambonz: you created a **Registration trunk**, checked *Require SIP Register*,
  set the realm, and added the outbound gateway.
- Verify: Asterisk `pjsip show registrations` → **Registered**; or watch for a
  `200 OK` to your `REGISTER` in tcpdump.

---

## Inbound Call Problems

**Symptoms:** registered but calls fail · busy tone · calls time out.

**Check:**
- **DID routing at URL Networks:** is the number actually pointed to your
  trunk/registration? Confirm with them.
- **INVITE destination:** does tcpdump show an inbound `INVITE` hitting your IP at
  all? If not, it's upstream (URL Networks routing / firewall).
- **Called-number format:** compare the `To`/Request-URI user part URL Networks
  sends (E.164 `+61...` vs local `0...` vs bare DID) against your routing match.
  Asterisk `_X.` matches digits; if they send a `+`, use `_[+0-9].` or strip it.
- **Application route:** Jambonz — the DID/number is assigned to the Application
  (or Account "Application for SIP device calls" for registration trunks).
- **Server logs:** an INVITE that arrives but isn't routed shows a `404`/`480` in
  your SBC/Asterisk — that's a routing/match issue, not Retell.

---

## Retell Registration Problems

**Symptoms:** call reaches middleware but Retell never answers · Retell API errors
· you hear the fallback message.

**Check:**
- `RETELL_API_KEY` valid (no extra whitespace/newline); `Authorization: Bearer`.
- `RETELL_AGENT_ID` is a real, published agent.
- Look at the app log line `Retell registration failed` — it includes the HTTP
  status and response body snippet. Common: `401` (bad key), `422` (bad/missing
  agent_id), `429` (rate/limits).
- Reachability: `curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $RETELL_API_KEY" https://api.retellai.com/v2/list-agents`
  → expect `200`. `/health` also reports `retell_api_reachable`.
- Retell account limits/credits not exhausted.
- Outbound HTTPS (443) from the VPS not blocked.

---

## SIP Dial Problems

**Symptoms:** Retell call registered (you have a `call_id`) but the SIP dial
fails · `403`/`404`/`408`/`480`/`486` on the INVITE to Retell.

**Check:**
- **SIP URI format:** must be `sip:{call_id}@{host}`. Log line `retell_sip_uri`
  shows what you dialed.
- **Wrong host?** This is the most likely gotcha. Current Retell docs say
  `sip.retellai.com`; the official **Jambonz example uses
  `5t4n6j0wnrl.sip.livekit.cloud`**. If you get `404`/`480` from
  `sip.retellai.com`, set `RETELL_SIP_DOMAIN=5t4n6j0wnrl.sip.livekit.cloud` (or
  whatever host Retell support confirms for your account) and re-test.
- **Expiry (5 min):** you must dial within 5 minutes of registration, or Retell
  drops it (`registered_call_timeout`). Our flow dials immediately; only a hang
  between register and dial causes this.
- **Transport:** Retell recommends **TCP**. If UDP dials get no response, switch
  the Retell endpoint transport to TCP/TLS (Asterisk `[retell] transport`).
- **Codec:** offer PCMU/PCMA (and G.722). A `488 Not Acceptable Here` means no
  codec overlap — fix `allow=` lines.
- **Firewall:** outbound to Retell SBC ranges allowed:
  `18.98.16.120/30`, `3.42.144.0/23`, `143.223.88.0/21`, `161.115.160.0/19`.
- `403` often = source IP not recognized by Retell; confirm the DID is imported /
  account configured if using the trunk path.

---

## Audio Problems

**Symptoms:** connects but **no audio** · **one-way audio** · audio drops after a
few seconds.

This is ~90% NAT/RTP/firewall. Check in this order:

- **RTP ports open:** the full UDP range (`10000–20000` or your `RTP_PORT_*`) open
  in **both** UFW **and** the cloud provider firewall. One-way audio = inbound
  RTP blocked one direction.
- **Public IP advertised:** Asterisk `external_media_address`/
  `external_signaling_address` = `PUBLIC_IP`; `local_net` lists your private
  ranges. Wrong/missing → SDP advertises a private IP → no audio.
- **Symmetric RTP / NAT:** `rtp_symmetric=yes`, `force_rport=yes`,
  `rewrite_contact=yes` (already set in `pjsip.conf`). Jambonz: rtpengine handles
  this; ensure rtpengine's advertised IP is the public one.
- **Media anchored:** we set `anchorMedia:true` (Jambonz) / `direct_media=no`
  (Asterisk) so media flows through the server and isn't sent peer-to-peer.
- **Audio drops after N seconds:** usually a NAT keepalive / one-way RTP timeout —
  open the RTP range fully and confirm symmetric RTP. Also check `qualify` keep
  alives.
- **Codec mismatch mid-call:** confirm a single common codec is negotiated; avoid
  transcoding surprises by aligning `allow=` on both endpoints.
- **Confirm RTP flows:** `sudo tcpdump -n -i any udp portrange 10000-20000` during
  a call — you should see packets in **both** directions.

---

## Fallback & failure behaviour (by design)

The middleware degrades gracefully — these are not bugs:

- Retell API down / non-200 / malformed → caller gets `ERROR_FALLBACK_MODE`
  (`hangup`, spoken `play_message`, or `forward_to_backup_number`). Logged as
  `registration_status: failed` with the reason.
- Caller hangs up before Retell answers → `dial-action` fires with a non-completed
  `dial_call_status`; both legs torn down.
- Retell hangs up first → bridge ends; inbound leg hung up cleanly.
- Unexpected handler error → safe `hangup` verb (never a 500 to a live call).

---

## Still stuck?

Capture a single failing call end-to-end and inspect together:

```bash
sudo tcpdump -n -i any -s 0 \( port 5060 or udp portrange 10000-20000 \) -w /tmp/call.pcap
# place the call, ctrl-C, then open /tmp/call.pcap in Wireshark (Telephony → VoIP Calls)
```

Match the `sip_call_id` / `retell_call_id` from the app logs to the Retell
dashboard Call History to pinpoint which hop failed.
