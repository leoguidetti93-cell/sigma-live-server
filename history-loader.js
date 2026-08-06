"use strict";

const DEFAULT_SOURCES = [
  "https://blaze.bet.br/api/singleplayer-originals/originals/roulette_games/recent/{page}",
  "https://blaze.com/api/singleplayer-originals/originals/roulette_games/recent/{page}"
];

function extractList(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  const candidates = [data.records, data.rounds, data.data, data.results, data.items, data.payload];
  for (const value of candidates) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") {
      for (const nested of [value.records, value.rounds, value.data, value.results, value.items]) {
        if (Array.isArray(nested)) return nested;
      }
    }
  }
  return [];
}

async function fetchJson(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        accept: "application/json, text/plain, */*",
        "accept-language": "pt-BR,pt;q=0.9,en;q=0.8",
        "cache-control": "no-cache",
        pragma: "no-cache",
        referer: "https://blaze.bet.br/pt/games/double",
        origin: "https://blaze.bet.br",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36"
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

class HistoryLoader {
  constructor({ memory, store, limit = 3000 }) {
    this.memory = memory;
    this.store = store;
    this.limit = Math.max(1, Number(limit) || 3000);
    this.running = false;
    this.lastRunAt = null;
    this.lastInserted = 0;
    this.lastError = null;
    this.lastSource = null;
    this.pagesLoaded = 0;
  }

  state() {
    return {
      running: this.running,
      lastRunAt: this.lastRunAt,
      lastInserted: this.lastInserted,
      lastError: this.lastError,
      lastSource: this.lastSource,
      pagesLoaded: this.pagesLoaded
    };
  }


  async loadRecent() {
    const templates = String(process.env.BLAZE_HISTORY_URLS || "")
      .split(",")
      .map(v => v.trim())
      .filter(Boolean);
    const sources = templates.length ? templates : DEFAULT_SOURCES;
    let lastError = null;

    for (const template of sources) {
      const url = template.includes("{page}") ? template.replace("{page}", "1") : template;
      try {
        const data = await fetchJson(url, 8000);
        const list = extractList(data);
        const normalized = list
          .map(item => this.memory.normalize(item))
          .filter(Boolean)
          .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

        const missing = [];
        for (const round of normalized) {
          const key = this.memory.createKey(round);
          if (!this.memory.keys.has(key)) missing.push(round);
        }
        return missing;
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError) throw lastError;
    return [];
  }

  async load() {
    if (this.running) return this.state();
    this.running = true;
    this.lastRunAt = new Date().toISOString();
    this.lastInserted = 0;
    this.lastError = null;
    this.lastSource = null;
    this.pagesLoaded = 0;

    const maxPages = Math.max(1, Number(process.env.HISTORY_MAX_PAGES || 160));
    const minTarget = Math.min(this.limit, Math.max(20, Number(process.env.HISTORY_TARGET || this.limit)));
    const templates = String(process.env.BLAZE_HISTORY_URLS || "")
      .split(",")
      .map(v => v.trim())
      .filter(Boolean);
    const sources = templates.length ? templates : DEFAULT_SOURCES;

    try {
      for (const template of sources) {
        let sourceInserted = 0;
        let emptyPages = 0;
        for (let page = 1; page <= maxPages && this.memory.size() < minTarget; page += 1) {
          const url = template.includes("{page}") ? template.replace("{page}", String(page)) : template;
          let data;
          try {
            data = await fetchJson(url);
          } catch (error) {
            if (page === 1) throw error;
            break;
          }
          const list = extractList(data);
          if (!list.length) {
            emptyPages += 1;
            if (emptyPages >= 2) break;
            continue;
          }
          const inserted = this.memory.addMany(list, false);
          sourceInserted += inserted;
          this.lastInserted += inserted;
          this.pagesLoaded += 1;
          this.lastSource = template;

          // Página repetida ou sem novidades: provavelmente chegamos ao fim do histórico disponível.
          if (!inserted) emptyPages += 1;
          else emptyPages = 0;
          if (emptyPages >= 2) break;
          await new Promise(resolve => setTimeout(resolve, 35));
        }
        if (sourceInserted || this.memory.size() >= minTarget) break;
      }

      if (this.lastInserted) {
        this.store.save(this.memory.all());
        console.log(`[MEMORY] Backfill HTTP: ${this.lastInserted} rodadas importadas; total=${this.memory.size()}.`);
      } else {
        console.warn(`[MEMORY] Backfill HTTP não encontrou rodadas novas; total=${this.memory.size()}.`);
      }
    } catch (error) {
      this.lastError = error?.name === "AbortError" ? "timeout" : (error?.message || String(error));
      console.warn(`[MEMORY] Backfill HTTP falhou: ${this.lastError}`);
    } finally {
      this.running = false;
    }
    return this.state();
  }
}

module.exports = HistoryLoader;
