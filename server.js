"use strict";

const express = require("express");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const config = require("./config");
const RoundMemory = require("./memory");
const MemoryStore = require("./memory-store");
const BlazeLiveSocket = require("./socket");
const SigmaColorEngine = require("./color-engine");
const SigmaWhiteEngine = require("./white-engine");
const HistoryLoader = require("./history-loader");

const APP_VERSION = "1.5.9";
const ACCESS_TABLE = "sigma_access";
const LICENSE_CHARACTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LICENSE_LENGTH = 6;

const app = express();
const memoryStore = new MemoryStore(process.env.ROUND_MEMORY_FILE);
const memory = new RoundMemory(config.memoryLimit, rounds => memoryStore.schedule(rounds));
const restoredRounds = memoryStore.load();
const restoredCount = memory.load(restoredRounds);
if (restoredCount) console.log(`[MEMORY] ${restoredCount} rodadas restauradas de ${memoryStore.filepath}.`);
const historyLoader = new HistoryLoader({ memory, store: memoryStore, limit: config.memoryLimit });
const clients = new Set();
let colorEngine = null;
let whiteEngine = null;

const supabaseUrl = String(process.env.SUPABASE_URL || "").trim();
const supabaseSecretKey = String(
  process.env.SUPABASE_SECRET_KEY || ""
).trim();

const sigmaAdminToken = String(
  process.env.SIGMA_ADMIN_TOKEN || ""
).trim();

const telegramBotToken = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
const telegramChatId = String(process.env.TELEGRAM_CHAT_ID || "").trim();
const sigmaColor24hEnabled = String(process.env.SIGMA_COLOR_24H_ENABLED || "true").toLowerCase() !== "false";
const telegramWhiteChatId = String(
  process.env.TELEGRAM_WHITE_CHAT_ID ||
  process.env.TELEGRAM_WHITE_GROUP_ID ||
  ""
).trim();

function envFlag(value, fallback = false) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["false", "0", "off", "no", "disabled"].includes(normalized)) return false;
  if (["true", "1", "on", "yes", "enabled"].includes(normalized)) return true;
  return fallback;
}

// Se o Chat ID WHITE estiver configurado, o motor fica ativo por padrão.
// A variável SIGMA_WHITE_24H_ENABLED ainda pode desligá-lo explicitamente.
const whiteEnabledRaw =
  process.env.SIGMA_WHITE_24H_ENABLED ??
  process.env.SIGMA_WHITE_ENABLED ??
  "";
const sigmaWhite24hEnabled = envFlag(
  whiteEnabledRaw,
  Boolean(telegramWhiteChatId)
);

const supabase =
  supabaseUrl && supabaseSecretKey
    ? createClient(supabaseUrl, supabaseSecretKey, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false
        }
      })
    : null;

const live = new BlazeLiveSocket({
  url: config.blazeSocketUrl,
  origin: config.blazeOrigin,
  reconnectMinMs: config.reconnectMinMs,
  reconnectMaxMs: config.reconnectMaxMs,
  staleConnectionMs: config.staleConnectionMs
});

function corsOrigin(origin, callback) {
  if (
    !origin ||
    config.allowedOrigins.includes("*") ||
    config.allowedOrigins.includes(origin)
  ) {
    callback(null, true);
    return;
  }

  callback(
    new Error("Origin não autorizado pelo SIGMA LIVE SERVER.")
  );
}

app.use(
  cors({
    origin: corsOrigin,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Sigma-Admin-Token"
    ],
    credentials: false
  })
);

app.use(express.json({ limit: "8mb" }));

const adminPublicDir = path.join(__dirname, "public");
app.use("/admin", express.static(adminPublicDir, { index: false, maxAge: "1h" }));
app.get(["/admin", "/admin/"], (_req, res) => {
  res.sendFile(path.join(adminPublicDir, "index.html"));
});

function normalizeText(value, maxLength = 100) {
  return String(value || "")
    .trim()
    .slice(0, maxLength);
}

