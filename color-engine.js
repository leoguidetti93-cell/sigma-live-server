"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

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
    this.stateFile = process.env.COLOR_STATE_FILE || "/var/data/sigma-color-state.json";
    this.stateSaveTimer = null;
    this.loadPersistentState();
  }

  loadPersistentState() {
    try {
      if (!fs.existsSync(this.stateFile)) return;
      const saved = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      if (Array.isArray(saved?.history)) this.history = saved.history.slice(0, 200);
      if (saved?.stats && typeof saved.stats === "object") this.stats = saved.stats;
      if (saved?.summaryState && typeof saved.summaryState === "object") this.summaryState = saved.summaryState;
      console.log(`[SIGMA COLOR] Estado restaurado de ${this.stateFile}.`);
    } catch (error) {
      console.warn(`[SIGMA COLOR] Falha ao restaurar estado: ${error?.message || error}`);
    }
  }

  schedulePersistentState() {
    clearTimeout(this.stateSaveTimer);
    this.stateSaveTimer = setTimeout(() => this.savePersistentState(), 500);
    this.stateSaveTimer.unref?.();
  }

  savePersistentState() {
    const payload = JSON.stringify({
      savedAt: new Date().toISOString(),
      history: this.history.slice(0, 200),
      stats: this.stats,
      summaryState: this.summaryState
    });
    const trySave = file => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, payload, "utf8");
      fs.renameSync(tmp, file);
    };
    try {
      trySave(this.stateFile);
    } catch (error) {
      if (this.stateFile.startsWith("/var/data/")) {
        this.stateFile = path.join(__dirname, "data", "sigma-color-state.json");
        try { trySave(this.stateFile); } catch (_) {}
      }
    }
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
      history: this.history.slice(0, 200),
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

  roundNumber(round) {
    const value = Number(round?.roll ?? round?.number ?? round?.value);
    return Number.isFinite(value) ? value : null;
  }

  sequenceSimilarity(a, b) {
    if (!a.length || a.length !== b.length) return 0;
    let earned = 0, possible = 0;
    for (let i = 0; i < a.length; i++) {
      // As posições mais recentes têm um pouco mais de peso.
      const recencyWeight = 1 + (i / Math.max(1, a.length - 1)) * 0.45;
      const colorWeight = 0.72 * recencyWeight;
      const numberWeight = 0.28 * recencyWeight;
      possible += colorWeight + numberWeight;

      if (a[i].color === b[i].color) earned += colorWeight;

      const na = this.roundNumber(a[i]);
      const nb = this.roundNumber(b[i]);
      if (na !== null && nb !== null) {
        const distance = Math.abs(na - nb);
        earned += numberWeight * Math.max(0, 1 - distance / 14);
      }
    }
    return possible ? earned / possible : 0;
  }

  similarityWindow(rounds, size) {
    if (rounds.length < size + 3) return null;
    const current = rounds.slice(-size);
    const candidates = [];

    // Exclui a própria janela atual e exige duas rodadas posteriores para avaliar Direta/G1.
    for (let end = size - 1; end <= rounds.length - 3; end++) {
      const historical = rounds.slice(end - size + 1, end + 1);
      const similarity = this.sequenceSimilarity(current, historical);
      if (similarity < 0.58) continue;
      candidates.push({ end, similarity });
    }

    candidates.sort((x, y) => y.similarity - x.similarity);
    const selected = candidates.slice(0, 80);
    if (!selected.length) return null;

    const targets = {
      red: { direct: 0, g1: 0, white: 0, loss: 0, weight: 0 },
      black: { direct: 0, g1: 0, white: 0, loss: 0, weight: 0 }
    };

    for (const match of selected) {
      const first = rounds[match.end + 1]?.color;
      const second = rounds[match.end + 2]?.color;
      const w = match.similarity * match.similarity;
      for (const target of ["red", "black"]) {
        const bucket = targets[target];
        bucket.weight += w;
        if (first === target) bucket.direct += w;
        else if (first === "white") bucket.white += w;
        else if (second === target) bucket.g1 += w;
        else if (second === "white") bucket.white += w;
        else bucket.loss += w;
      }
    }

    for (const target of ["red", "black"]) {
      const bucket = targets[target];
      bucket.success = bucket.weight
        ? Math.round(((bucket.direct + bucket.g1 + bucket.white) / bucket.weight) * 100)
        : 0;
    }

    return {
      size,
      matches: selected.length,
      averageSimilarity: Math.round((selected.reduce((sum, item) => sum + item.similarity, 0) / selected.length) * 100),
      targets
    };
  }

  similaritySensor(rounds, target) {
    const configs = [
      { size: 8, weight: 0.45 },
      { size: 15, weight: 0.35 },
      { size: 25, weight: 0.20 }
    ];
    const windows = configs
      .map(config => ({ ...config, result: this.similarityWindow(rounds, config.size) }))
      .filter(item => item.result);

    if (!windows.length) return { score: 50, confidence: 0, matches: 0, windows: [] };

    let weightedScore = 0, effectiveWeight = 0, totalMatches = 0;
    for (const item of windows) {
      const support = Math.min(1, item.result.matches / 20);
      const reliability = item.weight * (0.45 + support * 0.55);
      weightedScore += item.result.targets[target].success * reliability;
      effectiveWeight += reliability;
      totalMatches += item.result.matches;
    }

    const score = effectiveWeight ? Math.round(weightedScore / effectiveWeight) : 50;
    const confidence = Math.min(100, Math.round((totalMatches / (windows.length * 30)) * 100));
    return {
      score,
      confidence,
      matches: totalMatches,
      windows: windows.map(item => ({
        size: item.size,
        matches: item.result.matches,
        similarity: item.result.averageSimilarity,
        success: item.result.targets[target].success
      }))
    };
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
    let baseScore = 45;
    if (pattern) baseScore = Math.round(pattern.success * 0.65 + Math.min(100, pattern.cases * 3) * 0.20 + Math.min(100, Math.abs(redP - blackP) * 4) * 0.15);
    if (streak.count >= 3) baseScore = Math.min(96, baseScore + 5);

    // O novo sensor representa 20% do score. Não há corte novo de sinais nesta versão.
    const similarity = this.similaritySensor(rounds, target);
    const score = Math.max(0, Math.min(99, Math.round(baseScore * 0.80 + similarity.score * 0.20)));
    const grade = score >= 78 ? "FORTE" : score >= 62 ? "ATENÇÃO" : score < 45 ? "EVITAR" : "NEUTRO";
    return {
      target, score, baseScore, grade, similarity,
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
      if (this.operation.phase === "G2") {
        const result = color === this.operation.target ? "WIN G2" : color === "white" ? "WIN BRANCO" : "LOSS";
        await this.settle(result, round);
      } else if (this.operation.phase === "G1") {
        if (color === this.operation.target) await this.settle("WIN G1", round);
        else if (color === "white") await this.settle("WIN BRANCO", round);
        else if (this.operation.g2Enabled) {
          this.operation.phase = "G2";
          this.operation.g2StartedAt = roundTime(round);
          await this.sendEvent("G2", this.operation, { secondColor: color });
          this.emitState();
        } else {
          await this.settle("LOSS", round);
        }
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
      g2Enabled: suggestion.score >= 80,
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
    this.history = this.history.slice(0, 200);
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
        const coverage = operation.g2Enabled
          ? "🛡 Cobertura até G1\n🔥 G2 OPCIONAL HABILITADO"
          : "🛡 Cobertura até G1";
        text = `Σ SIGMA LEITURA • COLOR\n\n🎯 Entrada: ${colorEmoji(operation.target)} ${colorName(operation.target)}\n⚪ Proteção no branco\n${coverage}\n📊 Score: ${operation.score}`;
      } else if (type === "G1") {
        text = `🛡 G1 LIBERADO\n\nManter entrada no ${colorEmoji(operation.target)} ${colorName(operation.target)}\n⚪ Proteção no branco`;
      } else if (type === "G2") {
        text = `🔥 G2 OPCIONAL LIBERADO

Manter entrada no ${colorEmoji(operation.target)} ${colorName(operation.target)}
⚪ Proteção no branco
📊 Score: ${operation.score}`;
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

  emptyStats() { return { signals: 0, wins: 0, losses: 0, whites: 0, direct: 0, g1: 0, g2: 0 }; }

  recordStats(item) {
    const dKey = dayKey(new Date(item.resolvedAt));
    const sKey = halfHourKey(new Date(item.resolvedAt));
    for (const bucket of [this.stats.days[dKey] ||= this.emptyStats(), this.stats.sessions[sKey] ||= this.emptyStats()]) {
      bucket.signals += 1;
      if (item.result === "LOSS") bucket.losses += 1;
      else if (item.result === "WIN BRANCO") bucket.whites += 1;
      else { bucket.wins += 1; if (item.result === "WIN DIRETA") bucket.direct += 1; if (item.result === "WIN G1") bucket.g1 += 1; if (item.result === "WIN G2") bucket.g2 += 1; }
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
      this.schedulePersistentState();
    }
    this.summaryState.currentSlot = currentSlot;
    const p = dayParts(now), today = dayKey(now);
    if (p.hour === "23" && p.minute === "59" && this.summaryState.lastDailySent !== today) {
      await this.sendSummary("DAILY", this.stats.days[today] || this.emptyStats(), today);
      this.summaryState.lastDailySent = today;
      this.schedulePersistentState();
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
