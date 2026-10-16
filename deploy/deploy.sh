#!/usr/bin/env bash
# Publica o jogo na VPS: compila aqui, envia só o necessário e reinicia o serviço.
# Uso: npm run deploy   (ou deploy/deploy.sh root@outro-host)
# Primeira vez: rode deploy/setup-vps.sh antes (instala Node isolado e cria o usuário).
set -euo pipefail
HOST="${1:-root@vps67071.publiccloud.com.br}"
SSH="ssh -i $HOME/.ssh/id_rsa -o BatchMode=yes"
cd "$(dirname "$0")/.."

npm run build
npm run build:server

# Envia via tar sobre SSH (a VPS não tem rsync e não instalamos pacotes nela).
tar czf - dist dist-server -C deploy package.json multidao.service | $SSH "$HOST" 'set -e
  mkdir -p /opt/multidao/.incoming && cd /opt/multidao/.incoming && rm -rf ./* && tar xzf -
  rm -rf /opt/multidao/dist /opt/multidao/dist-server
  mv dist dist-server package.json /opt/multidao/
  mv multidao.service /etc/systemd/system/multidao.service'

$SSH "$HOST" 'set -e
  cd /opt/multidao && PATH=/opt/node22/bin:$PATH npm install --omit=dev --no-audit --no-fund --silent
  chown -R multidao:multidao /opt/multidao
  systemctl daemon-reload && systemctl enable multidao >/dev/null 2>&1 && systemctl restart multidao
  sleep 2 && systemctl --no-pager --lines=5 status multidao | head -12'