function normalizePlan(value) {
  const plan = normalizeText(value || "TRIAL", 30).toUpperCase();

  const allowedPlans = [
    "TRIAL",
    "MENSAL",
    "TRIMESTRAL",
    "SEMESTRAL",
    "ANUAL",
    "VITALICIO"
  ];

  return allowedPlans.includes(plan) ? plan : "TRIAL";
}

function calculateLicenseExpiration(plan, baseDate = new Date()) {
  const daysByPlan = {
    TRIAL: 7,
    MENSAL: 30,
    TRIMESTRAL: 90,
    SEMESTRAL: 180,
    ANUAL: 365
  };

  if (plan === "VITALICIO") return null;

  const days = daysByPlan[plan] || daysByPlan.TRIAL;
  const expiration = new Date(baseDate);
  expiration.setUTCDate(expiration.getUTCDate() + days);
  return expiration.toISOString();
}

function generateLicenseKey() {
  let key = "";

  for (let index = 0; index < LICENSE_LENGTH; index += 1) {
    const randomIndex = Math.floor(
      Math.random() * LICENSE_CHARACTERS.length
    );

    key += LICENSE_CHARACTERS[randomIndex];
  }

  return key;
}

function requireSupabase(_req, res, next) {
  if (!supabase) {
    res.status(503).json({
      ok: false,
      error: "SUPABASE_NOT_CONFIGURED",
      message:
        "A conexão do SIGMA ACCESS com o Supabase não está configurada."
    });
    return;
  }

  next();
}

function requireAdminToken(req, res, next) {
  if (!sigmaAdminToken) {
    res.status(503).json({
      ok: false,
      error: "ADMIN_TOKEN_NOT_CONFIGURED",
      message:
        "A variável SIGMA_ADMIN_TOKEN ainda não foi configurada no Render."
    });
    return;
  }

  const receivedToken = String(
    req.headers["x-sigma-admin-token"] || ""
  ).trim();

  if (!receivedToken || receivedToken !== sigmaAdminToken) {
    res.status(401).json({
      ok: false,
      error: "UNAUTHORIZED",
      message: "Token administrativo inválido."
    });
    return;
  }

  next();
}


function normalizeLicenseKey(value) {
  return normalizeText(value, 30).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeDeviceId(value) {
  return normalizeText(value, 120).replace(/[^a-zA-Z0-9_-]/g, "");
}

function publicLicensePayload(row) {
  return {
    display_name: row.display_name,
    plan: row.plan,
    status: row.status,
    expires_at: row.expires_at,
    first_access: row.first_access,
    last_seen: row.last_seen
  };
}

function licenseFailure(res, statusCode, error, message) {
  return res.status(statusCode).json({ ok: false, error, message });
}

function isExpired(expiresAt) {
  if (!expiresAt) return false;
  const time = new Date(expiresAt).getTime();
  return Number.isFinite(time) && time <= Date.now();
}

async function createUniqueLicenseKey(maxAttempts = 10) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const licenseKey = generateLicenseKey();

    const { data, error } = await supabase
      .from(ACCESS_TABLE)
      .select("id")
      .eq("license_key", licenseKey)
      .maybeSingle();

    if (error) {
      throw new Error(
        `Falha ao verificar chave existente: ${error.message}`
      );
    }

    if (!data) {
      return licenseKey;
    }
  }

  throw new Error(
    "Não foi possível gerar uma chave única após várias tentativas."
  );
}

function normalizeBootstrapRounds(items) {
  return (Array.isArray(items) ? items : [])
    .map(item => memory.normalize(item))
    .filter(Boolean)
    .slice(-config.memoryLimit);
}

