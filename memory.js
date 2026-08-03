"use strict";

class RoundMemory {
  constructor(limit = 3000, onChange = null) {
    this.limit = Math.max(1, Number(limit) || 3000);
    this.rounds = [];
    this.keys = new Set();
    this.onChange = typeof onChange === "function" ? onChange : null;
  }

  createKey(round) {
    if (round?.id !== undefined && round?.id !== null) return String(round.id);
    return [round?.created_at || round?.createdAt || "", round?.updated_at || round?.updatedAt || "", round?.roll ?? "", round?.color ?? ""].join("|");
  }

  normalize(round) {
    if (!round || typeof round !== "object") return null;
    const roll = Number(round.roll ?? round.number ?? round.value ?? round.result);
    if (!Number.isInteger(roll) || roll < 0 || roll > 14) return null;
    const createdAt = round.created_at ?? round.createdAt ?? round.timestamp ?? round.time ?? round.received_at;
    const date = new Date(createdAt);
    if (!createdAt || Number.isNaN(date.getTime())) return null;
    const colorRaw = Number(round.color);
    const color = roll === 0 ? 0 : colorRaw === 1 || colorRaw === 2 ? colorRaw : roll <= 7 ? 1 : 2;
    return {
      ...round,
      id: String(round.id ?? round.round_id ?? round.uuid ?? `${date.toISOString()}-${roll}`),
      roll,
      color,
      created_at: date.toISOString(),
      status: "complete"
    };
  }

  add(round, notify = true) {
    const normalized = this.normalize(round);
    if (!normalized) return false;
    const key = this.createKey(normalized);
    if (this.keys.has(key)) return false;
    this.rounds.unshift(normalized);
    this.keys.add(key);
    while (this.rounds.length > this.limit) {
      const removed = this.rounds.pop();
      this.keys.delete(this.createKey(removed));
    }
    if (notify) this.onChange?.(this.all());
    return true;
  }

  addMany(items, notify = true) {
    const list = Array.isArray(items) ? items : [];
    const normalized = list.map(item => this.normalize(item)).filter(Boolean)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    let inserted = 0;
    for (const round of normalized) {
      if (this.add(round, false)) inserted += 1;
    }
    if (inserted && notify) this.onChange?.(this.all());
    return inserted;
  }

  load(items) {
    this.rounds = [];
    this.keys.clear();
    return this.addMany(items, false);
  }

  all() { return [...this.rounds]; }
  last() { return this.rounds[0] || null; }
  size() { return this.rounds.length; }

  stats(sampleSize = 50) {
    const sample = this.rounds.slice(0, sampleSize);
    const stats = { total: sample.length, red: 0, black: 0, white: 0, unknown: 0 };
    for (const round of sample) {
      if (round.color === 1) stats.red += 1;
      else if (round.color === 2) stats.black += 1;
      else if (round.color === 0) stats.white += 1;
      else stats.unknown += 1;
    }
    return stats;
  }
}

module.exports = RoundMemory;
