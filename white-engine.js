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
    this.cooldownMs = 2 * 60 * 1000;
    this.cooldownUntil = null;
    this.watchdog = null;
    this.cooldownTimer = null;
    this.summaryTimer = null;
    this.settling = false;
    this.operationArchive = [];
    this.lastHourlySummaryKey = null;
    this.lastDailySummaryKey = null;
  }

  start() {
    console.log(`[SIGMA WHITE] Motor 24h ${this.enabled ? "ATIVO" : "DESATIVADO"}. Telegram=${Boolean(this.telegramToken && this.telegramChatId)}`);
    if (this.enabled) {
      this.ensureProjection();
      this.watchdog = setInterval(() => this.checkOperationTimeout(), 5000);
      this.watchdog.unref?.();
      this.summaryTimer = setInterval(() => this.checkScheduledSummaries().catch(error => console.error("[SIGMA WHITE] resumo", error)), 15000);
      this.summaryTimer.unref?.();
      this.checkScheduledSummaries().catch(error => console.error("[SIGMA WHITE] resumo", error));
    }
  }
  stop() {
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
    if (this.summaryTimer) clearInterval(this.summaryTimer);
    this.watchdog = null;
    this.cooldownTimer = null;
    this.summaryTimer = null;
  }
  chronologicalRounds() {
    return this.memory.all().slice().reverse().map(r => ({ ...r, color: normalizeColor(r), createdAt: roundTime(r) }));
  }
  diagnostics() {
    const rounds = this.chronologicalRounds();
    const { gaps, since } = this.whiteGaps(rounds);
    const whites = rounds.filter(r => r.color === "white").length;
    return {
      rounds: rounds.length,
      whites,
      intervals: gaps.length,
      sinceLastWhite: since,
      ready: gaps.length >= 1,
      quality: gaps.length >= 5 ? "FULL" : gaps.length >= 2 ? "WARMING" : gaps.length >= 1 ? "INITIAL" : "WAITING_WHITE"
    };
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
      cooldownUntil: this.cooldownUntil,
      diagnostics: this.diagnostics(),
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

    // O servidor pode reiniciar sem histórico persistido. Em vez de ficar parado
    // até acumular seis brancos, o motor entra em aquecimento assim que possui
    // ao menos um intervalo real. A referência teórica de 15 rodadas perde peso
    // automaticamente conforme novos intervalos reais são coletados.
    if (gaps.length < 1) return null;

    const recent = gaps.slice(-40);
    const weightTotal = recent.reduce((sum, _, i) => sum + i + 1, 0);
    const weightedObserved = recent.reduce((sum, g, i) => sum + g * (i + 1), 0) / Math.max(1, weightTotal);
    const medObserved = median(recent);
    const observedExpected = weightedObserved * 0.65 + medObserved * 0.35;
    const confidence = clamp(gaps.length / 8, 0.18, 1);
    const theoreticalGap = 15;
    const expected = Math.round(observedExpected * confidence + theoreticalGap * (1 - confidence));

    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    const variance = recent.reduce((a, b) => a + (b - mean) ** 2, 0) / recent.length;
    const spread = Math.sqrt(variance);
    const minuteModel = this.minuteWhiteModel(rounds);
    const recentWhites = rounds.slice(-120).filter(r => r.color === "white").length;
    const recentDensity = recentWhites / Math.max(1, Math.min(120, rounds.length));
    const warmup = gaps.length < 5;

    const now = new Date();
    now.setSeconds(0, 0);
    let best = null;

    for (let minuteOffset = 1; minuteOffset <= 240; minuteOffset += 1) {
      const target = new Date(now.getTime() + minuteOffset * 60000);
      const projectedGap = since + minuteOffset * 2;
      const gapScore = clamp(92 - Math.abs(projectedGap - expected) * 3, 45, 92);
      const localMinute = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", minute: "2-digit" }).format(target));
      const minuteStat = minuteModel[localMinute];
      const minuteRate = minuteStat.total ? minuteStat.white / minuteStat.total : 0;
      // Com amostra curta, minuto sem histórico deve ser neutro, não punitivo.
      const minuteScore = minuteStat.total >= 3
        ? clamp(Math.round(55 + minuteRate * 220), 50, 92)
        : 66;
      const densityScore = clamp(Math.round(70 + (recentDensity - 0.07) * 180), 55, 88);
      const stabilityScore = recent.length >= 3
        ? clamp(Math.round(88 - spread * 2 - Math.abs(weightedObserved - medObserved)), 50, 90)
        : 68;
      const distancePenalty = Math.min(12, Math.floor(minuteOffset / 35));
      let score = clamp(Math.round(
        gapScore * 0.48 +
        minuteScore * 0.22 +
        stabilityScore * 0.20 +
        densityScore * 0.10 -
        distancePenalty
      ), 50, 94);

      // Evita confiança artificialmente alta durante o aquecimento.
      if (warmup) score = Math.min(score, gaps.length >= 3 ? 82 : 78);

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
        sampleQuality: warmup ? "WARMING" : "FULL",
        intervalsUsed: gaps.length,
        reasons: [
          `Intervalo projetado ${projectedGap} rodadas; referência ${expected}.`,
          minuteStat.total ? `Minuto ${String(localMinute).padStart(2, "0")} teve ${Math.round(minuteRate * 100)}% de brancos na amostra.` : "Minuto ainda com pouca recorrência histórica.",
          `Dispersão recente dos intervalos: ${spread.toFixed(1)}.`,
          `${recentWhites} brancos nas últimas ${Math.min(120, rounds.length)} rodadas.`,
          warmup ? `Motor em aquecimento com ${gaps.length} intervalo(s) real(is).` : `Base completa com ${gaps.length} intervalos.`
        ]
      };

      if (!best || candidate.score > best.score || (candidate.score === best.score && targetMs < new Date(best.targetAt).getTime())) {
        best = candidate;
      }
    }

    return best && best.score >= 58 ? best : null;
  }
  async ensureProjection() {
    if (this.active || !this.enabled || this.settling) return;
    if (this.cooldownUntil && Date.now() < new Date(this.cooldownUntil).getTime()) {
      this.emitState();
      return;
    }
    this.cooldownUntil = null;
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
    if (time >= end) {
      // A janela terminou. Mesmo que alguma rodada tenha sido perdida pelo stream,
      // a operação precisa ser encerrada para nunca ficar travada em 4/6 ou 5/6.
      await this.settle("LOSS", "LOSS", null, round);
      return;
    }
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
    if (!this.active || this.settling) return;
    this.settling = true;
    const finished = { ...this.active, status, result, house, resolvedAt: roundTime(round) };
    this.history.unshift(finished);
    this.history = this.history.slice(0, 20);
    if (finished.score >= 72) {
      this.operationArchive.unshift(finished);
      this.operationArchive = this.operationArchive.slice(0, 2500);
      await this.sendResult(finished);
    }
    this.active = null;
    this.cooldownUntil = new Date(Date.now() + this.cooldownMs).toISOString();
    this.settling = false;
    this.emitState();

    if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
    this.cooldownTimer = setTimeout(() => {
      this.cooldownTimer = null;
      this.ensureProjection().catch(error => console.error("[SIGMA WHITE] cooldown", error));
    }, this.cooldownMs + 250);
    this.cooldownTimer.unref?.();
  }


  saoPauloParts(date = new Date()) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
    }).formatToParts(date);
    return Object.fromEntries(parts.map(p => [p.type, p.value]));
  }
  localKey(date = new Date()) {
    const p = this.saoPauloParts(date);
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
  }
  localDateKey(date = new Date()) {
    const p = this.saoPauloParts(date);
    return `${p.year}-${p.month}-${p.day}`;
  }
  localHourKey(date = new Date()) {
    const p = this.saoPauloParts(date);
    return `${p.year}-${p.month}-${p.day}-${p.hour}`;
  }
  localBoundaryToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }) {
    // America/Sao_Paulo is UTC-3 in the current deployment context.
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) + 3, Number(minute), Number(second)));
  }
  periodStats(start, end) {
    const operations = this.operationArchive.filter(op => {
      const t = new Date(op.resolvedAt || op.createdAt).getTime();
      return Number.isFinite(t) && t >= start.getTime() && t < end.getTime();
    });
    const wins = operations.filter(op => op.status === "WIN");
    const losses = operations.filter(op => op.status === "LOSS");
    const whites = this.chronologicalRounds().filter(round => {
      const t = new Date(round.createdAt).getTime();
      return round.color === "white" && Number.isFinite(t) && t >= start.getTime() && t < end.getTime();
    }).length;
    const houses = Array.from({ length: 6 }, (_, i) => wins.filter(op => Number(op.house) === i + 1).length);
    const accuracy = operations.length ? (wins.length / operations.length) * 100 : 0;
    return { signals: operations.length, wins: wins.length, losses: losses.length, whites, houses, accuracy };
  }
  async sendHourlySummary(now = new Date()) {
    const p = this.saoPauloParts(now);
    const end = this.localBoundaryToUtc({ year: p.year, month: p.month, day: p.day, hour: p.hour, minute: 0 });
    const start = new Date(end.getTime() - 60 * 60 * 1000);
    const stats = this.periodStats(start, end);
    const startLabel = fmtTime(start);
    const endLabel = fmtTime(new Date(end.getTime() - 1000));
    const houseLine = stats.wins ? `\n🏠 Casas: C1 ${stats.houses[0]} • C2 ${stats.houses[1]} • C3 ${stats.houses[2]} • C4 ${stats.houses[3]} • C5 ${stats.houses[4]} • C6 ${stats.houses[5]}` : "";
    await this.sendTelegram(`📊 SIGMA WHITE • RESUMO DA HORA\n\n🕒 Período: ${startLabel} às ${endLabel}\n📡 Sinais finalizados: ${stats.signals}\n✅ Wins: ${stats.wins}\n❌ Loss: ${stats.losses}\n⚪ Brancos no período: ${stats.whites}${houseLine}\n🎯 Assertividade: ${stats.accuracy.toFixed(1).replace(".", ",")}%`);
  }
  async sendDailySummary(now = new Date()) {
    const p = this.saoPauloParts(now);
    const start = this.localBoundaryToUtc({ year: p.year, month: p.month, day: p.day, hour: 0, minute: 0 });
    const end = new Date(now.getTime() + 1000);
    const stats = this.periodStats(start, end);
    const houseLine = stats.wins ? `\n🏠 Casas: C1 ${stats.houses[0]} • C2 ${stats.houses[1]} • C3 ${stats.houses[2]} • C4 ${stats.houses[3]} • C5 ${stats.houses[4]} • C6 ${stats.houses[5]}` : "";
    await this.sendTelegram(`📈 SIGMA WHITE • FECHAMENTO DO DIA\n\n📅 Data: ${p.day}/${p.month}/${p.year}\n📡 Sinais finalizados: ${stats.signals}\n✅ Wins: ${stats.wins}\n❌ Loss: ${stats.losses}\n⚪ Brancos no dia: ${stats.whites}${houseLine}\n🎯 Assertividade: ${stats.accuracy.toFixed(1).replace(".", ",")}%`);
  }
  async checkScheduledSummaries() {
    if (!this.enabled || !this.telegramToken || !this.telegramChatId) return;
    const now = new Date();
    const p = this.saoPauloParts(now);
    const minute = Number(p.minute);
    const second = Number(p.second);

    if (minute === 0 && second < 45) {
      const key = this.localHourKey(now);
      if (this.lastHourlySummaryKey !== key) {
        this.lastHourlySummaryKey = key;
        await this.sendHourlySummary(now);
      }
    }

    if (Number(p.hour) === 23 && minute === 59 && second < 45) {
      const key = this.localDateKey(now);
      if (this.lastDailySummaryKey !== key) {
        this.lastDailySummaryKey = key;
        await this.sendDailySummary(now);
      }
    }
  }

  async checkOperationTimeout() {
    if (!this.enabled || !this.active || this.settling) return;
    const end = new Date(this.active.windowEndAt).getTime();
    if (!Number.isFinite(end)) return;
    // Dá 30 segundos de tolerância para atrasos normais do stream.
    if (Date.now() < end + 30000) return;
    const syntheticRound = {
      id: `white-timeout-${Date.now()}`,
      created_at: new Date().toISOString(),
      roll: null,
      color: null
    };
    await this.settle("LOSS", "LOSS", null, syntheticRound);
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
