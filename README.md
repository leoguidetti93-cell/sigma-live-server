# SIGMA LIVE SERVER 1.0

Servidor Node.js que coleta os eventos ao vivo do Blaze Double e fornece uma API para o SIGMA ORION.

## O que faz

- conecta ao WebSocket Engine.IO v3;
- executa o handshake Socket.IO;
- responde aos pings;
- escuta `data` com `id: double.tick`;
- ignora `waiting`;
- armazena somente `complete`;
- remove duplicidades;
- mantém até 500 rodadas;
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
