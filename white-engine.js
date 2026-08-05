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
    this.evaluationTimer = null;
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
    this.historyFile = process.env.WHITE_HISTORY_FILE || "/var/data/sigma-white-history.json";
    this.learning = {
      version: 2,
      operations: 0,
      sensors: {
        gap: { mae: 0.30, n: 0 },
        minute: { mae: 0.30, n: 0 },
        pressure: { mae: 0.30, n: 0 },
        density: { mae: 0.30, n: 0 },
        dispersion: { mae: 0.30, n: 0 },
        similarity: { mae: 0.26, n: 0 },
        patterns: { mae: 0.30, n: 0 }
      }
    };
    this.loadLearning();
    this.loadHistoryState();
  }


  loadHistoryState() {
    try {
      if (!fs.existsSync(this.historyFile)) return;
      const saved = JSON.parse(fs.readFileSync(this.historyFile, "utf8"));
      if (Array.isArray(saved?.history)) this.history = saved.history.slice(0, 200);
      this.lastHourlySummaryKey = saved?.lastHourlySummaryKey || this.lastHourlySummaryKey;
      this.lastDailySummaryKey = saved?.lastDailySummaryKey || this.lastDailySummaryKey;
      console.log(`[SIGMA WHITE] Histórico restaurado de ${this.historyFile}.`);
    } catch (error) {
      console.warn(`[SIGMA WHITE] Falha ao restaurar histórico: ${error?.message || error}`);
    }
  }

  saveHistoryState() {
    const payload = JSON.stringify({
      savedAt: new Date().toISOString(),
      history: this.history.slice(0, 200),
      lastHourlySummaryKey: this.lastHourlySummaryKey,
      lastDailySummaryKey: this.lastDailySummaryKey
    });
    const trySave = file => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, payload, "utf8");
      fs.renameSync(tmp, file);
    };
    try {
      trySave(this.historyFile);
    } catch (error) {
      if (this.historyFile.startsWith("/var/data/")) {
        this.historyFile = path.join(__dirname, "data", "sigma-white-history.json");
        try { trySave(this.historyFile); } catch (_) {}
      }
    }
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
        if (!this.learning.sensors.patterns) this.learning.sensors.patterns = { mae: 0.30, n: 0 };
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
    // Índice único de força (0 a 10). A similaridade atua apenas como bônus
    // pequeno e nunca funciona como trava isolada.
    return {
      gap: 2.4,
      pressure: 2.0,
      density: 1.5,
      dispersion: 1.1,
      minute: 1.0,
      similarity: 0.5,
      patterns: 1.5
    };
  }
  minimumForce() { return 6.2; }
  signalTier(force) {
    if (force >= 8.5) return "ELITE";
    if (force >= 7.4) return "FORTE";
    return "NORMAL";
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
  patternToken(round, mode) {
    const color = normalizeColor(round);
    const roll = Number(round?.roll ?? round?.number ?? round?.value);
    if (mode === "number" && Number.isFinite(roll)) return `N${roll}`;
    return color === "red" ? "R" : color === "black" ? "B" : "W";
  }
  patternLabel(tokens) {
    return tokens.map(token => token === "R" ? "🔴" : token === "B" ? "⚫" : token === "W" ? "⚪" : token.replace(/^N/, "")).join(" + ");
  }
  recurringWhitePatternSensor(rounds, minuteOffset) {
    // Padrões ativos são avaliados sobre a sequência que acabou de acontecer.
    // A contribuição cai rapidamente para projeções distantes, pois um padrão
    // curto é especialmente útil para as próximas seis casas.
    const proximity = clamp(1 - Math.max(0, minuteOffset - 2) / 6, 0, 1);
    if (rounds.length < 250 || proximity <= 0) return { strength: 0, probability: 0.33, cases: 0, hits: 0, label: "—", qualified: false, proximity };
    const variants = [];
    for (const length of [2, 3, 4]) {
      if (rounds.length <= length + 12) continue;
      variants.push(Array(length).fill("color"));
      variants.push(Array(length).fill("number"));
      variants.push([...Array(Math.max(0, length - 1)).fill("color"), "number"]);
      if (length >= 3) variants.push([...Array(length - 2).fill("color"), "number", "number"]);
    }
    let best = null;
    for (const modes of variants) {
      const length = modes.length;
      const currentTokens = rounds.slice(-length).map((round, idx) => this.patternToken(round, modes[idx]));
      let cases = 0, hits = 0, weightedHits = 0, weightedCases = 0;
      const houseHits = [0,0,0,0,0,0];
      const maxEnd = rounds.length - 7;
      for (let end = length - 1; end < maxEnd; end += 1) {
        let match = true;
        for (let j = 0; j < length; j += 1) {
          if (this.patternToken(rounds[end - length + 1 + j], modes[j]) !== currentTokens[j]) { match = false; break; }
        }
        if (!match) continue;
        cases += 1;
        // Ocorrências mais recentes têm peso discretamente maior, sem apagar o histórico.
        const recency = 0.65 + 0.35 * (end / Math.max(1, maxEnd));
        weightedCases += recency;
        let hit = false;
        for (let h = 1; h <= 6; h += 1) {
          if (normalizeColor(rounds[end + h]) === "white") {
            hit = true;
            houseHits[h - 1] += 1;
          }
        }
        if (hit) { hits += 1; weightedHits += recency; }
      }
      if (cases < 6) continue;
      const rawRate = weightedCases ? weightedHits / weightedCases : hits / cases;
      const prior = 0.34;
      const shrink = cases / (cases + 14);
      const probability = rawRate * shrink + prior * (1 - shrink);
      const sampleConfidence = clamp((cases - 6) / 28, 0, 1);
      const quality = clamp((probability - 0.34) / 0.38, 0, 1);
      const strength = clamp(quality * (0.50 + 0.50 * sampleConfidence) * proximity, 0, 1);
      const candidate = {
        modes, tokens: currentTokens, label: this.patternLabel(currentTokens), cases, hits,
        hitRate: hits / Math.max(1, cases), probability, strength, houseHits,
        qualified: cases >= 12 && probability >= 0.58 && strength >= 0.35,
        proximity
      };
      if (!best || candidate.strength > best.strength || (candidate.strength === best.strength && candidate.cases > best.cases)) best = candidate;
    }
    return best || { strength: 0, probability: 0.33, cases: 0, hits: 0, label: "—", qualified: false, proximity };
  }
  updateLearning(operation) {
    const y = Number(operation.whitesCaptured || 0) > 0 ? 1 : 0;
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
      // Avalia imediatamente após o restore da memória. O atraso curto evita
      // competir com a inicialização do socket e garante que o estado apareça
      // no site mesmo antes da próxima rodada ao vivo.
      setTimeout(() => {
        this.processing = this.processing
          .then(() => this.ensureProjection())
          .catch(error => console.error("[SIGMA WHITE] avaliação inicial", error));
      }, 1200).unref?.();

      // Gatilho independente: se o stream atrasar ou não chegar rodada nova,
      // o candidato continua sendo recalculado e publicado no site.
      this.evaluationTimer = setInterval(() => {
        this.processing = this.processing
          .then(() => this.ensureProjection(true))
          .catch(error => console.error("[SIGMA WHITE] avaliação periódica", error));
      }, 15000);
      this.evaluationTimer.unref?.();

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
    if (this.evaluationTimer) clearInterval(this.evaluationTimer);
    this.watchdog = null;
    this.cooldownTimer = null;
    this.summaryTimer = null;
    this.evaluationTimer = null;
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
    const wins = this.history.filter(x => Number(x.whitesCaptured || 0) > 0).length;
    return {
      enabled: this.enabled,
      mode: "SERVER_24H",
      active: this.active,
      history: this.history.slice(0, 200),
      accuracy: this.history.length ? Math.round((wins / this.history.length) * 100) : null,
      telegramConfigured: Boolean(this.telegramToken && this.telegramChatId),
      cooldownUntil: this.cooldownUntil,
      diagnostics: this.diagnostics(),
      learning: { operations: this.learning.operations || 0, weights: this.sensorWeights(), sensors: this.learning.sensors },
      whiteDebug: this.whiteDebug,
      observationTracking: this.observationTracking.slice(0, 50),
      observationArchive: this.observationArchive.slice(0, 500),
      operationArchive: this.operationArchive.slice(0, 500),
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
      const recurringPattern = this.recurringWhitePatternSensor(rounds, minuteOffset);
      const patternProbability = recurringPattern.probability;

      const components = {
        gap: { probability: gapProbability },
        pressure: { probability: pressureProbability, percentile: pressurePercentile },
        density: { probability: densityProbability },
        dispersion: { probability: dispersionProbability },
        minute: { probability: minuteProbability },
        similarity: { probability: similarityProbability, matches: similarity.matches, confidence: similarity.confidence },
        patterns: {
          probability: patternProbability, strength: Number((recurringPattern.strength * 100).toFixed(1)),
          label: recurringPattern.label, cases: recurringPattern.cases, hits: recurringPattern.hits,
          hitRate: Number((recurringPattern.hitRate || 0).toFixed(4)), qualified: recurringPattern.qualified,
          houseHits: recurringPattern.houseHits || [0,0,0,0,0,0]
        }
      };
      const normalized = {
        gap: this.normalizeSensor(gapProbability, 0.06, 0.84),
        pressure: this.normalizeSensor(pressureProbability, 0.10, 0.78),
        density: this.normalizeSensor(densityProbability, 0.10, 0.68),
        dispersion: this.normalizeSensor(dispersionProbability, 0.12, 0.72),
        minute: this.normalizeSensor(minuteProbability, 0.08, 0.78),
        similarity: this.normalizeSensor(similarityProbability, 0.05, 0.92),
        patterns: recurringPattern.strength
      };
      Object.entries(normalized).forEach(([key, strength]) => {
        components[key].strength = Number((strength * 100).toFixed(1));
      });
      const favorableSensors = Object.values(normalized).filter(v => v >= 0.55).length;
      const force = (
        normalized.gap * weights.gap +
        normalized.pressure * weights.pressure +
        normalized.density * weights.density +
        normalized.dispersion * weights.dispersion +
        normalized.minute * weights.minute +
        normalized.similarity * weights.similarity +
        normalized.patterns * weights.patterns
      );
      const probability = clamp(force / 10, 0.05, 0.98);

      const targetMs = target.getTime();
      const candidate = {
        id: `server-white-v3-${targetMs}`,
        engineVersion: "BRANCO_V4_FORCA_PADROES_INTELIGENTES",
        targetAt: target.toISOString(), createdAt: new Date().toISOString(),
        force: Number(force.toFixed(2)), score: Math.round(force * 10),
        signalTier: this.signalTier(force), probability: Number(probability.toFixed(4)), expectedGap: Math.round(expected), sinceAtProjection: since,
        status: "WAITING", classification: force >= this.minimumForce() ? "ACTIVE" : "OBSERVATION",
        windowStartAt: new Date(targetMs - 60000).toISOString(),
        windowEndAt: new Date(targetMs + 120000).toISOString(), processedHouses: 0,
        sampleQuality: gaps.length >= 40 ? "FULL" : gaps.length >= 12 ? "MODERATE" : "LOW",
        intervalsUsed: gaps.length, favorableSensors, components, sensorWeights: weights,
        reasons: [
          `Padrão ativo: ${recurringPattern.label}; ${recurringPattern.cases} ocorrências, ${(patternProbability * 100).toFixed(0)}% de branco até C6; contribuição ${(recurringPattern.strength * weights.patterns).toFixed(2)}/${weights.patterns.toFixed(1)}.`,
          `Similaridade contextual: ${similarity.matches} cenários; chance histórica ${(similarityProbability * 100).toFixed(0)}% (bônus máximo 0,5).`,
          `Força integrada: ${force.toFixed(2)}/10,0 (mínimo ${this.minimumForce().toFixed(1)}).`,
          `Intervalo projetado ${projectedGap}; referência ${Math.round(expected)}.`,
          `Pressão estatística: percentil ${(pressurePercentile * 100).toFixed(0)}%.`,
          `Minuto ${String(localMinute).padStart(2, "0")}: taxa ajustada ${(minuteProbability * 100).toFixed(0)}%.`,
          `Fontes favoráveis: ${favorableSensors}/7; decisão feita pela força integrada.`,
          `Aprendizado contínuo: ${this.learning.operations || 0} operações avaliadas.`
        ]
      };
      if (!best || candidate.force > best.force || (candidate.force === best.force && targetMs < new Date(best.targetAt).getTime())) best = candidate;
    }
    this.whiteDebug = {
      evaluated,
      bestScore: best?.score ?? null,
      bestForce: best?.force ?? null,
      bestVotes: best?.favorableSensors ?? null,
      bestTargetAt: best?.targetAt ?? null,
      bestClassification: best?.classification ?? null,
      lastEvaluationAt: new Date().toISOString(),
      status: best ? (best.classification === "ACTIVE" ? "SIGNAL_READY" : "OBSERVING") : "NO_CANDIDATE",
      minimumForce: this.minimumForce(),
      rule: `Força integrada ${this.minimumForce().toFixed(1)}+ em escala de 0 a 10, incluindo padrões recorrentes`
    };
    // Mantém sempre o melhor candidato visível em observação, mesmo com score baixo.
    // A publicação no Telegram continua restrita às regras de score e consenso.
    return best || null;
  }
  async ensureProjection(forceRefresh = false) {
    if (!this.enabled || this.settling) return;
    if (this.active && (!forceRefresh || this.active.classification === "ACTIVE" || this.active.status === "IN_OPERATION")) return;
    if (this.cooldownUntil && Date.now() < new Date(this.cooldownUntil).getTime()) {
      this.emitState();
      return;
    }
    this.cooldownUntil = null;
    const candidate = this.projectNextWhite();
    if (!candidate) {
      this.emitState();
      return;
    }
    // No modo observação, o candidato pode mudar a cada avaliação. Uma operação
    // já publicada nunca é substituída.
    this.active = candidate;
    if (candidate.classification === "ACTIVE") await this.sendSignal(candidate);
    else this.beginObservationTracking(candidate);
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
        candidate.force >= this.active.force + 0.30 ||
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
    this.active.status = "IN_OPERATION";
    this.active.processedHouses = Math.min(6, (this.active.processedHouses || 0) + 1);
    if (!Array.isArray(this.active.whiteHouses)) this.active.whiteHouses = [];
    if (normalizeColor(round) === "white") {
      this.active.whiteHouses.push(this.active.processedHouses);
      this.active.whiteHouses = [...new Set(this.active.whiteHouses)].sort((a, b) => a - b);
      this.active.whitesCaptured = this.active.whiteHouses.length;
    }
    if (this.active.processedHouses >= 6) {
      const count = this.active.whiteHouses.length;
      await this.settle(count ? "WIN" : "LOSS", count ? this.classifyWhiteResult(this.active.whiteHouses) : "LOSS", this.active.whiteHouses[0] || null, round);
      return;
    }
    this.emitState();
  }
  beginObservationTracking(candidate) {
    if (!candidate || this.observationTracking.some(x => x.id === candidate.id)) return;
    this.observationTracking.unshift({
      ...candidate, status: "OBSERVING_RESULT", processedHouses: 0, whiteHouses: [], whitesCaptured: 0,
      observationStartedAt: new Date().toISOString()
    });
    this.observationTracking = this.observationTracking.slice(0, 120);
  }
  async processObservationRound(round, timeMs) {
    if (!this.observationTracking.length) return;
    const color = normalizeColor(round);
    const finished = [];
    for (const obs of this.observationTracking) {
      const start = new Date(obs.windowStartAt).getTime();
      const end = new Date(obs.windowEndAt).getTime();
      if (!Number.isFinite(start) || !Number.isFinite(end) || timeMs < start) continue;
      if (timeMs > end + 30000 && (obs.processedHouses || 0) < 6) {
        const count = Array.isArray(obs.whiteHouses) ? obs.whiteHouses.length : 0;
        finished.push({ ...obs, status: count ? "WIN" : "LOSS", result: count ? this.classifyWhiteResult(obs.whiteHouses) : "LOSS", whiteHouses: obs.whiteHouses || [], whitesCaptured: count, resolvedAt: roundTime(round) });
        continue;
      }
      obs.processedHouses = Math.min(6, (obs.processedHouses || 0) + 1);
      if (!Array.isArray(obs.whiteHouses)) obs.whiteHouses = [];
      if (color === "white") {
        obs.whiteHouses.push(obs.processedHouses);
        obs.whiteHouses = [...new Set(obs.whiteHouses)].sort((a, b) => a - b);
      }
      if (obs.processedHouses >= 6) {
        const count = obs.whiteHouses.length;
        finished.push({
          ...obs,
          status: count ? "WIN" : "LOSS",
          result: count ? this.classifyWhiteResult(obs.whiteHouses) : "LOSS",
          house: obs.whiteHouses[0] || null,
          whiteHouses: obs.whiteHouses,
          whitesCaptured: count,
          resolvedAt: roundTime(round)
        });
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

  classifyWhiteResult(houses) {
    const list = [...new Set((houses || []).map(Number).filter(n => n >= 1 && n <= 6))].sort((a, b) => a - b);
    if (!list.length) return "LOSS";
    if (list.length === 1) return `BRANCO PAGO • CASA ${list[0]}`;
    if (list.length === 2) {
      const distance = list[1] - list[0];
      if (distance === 1) return "BRANCO PAGO • DUPLO";
      if (distance === 2) return "BRANCO PAGO • ESPELHADO";
      if (distance === 3) return "BRANCO PAGO • DENTADO";
      if (distance === 4) return "BRANCO PAGO • BANGUELO";
      return "BRANCO PAGO • 2 BRANCOS NA OPERAÇÃO";
    }
    const consecutive = list.every((value, index) => index === 0 || value === list[index - 1] + 1);
    if (list.length === 3 && consecutive) return "BRANCO PAGO • TRIPLO";
    return `BRANCO PAGO • ${list.length} BRANCOS NA OPERAÇÃO`;
  }

  async settle(status, result, house, round) {
    if (!this.active || this.settling) return;
    this.settling = true;
    const whiteHouses = Array.isArray(this.active.whiteHouses) ? [...this.active.whiteHouses] : [];
    const finished = { ...this.active, status, result, house, whiteHouses, whitesCaptured: whiteHouses.length, resolvedAt: roundTime(round) };
    this.history.unshift(finished);
    this.history = this.history.slice(0, 200);
    this.saveHistoryState();
    if (finished.classification === "ACTIVE" || Number(finished.force) >= this.minimumForce()) {
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
    const losses = operations.filter(op => Number(op.whitesCaptured || 0) === 0);
    const capturedWhites = operations.reduce((sum, op) => sum + Number(op.whitesCaptured || 0), 0);
    const payingOperations = operations.filter(op => Number(op.whitesCaptured || 0) > 0);
    const realWhites = this.chronologicalRounds().filter(round => {
      const t = new Date(round.createdAt).getTime();
      return round.color === "white" && Number.isFinite(t) && t >= start.getTime() && t < end.getTime();
    }).length;
    const houseCaptures = Array.from({ length: 6 }, (_, i) => operations.filter(op => (op.whiteHouses || []).includes(i + 1)).length);
    const captureRate = operations.length ? capturedWhites / operations.length : 0;
    const coverage = realWhites ? capturedWhites / realWhites * 100 : 0;
    const observations = this.observationArchive.filter(op => {
      const t = new Date(op.resolvedAt || op.createdAt).getTime();
      return Number.isFinite(t) && t >= start.getTime() && t < end.getTime();
    });
    const observationWhites = observations.reduce((sum, op) => sum + Number(op.whitesCaptured || 0), 0);
    const observationPaying = observations.filter(op => Number(op.whitesCaptured || 0) > 0);
    const observationLosses = observations.filter(op => Number(op.whitesCaptured || 0) === 0);
    return {
      signals: operations.length,
      payingOperations: payingOperations.length,
      losses: losses.length,
      capturedWhites,
      realWhites,
      houseCaptures,
      captureRate,
      coverage,
      observations,
      observationWhites,
      observationPaying,
      observationLosses
    };
  }
  async sendHourlySummary(now = new Date()) {
    const p = this.saoPauloParts(now);
    const end = this.localBoundaryToUtc({ year: p.year, month: p.month, day: p.day, hour: p.hour, minute: 0 });
    const start = new Date(end.getTime() - 60 * 60 * 1000);
    const stats = this.periodStats(start, end);
    const startLabel = fmtTime(start);
    const endLabel = fmtTime(new Date(end.getTime() - 1000));
    const houseLine = stats.capturedWhites ? `
🏠 Capturas: C1 ${stats.houseCaptures[0]} • C2 ${stats.houseCaptures[1]} • C3 ${stats.houseCaptures[2]} • C4 ${stats.houseCaptures[3]} • C5 ${stats.houseCaptures[4]} • C6 ${stats.houseCaptures[5]}` : "";
    await this.sendTelegram(`📊 SIGMA ⚪ BRANCO • RESUMO DA HORA

🕒 Período: ${startLabel} às ${endLabel}
📡 Operações finalizadas: ${stats.signals}
⚪ Brancos capturados: ${stats.capturedWhites}
✅ Operações com branco: ${stats.payingOperations}
❌ Operações sem branco: ${stats.losses}
⚪ Brancos reais no período: ${stats.realWhites}${houseLine}
🎯 Média: ${stats.captureRate.toFixed(2).replace(".", ",")} branco/operação
📈 Cobertura dos brancos do período: ${stats.coverage.toFixed(1).replace(".", ",")}%`);
  }
  forceBucket(force) {
    if (force >= 8.5) return "8,5+";
    if (force >= 7.4) return "7,4-8,4";
    if (force >= 6.2) return "6,2-7,3";
    if (force >= 5.0) return "5,0-6,1";
    if (force >= 4.0) return "4,0-4,9";
    return "<4,0";
  }
  async sendDailySummary(now = new Date()) {
    const p = this.saoPauloParts(now);
    const start = this.localBoundaryToUtc({ year: p.year, month: p.month, day: p.day, hour: 0, minute: 0 });
    const end = new Date(now.getTime() + 1000);
    const stats = this.periodStats(start, end);
    const operations = this.operationArchive.filter(op => {
      const t = new Date(op.resolvedAt || op.createdAt).getTime();
      return Number.isFinite(t) && t >= start.getTime() && t < end.getTime();
    });
    const all = [...stats.observations, ...operations];
    const buckets = { "8,5+":0, "7,4-8,4":0, "6,2-7,3":0, "5,0-6,1":0, "4,0-4,9":0, "<4,0":0 };
    all.forEach(x => { buckets[this.forceBucket(Number(x.force) || 0)] += 1; });
    const avgForce = items => items.length ? items.reduce((a,b) => a + (Number(b.force)||0),0) / items.length : 0;
    const paying = operations.filter(x => Number(x.whitesCaptured || 0) > 0);
    const losses = operations.filter(x => Number(x.whitesCaptured || 0) === 0);
    const sensorNames = { gap:"Intervalo", pressure:"Pressão", density:"Densidade", dispersion:"Dispersão", minute:"Minuto", similarity:"Similaridade", patterns:"Padrões" };
    const sensorLine = group => Object.entries(sensorNames).map(([k,n]) => {
      const vals = group.map(x => Number(x.components?.[k]?.strength)).filter(Number.isFinite);
      return `${n}: ${vals.length ? (vals.reduce((a,b)=>a+b,0)/vals.length).toFixed(1).replace(".", ",") : "0,0"}%`;
    }).join("\n");
    const patterns = {};
    operations.filter(x => x.whitesCaptured > 1).forEach(x => { patterns[x.result] = (patterns[x.result] || 0) + 1; });
    const patternText = Object.keys(patterns).length ? Object.entries(patterns).map(([k,v]) => `${k.replace("BRANCO PAGO • ", "")}: ${v}`).join(" • ") : "Nenhum múltiplo";
    const text = `📈 SIGMA ⚪ BRANCO • FECHAMENTO DO DIA

📅 Data: ${p.day}/${p.month}/${p.year}
📡 Operações finalizadas: ${stats.signals}
⚪ Brancos capturados nas operações: ${stats.capturedWhites}
✅ Operações com pelo menos 1 branco: ${stats.payingOperations}
❌ Operações sem branco: ${stats.losses}
⚪ Brancos reais no dia: ${stats.realWhites}
🎯 Média: ${stats.captureRate.toFixed(2).replace(".", ",")} branco/operação
📈 Cobertura dos brancos do dia: ${stats.coverage.toFixed(1).replace(".", ",")}%
🏠 Capturas: C1 ${stats.houseCaptures[0]} • C2 ${stats.houseCaptures[1]} • C3 ${stats.houseCaptures[2]} • C4 ${stats.houseCaptures[3]} • C5 ${stats.houseCaptures[4]} • C6 ${stats.houseCaptures[5]}
🧬 Múltiplos: ${patternText}

🧠 DIAGNÓSTICO TÉCNICO
👀 Observações concluídas: ${stats.observations.length}
⚪ Brancos que seriam capturados nas observações: ${stats.observationWhites}
✅ Observações com branco: ${stats.observationPaying.length}
❌ Observações sem branco: ${stats.observationLosses.length}
🎯 Média nas observações: ${stats.observations.length ? (stats.observationWhites/stats.observations.length).toFixed(2).replace(".", ",") : "0,00"} branco/observação

📚 Força: 8,5+ ${buckets["8,5+"]} • 7,4-8,4 ${buckets["7,4-8,4"]} • 6,2-7,3 ${buckets["6,2-7,3"]} • 5,0-6,1 ${buckets["5,0-6,1"]} • 4,0-4,9 ${buckets["4,0-4,9"]} • <4,0 ${buckets["<4,0"]}

⚡ Força média com branco: ${avgForce(paying).toFixed(2).replace(".", ",")}
⚡ Força média sem branco: ${avgForce(losses).toFixed(2).replace(".", ",")}
📈 Maior força: ${all.length ? Math.max(...all.map(x=>Number(x.force)||0)).toFixed(2).replace(".", ",") : "0,00"}
📉 Menor força publicada: ${operations.length ? Math.min(...operations.map(x=>Number(x.force)||0)).toFixed(2).replace(".", ",") : "0,00"}

🧩 Sensores médios — operações com branco
${sensorLine(paying)}

🧩 Sensores médios — operações sem branco
${sensorLine(losses)}`;
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
      this.saveHistoryState();
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
    if (!this.enabled || this.settling) return;
    if (!this.active) {
      await this.ensureProjection(true);
      return;
    }
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
    const count = Array.isArray(this.active.whiteHouses) ? this.active.whiteHouses.length : 0;
    await this.settle(count ? "WIN" : "LOSS", count ? this.classifyWhiteResult(this.active.whiteHouses) : "LOSS", this.active.whiteHouses?.[0] || null, syntheticRound);
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
    operation.whiteHouses = [];
    operation.whitesCaptured = 0;
    await this.sendTelegram(`Σ SIGMA LEITURA • ⚪️ BRANCO

⏰ Horário central: ${fmtTime(operation.targetAt)}
🕒 Janela: ${fmtTime(operation.windowStartAt)} até ${fmtTime(new Date(new Date(operation.targetAt).getTime() + 60000))}

⚡️ Força: ${Number(operation.force || 0).toFixed(2).replace(".", ",")} / 10,0`);
  }
  async sendResult(operation) {
    if (operation.status === "WIN") {
      const whiteHouses = Array.isArray(operation.whiteHouses) ? operation.whiteHouses : [];
      const houses = whiteHouses.map(h => `C${h}`).join(" • ");
      const houseLabel = whiteHouses.length === 1 ? "🏠 Casa" : "🏠 Casas";
      await this.sendTelegram(`✅⚪️ ${operation.result}

⏰ Projeção: ${fmtTime(operation.targetAt)}
${houseLabel}: ${houses || "—"}
⚪️ Brancos capturados: ${operation.whitesCaptured || 0}`);
      return;
    }
    await this.sendTelegram(`❌ ⚪️ BRANCO NÃO OCORREU

⏰ Projeção: ${fmtTime(operation.targetAt)}
⚪️ Brancos capturados: 0`);
  }
  emitState() { this.broadcast("white-reading", this.state()); }
}

module.exports = SigmaWhiteEngine;
