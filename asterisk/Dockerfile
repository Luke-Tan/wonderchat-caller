# Self-contained Asterisk + Node for the Retell AGI.
# Debian 12 dropped the asterisk package, so we use Ubuntu 22.04 (Asterisk 18
# with PJSIP, in universe). Node 20 comes from NodeSource so the AGI has global
# fetch. Everything installs from real, existing repos.
FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      asterisk gettext-base ca-certificates curl \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# Entrypoint renders pjsip.conf from the template, then starts Asterisk.
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