function bootstrapMatchesLive(imported) {
  if (!memory.size()) return true;
  const current = memory.all().slice(0, 30);
  const importedKeys = new Set(imported.slice(-120).map(round => memory.createKey(round)));
  if (current.some(round => importedKeys.has(memory.createKey(round)))) return true;
  const newestImported = imported.at(-1);
  const newestCurrent = memory.last();
  if (!newestImported || !newestCurrent) return false;
  const delta = Math.abs(new Date(newestImported.created_at) - new Date(newestCurrent.created_at));
  return Number.isFinite(delta) && delta <= 15 * 60 * 1000;
}

app.get("/", (_req, res) => {
  res.json({
    name: "SIGMA LIVE SERVER",
    version: APP_VERSION,
    online: true,
    sigmaAccess: {
      configured: Boolean(supabase),
      adminConfigured: Boolean(sigmaAdminToken)
    },
    endpoints: [
      "/health",
      "/last",
      "/memory",
      "/stats",
      "/events",
      "/api/sigma-reading/state",
      "/access/health",
      "/admin",
      "/api/access/activate",
      "/api/access/validate",
      "/api/access/deactivate",
      "/api/access/admin/summary",
      "/api/access/licenses"
    ]
  });
});

app.get("/health", (_req, res) => {
  const state = live.state();

  res.json({
    ok: true,
    service: "sigma-live-server",
    version: APP_VERSION,
    timestamp: new Date().toISOString(),
    connected: state.connected,
    engineOpened: state.engineOpened,
    socketIoConnected: state.socketIoConnected,
    rounds: memory.size(),
    memoryLimit: config.memoryLimit,
    lastRound: memory.last(),
    lastConnectedAt: state.lastConnectedAt,
    lastDisconnectedAt: state.lastDisconnectedAt,
    lastMessageAt: state.lastMessageAt,
    lastError: state.lastError,
    reconnectAttempt: state.reconnectAttempt,
    sigmaAccessConfigured: Boolean(supabase),
    sigmaAdminConfigured: Boolean(sigmaAdminToken),
    colorEngine: {
      enabled: sigmaColor24hEnabled,
      telegramConfigured: Boolean(telegramBotToken && telegramChatId)
    },
    whiteEngine: {
      enabled: sigmaWhite24hEnabled,
      telegramConfigured: Boolean(telegramBotToken && telegramWhiteChatId),
      chatIdConfigured: Boolean(telegramWhiteChatId),
      envValueReceived: String(whiteEnabledRaw || "(vazio)"),
      state: whiteEngine?.state?.() || null
    },
    memoryPersistence: {
      file: memoryStore.filepath,
      restored: restoredCount,
      lastError: memoryStore.lastError,
      fallbackUsed: Boolean(memoryStore.fallbackUsed),
      persistentDiskActive: memoryStore.filepath.startsWith("/var/data/")
    },
    historyBackfill: historyLoader.state(),
    whiteDiagnostics: (() => {
      const rounds = memory.all();
      const whites = rounds.filter(round => Number(round.roll) === 0 || Number(round.color) === 0).length;
      return { rounds: rounds.length, whites, intervals: Math.max(0, whites - 1), ready: whites >= 6 };
    })()
  });
});

