# SIGMA LIVE SERVER 1.1

Servidor Node.js que coleta os eventos ao vivo do Blaze Double e fornece uma API para o SIGMA ORION.

## O que faz

- conecta ao WebSocket Engine.IO v3;
- executa o handshake Socket.IO;
- responde aos pings;
- escuta `data` com `id: double.tick`;
- ignora `waiting`;
- armazena somente `complete`;
- remove duplicidades;
- mantém até 3000 rodadas;
- reconecta automaticamente.

## Endpoints

- `/health`
- `/last`
- `/memory`
- `/memory?limit=100`
- `/stats?sample=50`
- `/events`

## Render

Use Node, branch `main`, diretório raiz vazio, `npm install` para build e `npm start` para iniciar.

Depois do deploy, abra `/health`. O campo `rounds` começa em zero e deve aumentar após resultados completos.

Observação: o plano gratuito do Render pode suspender o serviço após um período sem acessos.


## Correções da versão 1.1

- envia o comando de inscrição para `double_room_1`;
- envia ping Engine.IO v3 (`2`) no intervalo informado pelo handshake;
- reconhece o pong (`3`);
- evita que a Blaze encerre a conexão por ausência de heartbeat;
- expõe `subscribed`, `room`, `pingIntervalMs` e `pingTimeoutMs` em `/health`.

## SIGMA COLOR 24H
Configure no Render:
- `MEMORY_LIMIT=3000`
- `SIGMA_COLOR_24H_ENABLED=true`
- `TELEGRAM_BOT_TOKEN=<token do bot>`
- `TELEGRAM_CHAT_ID=<id do grupo>`

O motor COLOR passa a processar as rodadas, Direta/G1, resultados e resumos diretamente no servidor, mesmo sem navegadores abertos.
Estado: `GET /api/sigma-reading/state`.
