# SETUP — deploy & operate the Retell SIP middleware

End-to-end guide: provision a VPS, install the stack, configure URL Networks +
Retell, test a real call, and operate (logs, restart, update, rollback).

> Two SIP/media options. **Jambonz** (preferred — Node owns call control) or
> **Asterisk** (alternative — one self-contained box). Pick one; the Retell side
> and firewall are identical.

---

## 0. Decide your path first

| | Jambonz | Asterisk |
|---|---|---|
| Call control | JSON verbs from this Node service | dialplan + Node AGI |
| Install effort | Heavier (Jambonz stack + self-host license) | One container |
| Best when | You want the TS service to own logic, metrics, `/health` | You want the smallest box |

Also reconsider whether you need the middleware at all — see
[Option B](#option-b-static-trunk--inbound-webhook) and the README's "Read this
first". If a static SIP forward works, you skip most of this.

---

## 1. Provision a VPS

- **Provider:** DigitalOcean, Hetzner, Vultr, Linode, or AWS EC2. Must give you a
  **public static IP** and full inbound/outbound UDP+TCP control. **Avoid** PaaS
  (Render/Heroku) for the SIP/media layer.
- **Specs:**
  - Node middleware only: 1 vCPU / 1 GB RAM is plenty.
  - Asterisk all-in-one: 1–2 vCPU / 2 GB RAM (≈ dozens of concurrent calls).
  - Jambonz mini: 2–4 vCPU / 4–8 GB RAM (it runs mysql/redis/influx + SBC + FS).
- **OS:** Ubuntu 22.04 LTS (x86_64). (Jambonz mini also ships VM images.)
- **DNS:** Point an A record (e.g. `caller.yourdomain.com`) at the VPS IP. Needed
  for HTTPS on the webhook and for Let's Encrypt via Caddy.

---

## 2. Firewall ports

Open exactly what your path needs (UFW shown; mirror in the provider's cloud
firewall too):

```bash
sudo ufw allow 22/tcp                 # SSH
sudo ufw allow 80/tcp                 # ACME http-01 (Caddy)
sudo ufw allow 443/tcp                # HTTPS webhook
sudo ufw allow 5060/udp               # SIP signaling
sudo ufw allow 5060/tcp               # SIP signaling (TCP)
sudo ufw allow 5061/tcp               # SIP over TLS (if used)
sudo ufw allow 10000:20000/udp        # RTP media (match rtp.conf / RTP_PORT_*)
# Jambonz also: 8443/tcp (SIP-over-WSS) and its portal/API ports (front with TLS)
sudo ufw enable
```

**Lock down SIP** to known sources where possible:

```bash
# Allow only URL Networks signaling IP(s) on 5060 (replace with real CIDR):
sudo ufw allow from <URL_NETWORKS_IP> to any port 5060 proto udp
# Allow Retell SBC ranges for return signaling/media:
for c in 18.98.16.120/30 3.42.144.0/23 143.223.88.0/21 161.115.160.0/19; do
  sudo ufw allow from $c
done
```

> If URL Networks uses **registration** (no fixed IP), you can't IP-restrict 5060
> to them; rely on SIP digest auth + the RTP range restriction instead.

---

## 3. Install Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker
docker compose version    # v2 ships with Docker Engine
```

---

## 4. Get the code & configure env

```bash
git clone <your-repo-url> retell-sip-middleware && cd retell-sip-middleware
cp .env.example .env
nano .env
```

Fill at minimum:

```ini
RETELL_API_KEY=key_xxx
RETELL_AGENT_ID=agent_xxx
PUBLIC_BASE_URL=https://caller.yourdomain.com
PUBLIC_IP=<your.vps.public.ip>
# URL Networks SIP creds (reuse what 3CX used):
SIP_USERNAME=...
SIP_PASSWORD=...
SIP_REGISTRAR=...
SIP_REALM=...
SIP_PROXY=...
SIP_TRANSPORT=udp
# Fallback when Retell is unreachable:
ERROR_FALLBACK_MODE=play_message
JAMBONZ_WEBHOOK_SECRET=<random-long-string>
```

Never commit `.env` (it's git-ignored).

---

## 5. Configure Retell

1. In Retell, note your **agent id** → `RETELL_AGENT_ID`, and an **API key** →
   `RETELL_API_KEY`.
2. Confirm the dial host. Default `RETELL_SIP_DOMAIN=sip.retellai.com` (per current
   docs). If test dials fail with 404/480, try the LiveKit host the Jambonz
   example uses (see TROUBLESHOOTING → "SIP Dial Problems").
3. (Option B only) Import the DID and bind an **Inbound Call Agent** — see below.

---

## 6. Configure URL Networks

You need from URL Networks (open a ticket if unknown — these are the "Key
Unknowns" in the brief):

- Whether they **register** to you, **IP-forward** to you, or require **you to
  register to them** (most likely — that's what 3CX did).
- SIP **registrar / proxy / realm**, **username/password**, **transport**
  (UDP/TCP/TLS).
- The **DID format** in inbound INVITEs (E.164 vs local; in To header vs R-URI).
- Whether they **IP-whitelist** — give them your VPS public IP.
- **RTP port range** expectations and **codec** support (aim for PCMU/PCMA).

Then, depending on their model:

- **They forward to your IP** → point their trunk at `sip:<PUBLIC_IP>:5060`.
- **You register to them** → put the creds in `.env`; Jambonz "Registration
  trunk" or Asterisk `[urlnetworks-reg]` will REGISTER outbound.

---

## 7a. Path A — Jambonz (preferred)

1. Install Jambonz mini on the VPS (Debian package install or the mini VM image),
   obtain a self-host license. Follow Jambonz's official self-hosting guide.
2. In the Jambonz portal, do steps 2–4 of [`jambonz/README.md`](../jambonz/README.md):
   create the **Carrier** (matching URL Networks' auth model), the **Application**
   (calling webhook → `https://caller.yourdomain.com/jambonz/inbound`, POST), and
   route the **DID** to the Application. Set webhook Basic auth password =
   `JAMBONZ_WEBHOOK_SECRET`. Add a TTS (Google/AWS) credential for the `say`
   fallback.
3. Start this webhook service + TLS proxy:
   ```bash
   # edit Caddyfile: set caller.yourdomain.com
   sed -i 's/caller.yourdomain.com/caller.REALDOMAIN.com/' Caddyfile
   # enable the caddy service in docker-compose.yml (uncomment it), then:
   docker compose up -d --build
   curl -s https://caller.REALDOMAIN.com/health | jq
   ```

## 7b. Path B — Asterisk (alternative)

Follow [`asterisk/README.md`](../asterisk/README.md): render `pjsip.conf` env
vars, bake Node into the Asterisk image, then:

```bash
docker compose -f asterisk/docker-compose.asterisk.yml up -d
docker exec -it <ctr> asterisk -rx "pjsip show registrations"   # -> Registered
```

You still run this Node service only if you want `/health`/`/metrics`; the AGI
itself is self-contained.

---

## 8. Test inbound calls

1. **Health:** `curl -s https://caller.../health | jq` → `status: ok`.
2. **Webhook simulation** (Jambonz path):
   ```bash
   curl -sX POST https://caller.../jambonz/inbound \
     -u any:$JAMBONZ_WEBHOOK_SECRET -H 'content-type: application/json' \
     -d '{"call_sid":"t1","from":"+61400000000","to":"+61399999999","direction":"inbound"}' | jq
   ```
   Expect a `dial` verb with `sipUri: sip:<call_id>@sip.retellai.com`.
3. **Real call:** dial the URL Networks DID from a mobile.
4. **Verify Retell received it:** check the Retell dashboard **Call History** for a
   new call within seconds; the `call_id` matches your logs.
5. **Two-way audio:** speak — you should hear the agent and it should hear you.
6. **Hangup:** hang up; confirm both legs tear down (logs show `dial completed`).
7. **Logs contain metadata:** see §10.

---

## 9. Verify / debug audio

If the call connects but audio is missing or one-way, it's almost always
NAT/RTP/firewall — go straight to
[TROUBLESHOOTING → Audio Problems](TROUBLESHOOTING.md#audio-problems). Fast checks:

- `PUBLIC_IP` set correctly (Asterisk `external_media_address`).
- RTP UDP range open in **both** UFW and the cloud firewall.
- Codec overlap exists (PCMU/PCMA on both legs).

---

## 10. Operate

**Inspect logs** (structured JSON; pipe through `jq`):
```bash
docker compose logs -f middleware | jq -R 'fromjson? // .'
# Asterisk: docker exec -it <ctr> asterisk -rvvv   (live SIP/RTP)
```
Each call logs `call_id_internal`, `sip_call_id`, `caller_number`,
`called_number`, `retell_call_id`, `retell_sip_uri`, `registration_status`,
`dial_status`, `hangup_reason`, `duration`.

**Restart:**
```bash
docker compose restart middleware
```

**Update:**
```bash
git pull
docker compose up -d --build     # rebuilds image, recreates container
curl -s https://caller.../health | jq    # confirm version bumped
```

**Roll back:**
```bash
git checkout <previous-good-sha>
docker compose up -d --build
# or re-tag a previously built image: docker tag retell-sip-middleware:prev retell-sip-middleware:latest
```

**Metrics:** `curl -s https://caller.../metrics` (Prometheus text;
`inbound_calls_total`, `retell_registration_*`, `sip_dial_*`, `active_calls`,
`average_call_duration`).

---

## Option B: static trunk + inbound webhook

If URL Networks can forward to a host and you don't need per-call dialing:

1. **Import the DID in Retell** → Phone Numbers → *Connect your number via SIP
   trunking*; enter the DID (E.164) and termination URI. Bind an **Inbound Call
   Agent**.
2. **Point URL Networks** at `sip:sip.retellai.com` (DID in the To header,
   E.164). IP-whitelist Retell's SBC ranges or use credentials.
3. **(Optional) dynamic agent / variables:** set an inbound webhook on the number
   in Retell. Retell POSTs `{"event":"call_inbound","call_inbound":{...}}`; reply
   within 10s with `{"call_inbound":{"override_agent_id":"...","dynamic_variables":{...}}}`.
   Omit `override_agent_id` to reject the call. (This service can host that
   endpoint too — it's a natural extension of `src/index.ts`.)

No SIP/media VPS required for the basic case. Choose this if it fits — it's the
least to maintain.
