# Asterisk + Node (for the Retell AGI) + envsubst (for config templating).
# andrius/asterisk is Alpine-based -> apk. If you swap to a Debian-based
# Asterisk image, change `apk add` to `apt-get install -y nodejs gettext-base`.
FROM andrius/asterisk:20-current

RUN apk add --no-cache nodejs gettext

# Entrypoint renders pjsip.conf from a template at boot, then starts Asterisk.
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