app.get(
  "/access/health",
  requireSupabase,
  async (_req, res) => {
    try {
      const { count, error } = await supabase
        .from(ACCESS_TABLE)
        .select("id", {
          count: "exact",
          head: true
        });

      if (error) {
        throw error;
      }

      res.json({
        ok: true,
        service: "sigma-access",
        version: APP_VERSION,
        database: "connected",
        table: ACCESS_TABLE,
        licenses: count || 0,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error(
        "[SIGMA ACCESS] Erro no teste de conexão:",
        error
      );

      res.status(500).json({
        ok: false,
        error: "SUPABASE_CONNECTION_ERROR",
        message:
          error?.message ||
          "Não foi possível consultar a tabela sigma_access."
      });
    }
  }
);



app.post(
  "/api/access/activate",
  requireSupabase,
  async (req, res) => {
    try {
      const licenseKey = normalizeLicenseKey(req.body?.license_key);
      const deviceId = normalizeDeviceId(req.body?.device_id);
      const deviceName = normalizeText(req.body?.device_name || "Navegador", 120);

      if (!licenseKey || !deviceId) {
        return licenseFailure(res, 400, "ACTIVATION_DATA_REQUIRED", "Informe a licença e o dispositivo.");
      }

      const { data: license, error } = await supabase
        .from(ACCESS_TABLE)
        .select("id, license_key, display_name, status, plan, first_access, expires_at, current_session, current_device, last_seen")
        .eq("license_key", licenseKey)
        .maybeSingle();

      if (error) throw error;
      if (!license) return licenseFailure(res, 404, "LICENSE_NOT_FOUND", "Licença não encontrada.");
      if (license.status === "BLOCKED") return licenseFailure(res, 403, "LICENSE_BLOCKED", "Esta licença foi bloqueada.");
      if (license.status === "EXPIRED" || isExpired(license.expires_at)) {
        if (license.status !== "EXPIRED") await supabase.from(ACCESS_TABLE).update({ status: "EXPIRED" }).eq("id", license.id);
        return licenseFailure(res, 403, "LICENSE_EXPIRED", "Esta licença está expirada.");
      }
      // Uma licença pode ficar ativa em somente uma sessão por vez.
      // Uma nova ativação sempre assume a licença e substitui a sessão anterior,
      // inclusive quando vem de outro navegador ou dispositivo.
      const previousSession = license.current_session;
      const previousDevice = license.current_device;
      const isTransfer = Boolean(previousSession && (previousSession !== req.body?.session_id || previousDevice !== deviceId));

      const now = new Date().toISOString();
      const sessionId = crypto.randomUUID();
      const updates = {
        status: "ACTIVE",
        first_access: license.first_access || now,
        current_device: deviceId,
        current_session: sessionId,
        last_seen: now,
        grace_until: null
      };

      const { data: updated, error: updateError } = await supabase
        .from(ACCESS_TABLE)
        .update(updates)
        .eq("id", license.id)
        .select("display_name, plan, status, expires_at, first_access, last_seen")
        .single();
      if (updateError) throw updateError;

      if (isTransfer) {
        console.log(`[SIGMA ACCESS] Sessão transferida: ${licenseKey} | ${previousDevice || "sem dispositivo"} -> ${deviceName} | ${deviceId}`);
      } else {
        console.log(`[SIGMA ACCESS] Ativação: ${licenseKey} | ${deviceName} | ${deviceId}`);
      }
      res.json({
        ok: true,
        message: isTransfer ? "Licença transferida para este dispositivo." : "Licença ativada.",
        transferred: isTransfer,
        session_id: sessionId,
        license: publicLicensePayload(updated)
      });
    } catch (error) {
      console.error("[SIGMA ACCESS] Erro na ativação:", error);
      res.status(500).json({ ok: false, error: "ACTIVATION_ERROR", message: error?.message || "Não foi possível ativar a licença." });
    }
  }
);

app.post(
  "/api/access/validate",
  requireSupabase,
  async (req, res) => {
    try {
      const licenseKey = normalizeLicenseKey(req.body?.license_key);
      const deviceId = normalizeDeviceId(req.body?.device_id);
      const sessionId = normalizeText(req.body?.session_id, 120);
      if (!licenseKey || !deviceId || !sessionId) return licenseFailure(res, 400, "VALIDATION_DATA_REQUIRED", "Dados de validação incompletos.");

      const { data: license, error } = await supabase
        .from(ACCESS_TABLE)
        .select("id, display_name, status, plan, first_access, expires_at, current_session, current_device, last_seen")
        .eq("license_key", licenseKey)
        .maybeSingle();
      if (error) throw error;
      if (!license) return licenseFailure(res, 404, "LICENSE_NOT_FOUND", "Licença não encontrada.");
      if (license.status === "BLOCKED") return licenseFailure(res, 403, "LICENSE_BLOCKED", "Esta licença foi bloqueada.");
      if (license.status === "EXPIRED" || isExpired(license.expires_at)) {
        if (license.status !== "EXPIRED") await supabase.from(ACCESS_TABLE).update({ status: "EXPIRED" }).eq("id", license.id);
        return licenseFailure(res, 403, "LICENSE_EXPIRED", "Esta licença está expirada.");
      }
      if (license.current_device !== deviceId || license.current_session !== sessionId) {
        const wasTransferred = Boolean(license.current_session && license.current_session !== sessionId);
        return licenseFailure(
          res,
          401,
          wasTransferred ? "SESSION_REVOKED" : "SESSION_INVALID",
          wasTransferred
            ? "Sua licença foi ativada em outro navegador ou dispositivo."
            : "Sessão inválida. Ative a licença novamente."
        );
      }

      const now = new Date().toISOString();
      const { data: updated, error: updateError } = await supabase
        .from(ACCESS_TABLE)
        .update({ status: "ACTIVE", last_seen: now, grace_until: null })
        .eq("id", license.id)
        .select("display_name, plan, status, expires_at, first_access, last_seen")
        .single();
      if (updateError) throw updateError;
      res.json({ ok: true, valid: true, license: publicLicensePayload(updated) });
    } catch (error) {
      console.error("[SIGMA ACCESS] Erro na validação:", error);
      res.status(500).json({ ok: false, error: "VALIDATION_ERROR", message: error?.message || "Não foi possível validar a licença." });
    }
  }
);

app.post(
  "/api/access/deactivate",
  requireSupabase,
  async (req, res) => {
    try {
      const licenseKey = normalizeLicenseKey(req.body?.license_key);
      const deviceId = normalizeDeviceId(req.body?.device_id);
      const sessionId = normalizeText(req.body?.session_id, 120);
      if (!licenseKey || !deviceId || !sessionId) return licenseFailure(res, 400, "DEACTIVATION_DATA_REQUIRED", "Dados incompletos.");

      const { data: license, error } = await supabase
        .from(ACCESS_TABLE)
        .select("id, current_device, current_session, status")
        .eq("license_key", licenseKey)
        .maybeSingle();
      if (error) throw error;
      if (!license) return licenseFailure(res, 404, "LICENSE_NOT_FOUND", "Licença não encontrada.");
      if (license.current_device !== deviceId || license.current_session !== sessionId) return licenseFailure(res, 401, "SESSION_INVALID", "Sessão inválida.");

      const nextStatus = license.status === "BLOCKED" ? "BLOCKED" : "ACTIVE";
      const { error: updateError } = await supabase.from(ACCESS_TABLE).update({ current_session: null, current_device: null, last_seen: new Date().toISOString(), status: nextStatus }).eq("id", license.id);
      if (updateError) throw updateError;
      res.json({ ok: true, message: "Dispositivo desvinculado." });
    } catch (error) {
      console.error("[SIGMA ACCESS] Erro ao desvincular:", error);
      res.status(500).json({ ok: false, error: "DEACTIVATION_ERROR", message: error?.message || "Não foi possível desvincular." });
    }
  }
);

app.get(
  "/api/access/admin/summary",
  requireSupabase,
  requireAdminToken,
  async (_req, res) => {
    try {
      const { data, error } = await supabase
        .from(ACCESS_TABLE)
        .select("status, plan");

      if (error) throw error;

      const rows = data || [];
      const summary = {
        total: rows.length,
        active: rows.filter(item => ["NEW", "ACTIVE"].includes(item.status)).length,
        trials: rows.filter(item => item.plan === "TRIAL").length,
        blocked: rows.filter(item => item.status === "BLOCKED").length,
        expired: rows.filter(item => item.status === "EXPIRED").length
      };

      res.json({ ok: true, summary });
    } catch (error) {
      console.error("[SIGMA ACCESS] Erro no resumo:", error);
      res.status(500).json({
        ok: false,
        error: "SUMMARY_ERROR",
        message: error?.message || "Não foi possível carregar o resumo."
      });
    }
  }
);

app.get(
  "/api/access/licenses",
  requireSupabase,
  requireAdminToken,
  async (_req, res) => {
    try {
      const { data, error } = await supabase
        .from(ACCESS_TABLE)
        .select("id, created_at, license_key, display_name, status, plan, first_access, expires_at, current_session, current_device, last_seen, grace_until")
        .order("created_at", { ascending: false });

      if (error) throw error;
      res.json({ ok: true, licenses: data || [] });
    } catch (error) {
      console.error("[SIGMA ACCESS] Erro ao listar licenças:", error);
      res.status(500).json({
        ok: false,
        error: "LICENSE_LIST_ERROR",
        message: error?.message || "Não foi possível listar as licenças."
      });
    }
  }
);

app.post(
  "/api/access/licenses",
  requireSupabase,
  requireAdminToken,
  async (req, res) => {
    try {
      const displayName = normalizeText(
        req.body?.display_name,
        100
      );

      const plan = normalizePlan(req.body?.plan);

      if (!displayName) {
        res.status(400).json({
          ok: false,
          error: "DISPLAY_NAME_REQUIRED",
          message:
            "Informe o nome do cliente em display_name."
        });
        return;
      }

      const licenseKey = await createUniqueLicenseKey();
      const expiresAt = calculateLicenseExpiration(plan);

      const { data, error } = await supabase
        .from(ACCESS_TABLE)
        .insert({
          license_key: licenseKey,
          display_name: displayName,
          status: "NEW",
          plan,
          first_access: null,
          expires_at: expiresAt,
          current_session: null,
          current_device: null,
          last_seen: null,
          grace_until: null
        })
        .select(
          "id, created_at, license_key, display_name, status, plan, expires_at"
        )
        .single();

      if (error) {
        throw error;
      }

      console.log(
        `[SIGMA ACCESS] Licença gerada: ${data.license_key} | ${data.display_name} | ${data.plan}`
      );

      res.status(201).json({
        ok: true,
        message: "Chave gerada com sucesso.",
        license: data
      });
    } catch (error) {
      console.error(
        "[SIGMA ACCESS] Erro ao gerar licença:",
        error
      );

      res.status(500).json({
        ok: false,
        error: "LICENSE_CREATE_ERROR",
        message:
          error?.message ||
          "Não foi possível gerar a licença."
      });
    }
  }
);


app.patch(
  "/api/access/licenses/:id",
  requireSupabase,
  requireAdminToken,
  async (req, res) => {
    try {
      const id = normalizeText(req.params.id, 80);
      const updates = {};

      if (req.body?.status !== undefined) {
        const status = normalizeText(req.body.status, 20).toUpperCase();
        const allowed = ["NEW", "ACTIVE", "EXPIRED", "BLOCKED"];
        if (!allowed.includes(status)) {
          return res.status(400).json({ ok: false, error: "INVALID_STATUS", message: "Status inválido." });
        }
        updates.status = status;
      }

      if (req.body?.plan !== undefined) updates.plan = normalizePlan(req.body.plan);
      if (req.body?.display_name !== undefined) {
        const displayName = normalizeText(req.body.display_name, 100);
        if (!displayName) return res.status(400).json({ ok: false, error: "DISPLAY_NAME_REQUIRED", message: "Informe o nome do cliente." });
        updates.display_name = displayName;
      }

      if (req.body?.expires_at !== undefined) {
        updates.expires_at = req.body.expires_at ? new Date(req.body.expires_at).toISOString() : null;
      }

      if (!Object.keys(updates).length) {
        return res.status(400).json({ ok: false, error: "NO_CHANGES", message: "Nenhuma alteração válida foi informada." });
      }

      const { data, error } = await supabase
        .from(ACCESS_TABLE)
        .update(updates)
        .eq("id", id)
        .select("id, created_at, license_key, display_name, status, plan, expires_at")
        .single();

      if (error) throw error;
      res.json({ ok: true, message: "Licença atualizada.", license: data });
    } catch (error) {
      console.error("[SIGMA ACCESS] Erro ao atualizar licença:", error);
      res.status(500).json({ ok: false, error: "LICENSE_UPDATE_ERROR", message: error?.message || "Não foi possível atualizar a licença." });
    }
  }
);

app.delete(
  "/api/access/licenses/:id",
  requireSupabase,
  requireAdminToken,
  async (req, res) => {
    try {
      const id = normalizeText(req.params.id, 80);
      const { error } = await supabase.from(ACCESS_TABLE).delete().eq("id", id);
      if (error) throw error;
      res.json({ ok: true, message: "Licença excluída." });
    } catch (error) {
      console.error("[SIGMA ACCESS] Erro ao excluir licença:", error);
      res.status(500).json({ ok: false, error: "LICENSE_DELETE_ERROR", message: error?.message || "Não foi possível excluir a licença." });
    }
  }
);

app.get("/last", (_req, res) => {
  res.json({
    ok: true,
    round: memory.last()
  });
});

app.post("/memory/backfill", async (_req, res) => {
  const state = await historyLoader.load();
  res.json({ ok: !state.lastError, count: memory.size(), memoryLimit: config.memoryLimit, ...state });
});

app.get("/memory", (req, res) => {
  const requested = Number(
    req.query.limit || config.memoryLimit
  );

  const limit = Math.max(
    1,
    Math.min(
      Number.isFinite(requested)
        ? requested
        : config.memoryLimit,
      config.memoryLimit
    )
  );

  const rounds = memory.all().slice(0, limit);

  res.json({
    ok: true,
    count: rounds.length,
    memoryLimit: config.memoryLimit,
    rounds
  });
});

app.get("/stats", (req, res) => {
  const requested = Number(req.query.sample || 50);

  const sample = Math.max(
    1,
    Math.min(
      Number.isFinite(requested) ? requested : 50,
      500
    )
  );

  res.json({
    ok: true,
    sample,
    stats: memory.stats(sample)
  });
});


app.get("/api/sigma-reading/state", (_req, res) => {
  res.json({ ok: true, ...(colorEngine ? colorEngine.state() : { enabled: false, mode: "STARTING" }) });
});

app.get("/api/sigma-white/state", (_req, res) => {
  res.json({ ok: true, ...(whiteEngine ? whiteEngine.state() : { enabled: false, mode: "STARTING" }) });
});

app.post("/memory/bootstrap", async (req, res) => {
  try {
    const imported = normalizeBootstrapRounds(req.body?.rounds);
    if (imported.length < 20) {
      return res.status(400).json({ ok: false, error: "INSUFFICIENT_ROUNDS", message: "Envie ao menos 20 rodadas válidas." });
    }
    if (!bootstrapMatchesLive(imported)) {
      return res.status(409).json({ ok: false, error: "MEMORY_MISMATCH", message: "A memória enviada não corresponde às rodadas atuais do servidor." });
    }
    const before = memory.size();
    const inserted = memory.addMany(imported);
    const saved = memoryStore.save(memory.all());
    console.log(`[MEMORY] Bootstrap recebido do ORION: ${inserted} novas | total=${memory.size()}.`);
    broadcast("memory-bootstrap", { inserted, count: memory.size() });
    await whiteEngine?.ensureProjection?.();
    return res.json({ ok: true, inserted, before, count: memory.size(), memoryLimit: config.memoryLimit, persisted: saved, persistenceFile: memoryStore.filepath });
  } catch (error) {
    console.error("[MEMORY] Erro no bootstrap:", error);
    return res.status(500).json({ ok: false, error: "BOOTSTRAP_ERROR", message: error?.message || "Falha ao importar memória." });
  }
});

app.get("/api/white/state", (_req, res) => {
  res.json(whiteEngine?.state?.() || { enabled: sigmaWhite24hEnabled, active: null, history: [], accuracy: null });
});

app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader(
    "Cache-Control",
    "no-cache, no-transform"
  );
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  res.flushHeaders?.();

  const client = { res };
  clients.add(client);

  res.write(
    `event: state\ndata: ${JSON.stringify({
      ...live.state(),
      rounds: memory.size()
    })}\n\n`
  );

  const heartbeat = setInterval(() => {
    res.write(
      `event: heartbeat\ndata: ${Date.now()}\n\n`
    );
  }, 20000);

  req.on("close", () => {
    clearInterval(heartbeat);
    clients.delete(client);
  });
});

