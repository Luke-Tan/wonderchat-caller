# Self-contained Asterisk + Node (for the Retell AGI) + envsubst (config render).
# Debian base so we don't depend on a third-party Asterisk image tag existing.
# Debian bookworm ships Asterisk 20 and Node 18 (which has global fetch).
FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      asterisk asterisk-modules nodejs gettext-base ca-certificates \
 && ln -sf /usr/bin/nodejs /usr/bin/node \
 && rm -rf /var/lib/apt/lists/*

# Entrypoint renders pjsip.conf from the template, then starts Asterisk.
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
