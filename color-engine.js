"use strict";

const crypto = require("crypto");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const pct = (n, d) => d ? Math.round((n / d) * 100) : 0;

function normalizeColor(round) {
  const roll = Number(round?.roll ?? round?.number ?? round?.value);
  const raw = round?.color;
  if (roll === 0 || raw === 0 || raw === "white") return "white";
  if (raw === 1 || raw === "red" || (roll >= 1 && roll <= 7)) return "red";
  return "black";
}

function roundKey(round) {
  return String(round?.id ?? round?._id ?? round?.created_at ?? round?.createdAt ?? round?.timestamp ?? "");
}

function roundTime(round) {
  return round?.created_at || round?.createdAt || round?.timestamp || new Date().toISOString();
}

function colorName(color) {
  return color === "red" ? "VERMELHO" : color === "black" ? "PRETO" : "BRANCO";
}

function colorEmoji(color) {
  return color === "red" ? "🔴" : color === "black" ? "⚫" : "⚪";
}

function dayParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(date).reduce((acc, item) => (acc[item.type] = item.value, acc), {});
  return parts;
}

function dayKey(date = new Date()) {
  const p = dayParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

function halfHourKey(date = new Date()) {
  const p = dayParts(date);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${Number(p.minute) < 30 ? "00" : "30"}`;
}

function previousHalfHourKey(date = new Date()) {
  const d = new Date(date.getTime() - 30 * 60 * 1000);
  return halfHourKey(d);
}

class SigmaColorEngine {
  constructor({ memory, broadcast, telegramToken, telegramChatId, enabled = true }) {
    this.memory = memory;
    this.broadcast = typeof broadcast === "function" ? broadcast : () => {};
    this.telegramToken = String(telegramToken || "").trim();
    this.telegramChatId = String(telegramChatId || "").trim();
    this.enabled = enabled;
    this.operation = null;
    this.history = [];
    this.stats = { days: {}, sessions: {} };
    this.sentEvents = new Set();
    this.processing = Promise.resolve();
    this.nextSignalAllowedAt = 0;
    this.lastSignalAnchorKey = "";
    this.summaryState = {};
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.processSummaries().catch(console.error), 10000);
    this.timer.unref?.();
    console.log(`[SIGMA COLOR] Motor 24h ${this.enabled ? "ATIVO" : "DESATIVADO"}. Telegram=${Boolean(this.telegramToken && this.telegramChatId)}`);
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  state() {
    return {
      enabled: this.enabled,
      mode: "SERVER_24H",
      operation: this.operation,
      history: this.history.slice(0, 20),
      nextSignalAllowedAt: this.nextSignalAllowedAt,
      telegramConfigured: Boolean(this.telegramToken && this.telegramChatId),
      stats: this.stats.days[dayKey()] || this.emptyStats(),
      updatedAt: new Date().toISOString()
    };
  }

  enqueueRound(round) {
    if (!this.enabled || !round) return;
    this.processing = this.processing.then(() => this.handleRound(round)).catch(error => {
      console.error("[SIGMA COLOR] Falha ao processar rodada:", error);
    });
  }

  chronologicalRounds() {
    return this.memory.all().slice().reverse().map(r => ({ ...r, color: normalizeColor(r), createdAt: roundTime(r) }));
  }

  currentStreak(rounds) {
    if (!rounds.length) return { color: null, count: 0 };
    const color = rounds.at(-1).color;
    let count = 0;
    for (let i = rounds.length - 1; i >= 0 && rounds[i].color === color; i--) count += 1;
    return { color, count };
  }

  distribution(rounds, n = 50) {
    const sample = rounds.slice(-Math.min(n, rounds.length));
    const d = { red: 0, black: 0, white: 0, total: sample.length };
    sample.forEach(r => { d[r.color] = (d[r.color] || 0) + 1; });
    return d;
  }

  testPattern(rounds, pattern, target) {
    let direct = 0, g1 = 0, white = 0, loss = 0, cases = 0;
    const len = pattern.length;
    for (let i = len - 1; i < rounds.length - 2; i++) {
      const seq = rounds.slice(i - len + 1, i + 1).map(r => r.color);
      if (!seq.every((c, j) => c === pattern[j])) continue;
      cases += 1;
      const a = rounds[i + 1].color, b = rounds[i + 2].color;
      if (a === target) direct += 1;
      else if (a === "white") white += 1;
      else if (b === target) g1 += 1;
      else if (b === "white") white += 1;
      else loss += 1;
    }
    return { cases, direct, g1, white, loss, success: cases ? pct(direct + g1 + white, cases) : 0 };
  }

  choosePattern(rounds) {
    const nonWhite = rounds.filter(r => r.color !== "white");
    if (nonWhite.length < 3) return null;
    let best = null;
    for (const len of [4, 3, 2]) {
      const pattern = nonWhite.slice(-len).map(r => r.color);
      for (const target of ["red", "black"]) {
        const test = this.testPattern(rounds, pattern, target);
        if (test.cases >= 5 && (!best || test.success > best.success || (test.success === best.success && test.cases > best.cases))) {
          best = { ...test, pattern, target };
        }
      }
      if (best && best.cases >= 10) break;
    }
    return best;
  }

  calculateSuggestion() {
    const rounds = this.chronologicalRounds();
    if (rounds.length < 20) return null;
    const latest = rounds.at(-1);
    const recent = this.distribution(rounds, 50);
    const redP = pct(recent.red, recent.total), blackP = pct(recent.black, recent.total);
    const dominant = redP > blackP ? "red" : blackP > redP ? "black" : null;
    const streak = this.currentStreak(rounds);
    const reversal = streak.color === "red" ? "black" : streak.color === "black" ? "red" : dominant;
    const pattern = this.choosePattern(rounds);
    const target = pattern?.target || reversal || dominant;
    if (!target) return null;
    let score = 45;
    if (pattern) score = Math.round(pattern.success * 0.65 + Math.min(100, pattern.cases * 3) * 0.20 + Math.min(100, Math.abs(redP - blackP) * 4) * 0.15);
    if (streak.count >= 3) score = Math.min(96, score + 5);
    const grade = score >= 78 ? "FORTE" : score >= 62 ? "ATENÇÃO" : score < 45 ? "EVITAR" : "NEUTRO";
    return {
      target, score, grade,
      pattern: pattern ? pattern.pattern.map(c => c === "red" ? "V" : "P").join(" • ") : "LEITURA DINÂMICA",
      anchorKey: roundKey(latest), anchorAt: latest.createdAt
    };
  }

  async handleRound(round) {
    const key = roundKey(round);
    if (!key) return;
    const color = normalizeColor(round);
    if (this.operation) {
      if (key === this.operation.anchorKey || key === this.operation.lastProcessedRoundKey) return;
      this.operation.lastProcessedRoundKey = key;
      if (this.operation.phase === "G1") {
        const result = color === this.operation.target ? "WIN G1" : color === "white" ? "WIN BRANCO" : "LOSS";
        await this.settle(result, round);
      } else {
        if (color === this.operation.target) await this.settle("WIN DIRETA", round);
        else if (color === "white") await this.settle("WIN BRANCO", round);
        else {
          this.operation.phase = "G1";
          this.operation.g1StartedAt = roundTime(round);
          await this.sendEvent("G1", this.operation, { firstColor: color });
          this.emitState();
        }
      }
      return;
    }
    if (Date.now() < this.nextSignalAllowedAt) return;
    await this.generateSignal();
  }

  async generateSignal() {
    if (this.operation || Date.now() < this.nextSignalAllowedAt) return;
    const suggestion = this.calculateSuggestion();
    if (!suggestion || suggestion.anchorKey === this.lastSignalAnchorKey) return;
    this.lastSignalAnchorKey = suggestion.anchorKey;
    this.operation = {
      id: `server-color-${suggestion.anchorKey}-${suggestion.target}-${crypto.randomBytes(3).toString("hex")}`,
      ...suggestion,
      phase: "DIRECT",
      createdAt: new Date().toISOString(),
      source: "SIGMA_SERVER_24H"
    };
    await this.sendEvent("SIGNAL", this.operation);
    this.emitState();
  }

  async settle(result, round) {
    if (!this.operation) return;
    const finished = {
      ...this.operation,
      result,
      resolvedAt: roundTime(round),
      resolvedColor: normalizeColor(round),
      phase: "SETTLED"
    };
    await this.sendEvent("RESULT", finished);
    this.recordStats(finished);
    this.history.unshift(finished);
    this.history = this.history.slice(0, 20);
    this.operation = null;
    this.nextSignalAllowedAt = Date.now() + 1000;
    this.emitState();
    await sleep(1000);
    await this.generateSignal();
  }

  eventId(type, operation) { return `${operation.id}:${type}`; }

  async sendEvent(type, operation, extra = {}) {
    const eventId = this.eventId(type, operation);
    if (this.sentEvents.has(eventId)) return;
    this.sentEvents.add(eventId);
    try {
      let text = "";
      if (type === "SIGNAL") {
        text = `Σ SIGMA LEITURA • COLOR\n\n🎯 Entrada: ${colorEmoji(operation.target)} ${colorName(operation.target)}\n⚪ Proteção no branco\n🛡 Cobertura até G1\n📊 Score: ${operation.score}`;
      } else if (type === "G1") {
        text = `🛡 G1 LIBERADO\n\nManter entrada no ${colorEmoji(operation.target)} ${colorName(operation.target)}\n⚪ Proteção no branco`;
      } else if (type === "RESULT") {
        const icon = operation.result === "LOSS" ? "❌" : operation.result === "WIN BRANCO" ? "⚪" : "✅";
        const detail = operation.result === "WIN BRANCO" ? "PROTEÇÃO NO BRANCO" : `${colorEmoji(operation.target)} ${colorName(operation.target)}`;
        text = `${icon} ${operation.result} • SIGMA COLOR\n\n🎯 ${detail}`;
      }
      if (text) await this.sendTelegram(text, operation.telegramMessageId);
    } catch (error) {
      this.sentEvents.delete(eventId);
      throw error;
    }
  }

  async sendTelegram(text, replyToMessageId = null) {
    if (!this.telegramToken || !this.telegramChatId) {
      console.warn("[SIGMA COLOR] Telegram não configurado no Render.");
      return null;
    }
    const body = { chat_id: this.telegramChatId, text, disable_web_page_preview: true };
    if (replyToMessageId) body.reply_to_message_id = replyToMessageId;
    const response = await fetch(`https://api.telegram.org/bot${this.telegramToken}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.description || "Falha no Telegram");
    return data.result;
  }

  emptyStats() { return { signals: 0, wins: 0, losses: 0, whites: 0, direct: 0, g1: 0 }; }

  recordStats(item) {
    const dKey = dayKey(new Date(item.resolvedAt));
    const sKey = halfHourKey(new Date(item.resolvedAt));
    for (const bucket of [this.stats.days[dKey] ||= this.emptyStats(), this.stats.sessions[sKey] ||= this.emptyStats()]) {
      bucket.signals += 1;
      if (item.result === "LOSS") bucket.losses += 1;
      else if (item.result === "WIN BRANCO") bucket.whites += 1;
      else { bucket.wins += 1; if (item.result === "WIN DIRETA") bucket.direct += 1; if (item.result === "WIN G1") bucket.g1 += 1; }
    }
  }

  accuracy(bucket) { return bucket.signals ? Math.round(((bucket.wins || 0) + (bucket.whites || 0)) / bucket.signals * 100) : 0; }

  async processSummaries() {
    if (!this.enabled) return;
    const now = new Date();
    const currentSlot = halfHourKey(now);
    const previousSlot = previousHalfHourKey(now);
    if (this.summaryState.currentSlot && this.summaryState.currentSlot !== currentSlot && this.summaryState.lastSessionSent !== previousSlot) {
      const bucket = this.stats.sessions[previousSlot] || this.emptyStats();
      await this.sendSummary("SESSION", bucket, previousSlot);
      this.summaryState.lastSessionSent = previousSlot;
    }
    this.summaryState.currentSlot = currentSlot;
    const p = dayParts(now), today = dayKey(now);
    if (p.hour === "23" && p.minute === "59" && this.summaryState.lastDailySent !== today) {
      await this.sendSummary("DAILY", this.stats.days[today] || this.emptyStats(), today);
      this.summaryState.lastDailySent = today;
    }
  }

  async sendSummary(type, bucket, period) {
    const title = type === "DAILY" ? "RESULTADO GERAL DO DIA" : "RESULTADO DA SESSÃO • 30 MIN";
    const text = `Σ SIGMA LEITURA • COLOR\n\n⏱ ${title}\n\n📡 Sinais: ${bucket.signals || 0}\n✅ Wins: ${bucket.wins || 0}\n⚪ Brancos: ${bucket.whites || 0}\n❌ Loss: ${bucket.losses || 0}\n📊 Assertividade: ${this.accuracy(bucket)}%`;
    await this.sendTelegram(text);
    console.log(`[SIGMA COLOR] Resumo ${type} enviado: ${period}`);
  }

  emitState() { this.broadcast("reading", this.state()); }
}

module.exports = SigmaColorEngine;
