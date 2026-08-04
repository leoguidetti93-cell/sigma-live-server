"use strict";

const fs = require("fs");
const path = require("path");
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
    this.observationArchive = [];
    this.observationTracking = [];
    this.lastHourlySummaryKey = null;
    this.lastDailySummaryKey = null;
    this.whiteDebug = {
      evaluated: 0,
      bestScore: null,
      bestVotes: null,
      bestTargetAt: null,
      bestClassification: null,
      lastEvaluationAt: null,
      status: "NOT_EVALUATED"
    };
    this.learningFile = process.env.WHITE_LEARNING_FILE || "/var/data/sigma-white-learning.json";
    this.learning = {
      version: 2,
      operations: 0,
      sensors: {
        gap: { mae: 0.30, n: 0 },
        minute: { mae: 0.30, n: 0 },
        pressure: { mae: 0.30, n: 0 },
        density: { mae: 0.30, n: 0 },
        dispersion: { mae: 0.30, n: 0 },
        similarity: { mae: 0.26, n: 0 }
      }
    };
    this.loadLearning();
  }


  loadLearning() {
    try {
      if (!fs.existsSync(this.learningFile)) return;
      const saved = JSON.parse(fs.readFileSync(this.learningFile, "utf8"));
      if (saved?.learning?.sensors) {
        this.learning = saved.learning;
        // Migração transparente do nome antigo "stability" para "dispersion".
        if (!this.learning.sensors.dispersion && this.learning.sensors.stability) {
          this.learning.sensors.dispersion = this.learning.sensors.stability;
        }
        if (!this.learning.sensors.pressure) this.learning.sensors.pressure = { mae: 0.30, n: 0 };
        delete this.learning.sensors.stability;
      }
      if (Array.isArray(saved?.operationArchive)) this.operationArchive = saved.operationArchive.slice(0, 2500);
      if (Array.isArray(saved?.observationArchive)) this.observationArchive = saved.observationArchive.slice(0, 5000);
      console.log(`[SIGMA WHITE V2] Aprendizado restaurado: ${this.learning.operations || 0} operações.`);
    } catch (error) {
      console.warn(`[SIGMA WHITE V2] Falha ao restaurar aprendizado: ${error?.message || error}`);
    }
  }
  saveLearning() {
    const payload = JSON.stringify({ savedAt: new Date().toISOString(), learning: this.learning, operationArchive: this.operationArchive.slice(0, 2500), observationArchive: this.observationArchive.slice(0, 5000) });
    const trySave = file => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, payload, "utf8");
      fs.renameSync(tmp, file);
    };
    try {
      trySave(this.learningFile);
    } catch (error) {
      if (this.learningFile.startsWith("/var/data/")) {
        this.learningFile = path.join(__dirname, "data", "sigma-white-learning.json");
        try { trySave(this.learningFile); } catch (_) {}
      }
    }
  }
  sensorWeights() {
    // Calibração experimental solicitada para o WHITE V2.1.
    // Os pesos ficam fixos durante este teste; o aprendizado contínuo segue
    // registrando desempenho dos sensores, sem alterar esta distribuição.
    return {
      gap: 0.32,
      pressure: 0.22,
      density: 0.15,
      dispersion: 0.10,
      minute: 0.10,
      similarity: 0.11
    };
  }
  patternSimilarity(rounds, aEnd, bEnd, length) {
    let score = 0;
    let weight = 0;
    for (let j = 0; j < length; j += 1) {
      const a = rounds[aEnd - j];
      const b = rounds[bEnd - j];
      if (!a || !b) return 0;
      const w = 1 + (length - j) / length;
      weight += w;
      if (a.color === b.color) score += w * 0.72;
      const ar = Number(a.roll ?? a.number ?? a.value);
      const br = Number(b.roll ?? b.number ?? b.value);
      if (Number.isFinite(ar) && Number.isFinite(br)) {
        if (ar === br) score += w * 0.28;
        else if (a.color === b.color && Math.abs(ar - br) <= 2) score += w * 0.12;
      }
    }
    return weight ? clamp(score / weight, 0, 1) : 0;
  }
  similarityForecast(rounds, since, horizonRounds) {
    const currentEnd = rounds.length - 1;
    const windows = [8, 15, 25].filter(n => rounds.length > n + horizonRounds + 8);
    if (!windows.length) return { probability: 0.18, matches: 0, confidence: 0, agreement: 0 };
    const matches = [];
    let lastWhite = -1;
    const sinceAt = [];
    rounds.forEach((r, i) => { if (r.color === "white") lastWhite = i; sinceAt[i] = lastWhite >= 0 ? i - lastWhite : i + 1; });
    const maxAnchor = rounds.length - horizonRounds - 4;
    for (let i = Math.max(30, windows.at(-1)); i < maxAnchor; i += 1) {
      const sinceDiff = Math.abs((sinceAt[i] || 0) - since);
      if (sinceDiff > 10) continue;
      const sims = windows.map(n => this.patternSimilarity(rounds, currentEnd, i, n));
      const sim = sims.reduce((a, b, idx) => a + b * ([0.42, 0.36, 0.22][idx] || 0.2), 0) / sims.reduce((a, _, idx) => a + ([0.42, 0.36, 0.22][idx] || 0.2), 0);
      const sinceScore = clamp(1 - sinceDiff / 11, 0, 1);
      const combined = sim * 0.82 + sinceScore * 0.18;
      if (combined < 0.61) continue;
      const start = i + Math.max(1, horizonRounds - 2);
      const end = i + horizonRounds + 3;
      const hit = rounds.slice(start, end + 1).some(r => r?.color === "white");
      matches.push({ combined, hit });
    }
    matches.sort((a, b) => b.combined - a.combined);
    const top = matches.slice(0, 80);
    if (top.length < 5) return { probability: 0.18, matches: top.length, confidence: top.length / 5 * 0.35, agreement: 0 };
    let hitWeight = 0, totalWeight = 0;
    top.forEach(m => { const w = m.combined ** 3; totalWeight += w; if (m.hit) hitWeight += w; });
    const raw = totalWeight ? hitWeight / totalWeight : 0;
    const prior = 0.33;
    const shrink = top.length / (top.length + 18);
    const probability = raw * shrink + prior * (1 - shrink);
    const agreement = Math.abs(raw - 0.5) * 2;
    return { probability: clamp(probability, 0.05, 0.92), matches: top.length, confidence: clamp(top.length / 45, 0, 1), agreement };
  }
  updateLearning(operation) {
    const y = operation.status === "WIN" ? 1 : 0;
    const components = operation.components || {};
    Object.entries(this.learning.sensors).forEach(([key, sensor]) => {
      const p = clamp(Number(components[key]?.probability ?? components[key] ?? 0.5), 0.02, 0.98);
      const error = Math.abs(y - p);
      const alpha = sensor.n < 25 ? 0.12 : 0.045;
      sensor.mae = sensor.n ? sensor.mae * (1 - alpha) + error * alpha : error;
      sensor.n = (sensor.n || 0) + 1;
    });
    this.learning.operations = (this.learning.operations || 0) + 1;
    this.saveLearning();
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
      learning: { operations: this.learning.operations || 0, weights: this.sensorWeights(), sensors: this.learning.sensors },
      whiteDebug: this.whiteDebug,
      observationTracking: this.observationTracking.slice(0, 10),
      observationArchiveCount: this.observationArchive.length,
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
  normalizeSensor(value, min, max) {
    return clamp((Number(value) - min) / Math.max(0.0001, max - min), 0, 1);
  }
  calibrateScore(rawStrength) {
    const points = [[0,30],[20,42],[40,55],[50,64],[60,72],[70,80],[80,88],[90,94],[100,98]];
    const x = clamp(Number(rawStrength) || 0, 0, 100);
    for (let i = 1; i < points.length; i += 1) {
      const [x1, y1] = points[i - 1];
      const [x2, y2] = points[i];
      if (x <= x2) return Math.round(y1 + ((x - x1) / (x2 - x1)) * (y2 - y1));
    }
    return 98;
  }
  signalTier(score) {
    if (score >= 93) return "ELITE";
    if (score >= 85) return "FORTE";
    return "NORMAL";
  }

  projectNextWhite() {
    const rounds = this.chronologicalRounds();
    const { gaps, since } = this.whiteGaps(rounds);
    if (gaps.length < 5 || rounds.length < 300) {
      this.whiteDebug = {
        evaluated: 0, bestScore: null, bestVotes: null, bestTargetAt: null,
        bestClassification: null, lastEvaluationAt: new Date().toISOString(),
        status: gaps.length < 5 ? "WAITING_INTERVALS" : "WAITING_MEMORY",
        rounds: rounds.length, intervals: gaps.length
      };
      return null;
    }

    const recent = gaps.slice(-60);
    const weightTotal = recent.reduce((sum, _, i) => sum + i + 1, 0);
    const weightedObserved = recent.reduce((sum, g, i) => sum + g * (i + 1), 0) / Math.max(1, weightTotal);
    const medObserved = median(recent);
    const expected = weightedObserved * 0.62 + medObserved * 0.38;
    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    const variance = recent.reduce((a, b) => a + (b - mean) ** 2, 0) / recent.length;
    const spread = Math.sqrt(variance);
    const minuteModel = this.minuteWhiteModel(rounds);
    const recentWhites = rounds.slice(-120).filter(r => r.color === "white").length;
    const recentDensity = recentWhites / Math.max(1, Math.min(120, rounds.length));
    const weights = this.sensorWeights();

    const now = new Date();
    now.setSeconds(0, 0);
    let best = null;
    let evaluated = 0;

    for (let minuteOffset = 2; minuteOffset <= 240; minuteOffset += 1) {
      evaluated += 1;
      const target = new Date(now.getTime() + minuteOffset * 60000);
      const horizonRounds = minuteOffset * 2;
      const projectedGap = since + horizonRounds;
      const gapProbability = clamp(0.12 + 0.72 * Math.exp(-Math.abs(projectedGap - expected) / Math.max(5, spread + 3)), 0.06, 0.84);
      const localMinute = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", minute: "2-digit" }).format(target));
      const minuteStat = minuteModel[localMinute];
      const minuteRate = minuteStat.total ? minuteStat.white / minuteStat.total : recentDensity;
      const minuteProbability = clamp(0.12 + minuteRate * 3.2, 0.08, 0.78);
      const dispersionProbability = clamp(0.68 - spread / 45, 0.12, 0.72);
      const densityProbability = clamp(0.16 + recentDensity * 3.0, 0.10, 0.68);

      // Pressão estatística: mede o quanto o intervalo projetado avançou dentro
      // da distribuição real dos intervalos entre brancos. Quanto maior o
      // percentil, maior a pressão, mas sem transformar atraso em certeza.
      const sortedGaps = [...recent].sort((a, b) => a - b);
      const pressurePercentile = sortedGaps.filter(g => g <= projectedGap).length / Math.max(1, sortedGaps.length);
      const pressureProbability = clamp(0.12 + pressurePercentile * 0.66, 0.10, 0.78);

      const similarity = this.similarityForecast(rounds, since, horizonRounds);
      const similarityProbability = similarity.probability;

      const components = {
        gap: { probability: gapProbability },
        pressure: { probability: pressureProbability, percentile: pressurePercentile },
        density: { probability: densityProbability },
        dispersion: { probability: dispersionProbability },
        minute: { probability: minuteProbability },
        similarity: { probability: similarityProbability, matches: similarity.matches, confidence: similarity.confidence }
      };
      Object.entries(normalized).forEach(([key, strength]) => { components[key].strength = Number((strength * 100).toFixed(1)); });
      const normalized = {
        gap: this.normalizeSensor(gapProbability, 0.06, 0.84),
        pressure: this.normalizeSensor(pressureProbability, 0.10, 0.78),
        density: this.normalizeSensor(densityProbability, 0.10, 0.68),
        dispersion: this.normalizeSensor(dispersionProbability, 0.12, 0.72),
        minute: this.normalizeSensor(minuteProbability, 0.08, 0.78),
        similarity: this.normalizeSensor(similarityProbability, 0.05, 0.92)
      };
      const consensusVotes = Object.values(normalized).filter(v => v >= 0.55).length;
      const rawStrength = (
        normalized.gap * weights.gap +
        normalized.pressure * weights.pressure +
        normalized.density * weights.density +
        normalized.dispersion * weights.dispersion +
        normalized.minute * weights.minute +
        normalized.similarity * weights.similarity
      ) * 100;
      const score = this.calibrateScore(rawStrength);
      const probability = clamp(score / 100, 0.30, 0.98);

      const targetMs = target.getTime();
      const candidate = {
        id: `server-white-v2-${targetMs}`,
        engineVersion: "WHITE_V2_3_SCORE_NORMALIZADO_TELEMETRIA",
        targetAt: target.toISOString(), createdAt: new Date().toISOString(), score, rawScore: Number(rawStrength.toFixed(1)),
        signalTier: this.signalTier(score), probability: Number(probability.toFixed(4)), expectedGap: Math.round(expected), sinceAtProjection: since,
        status: "WAITING", classification: score >= 72 && (consensusVotes >= 4 || (score >= 79 && consensusVotes >= 3)) ? "ACTIVE" : "OBSERVATION",
        windowStartAt: new Date(targetMs - 60000).toISOString(),
        windowEndAt: new Date(targetMs + 120000).toISOString(), processedHouses: 0,
        sampleQuality: gaps.length >= 40 ? "FULL" : gaps.length >= 12 ? "MODERATE" : "LOW",
        intervalsUsed: gaps.length, consensusVotes, components, sensorWeights: weights,
        reasons: [
          `Similaridade: ${similarity.matches} cenários; chance histórica ${(similarityProbability * 100).toFixed(0)}%.`,
          `Consenso: ${consensusVotes}/6 sensores favoráveis (${score >= 79 ? "mínimo 3" : "mínimo 4"}).`,
          `Intervalo projetado ${projectedGap}; referência ${Math.round(expected)}.`,
          `Pressão estatística: percentil ${(pressurePercentile * 100).toFixed(0)}%.`,
          `Minuto ${String(localMinute).padStart(2, "0")}: taxa ajustada ${(minuteProbability * 100).toFixed(0)}%.`,
          `Score-base normalizado: ${rawStrength.toFixed(1)}; calibrado: ${score}.`,
          `Aprendizado contínuo: ${this.learning.operations || 0} operações avaliadas.`
        ]
      };
      if (!best || candidate.score > best.score || (candidate.score === best.score && targetMs < new Date(best.targetAt).getTime())) best = candidate;
    }
    this.whiteDebug = {
      evaluated,
      bestScore: best?.score ?? null,
      bestVotes: best?.consensusVotes ?? null,
      bestTargetAt: best?.targetAt ?? null,
      bestClassification: best?.classification ?? null,
      lastEvaluationAt: new Date().toISOString(),
      status: best ? (best.classification === "ACTIVE" ? "SIGNAL_READY" : "OBSERVING") : "NO_CANDIDATE",
      minimumScore: 72,
      rule: "72-78: 4/6 | 79+: 3/6"
    };
    // Mantém sempre o melhor candidato visível em observação, mesmo com score baixo.
    // A publicação no Telegram continua restrita às regras de score e consenso.
    return best || null;
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
    if (candidate.classification === "ACTIVE") await this.sendSignal(candidate);
    this.emitState();
  }
  async handleRound(round) {
    const key = roundKey(round);
    if (!key || key === this.lastProcessedRoundKey) return;
    this.lastProcessedRoundKey = key;
    if (!this.active) { await this.ensureProjection(); return; }
    const time = new Date(roundTime(round)).getTime();
    await this.processObservationRound(round, time);
    const start = new Date(this.active.windowStartAt).getTime();
    const end = new Date(this.active.windowEndAt).getTime();
    if (time < start) {
      const candidate = this.projectNextWhite();
      const currentWasActive = this.active.classification === "ACTIVE";
      const candidateIsActive = candidate?.classification === "ACTIVE";
      const shouldReplace = candidate && Date.now() < start && (
        !currentWasActive ||
        candidate.score >= this.active.score + 3 ||
        (candidateIsActive && !currentWasActive)
      );
      if (shouldReplace) {
        this.active = candidate;
        if (candidateIsActive && !currentWasActive) await this.sendSignal(candidate);
        this.emitState();
      }
      return;
    }
    if (time >= start && this.active.classification !== "ACTIVE") {
      this.beginObservationTracking(this.active);
      this.active = null;
      this.emitState();
      await this.ensureProjection();
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
  beginObservationTracking(candidate) {
    if (!candidate || this.observationTracking.some(x => x.id === candidate.id)) return;
    this.observationTracking.unshift({
      ...candidate, status: "OBSERVING_RESULT", processedHouses: 0,
      observationStartedAt: new Date().toISOString()
    });
    this.observationTracking = this.observationTracking.slice(0, 12);
  }
  async processObservationRound(round, timeMs) {
    if (!this.observationTracking.length) return;
    const color = normalizeColor(round);
    const finished = [];
    for (const obs of this.observationTracking) {
      const start = new Date(obs.windowStartAt).getTime();
      const end = new Date(obs.windowEndAt).getTime();
      if (!Number.isFinite(start) || !Number.isFinite(end) || timeMs < start) continue;
      if (timeMs >= end) { finished.push({ ...obs, status: "LOSS", result: "LOSS", resolvedAt: roundTime(round) }); continue; }
      obs.processedHouses = Math.min(6, (obs.processedHouses || 0) + 1);
      if (color === "white") {
        finished.push({ ...obs, status: "WIN", result: `WIN CASA ${obs.processedHouses}`, house: obs.processedHouses, resolvedAt: roundTime(round) });
      } else if (obs.processedHouses >= 6) {
        finished.push({ ...obs, status: "LOSS", result: "LOSS", resolvedAt: roundTime(round) });
      }
    }
    if (finished.length) {
      const ids = new Set(finished.map(x => x.id));
      this.observationTracking = this.observationTracking.filter(x => !ids.has(x.id));
      finished.forEach(item => this.observationArchive.unshift(item));
      this.observationArchive = this.observationArchive.slice(0, 5000);
      this.saveLearning();
    }
  }

  async settle(status, result, house, round) {
    if (!this.active || this.settling) return;
    this.settling = true;
    const finished = { ...this.active, status, result, house, resolvedAt: roundTime(round) };
    this.history.unshift(finished);
    this.history = this.history.slice(0, 20);
    if (finished.classification === "ACTIVE" || finished.score >= 72) {
      this.operationArchive.unshift(finished);
      this.operationArchive = this.operationArchive.slice(0, 2500);
      this.updateLearning(finished);
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
    const observations = this.observationArchive.filter(op => {
      const t = new Date(op.resolvedAt || op.createdAt).getTime();
      return Number.isFinite(t) && t >= start.getTime() && t < end.getTime();
    });
    const observationWins = observations.filter(op => op.status === "WIN");
    const observationLosses = observations.filter(op => op.status === "LOSS");
    const observationAccuracy = observations.length ? observationWins.length / observations.length * 100 : 0;
    return { signals: operations.length, wins: wins.length, losses: losses.length, whites, houses, accuracy, observations, observationWins, observationLosses, observationAccuracy };
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
  scoreBucket(score) {
    if (score >= 93) return "93+";
    if (score >= 90) return "90-92";
    if (score >= 85) return "85-89";
    if (score >= 80) return "80-84";
    if (score >= 72) return "72-79";
    if (score >= 60) return "60-71";
    if (score >= 50) return "50-59";
    return "<50";
  }
  async sendDailySummary(now = new Date()) {
    const p = this.saoPauloParts(now);
    const start = this.localBoundaryToUtc({ year: p.year, month: p.month, day: p.day, hour: 0, minute: 0 });
    const end = new Date(now.getTime() + 1000);
    const stats = this.periodStats(start, end);
    const houseLine = stats.wins ? `\n🏠 Casas: C1 ${stats.houses[0]} • C2 ${stats.houses[1]} • C3 ${stats.houses[2]} • C4 ${stats.houses[3]} • C5 ${stats.houses[4]} • C6 ${stats.houses[5]}` : "";
    const all = [...stats.observations, ...this.operationArchive.filter(op => { const t = new Date(op.resolvedAt || op.createdAt).getTime(); return Number.isFinite(t) && t >= start.getTime() && t < end.getTime(); })];
    const buckets = { "93+":0, "90-92":0, "85-89":0, "80-84":0, "72-79":0, "60-71":0, "50-59":0, "<50":0 };
    all.forEach(x => { buckets[this.scoreBucket(Number(x.score) || 0)] += 1; });
    const published = all.filter(x => x.classification === "ACTIVE" || Number(x.score) >= 72);
    const avg = items => items.length ? items.reduce((a,b) => a + (Number(b.score)||0),0) / items.length : 0;
    const winOps = published.filter(x => x.status === "WIN");
    const lossOps = published.filter(x => x.status === "LOSS");
    const sensorNames = { gap:"Intervalo", pressure:"Pressão", density:"Densidade", dispersion:"Dispersão", minute:"Minuto", similarity:"Similaridade" };
    const sensorStats = {};
    Object.keys(sensorNames).forEach(key => {
      const vals = all.map(x => Number(x.components?.[key]?.strength)).filter(Number.isFinite);
      sensorStats[key] = vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : 0;
    });
    const text = `📈 SIGMA WHITE • FECHAMENTO DO DIA\n\n📅 Data: ${p.day}/${p.month}/${p.year}\n📡 Sinais finalizados: ${stats.signals}\n✅ Wins: ${stats.wins}\n❌ Loss: ${stats.losses}\n⚪ Brancos no dia: ${stats.whites}${houseLine}\n🎯 Assertividade: ${stats.accuracy.toFixed(1).replace(".", ",")}%\n\n🧠 DIAGNÓSTICO TÉCNICO\n👀 Observações avaliadas: ${stats.observations.length}\n⚪ Observações que pagariam: ${stats.observationWins.length}\n❌ Observações que falhariam: ${stats.observationLosses.length}\n📊 Acerto das observações: ${stats.observationAccuracy.toFixed(1).replace(".", ",")}%\n\n📚 Scores: 93+ ${buckets["93+"]} • 90-92 ${buckets["90-92"]} • 85-89 ${buckets["85-89"]} • 80-84 ${buckets["80-84"]} • 72-79 ${buckets["72-79"]} • 60-71 ${buckets["60-71"]} • 50-59 ${buckets["50-59"]} • <50 ${buckets["<50"]}\n\n📐 Score médio WIN: ${avg(winOps).toFixed(1).replace(".", ",")}\n📐 Score médio LOSS: ${avg(lossOps).toFixed(1).replace(".", ",")}\n📈 Maior score: ${all.length ? Math.max(...all.map(x=>Number(x.score)||0)) : 0}\n📉 Menor score publicado: ${published.length ? Math.min(...published.map(x=>Number(x.score)||0)) : 0}\n\n🧩 Força média dos sensores\n${Object.entries(sensorNames).map(([k,n]) => `${n}: ${sensorStats[k].toFixed(1).replace(".", ",")}%`).join("\n")}`;
    await this.sendTelegram(text);
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
    const tier = operation.signalTier || this.signalTier(operation.score);
    const header = tier === "ELITE" ? "👑 SIGMA WHITE • SINAL ELITE" : tier === "FORTE" ? "🔥 SIGMA WHITE • SINAL FORTE" : "Σ SIGMA LEITURA • WHITE";
    const badge = tier === "ELITE" ? "\n🚨 CENÁRIO RARÍSSIMO • 90+" : tier === "FORTE" ? "\n💪 CONFIANÇA ELEVADA" : "";
    const strengths = Object.entries(operation.components || {}).sort((a,b)=>(b[1].strength||0)-(a[1].strength||0)).slice(0,3).map(([k,v]) => `✔ ${({gap:"Intervalo",pressure:"Pressão",density:"Densidade",dispersion:"Dispersão",minute:"Minuto",similarity:"Similaridade"})[k]} ${Number(v.strength||0).toFixed(0)}%`).join("\n");
    await this.sendTelegram(`${header}\n\n⚪ BRANCO PROJETADO\n\n⏰ Horário central: ${fmtTime(operation.targetAt)}\n🕒 Janela: ${fmtTime(operation.windowStartAt)} até ${fmtTime(new Date(new Date(operation.targetAt).getTime() + 60000))}\n🎯 Margem: 6 casas\n📊 Score: ${operation.score} (base ${operation.rawScore ?? "—"})${badge}${strengths ? `\n\n${strengths}` : ""}`);
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