function broadcast(event, payload) {
  const message =
    `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;

  for (const client of clients) {
    try {
      client.res.write(message);
    } catch (_error) {
      clients.delete(client);
    }
  }
}

live.on("round", round => {
  const inserted = memory.add(round);

  if (!inserted) {
    console.log(
      `[LIVE] Rodada duplicada ignorada: ${round.id}`
    );
    return;
  }

  console.log(
    `[LIVE] Rodada armazenada: id=${round.id} roll=${round.roll} color=${round.color} memória=${memory.size()}`
  );

  broadcast("round", {
    round,
    count: memory.size()
  });

  colorEngine?.enqueueRound(round);
  whiteEngine?.enqueueRound(round);
});

live.on("state", state => {
  broadcast("state", {
    ...state,
    rounds: memory.size()
  });
});

const server = app.listen(
  config.port,
  "0.0.0.0",
  () => {
    console.log(
      `[SIGMA] Servidor HTTP ativo na porta ${config.port}.`
    );

    if (supabase) {
      console.log(
        "[SIGMA ACCESS] Cliente Supabase configurado."
      );
    } else {
      console.warn(
        "[SIGMA ACCESS] SUPABASE_URL ou SUPABASE_SECRET_KEY ausente."
      );
    }

    if (!sigmaAdminToken) {
      console.warn(
        "[SIGMA ACCESS] SIGMA_ADMIN_TOKEN ainda não configurado."
      );
    }

    console.log(
      `[SIGMA WHITE] Configuração: enabled=${sigmaWhite24hEnabled} chatId=${telegramWhiteChatId ? "OK" : "AUSENTE"} token=${telegramBotToken ? "OK" : "AUSENTE"} env=${String(whiteEnabledRaw || "(vazio)")}`
    );

    colorEngine = new SigmaColorEngine({
      memory,
      broadcast,
      telegramToken: telegramBotToken,
      telegramChatId,
      enabled: sigmaColor24hEnabled
    });
    colorEngine.start();

    whiteEngine = new SigmaWhiteEngine({
      memory,
      broadcast,
      telegramToken: telegramBotToken,
      telegramChatId: telegramWhiteChatId,
      enabled: sigmaWhite24hEnabled
    });
    whiteEngine.start();
    live.start();

    // O histórico oficial é a memória central restaurada do disco e/ou
    // sincronizada pelo ORION. O endpoint HTTP público da Blaze retorna 451
    // no Render; por isso o backfill remoto só roda quando for habilitado
    // explicitamente por BLAZE_HISTORY_BACKFILL_ENABLED=true.
    if (String(process.env.BLAZE_HISTORY_BACKFILL_ENABLED || "false").toLowerCase() === "true" && memory.size() < Math.min(config.memoryLimit, 300)) {
      historyLoader.load().then(() => {
        broadcast("memory-backfill", { count: memory.size(), state: historyLoader.state() });
      });
    }
  }
);

function shutdown(signal) {
  console.log(`[SIGMA] Encerrando por ${signal}.`);

  memoryStore.save(memory.all());
  live.stop();
  colorEngine?.stop();
  whiteEngine?.stop();

  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => {
    process.exit(1);
  }, 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
