"use strict";

class RoundMemory {
  constructor(limit = 1000) {
    this.limit = limit;
    this.rounds = [];
    this.keys = new Set();
  }

  createKey(round) {
    if (round.id !== undefined && round.id !== null) return String(round.id);
    return [round.created_at || "", round.updated_at || "", round.roll ?? "", round.color ?? ""].join("|");
  }

  add(round) {
    const key = this.createKey(round);
    if (this.keys.has(key)) return false;
    this.rounds.unshift(round);
    this.keys.add(key);
    while (this.rounds.length > this.limit) {
      const removed = this.rounds.pop();
      this.keys.delete(this.createKey(removed));
    }
    return true;
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
