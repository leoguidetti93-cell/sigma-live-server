"use strict";

const WebSocket = require("ws");
const EventEmitter = require("events");

class BlazeLiveSocket extends EventEmitter {
  constructor(options) {
    super();
    this.url = options.url;
    this.origin = options.origin;
    this.reconnectMinMs = options.reconnectMinMs;
    this.reconnectMaxMs = options.reconnectMaxMs;
    this.staleConnectionMs = options.staleConnectionMs;
    this.socket = null;
    this.connected = false;
    this.engineOpened = false;
    this.socketIoConnected = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.watchdogTimer = null;
    this.shouldRun = false;
    this.lastMessageAt = null;
    this.lastConnectedAt = null;
    this.lastDisconnectedAt = null;
    this.lastError = null;
  }

  start() {
    if (this.shouldRun) return;
    this.shouldRun = true;
    this.connect();
  }

  stop() {
    this.shouldRun = false;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.watchdogTimer);
    if (this.socket) {
      try { this.socket.close(); } catch (_) {}
    }
  }

  connect() {
    if (!this.shouldRun) return;
    clearTimeout(this.reconnectTimer);
    console.log(`[LIVE] Conectando em ${this.url}`);
    this.engineOpened = false;
    this.socketIoConnected = false;
    this.lastError = null;

    const socket = new WebSocket(this.url, {
      origin: this.origin,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150 Safari/537.36",
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache"
      },
      handshakeTimeout: 15000
    });

    this.socket = socket;

    socket.on("open", () => {
      this.connected = true;
      this.lastConnectedAt = new Date().toISOString();
      this.lastMessageAt = Date.now();
      this.reconnectAttempt = 0;
      this.lastError = null;
      console.log("[LIVE] WebSocket aberto. Aguardando handshake Engine.IO.");
      this.emit("state", this.state());
      this.startWatchdog();
    });

    socket.on("message", data => {
      this.lastMessageAt = Date.now();
      this.handleFrame(data.toString());
    });

    socket.on("error", error => {
      this.lastError = error?.message || String(error);
      console.error("[LIVE] Erro:", this.lastError);
      this.emit("state", this.state());
    });

    socket.on("close", (code, reasonBuffer) => {
      const reason = reasonBuffer?.toString() || "";
      this.connected = false;
      this.engineOpened = false;
      this.socketIoConnected = false;
      this.lastDisconnectedAt = new Date().toISOString();
      clearInterval(this.watchdogTimer);
      console.warn(`[LIVE] Conexão encerrada. Código ${code}. ${reason}`);
      this.emit("state", this.state());
      this.scheduleReconnect();
    });
  }

  startWatchdog() {
    clearInterval(this.watchdogTimer);
    this.watchdogTimer = setInterval(() => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.lastMessageAt) return;
      const silentFor = Date.now() - this.lastMessageAt;
      if (silentFor > this.staleConnectionMs) {
        console.warn(`[LIVE] Sem mensagens por ${silentFor} ms. Reiniciando conexão.`);
        try { this.socket.terminate(); } catch (_) {}
      }
    }, 5000);
  }

  scheduleReconnect() {
    if (!this.shouldRun) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectAttempt += 1;
    const exponential = this.reconnectMinMs * Math.pow(2, Math.min(this.reconnectAttempt - 1, 5));
    const delay = Math.min(exponential, this.reconnectMaxMs) + Math.floor(Math.random() * 500);
    console.log(`[LIVE] Nova tentativa em ${delay} ms.`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  send(frame) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(frame);
    return true;
  }

  handleFrame(frame) {
    if (!frame) return;
    if (frame.startsWith("0")) {
      this.engineOpened = true;
      console.log("[LIVE] Handshake Engine.IO recebido.");
      this.send("40");
      this.emit("state", this.state());
      return;
    }
    if (frame === "2" || frame.startsWith("2")) {
      const payload = frame.length > 1 ? frame.slice(1) : "";
      this.send(`3${payload}`);
      return;
    }
    if (frame === "40" || frame.startsWith("40")) {
      this.socketIoConnected = true;
      console.log("[LIVE] Socket.IO conectado.");
      this.emit("state", this.state());
      return;
    }
    if (!frame.startsWith("42")) return;

    let packet;
    try { packet = JSON.parse(frame.slice(2)); }
    catch (error) {
      this.lastError = `Pacote Socket.IO inválido: ${error.message}`;
      console.warn("[LIVE]", this.lastError);
      return;
    }

    if (!Array.isArray(packet) || packet.length < 2) return;
    const [eventName, message] = packet;
    if (eventName !== "data") return;
    if (!message || message.id !== "double.tick") return;
    const payload = message.payload;
    if (!payload || payload.status !== "complete") return;

    const round = {
      id: payload.id ?? null,
      room_id: payload.room_id ?? null,
      status: payload.status,
      roll: Number.isFinite(Number(payload.roll)) ? Number(payload.roll) : null,
      color: Number.isFinite(Number(payload.color)) ? Number(payload.color) : null,
      created_at: payload.created_at || null,
      updated_at: payload.updated_at || null,
      total_red_bet: payload.total_red_bet ?? null,
      total_black_bet: payload.total_black_bet ?? null,
      total_white_bet: payload.total_white_bet ?? null,
      received_at: new Date().toISOString()
    };

    this.emit("round", round);
  }

  state() {
    return {
      connected: this.connected,
      engineOpened: this.engineOpened,
      socketIoConnected: this.socketIoConnected,
      lastConnectedAt: this.lastConnectedAt,
      lastDisconnectedAt: this.lastDisconnectedAt,
      lastMessageAt: this.lastMessageAt ? new Date(this.lastMessageAt).toISOString() : null,
      lastError: this.lastError,
      reconnectAttempt: this.reconnectAttempt
    };
  }
}

module.exports = BlazeLiveSocket;
