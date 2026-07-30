"use strict";

class RoundStore {
  constructor({ supabase, table = "sigma_double_rounds", limit = 3000 }) {
    this.supabase = supabase;
    this.table = table;
    this.limit = limit;
  }

  get enabled() { return Boolean(this.supabase); }

  normalize(row) {
    const payload = row?.payload && typeof row.payload === "object" ? row.payload : {};
    return {
      ...payload,
      id: String(row.round_id ?? payload.id ?? ""),
      roll: Number(row.roll ?? payload.roll),
      color: Number(row.color ?? payload.color),
      created_at: row.created_at ?? payload.created_at,
      updated_at: row.updated_at ?? payload.updated_at ?? null,
      status: row.status ?? payload.status ?? "complete"
    };
  }

  async loadLatest() {
    if (!this.enabled) return [];
    const { data, error } = await this.supabase
      .from(this.table)
      .select("round_id, roll, color, created_at, updated_at, status, payload")
      .order("created_at", { ascending: false })
      .limit(this.limit);
    if (error) throw error;
    return (data || []).map(row => this.normalize(row));
  }

  async save(round) {
    if (!this.enabled || !round?.id) return false;
    const { error } = await this.supabase.from(this.table).upsert({
      round_id: String(round.id),
      roll: Number(round.roll),
      color: Number(round.color),
      created_at: round.created_at ?? round.createdAt,
      updated_at: round.updated_at ?? round.updatedAt ?? null,
      status: round.status || "complete",
      payload: round
    }, { onConflict: "round_id" });
    if (error) throw error;
    return true;
  }

  async prune() {
    if (!this.enabled) return;
    const { data, error } = await this.supabase
      .from(this.table)
      .select("created_at")
      .order("created_at", { ascending: false })
      .range(this.limit - 1, this.limit - 1);
    if (error) throw error;
    const cutoff = data?.[0]?.created_at;
    if (!cutoff) return;
    const { error: deleteError } = await this.supabase
      .from(this.table)
      .delete()
      .lt("created_at", cutoff);
    if (deleteError) throw deleteError;
  }
}

module.exports = RoundStore;