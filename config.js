"use strict";

module.exports = {
  port: Number(process.env.PORT || 3000),
  blazeSocketUrl: process.env.BLAZE_SOCKET_URL || "wss://api-gaming.blaze.bet.br/replication/?EIO=3&transport=websocket",
  blazeOrigin: process.env.BLAZE_ORIGIN || "https://blaze.bet.br",
  memoryLimit: Number(process.env.MEMORY_LIMIT || 1000),
  reconnectMinMs: Number(process.env.RECONNECT_MIN_MS || 1500),
  reconnectMaxMs: Number(process.env.RECONNECT_MAX_MS || 30000),
  staleConnectionMs: Number(process.env.STALE_CONNECTION_MS || 45000),
  allowedOrigins: (process.env.ALLOWED_ORIGINS || "*").split(",").map(v => v.trim()).filter(Boolean)
};
