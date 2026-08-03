"use strict";

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const median = values => {
  if (!values.length) return 0;
  const a = [...values].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

function normalizeColor(round) {
  const roll = Number(round?.roll ?? round?.number ?? round?.value);
  const raw = round?.color;
  if (roll === 0 || raw === 0 || raw === "white") return "white";
  if (raw === 1 || raw === "red" || (roll >= 1 && roll <= 7)) return "red";
  return "black";
}
function roundKey(round) { return String(round?.id ?? round?._id ?? round?.created_at ?? round?.createdAt ?? round?.timestamp ?? ""); }
function roundTime(round) { return round?.created_at || round?.createdAt || round?.timestamp || new Date().toISOString(); }
function fmtTime(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
}

class SigmaWhiteEngine {
  constructor({ memory, broadcast, telegramToken, telegramChatId, enabled = false }) {
    this.memory = memory;
    this.broadcast = typeof broadcast === "function" ? broadcast : () => {};
    this.telegramToken = String(telegramToken || "").trim();
    this.telegramChatId = String(telegramChatId || "").trim();
    this.enabled = enabled;
    this.active = null;
    this.history = [];
    this.processing = Promise.resolve();
    this.lastProcessedRoundKey = "";
  }

  start() {
    console.log(`[SIGMA WHITE] Motor 24h ${this.enabled ? "ATIVO" : "DESATIVADO"}. Telegram=${Boolean(this.telegramToken && this.telegramChatId)}`);
    if (this.enabled) this.ensureProjection();
  }
  stop() {}
  chronologicalRounds() {
    return this.memory.all().slice().reverse().map(r => ({ ...r, color: normalizeColor(r), createdAt: roundTime(r) }));
  }
  state() {
    const wins = this.history.filter(x => x.status === "WIN").length;
    return {
      enabled: this.enabled,
      mode: "SERVER_24H",
      active: this.active,
      history: this.history.slice(0, 20),
      accuracy: this.history.length ? Math.round((wins / this.history.length) * 100) : null,
      telegramConfigured: Boolean(this.telegramToken && this.telegramChatId),
      updatedAt: new Date().toISOString()
    };
  }
  enqueueRound(round) {
    if (!this.enabled || !round) return;
    this.processing = this.processing.then(() => this.handleRound(round)).catch(error => console.error("[SIGMA WHITE]", error));
  }
  whiteGaps(rounds) {
    const idx = [];
    rounds.forEach((r, i) => { if (r.color === "white") idx.push(i); });
    const gaps = [];
    for (let i = 1; i < idx.length; i += 1) gaps.push(idx[i] - idx[i - 1]);
    return { gaps, since: idx.length ? rounds.length - 1 - idx.at(-1) : rounds.length };
  }
  minuteWhiteModel(rounds) {
    const model = Array.from({ length: 60 }, () => ({ white: 0, total: 0 }));
    rounds.forEach(r => {
      const d = new Date(r.createdAt);
      if (Number.isNaN(d.getTime())) return;
      const m = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", minute: "2-digit" }).format(d));
      model[m].total += 1;
      if (r.color === "white") model[m].white += 1;
    });
    return model;
  }
  projectNextWhite() {
    const rounds = this.chronologicalRounds();
    const { gaps, since } = this.whiteGaps(rounds);
    if (gaps.length < 5) return null;
    const recent = gaps.slice(-40);
    const weighted = recent.reduce((sum, g, i) => sum + g * (i + 1), 0) / recent.reduce((sum, _, i) => sum + i + 1, 0);
    const med = median(recent);
    const expected = Math.round(weighted * 0.65 + med * 0.35);
    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    const variance = recent.reduce((a, b) => a + (b - mean) ** 2, 0) / recent.length;
    const spread = Math.sqrt(variance);
    const minuteModel = this.minuteWhiteModel(rounds);
    const recentWhites = rounds.slice(-120).filter(r => r.color === "white").length;
    const recentDensity = recentWhites / Math.max(1, Math.min(120, rounds.length));
    const now = new Date(); now.setSeconds(0, 0);
    let best = null;
    for (let minuteOffset = 1; minuteOffset <= 240; minuteOffset += 1) {
      const target = new Date(now.getTime() + minuteOffset * 60000);
      const projectedGap = since + minuteOffset * 2;
      const gapScore = clamp(92 - Math.abs(projectedGap - expected) * 3, 45, 92);
      const localMinute = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", minute: "2-digit" }).format(target));
      const minuteStat = minuteModel[localMinute];
      const minuteRate = minuteStat.total ? minuteStat.white / minuteStat.total : 0;
      const minuteScore = clamp(Math.round(55 + minuteRate * 220), 50, 92);
      const densityScore = clamp(Math.round(70 + (recentDensity - 0.07) * 180), 55, 88);
      const stabilityScore = clamp(Math.round(88 - spread * 2 - Math.abs(weighted - med)), 50, 90);
      const distancePenalty = Math.min(12, Math.floor(minuteOffset / 35));
      const score = clamp(Math.round(gapScore * 0.42 + minuteScore * 0.28 + stabilityScore * 0.20 + densityScore * 0.10 - distancePenalty), 50, 94);
      const targetMs = target.getTime();
      const candidate = {
        id: `server-white-${targetMs}`,
        targetAt: target.toISOString(),
        createdAt: new Date().toISOString(),
        score,
        expectedGap: expected,
        sinceAtProjection: since,
        status: "WAITING",
        classification: score >= 72 ? "ACTIVE" : "OBSERVATION",
        windowStartAt: new Date(targetMs - 60000).toISOString(),
        windowEndAt: new Date(targetMs + 120000).toISOString(),
        processedHouses: 0,
        reasons: [
          `Intervalo projetado ${projectedGap} rodadas; referência ${expected}.`,
          minuteStat.total ? `Minuto ${String(localMinute).padStart(2, "0")} teve ${Math.round(minuteRate * 100)}% de brancos na amostra.` : "Minuto ainda com pouca recorrência histórica.",
          `Dispersão recente dos intervalos: ${spread.toFixed(1)}.`,
          `${recentWhites} brancos nas últimas ${Math.min(120, rounds.length)} rodadas.`
        ]
      };
      if (!best || candidate.score > best.score || (candidate.score === best.score && targetMs < new Date(best.targetAt).getTime())) best = candidate;
    }
    return best && best.score >= 60 ? best : null;
  }
  async ensureProjection() {
    if (this.active || !this.enabled) return;
    const candidate = this.projectNextWhite();
    if (!candidate) return;
    this.active = candidate;
    if (candidate.score >= 72) await this.sendSignal(candidate);
    this.emitState();
  }
  async handleRound(round) {
    const key = roundKey(round);
    if (!key || key === this.lastProcessedRoundKey) return;
    this.lastProcessedRoundKey = key;
    if (!this.active) { await this.ensureProjection(); return; }
    const time = new Date(roundTime(round)).getTime();
    const start = new Date(this.active.windowStartAt).getTime();
    const end = new Date(this.active.windowEndAt).getTime();
    if (time < start) {
      const candidate = this.projectNextWhite();
      if (candidate && Date.now() < start && (candidate.score >= this.active.score + 3 || (candidate.score >= 72 && this.active.score < 72))) {
        this.active = candidate;
        if (candidate.score >= 72) await this.sendSignal(candidate);
        this.emitState();
      }
      return;
    }
    if (time >= end) return;
    this.active.status = "IN_OPERATION";
    this.active.processedHouses = Math.min(6, (this.active.processedHouses || 0) + 1);
    if (normalizeColor(round) === "white") {
      await this.settle("WIN", `WIN CASA ${this.active.processedHouses}`, this.active.processedHouses, round);
      return;
    }
    if (this.active.processedHouses >= 6) {
      await this.settle("LOSS", "LOSS", null, round);
      return;
    }
    this.emitState();
  }
  async settle(status, result, house, round) {
    const finished = { ...this.active, status, result, house, resolvedAt: roundTime(round) };
    this.history.unshift(finished);
    this.history = this.history.slice(0, 20);
    if (finished.score >= 72) await this.sendResult(finished);
    this.active = null;
    this.emitState();
    await this.ensureProjection();
  }
  async sendTelegram(text) {
    if (!this.telegramToken || !this.telegramChatId) return null;
    const response = await fetch(`https://api.telegram.org/bot${this.telegramToken}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: this.telegramChatId, text, disable_web_page_preview: true })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.description || "Falha no Telegram WHITE");
    return data.result;
  }
  async sendSignal(operation) {
    if (operation.telegramSignalSent) return;
    operation.telegramSignalSent = true;
    await this.sendTelegram(`Σ SIGMA LEITURA • WHITE\n\n⚪ BRANCO PROJETADO\n\n⏰ Horário central: ${fmtTime(operation.targetAt)}\n🕒 Janela: ${fmtTime(operation.windowStartAt)} até ${fmtTime(new Date(new Date(operation.targetAt).getTime() + 60000))}\n🎯 Margem: 6 casas\n📊 Score: ${operation.score}`);
  }
  async sendResult(operation) {
    const text = operation.status === "WIN"
      ? `✅ WHITE PAGO • CASA ${operation.house}\n\n⏰ Projeção: ${fmtTime(operation.targetAt)}\n📊 Score: ${operation.score}`
      : `❌ WHITE LOSS\n\n⏰ Projeção: ${fmtTime(operation.targetAt)}\n📊 Score: ${operation.score}`;
    await this.sendTelegram(text);
  }
  emitState() { this.broadcast("white-reading", this.state()); }
}

module.exports = SigmaWhiteEngine;
