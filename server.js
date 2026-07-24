"use strict";

const express = require("express");
const cors = require("cors");
const config = require("./config");
const RoundMemory = require("./memory");
const BlazeLiveSocket = require("./socket");

const app = express();
const memory = new RoundMemory(config.memoryLimit);
const clients = new Set();
const live = new BlazeLiveSocket({
  url: config.blazeSocketUrl,
  origin: config.blazeOrigin,
  reconnectMinMs: config.reconnectMinMs,
  reconnectMaxMs: config.reconnectMaxMs,
  staleConnectionMs: config.staleConnectionMs
});

function corsOrigin(origin, callback) {
  if (!origin || config.allowedOrigins.includes("*") || config.allowedOrigins.includes(origin)) {
    callback(null, true);
    return;
  }
  callback(new Error("Origin não autorizado pelo SIGMA LIVE SERVER."));
}

app.use(cors({ origin: corsOrigin, methods: ["GET", "OPTIONS"], credentials: false }));
app.use(express.json({ limit: "100kb" }));

app.get("/", (_req, res) => {
  res.json({
    name: "SIGMA LIVE SERVER",
    version: "1.1.0",
    online: true,
    endpoints: ["/health", "/last", "/memory", "/stats", "/events"]
  });
});

app.get("/health", (_req, res) => {
  const state = live.state();
  res.json({
    ok: true,
    service: "sigma-live-server",
    version: "1.1.0",
    timestamp: new Date().toISOString(),
    connected: state.connected,
    engineOpened: state.engineOpened,
    socketIoConnected: state.socketIoConnected,
    rounds: memory.size(),
    memoryLimit: config.memoryLimit,
    lastRound: memory.last(),
    lastConnectedAt: state.lastConnectedAt,
    lastDisconnectedAt: state.lastDisconnectedAt,
    lastMessageAt: state.lastMessageAt,
    lastError: state.lastError,
    reconnectAttempt: state.reconnectAttempt
  });
});

app.get("/last", (_req, res) => res.json({ ok: true, round: memory.last() }));

app.get("/memory", (req, res) => {
  const requested = Number(req.query.limit || config.memoryLimit);
  const limit = Math.max(1, Math.min(Number.isFinite(requested) ? requested : config.memoryLimit, config.memoryLimit));
  const rounds = memory.all().slice(0, limit);
  res.json({ ok: true, count: rounds.length, memoryLimit: config.memoryLimit, rounds });
});

app.get("/stats", (req, res) => {
  const requested = Number(req.query.sample || 50);
  const sample = Math.max(1, Math.min(Number.isFinite(requested) ? requested : 50, 500));
  res.json({ ok: true, sample, stats: memory.stats(sample) });
});

app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  const client = { res };
  clients.add(client);
  res.write(`event: state\ndata: ${JSON.stringify({ ...live.state(), rounds: memory.size() })}\n\n`);
  const heartbeat = setInterval(() => res.write(`event: heartbeat\ndata: ${Date.now()}\n\n`), 20000);
  req.on("close", () => {
    clearInterval(heartbeat);
    clients.delete(client);
  });
});

function broadcast(event, payload) {
  const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    try { client.res.write(message); }
    catch (_) { clients.delete(client); }
  }
}

live.on("round", round => {
  const inserted = memory.add(round);
  if (!inserted) {
    console.log(`[LIVE] Rodada duplicada ignorada: ${round.id}`);
    return;
  }
  console.log(`[LIVE] Rodada armazenada: id=${round.id} roll=${round.roll} color=${round.color} memória=${memory.size()}`);
  broadcast("round", { round, count: memory.size() });
});

live.on("state", state => broadcast("state", { ...state, rounds: memory.size() }));

const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(`[SIGMA] Servidor HTTP ativo na porta ${config.port}.`);
  live.start();
});

function shutdown(signal) {
  console.log(`[SIGMA] Encerrando por ${signal}.`);
  live.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
