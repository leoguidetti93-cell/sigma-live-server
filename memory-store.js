"use strict";

const fs = require("fs");
const path = require("path");

class MemoryStore {
  constructor(filepath) {
    this.filepath = filepath || process.env.ROUND_MEMORY_FILE || "/var/data/sigma-rounds.json";
    this.timer = null;
    this.lastError = null;
  }

  ensureDirectory() {
    fs.mkdirSync(path.dirname(this.filepath), { recursive: true });
  }

  load() {
    try {
      if (!fs.existsSync(this.filepath)) return [];
      const parsed = JSON.parse(fs.readFileSync(this.filepath, "utf8"));
      return Array.isArray(parsed) ? parsed : Array.isArray(parsed?.rounds) ? parsed.rounds : [];
    } catch (error) {
      this.lastError = error?.message || String(error);
      console.warn(`[MEMORY] Não foi possível restaurar ${this.filepath}: ${this.lastError}`);
      return [];
    }
  }

  schedule(rounds) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.save(rounds), 700);
    this.timer.unref?.();
  }

  save(rounds) {
    try {
      this.ensureDirectory();
      const temporary = `${this.filepath}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ savedAt: new Date().toISOString(), rounds }), "utf8");
      fs.renameSync(temporary, this.filepath);
      this.lastError = null;
      return true;
    } catch (error) {
      this.lastError = error?.message || String(error);
      // Render sem disco persistente: usa diretório local do projeto como fallback.
      if (this.filepath.startsWith("/var/data/")) {
        this.filepath = path.join(__dirname, "data", "sigma-rounds.json");
        return this.save(rounds);
      }
      console.warn(`[MEMORY] Não foi possível salvar: ${this.lastError}`);
      return false;
    }
  }
}

module.exports = MemoryStore;
