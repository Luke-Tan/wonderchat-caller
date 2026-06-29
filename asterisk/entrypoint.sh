#!/bin/sh
# Render pjsip.conf from its template, substituting ONLY our known vars (so we
# never accidentally mangle $PATH or Asterisk dialplan tokens), then exec
# Asterisk in the foreground so Docker manages it as PID 1.
set -e

TEMPLATE=/etc/asterisk/templates/pjsip.conf
TARGET=/etc/asterisk/pjsip.conf

if [ -f "$TEMPLATE" ]; then
  echo "[entrypoint] rendering pjsip.conf (registrar=$SIP_REGISTRAR, public_ip=$PUBLIC_IP)"
  envsubst '$PUBLIC_IP $SIP_USERNAME $SIP_PASSWORD $SIP_REGISTRAR $SIP_PROXY $SIP_REALM $RETELL_SIP_DOMAIN' \
    < "$TEMPLATE" > "$TARGET"
else
  echo "[entrypoint] WARN: $TEMPLATE not found; using whatever pjsip.conf is mounted"
fi

if [ "$PUBLIC_IP" = "REPLACE_WITH_VPS_PUBLIC_IP" ] || [ -z "$PUBLIC_IP" ]; then
  echo "[entrypoint] WARNING: PUBLIC_IP is not set to a real address — audio will likely be one-way until you fix .env"
fi

# Make sure the AGI is executable (mounts can lose the bit).
chmod +x /var/lib/asterisk/agi-bin/*.mjs 2>/dev/null || true

exec asterisk -f -vvvg
