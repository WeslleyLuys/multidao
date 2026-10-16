# Multidão

Manifestação online multiplayer em 3D no navegador: escolha um lado, monte o visual e vá para a avenida com chat, emotes, bandeiras e cartazes.

## Rodando

Requer Node 20+ (`nvm use` lê o `.nvmrc`).

```bash
npm install
npm run dev        # servidor (porta 3001) + Vite (http://localhost:5173)
```

Produção:

```bash
npm run build      # checa tipos e gera dist/
npm start          # serve dist/ e o WebSocket em /ws na porta $PORT (padrão 3001)
```

Atrás de um proxy (Nginx, Cloudflare), encaminhe `/ws` com upgrade de WebSocket.

## Estrutura

| Pasta | Conteúdo |
|---|---|
| `shared/config.ts` | **Nome, slogan, lados, cores, limites.** Para trocar a identidade, edite este arquivo |
| `shared/protocol.ts` | Mensagens trocadas entre cliente e servidor |
| `shared/physics.ts` | Regra de movimento e colisão (a mesma no servidor e no cliente) |
| `server/index.ts` | Servidor autoritativo: simulação a 20 Hz, snapshots a 15 Hz, validação e rate limit |
| `client/src/main.ts` | Lobby, HUD, predição local, interpolação dos outros jogadores, câmera |
| `shared/look.ts` | Formato do visual (pele, cabelo, 4 peças de roupa, item) e validação |
| `client/src/character.ts` | Carrega o GLB, regiões do corpo, shader de roupas/estampas, controle dos ossos |
| `client/src/avatar.ts` | Avatar animado (andar, correr, emotes), bandeira/cartaz, nome e balão de chat |
| `client/src/graphics.ts` | Renderizador, céu, sombras, qualidade Baixa/Média/Alta, GTAO |
| `client/src/world.ts`, `crowd.ts`, `textures.ts` | Avenida, prédios, árvores, carros de som, papel picado, multidão de fundo |
| `client/src/logo.svg`, `client/public/favicon.svg` | Logo |

## Personagem 3D

- Fonte: `assets-src/personagem/BASEmodel.blend` (malha base com esqueleto).
- Jogo: `client/public/models/personagem.glb`, gerado pelo script de exportação:

```bash
blender -b assets-src/personagem/BASEmodel.blend \
  --python assets-src/personagem/export_glb.py -- client/public/models/personagem.glb
```

O modelo não precisa de materiais nem de animações:
- **Roupas** (`client/src/character.ts`): um shader pinta cada região do corpo com estilo, cor, estampa e cor do detalhe. A região de cada vértice vem do osso que mais o influencia.
- **Animações** (`client/src/avatar.ts`): andar, correr e emotes giram os ossos por código.

Se trocar o modelo, mantenha os nomes dos ossos (`upperarm.L`, `lowerleg.R`, `head`, `chest`, `wiest`…) ou ajuste `regionOf()` e as poses.

## Bots

O servidor cria `BOTS_PER_TEAM` bots por lado (`shared/config.ts`). Eles andam pela zona do seu lado, param, olham em volta e fazem gestos. Não falam e não entram na contagem de pessoas online. Além deles há uma multidão de fundo, estática e instanciada, só no cliente.

## Eventos (FPS)

O botão "🎯 Eventos" (ou Esc → Eventos) abre a escolha de tamanho: 1x1, 2x2, 4x4, 8x8 ou 12x12, Esquerda contra Direita. A partida começa quando os dois lados enchem; com "Jogar agora com bots", ou depois de 20 s na fila, as vagas são completadas com bots.

- **Arena** (`shared/arena.ts`): terreno abandonado gerado por semente e espelhado (justo para os dois lados). O tamanho acompanha o número de jogadores.
- **Armas** (`shared/weapons.ts`): soco, pistola, fuzil, shotgun e canhão. Todos nascem só com o soco; as armas saem dos baús, que voltam a fechar depois de 25 s.
- **Servidor** (`server/match.ts`): fila, partida de 3 minutos, tiros, headshot, projétil com dano em área, proteção de 2 s ao renascer, pontuação e bots.
- **Cliente** (`client/src/match/`): primeira pessoa, HUD, efeitos e sons sintetizados.
- **Controles:** WASD, mouse, clique (atirar), E (baú), R (recarregar), 1–5 ou roda (armas), Tab (placar), Esc (pausa).


## Publicação (VPS de testes)

O jogo roda em `http://vps67071.publiccloud.com.br:8090`. A VPS é compartilhada com sites em produção (Apache) e tem pouca memória, então:

- **Compilação:** tudo é compilado localmente; a VPS recebe só `dist/` (cliente) e `dist-server/index.mjs` (servidor em um arquivo).
- **Instalação isolada:** Node fica em `/opt/node22`, o app em `/opt/multidao`, e o serviço systemd `multidao` roda com limite de memória e CPU.

```bash
deploy/setup-vps.sh   # uma vez, na VPS (via: ssh root@vps 'bash -s' < deploy/setup-vps.sh)
npm run deploy        # compila e publica
```

Logs: `ssh root@vps67071.publiccloud.com.br journalctl -u multidao -f`

## Próximos passos sugeridos

- Contas (cadastro/login) e perfil persistente
- Pagamento único via Pix
- Protocolo binário e interest management para centenas de jogadores por sala
- Várias salas/instâncias, moderação de chat e denúncias
- Modelos 3D próprios (glTF) no lugar das primitivas
