#!/usr/bin/env bash
# Preparação única da VPS (roda NA VPS, como root). Não mexe no Apache nem nos sites.
# - Node 22 isolado em /opt/node22 (sem apt)
# - usuário de sistema "multidao" sem login
# - pasta /opt/multidao
set -euo pipefail
NODE_VERSION=v22.22.2
if [ ! -x /opt/node22/bin/node ]; then
  cd /tmp
  curl -fsSLO "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz"
  mkdir -p /opt/node22
  tar -xJf "node-${NODE_VERSION}-linux-x64.tar.xz" -C /opt/node22 --strip-components=1
  rm -f "node-${NODE_VERSION}-linux-x64.tar.xz"
fi
id multidao >/dev/null 2>&1 || useradd --system --home /opt/multidao --shell /usr/sbin/nologin multidao
mkdir -p /opt/multidao
chown multidao:multidao /opt/multidao
/opt/node22/bin/node -v
