const { app, BrowserWindow, ipcMain, shell, dialog, Notification, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");
const { execFile, spawn } = require("child_process");
const { promisify } = require("util");
const crypto = require("crypto");

process.on("unhandledRejection", (reason, _promise) => {
	console.error("[main] unhandled rejection:", reason);
});
process.on("uncaughtException", (err) => {
	console.error("[main] uncaught exception:", err && err.stack || err);
});

const execFileAsync = promisify(execFile);
const {
  createPlannerFileStore,
  sanitizePlannerScopeId,
  PLANNER_FILE_KEYS,
} = require("./planner-file-store");
const { createKeywordIndexService } = require("./keyword-index-service");

/* Windows 11 Chromium Fluent scrollbars ignore slim `::-webkit-scrollbar` widths; use classic webkit styling. */
if (process.platform === "win32") {
  app.commandLine.appendSwitch("disable-features", "FluentScrollbars");
}

// Chromium HTTP disk cache throws repeated "writing the file to cache" ENOTDIR
// noise on some Windows profiles; the app does not rely on it, so disable it.
app.commandLine.appendSwitch("disable-http-cache");

/** Windows 11 Efficiency Mode (EcoQoS) — green leaf in Task Manager when backgrounded. */
let winEfficiencyMode = null;
if (process.platform === "win32") {
  try {
    winEfficiencyMode = require("./win-efficiency-mode");
    const boot = winEfficiencyMode.applyToCurrentProcess("background");
    if (!boot.ok) {
      console.warn("Windows efficiency mode (main):", boot.reason || "failed");
    }
  } catch (e) {
    console.warn("Windows efficiency mode unavailable:", e);
  }
}

/** Injected on window close as a best-effort sync persist. */
const RENDERER_FLUSH_FLOATING_DRAFTS_JS =
  "(function(){try{if(typeof window.__persistFloatingReplicasNow==='function')window.__persistFloatingReplicasNow();}catch(e){console.error('[persist drafts]',e);}})();";

/** Await planner notes / to-dos / reminders file writes before the window closes. */
const RENDERER_FLUSH_PLANNER_JS =
  "(async function(){try{if(typeof window.rmePlannerFlushAll==='function')await window.rmePlannerFlushAll();}catch(e){console.error('[planner flush]',e);}})();";

// Resolve bundled Python voice servers (STT/VAD/TTS).
// Packaged builds ship tools/ via electron-builder extraResources to resources/tools.
if (!process.env.RME_TOOLS_ROOT) {
  process.env.RME_TOOLS_ROOT = app.isPackaged
    ? path.join(process.resourcesPath, "tools")
    : path.join(__dirname, "tools");
}

// Auto-detect the GPU voice Python environments created by setup-voice-gpu.ps1
// (under the app userData dir) so voice works even if no .env was written.
try {
  const _voiceBases = [];
  try { _voiceBases.push(app.getPath("userData")); } catch (e) {}
  if (process.env.APPDATA) { _voiceBases.push(path.join(process.env.APPDATA, "Recruit My English")); }
  for (const _b of _voiceBases) {
    const _stt = path.join(_b, "voice-venv", "Scripts", "python.exe");
    const _tts = path.join(_b, "tts-venv", "Scripts", "python.exe");
    if (!process.env.RME_PARAKEET_PYTHON && fs.existsSync(_stt)) process.env.RME_PARAKEET_PYTHON = _stt;
    if (!process.env.RME_PYTHON_EXE && fs.existsSync(_tts)) process.env.RME_PYTHON_EXE = _tts;
  }
  if (!process.env.RME_PARAKEET_DEVICE) process.env.RME_PARAKEET_DEVICE = "cuda";
} catch (e) { /* ignore */ }

function loadDotenv() {
  const dotenv = require("dotenv");
  /** Later paths win. Exe dir first, then userData, so AppData edits override install folder. */
  /** Later paths win. Dev: project .env overrides AppData so unsaved edits in the repo file apply after save. */
  const paths = app.isPackaged
    ? [
        path.join(path.dirname(process.execPath), ".env"),
        path.join(app.getPath("userData"), ".env"),
        ...(process.env.APPDATA ? [path.join(process.env.APPDATA, "Recruit My English", ".env")] : []),
        ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, "Programs", "Recruit My English", ".env")] : []),
      ]
    : [
        path.join(app.getPath("userData"), ".env"),
        path.join(__dirname, ".env"),
      ];

  for (const envPath of paths) {
    if (!fs.existsSync(envPath)) {
      continue;
    }
    let raw = fs.readFileSync(envPath, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) {
      raw = raw.slice(1);
    }
    const parsed = dotenv.parse(raw);
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        const v = value.trim();
        if (v === "") {
          continue;
        }
        process.env[key] = v;
      } else if (value != null) {
        const s = String(value).trim();
        if (s === "") {
          continue;
        }
        process.env[key] = s;
      }
    }
  }

  if (app.isPackaged) {
    applyBundledNotionDefaults(dotenv);
    applyBundledSupabaseDefaults(dotenv);
  }
}

function seedPackagedEnvTemplate(userDataPath) {
  if (!app.isPackaged) {
    return;
  }
  const userEnv = path.join(userDataPath, ".env");
  if (fs.existsSync(userEnv)) {
    return;
  }
  const examplePath = path.join(process.resourcesPath, ".env.example");
  if (!fs.existsSync(examplePath)) {
    return;
  }
  try {
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.copyFileSync(examplePath, userEnv);
  } catch {
    /* ignore */
  }
}

function notionMissingTokenMessage() {
  if (!app.isPackaged) {
    return `Missing NOTION_TOKEN. Save a .env file next to the app project:\n${path.join(__dirname, ".env")}\n(See .env.example.)`;
  }
  const ud = path.join(app.getPath("userData"), ".env");
  const nextToExe = path.join(path.dirname(process.execPath), ".env");
  return (
    "Missing NOTION_TOKEN. Add your Notion secret to a file named .env in one of these places:\n\n" +
    `• ${ud}\n` +
    `• ${nextToExe}\n\n` +
    "Tip: open that .env file in Notepad (or use the button below), paste NOTION_TOKEN= and your database IDs from your dev machine's .env, save, then click Refresh from Notion again."
  );
}

const { pagesToTable, normalizePageId } = require("./notion-simplify");
const { buildPaySlipPdfBuffer } = require("./payslip-pdf");
const {
  hasAdmin,
  ALLOWED_ADMIN_EMAIL,
} = require("./auth-store");
const { initAutoUpdate, registerAutoUpdateIpc } = require("./auto-update");
const { createVoiceAgentService, VOICE_SYSTEM_PROMPT, detectSpeaker } = require("./lib/voice-agent");
const { NotionApi } = require("./lib/notion-api");
const { ensureSttServer } = require("./lib/voice-agent/stt-router");
const { cudaRuntimeLikelyAvailable } = require("./lib/voice/cuda-check");
const { log } = require("./lib/log");
const {
  resolveVoiceEnvPaths,
  applyVoiceEnvPaths,
} = require("./lib/voice-env-resolve");
const voiceMemory = require("./lib/supabase/voice-memory");
const pageMemory = require("./lib/supabase/page-memory");
const voiceProfiles = require("./lib/supabase/voice-profiles");
const retrievalPipeline = require("./lib/retrieval-pipeline");
const distillation = require("./lib/distillation");
const searchTools = require("./lib/search");
const { embed } = require("./lib/embeddings");
const { extractAndStore: extractFacts } = require("./lib/voice-agent/fact-extractor");
const discordBot = require("./lib/discord/index");

const plannerVoiceTools = require("./lib/planner-voice-tools");
const plannerSearch = require("./lib/planner-search");

let mainWindow = null;
/** @type {NotionApi | null} */
let notionApi = null;

/** @type {{ level: string; text: string; ts: number }[]} */
const devLogBuffer = [];
const DEV_LOG_MAX = 500;

const _origConsoleLog = console.log;
const _origConsoleWarn = console.warn;
const _origConsoleError = console.error;
const { sanitizeArgs } = require('./lib/log/sanitize');
let _lastKnownSpeaker = null;
let _voiceAgent = null;
let _vadProc = null;
let _vadPort = 8125;

console.log = (...args) => {
  const text = sanitizeArgs(args);
  devLogBuffer.push({ level: 'log', text, ts: Date.now() });
  if (devLogBuffer.length > DEV_LOG_MAX) devLogBuffer.shift();
  const w = getMainBrowserWindow();
  if (w && !w.isDestroyed()) {
    try { w.webContents.send('devlog:new', { level: 'log', text }); } catch {}
  }
  _origConsoleLog.apply(console, args);
};

console.warn = (...args) => {
  const text = sanitizeArgs(args);
  devLogBuffer.push({ level: 'warn', text, ts: Date.now() });
  if (devLogBuffer.length > DEV_LOG_MAX) devLogBuffer.shift();
  const w = getMainBrowserWindow();
  if (w && !w.isDestroyed()) {
    try { w.webContents.send('devlog:new', { level: 'warn', text }); } catch {}
  }
  _origConsoleWarn.apply(console, args);
};

console.error = (...args) => {
  const text = sanitizeArgs(args);
  devLogBuffer.push({ level: 'error', text, ts: Date.now() });
  if (devLogBuffer.length > DEV_LOG_MAX) devLogBuffer.shift();
  const w = getMainBrowserWindow();
  if (w && !w.isDestroyed()) {
    try { w.webContents.send('devlog:new', { level: 'error', text }); } catch {}
  }
  _origConsoleError.apply(console, args);
};

function getVoiceAgent() {
	if (!_voiceAgent) {
		const voicePaths = resolveVoiceEnvPaths(__dirname, {
			whisperBin: process.env.RME_WHISPER_BIN,
			whisperModel: process.env.RME_WHISPER_MODEL,
			ffmpegBin: process.env.RME_FFMPEG_BIN,
		});
		_voiceAgent = createVoiceAgentService({
			...voicePaths,
			anthropicKey: process.env.ANTHROPIC_API_KEY,
			anthropicModel: process.env.ANTHROPIC_MODEL,
			anthropicModelFast: process.env.RME_ANTHROPIC_MODEL_FAST,
			claudePromptCache: process.env.RME_CLAUDE_PROMPT_CACHE !== "0",
			persistAudioPath: path.join(app.getPath("userData"), "rme-voice-last.wav"),
			fillerCacheDir: path.join(app.getPath("userData"), "voice-fillers"),
		});
	}
	return _voiceAgent;
}

/** @param {unknown} payload */
function voicePayloadToBuffer(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const p = /** @type {{ audioBase64?: string; audio?: unknown }} */ (payload);
  if (typeof p.audioBase64 === "string" && p.audioBase64.length) {
    try {
      return Buffer.from(p.audioBase64, "base64");
    } catch {
      return null;
    }
  }
  const raw = p.audio;
  if (Buffer.isBuffer(raw)) {
    return raw;
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw);
  }
  if (ArrayBuffer.isView(raw)) {
    const view = /** @type {ArrayBufferView} */ (raw);
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
  }
  return null;
}

const NOTION_VERSION = "2026-03-11";

function normalizeNotionToken(raw) {
  if (!raw || typeof raw !== "string") {
    return "";
  }
  let t = raw.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    t = t.slice(1, -1).trim();
  }
  const lower = t.toLowerCase();
  if (lower.startsWith("bearer ")) {
    t = t.slice(7).trim();
  }
  return t;
}

function normalizeDatabaseId(raw) {
  if (!raw) {
    return "";
  }
  const s = String(raw).trim();
  const hex = s.replace(/-/g, "");
  if (hex.length !== 32) {
    return s;
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Accepts plain UUID or Notion collection URL id: collection://uuid */
function normalizeDataSourceId(raw) {
  if (!raw) {
    return "";
  }
  let s = String(raw).trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  if (s.toLowerCase().startsWith("collection://")) {
    s = s.slice("collection://".length).trim();
  }
  return normalizeDatabaseId(s);
}

function stripEnvQuotes(s) {
  let v = String(s ?? "").trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

/**
 * Values passed to @supabase/supabase-js in the preload bridge. Fixes common .env
 * mistakes (missing scheme, trailing slash, stray quotes, line breaks in the anon key)
 * that surface in the UI as "Failed to fetch".
 * @param {string | undefined} raw
 */
function normalizeSupabaseUrlForClient(raw) {
  let u = stripEnvQuotes(typeof raw === "string" ? raw : "");
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) {
    u = `https://${u}`;
  }
  try {
    const p = new URL(u);
    const path = p.pathname.replace(/\/+$/, "");
    if (
      p.protocol === "http:" &&
      p.hostname !== "127.0.0.1" &&
      p.hostname !== "localhost"
    ) {
      return `https://${p.host}${path}`;
    }
    return `${p.origin}${path}`;
  } catch {
    return u.replace(/\/+$/, "");
  }
}

/** @param {string | undefined} raw */
function normalizeSupabaseAnonKey(raw) {
  return stripEnvQuotes(typeof raw === "string" ? raw : "").replace(/\s+/g, "");
}

/**
 * Packaged apps read NOTION_TOKEN from .env files; NOTION_DATABASE_ID comes from
 * the shipped resources/.env.example so new installers match the build (stale
 * %APPDATA% seeds no longer pin an old database). Set NOTION_SKIP_BUNDLED_DATABASE_ID=1
 * in .env to use only file-based NOTION_DATABASE_ID.
 */
/**
 * Packaged builds ship supabase.public.env (baked at `npm run release` from dev .env).
 * Fills SUPABASE_URL / SUPABASE_ANON_KEY when the user's AppData .env omits them.
 */
function applyBundledSupabaseDefaults(dotenv) {
  const hasUrl = Boolean(normalizeSupabaseUrlForClient(process.env.SUPABASE_URL));
  const hasKey = Boolean(normalizeSupabaseAnonKey(process.env.SUPABASE_ANON_KEY));
  if (hasUrl && hasKey) {
    return;
  }
  const bundledPath = path.join(process.resourcesPath, "supabase.public.env");
  if (!fs.existsSync(bundledPath)) {
    return;
  }
  let raw = fs.readFileSync(bundledPath, "utf8");
  if (raw.charCodeAt(0) === 0xfeff) {
    raw = raw.slice(1);
  }
  const parsed = dotenv.parse(raw);
  if (!hasUrl) {
    const url = normalizeSupabaseUrlForClient(parsed.SUPABASE_URL);
    if (url) {
      process.env.SUPABASE_URL = url;
    }
  }
  if (!hasKey) {
    const key = normalizeSupabaseAnonKey(parsed.SUPABASE_ANON_KEY);
    if (key) {
      process.env.SUPABASE_ANON_KEY = key;
    }
  }
}

function applyBundledNotionDefaults(dotenv) {
  if (process.env.NOTION_SKIP_BUNDLED_DATABASE_ID === "1") {
    return;
  }
  const examplePath = path.join(process.resourcesPath, ".env.example");
  if (!fs.existsSync(examplePath)) {
    return;
  }
  let raw = fs.readFileSync(examplePath, "utf8");
  if (raw.charCodeAt(0) === 0xfeff) {
    raw = raw.slice(1);
  }
  const parsed = dotenv.parse(raw);
  const candidate = parsed.NOTION_DATABASE_ID;
  if (candidate == null || String(candidate).trim() === "") {
    return;
  }
  const id = normalizeDatabaseId(String(candidate).trim());
  if (id) {
    process.env.NOTION_DATABASE_ID = id;
  }
}

function notionHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Notion-Version": NOTION_VERSION,
  };
}

function notionReadHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
  };
}

/**
 * @param {string} token
 * @param {string} databaseId
 * @param {string} [explicitFallbackDs] optional data source id (e.g. from Supabase per-teacher) before env fallback
 */
async function resolveDataSourceId(token, databaseId, explicitFallbackDs) {
  const res = await fetch(
    "https://" + "api.notion.com/v1/databases/" + databaseId,
    {
      method: "GET",
      headers: notionReadHeaders(token),
    },
  );
  const bodyText = await res.text();
  if (!res.ok) {
    const err = new Error(
      `Could not load database metadata (${res.status}): ${bodyText}. Check NOTION_DATABASE_ID and that the integration can access this database.`,
    );
    err.code = "API";
    throw err;
  }
  const data = JSON.parse(bodyText);
  const sources = data.data_sources;
  if (!Array.isArray(sources) || sources.length === 0) {
    const fromExplicit = normalizeDataSourceId(explicitFallbackDs);
    if (fromExplicit) {
      return fromExplicit;
    }
    const fromEnv = normalizeDataSourceId(process.env.NOTION_DATA_SOURCE_ID);
    if (fromEnv) {
      return fromEnv;
    }
    const err = new Error(
      "This database has no data_sources in the API response. For wiki databases, set NOTION_DATA_SOURCE_ID in .env to the data source UUID (from the database URL or Notion devtools).",
    );
    err.code = "CONFIG";
    throw err;
  }
  return sources[0].id;
}

/** Notion caps page_size at 100; data source query supports up to ~10k rows via pagination. */
const NOTION_QUERY_PAGE_SIZE = 100;
const NOTION_QUERY_MAX_ROWS = 10_000;

/** @param {unknown} r */
function isDataSourceQueryPageRow(r) {
  if (!r || typeof r !== "object") {
    return false;
  }
  const o = /** @type {any} */ (r);
  if (o.object === "data_source") {
    return false;
  }
  if (o.object === "page") {
    return true;
  }
  return (
    o.properties != null &&
    typeof o.properties === "object" &&
    !Array.isArray(o.properties)
  );
}

/**
 * @param {string} token
 * @param {string} dataSourceId
 * @returns {Promise<object[]>}
 */
async function queryDataSourceAllPages(token, dataSourceId) {
  const allPages = [];
  /** @type {string | undefined} */
  let startCursor;
  let hasMore = true;
  let iterations = 0;

  while (hasMore && allPages.length < NOTION_QUERY_MAX_ROWS) {
    iterations += 1;
    if (iterations > 200) {
      break;
    }
    const body = {
      page_size: NOTION_QUERY_PAGE_SIZE,
      /** Wiki DBs can return child data_source rows; pay slip rows are always pages. */
      result_type: "page",
    };
    if (startCursor) {
      body.start_cursor = startCursor;
    }

    const res = await fetch(
      "https://" + "api.notion.com/v1/data_sources/" + dataSourceId + "/query",
      {
        method: "POST",
        headers: notionHeaders(token),
        body: JSON.stringify(body),
      },
    );

    const bodyText = await res.text();
    if (!res.ok) {
      let message = `Notion API ${res.status}: ${bodyText}`;
      if (res.status === 401) {
        message +=
          "\n\nFix checklist:\n" +
          "• Use an Internal integration: Notion integrations page → New integration → type Internal. Copy the full secret (one line, no spaces).\n" +
          "- The OAuth bot invite URL only needs client_id, scope, and permissions.\n" +
          "No secret of any kind is required for this URL — never include one.\n" +
          "• After pasting, save .env and restart the app. Try \"Refresh secret\" in Notion if this key was ever shared.";
      }
      const err = new Error(message);
      err.code = "API";
      throw err;
    }

    const data = JSON.parse(bodyText);
    const results = Array.isArray(data.results) ? data.results : [];
    for (const r of results) {
      if (isDataSourceQueryPageRow(r)) {
        allPages.push(r);
      }
    }

    hasMore = Boolean(data.has_more);
    startCursor =
      typeof data.next_cursor === "string" && data.next_cursor.trim()
        ? data.next_cursor.trim()
        : undefined;
    if (!hasMore || !startCursor) {
      break;
    }
  }

  return allPages;
}

/**
 * Resolve token + primary data source id (same rules as table load).
 * @param {object} [opts]
 * @returns {Promise<{ token: string; dataSourceId: string }>}
 */
async function resolveNotionTokenAndDataSourceId(opts = {}) {
  const token = normalizeNotionToken(process.env.NOTION_TOKEN);
  const optDb = normalizeDatabaseId(opts.databaseId);
  const optDs = normalizeDataSourceId(opts.dataSourceId);
  const envDb = normalizeDatabaseId(process.env.NOTION_DATABASE_ID);
  const envDs = normalizeDataSourceId(process.env.NOTION_DATA_SOURCE_ID);

  if (!token) {
    const err = new Error(notionMissingTokenMessage());
    err.code = "CONFIG";
    throw err;
  }

  /** @type {string} */
  let dataSourceId = "";

  if (optDb) {
    dataSourceId = await resolveDataSourceId(token, optDb, optDs);
  } else if (optDs) {
    dataSourceId = optDs;
  } else if (envDb) {
    dataSourceId = await resolveDataSourceId(token, envDb, envDs);
  } else if (envDs) {
    dataSourceId = envDs;
  } else {
    const err = new Error(
      "Set NOTION_DATABASE_ID (database page URL id) and/or NOTION_DATA_SOURCE_ID. The app uses API 2026-03-11: it queries POST /v1/data_sources/{id}/query (legacy /databases/.../query is not valid on this version).",
    );
    err.code = "CONFIG";
    throw err;
  }

  return { token, dataSourceId };
}

/**
 * Discover all accessible databases and pages via POST /v1/search.
 * @returns {Promise<{ databases: { id: string; title: string; url: string }[]; pages: { id: string; title: string; parentDatabaseId: string | null }[] }>}
 */
async function searchNotionWorkspace() {
  const token = normalizeNotionToken(process.env.NOTION_TOKEN);
  if (!token) {
    return { databases: [], pages: [] };
  }

  let allResults = [];
  let startCursor = undefined;

  while (true) {
    const body = { page_size: 100, sort: { direction: "ascending", timestamp: "last_edited_time" } };
    if (startCursor) {
      body.start_cursor = startCursor;
    }

    const res = await fetch("https://" + "api.notion.com/v1/search", {
      method: "POST",
      headers: notionHeaders(token),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.warn(`[notion] search failed ${res.status}: ${await res.text().catch(() => "")}`);
      return { databases: [], pages: [] };
    }

    const data = await res.json();
    const results = Array.isArray(data.results) ? data.results : [];
    allResults = allResults.concat(results);

    if (!data.has_more || !data.next_cursor) break;
    startCursor = data.next_cursor;
  }

  const databases = [];
  const pages = [];

  for (const r of allResults) {
    const obj = r;
    if (!obj || typeof obj !== "object") continue;
    const id = normalizePageId(String(obj.id || ""));
    if (!id) continue;

    const title = obj.object === "database"
      ? String(obj.title?.[0]?.plain_text ?? obj.name ?? "").trim()
      : plainTitleFromNotionPageProperties(obj.properties);

    if (obj.object === "database") {
      const url = typeof obj.url === "string" ? obj.url : "";
      databases.push({ id, title: title || "Untitled Database", url });
    } else if (obj.object === "page") {
      const parent = obj.parent;
      const parentDatabaseId = parent?.type === "database_id"
        ? normalizePageId(String(parent.database_id || ""))
        : null;
      pages.push({ id, title: title || "Untitled Page", parentDatabaseId });
    }
  }

  return { databases, pages };
}

/**
 * Get child blocks of a Notion page via GET /v1/blocks/{pageId}/children.
 * Returns child database block ids (with titles when available).
 * @param {string} pageId
 * @returns {Promise<{ id: string; title: string }[]>}
 */
async function getPageChildDatabases(pageId) {
  const token = normalizeNotionToken(process.env.NOTION_TOKEN);
  if (!token || !pageId) return [];

  const normalizedId = normalizePageId(pageId);
  if (!normalizedId) return [];

  const childDatabases = [];
  let startCursor = undefined;

  while (true) {
    let url = "https://" + `api.notion.com/v1/blocks/${normalizedId}/children?page_size=100`;
    if (startCursor) {
      url += `&start_cursor=${startCursor}`;
    }

    const res = await fetch(url, {
      method: "GET",
      headers: notionReadHeaders(token),
    });

    if (!res.ok) {
      console.warn(`[notion] blocks API failed ${res.status} for ${normalizedId.slice(0, 8)}...`);
      return childDatabases;
    }

    const data = await res.json();
    const results = Array.isArray(data.results) ? data.results : [];

    for (const block of results) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "child_database") {
        const dbId = normalizePageId(String(block.id || ""));
        if (dbId) {
          const title = String(block.child_database?.title || "").trim();
          childDatabases.push({ id: dbId, title: title || "Untitled Database" });
        }
      }
    }

    if (!data.has_more || !data.next_cursor) break;
    startCursor = data.next_cursor;
  }

  return childDatabases;
}

/** @type {{ context: string; expiresAt: number } | null} */
let notionVoiceContextCache = null;

/**
 * Build compact plain-text Notion context for the voice agent.
 * Always queries main DB directly via .env ID (up to 20 rows).
 * Search discovers other databases by name (non-blocking).
 * Cached with 5-minute TTL.
 * @returns {Promise<string>} Empty string on total failure.
 */
async function buildNotionVoiceContext() {
  loadDotenv();
  const now = Date.now();
  if (notionVoiceContextCache && notionVoiceContextCache.expiresAt > now) {
    console.log(`[voice] notion context cache hit, returning ${notionVoiceContextCache.context.length} chars`);
    return notionVoiceContextCache.context;
  }

  try {
    const mainId = normalizeDatabaseId(process.env.NOTION_DATABASE_ID);
    console.log(`[voice] buildNotionVoiceContext: NOTION_DATABASE_ID=${mainId ? mainId.slice(0, 8) + '...' : 'EMPTY'}`);
    const lines = [];
    let totalRows = 0;
    const MAX_TOTAL_ROWS = 20;

    /* Try as a database first, otherwise treat as a page (THE VAULT). */
    if (mainId) {
      let triedAsDb = false;
      try {
        const table = await queryNotionTableForSource({ databaseId: mainId });
        triedAsDb = true;
        const cols = table.columns || [];
        const rows = (table.rows || []).slice(0, MAX_TOTAL_ROWS);
        totalRows += rows.length;
        console.log(`[voice] main DB query OK: ${cols.length} columns, ${rows.length} rows`);

        lines.push(`# Live Notion Context`);
        if (cols.length > 0) lines.push(`Columns: ${cols.join(" | ")}`);
        for (const row of rows) {
          const cells = cols.map((_, i) => row[i] || "").map(s => String(s).trim());
          lines.push(`• ${cells.join(" | ")}`);
        }
      } catch (e) {
        /* Not a database — treat as a page (THE VAULT). */
        if (!triedAsDb) {
          try {
            const childDbs = await getPageChildDatabases(mainId);
            console.log(`[voice] vault page children: ${childDbs.length} databases found`);
            if (childDbs.length > 0) lines.push(`# Live Notion Context — THE VAULT`);

            let rowsPerDb = Math.max(1, Math.floor(MAX_TOTAL_ROWS / (childDbs.length || 1)));
            for (const childDb of childDbs) {
              if (totalRows >= MAX_TOTAL_ROWS) break;
              try {
                const table = await queryNotionTableForSource({ databaseId: childDb.id });
                const cols = table.columns || [];
                const rows = (table.rows || []).slice(0, rowsPerDb);
                totalRows += rows.length;
                lines.push(`[${childDb.title}]`);
                if (cols.length > 0) lines.push(`  Columns: ${cols.join(" | ")}`);
                for (const row of rows) {
                  const cells = cols.map((_, i) => row[i] || "").map(s => String(s).trim());
                  lines.push(`  • ${cells.join(" | ")}`);
                }
              } catch {
                console.warn(`[voice] child DB query failed: ${childDb.title}`);
              }
            }
          } catch {
            console.warn(`[voice] vault page children failed`);
          }
        }
      }
    } else {
      console.warn(`[voice] NOTION_DATABASE_ID is not set in .env`);
    }

    /* Search for other databases (best-effort, non-blocking). */
    try {
      const { databases } = await searchNotionWorkspace();
      console.log(`[voice] search found ${databases.length} databases`);
      if (databases.length > 0) {
        lines.push("");
        lines.push("# Other Workspace Databases");
        for (const db of databases) {
          lines.push(`• ${db.title}`);
        }
      }
    } catch (e) {
      console.warn(`[voice] search failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    const context = lines.join("\n");
    console.log(`[voice] notion context built: ${context.length} chars, lines=${lines.length}`);
    if (context.length > 0 && context.length < 500) {
      console.log(`[voice] context preview: ${context}`);
    }
    notionVoiceContextCache = { context, expiresAt: now + 5 * 60 * 1000 };
    return context;
  } catch (e) {
    console.warn(`[voice] buildNotionVoiceContext failed: ${e instanceof Error ? e.message : String(e)}`);
    return "";
  }
}

/**
 * @param {unknown} properties properties object from GET /pages/{id}
 * @returns {string} Plain text title (Notion databases have exactly one title property).
 */
function plainTitleFromNotionPageProperties(properties) {
  if (!properties || typeof properties !== "object") {
    return "";
  }
  for (const key of Object.keys(properties)) {
    const p = /** @type {any} */ (
      properties[key]
    );
    if (p && p.type === "title" && Array.isArray(p.title)) {
      return p.title.map((t) => t.plain_text || "").join("").trim();
    }
  }
  return "";
}

/**
 * Relation fields on query responses only expose `{ id }`. Fetch linked pages once
 * so sheets show titles (e.g. School Name → related school DB row name), not UUIDs.
 * Mutates relation items with `display_name` when resolvable.
 * @param {string} token
 * @param {object[]} pages
 */
async function enrichRelationTitlesOnPages(token, pages) {
  if (!pages.length) {
    return;
  }

  /** @type {Set<string>} */
  const ids = new Set();

  for (const page of pages) {
    if (!page || typeof page !== "object") {
      continue;
    }
    const props = /** @type {any} */ (page).properties;
    if (!props || typeof props !== "object") {
      continue;
    }
    for (const raw of Object.values(props)) {
      const prop =
        /** @type {any} */ (
          raw
        );
      if (!prop || prop.type !== "relation" || !Array.isArray(prop.relation)) {
        continue;
      }
      for (const r of prop.relation) {
        if (r && typeof r.id === "string") {
          const id = normalizePageId(r.id.trim());
          if (id) {
            ids.add(id);
          }
        }
      }
    }
  }

  if (!ids.size) {
    return;
  }

  const list = [...ids];
  /** @type {Map<string, string>} */
  const idToTitle = new Map();

  const CHUNK = 6;
  for (let i = 0; i < list.length; i += CHUNK) {
    const chunk = list.slice(i, i + CHUNK);
    await Promise.all(
      chunk.map(async (id) => {
        try {
          const res = await fetch("https://" + "api.notion.com/v1/pages/" + id, {
            method: "GET",
            headers: notionReadHeaders(token),
          });
          const text = await res.text();
          if (!res.ok) {
            return;
          }
          const data = /** @type {any} */ (JSON.parse(text));
          const title = plainTitleFromNotionPageProperties(data.properties);
          if (title) {
            idToTitle.set(id, title);
          }
        } catch {
          /* ignore */
        }
      }),
    );
    if (i + CHUNK < list.length) {
      await new Promise((r) => setTimeout(r, 40));
    }
  }

  for (const page of pages) {
    if (!page || typeof page !== "object") {
      continue;
    }
    const props = /** @type {any} */ (page).properties;
    if (!props || typeof props !== "object") {
      continue;
    }
    for (const raw of Object.values(props)) {
      const prop =
        /** @type {any} */ (
          raw
        );
      if (!prop || prop.type !== "relation" || !Array.isArray(prop.relation)) {
        continue;
      }
      prop.relation = prop.relation.map((r) => {
        if (!r || typeof r !== "object" || typeof r.id !== "string") {
          return r;
        }
        const nid = normalizePageId(r.id.trim());
        const name = idToTitle.get(nid);
        if (typeof name === "string" && name.trim()) {
          return {
            ...r,
            display_name: name.trim(),
          };
        }
        return r;
      });
    }
  }
}

function notionNormalizeComparableTitle(t) {
  return String(t ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * GET /v1/databases/{id}
 * @param {string} token
 * @param {string} databaseIdNormalized
 */
async function notionGetDatabase(token, databaseIdNormalized) {
  const res = await fetch(
    "https://" + "api.notion.com/v1/databases/" + databaseIdNormalized,
    {
      method: "GET",
      headers: notionReadHeaders(token),
    },
  );
  const bodyText = await res.text();
  if (!res.ok) {
    const err = new Error(
      `Could not retrieve Notion database (${res.status}): ${bodyText}`,
    );
    err.code = "API";
    throw err;
  }
  return JSON.parse(bodyText);
}

/** @param {Record<string, unknown>} dbJson */
function notionPrimaryDataSourceIdFromDbJson(dbJson) {
  const sources = dbJson?.data_sources;
  if (!Array.isArray(sources) || !sources.length) {
    return "";
  }
  const id0 =
    typeof sources[0] === "object" && sources[0] !== null
      ? /** @type {any} */ (sources[0]).id
      : undefined;
  return typeof id0 === "string" ? normalizeDataSourceId(id0.trim()) : "";
}

/** Merge root + first data_sources entry property maps (/wiki DB schemas differ). */
function notionMergedDatabaseSchemaProperties(databaseJson) {
  /** @type {Record<string, unknown>} */
  const merged = {};
  const top = databaseJson?.properties;
  if (top && typeof top === "object" && !Array.isArray(top)) {
    Object.assign(merged, top);
  }
  const dsArr = databaseJson?.data_sources;
  const ds0 =
    Array.isArray(dsArr) && dsArr.length > 0 && typeof dsArr[0] === "object"
      ? dsArr[0]
      : null;
  const nested =
    ds0 &&
    ds0.properties &&
    typeof ds0.properties === "object" &&
    !Array.isArray(ds0.properties)
      ? ds0.properties
      : null;
  if (nested) {
    for (const [k, v] of Object.entries(nested)) {
      if (!(k in merged)) {
        merged[k] = v;
      }
    }
  }
  return merged;
}

/**
 * True when retrieve page rejects because UUID is actually a database.
 * @param {number} status
 * @param {string} detail
 */
function retrievedPageIndicatesDatabaseNotPage(status, detail) {
  if (status !== 400) {
    return false;
  }
  const t = detail.toLowerCase();
  return (
    t.includes("is a database") ||
    (t.includes("database") &&
      (t.includes("not a page") ||
        /\bprovided id\b.*\bdatabase\b/.test(detail.toLowerCase())))
  );
}

/**
 * Fetch every row from a database by id (same pipeline as main sheet refresh).
 * @param {string} token
 * @param {string} dbIdNormalized
 * @returns {Promise<{ columns: string[]; rows: string[][]; pageIds: string[] }>}
 */
async function retrieveNotionFullDatabaseAsTable(token, dbIdNormalized) {
  const dbJson = await notionGetDatabase(token, dbIdNormalized);
  let dataSourceId = notionPrimaryDataSourceIdFromDbJson(dbJson);
  if (!dataSourceId) {
    dataSourceId = await resolveDataSourceId(token, dbIdNormalized, undefined);
  }
  const pages = await queryDataSourceAllPages(token, dataSourceId);
  await enrichRelationTitlesOnPages(token, pages);
  const table = pagesToTable(pages);

  if (table.columns.length > 0 || table.rows.length > 0) {
    return table;
  }

  const schemaCols = Object.keys(notionMergedDatabaseSchemaProperties(dbJson))
    .filter((name) => name && String(name).trim())
    .sort((a, b) => a.localeCompare(b));

  if (!schemaCols.length) {
    const err = new Error(
      "That Notion database returned no rows and no column definitions to display.",
    );
    err.code = "API";
    throw err;
  }

  return { columns: schemaCols, rows: [], pageIds: [] };
}

/**
 * Fetch a single database row by page UUID and return columns/rows/pageIds (same shape as query).
 * If the id is actually a database, loads the entire database into columns/rows/pageIds (up to sync limits).
 * @param {string} token
 * @param {string} pageIdRaw
 * @param {object} [options] Forward-compatibility; reserved for IPC.
 */
async function retrieveNotionPageAsTable(token, pageIdRaw, _options = {}) {
  void _options;

  const id = normalizePageId(pageIdRaw);
  if (!id) {
    const err = new Error("Missing or invalid Notion page id.");
    err.code = "BAD_INPUT";
    throw err;
  }

  const res = await fetch("https://" + "api.notion.com/v1/pages/" + id, {
    method: "GET",
    headers: notionReadHeaders(token),
  });
  const bodyText = await res.text();
  if (!res.ok) {
    let detail = bodyText;
    try {
      const j = JSON.parse(bodyText);
      if (typeof j.message === "string") {
        detail = j.message;
      }
    } catch {
      /* keep */
    }

    const looksLikeDb = retrievedPageIndicatesDatabaseNotPage(res.status, detail);

    if (looksLikeDb) {
      const dbId = normalizeDatabaseId(pageIdRaw) || normalizeDatabaseId(id);
      if (dbId) {
        try {
          return await retrieveNotionFullDatabaseAsTable(token, dbId);
        } catch (e2) {
          if (
            e2 instanceof Error &&
            typeof e2 === "object" &&
            "code" in e2 &&
            (e2.code === "BAD_INPUT" || e2.code === "API")
          ) {
            throw e2;
          }
          const msg = e2 instanceof Error ? e2.message : String(e2);
          const err = new Error(
            `${detail} — Full database fetch failed: ${msg}`,
          );
          err.code = "API";
          throw err;
        }
      }
    }

    const err = new Error(`Could not read Notion page (${res.status}): ${detail}`);
    err.code = "API";
    throw err;
  }

  const page = JSON.parse(bodyText);
  if (
    page &&
    typeof page === "object" &&
    page.object === "page" &&
    page.properties &&
    typeof page.properties === "object"
  ) {
    await enrichRelationTitlesOnPages(token, [/** @type {object} */ (page)]);
  }

  return pagesToTable([/** @type {object} */ (page)]);
}

/**
 * @param {object} [opts]
 */
async function queryNotionTableForSource(opts = {}) {
  const { token, dataSourceId } = await resolveNotionTokenAndDataSourceId(opts);
  const pages = await queryDataSourceAllPages(token, dataSourceId);
  await enrichRelationTitlesOnPages(token, pages);
  return pagesToTable(pages);
}

async function queryNotionDatabase() {
  return queryNotionTableForSource({});
}

/**
 * Load all pages from a source, filter to this teacher, then resolve relation titles only for those rows.
 * Avoids hundreds of GET /pages calls when the shared payslip DB has many teachers' rows.
 * @param {{ databaseId?: string; dataSourceId?: string }} sourceOpts Passed to {@link resolveNotionTokenAndDataSourceId}.
 * @param {string} email Teacher sign-in email (used when person filter matches nothing).
 * @param {string} notionPersonRecordId Optional Notion person / row id filter.
 * @param {{ personOnly?: boolean }} [mode] When true (dedicated DB), only apply the person filter (no email fallback).
 */
async function queryNotionTeacherPayslipRowsPartialEnrich(
  sourceOpts,
  email,
  notionPersonRecordId,
  mode,
) {
  const { token, dataSourceId } =
    await resolveNotionTokenAndDataSourceId(sourceOpts);
  const pages = await queryDataSourceAllPages(token, dataSourceId);
  const baseTable = pagesToTable(pages);

  /** @type {{ columns: string[]; rows: string[][]; pageIds: string[]; noEmailColumn?: boolean }} */
  let filtered;

  if (mode?.personOnly && notionPersonRecordId) {
    filtered = filterPayslipsForNotionPerson(baseTable, notionPersonRecordId);
  } else if (notionPersonRecordId) {
    const byPerson = filterPayslipsForNotionPerson(
      baseTable,
      notionPersonRecordId,
    );
    filtered =
      byPerson.rows.length > 0
        ? byPerson
        : filterPayslipsForTeacher(baseTable, email);
  } else {
    filtered = filterPayslipsForTeacher(baseTable, email);
  }

  /** @type {Map<string, object>} */
  const pageById = new Map();
  for (const p of pages) {
    if (!p || typeof p !== "object" || !("id" in p)) {
      continue;
    }
    const id = normalizePageId(String(/** @type {{ id?: unknown }} */ (p).id));
    if (id) {
      pageById.set(id, /** @type {object} */ (p));
    }
  }

  const orderedSubset = [];
  for (const rawPid of filtered.pageIds || []) {
    const pid = normalizePageId(String(rawPid));
    const pg = pid ? pageById.get(pid) : undefined;
    if (pg) {
      orderedSubset.push(pg);
    }
  }

  await enrichRelationTitlesOnPages(token, orderedSubset);
  const out = pagesToTable(orderedSubset);
  return {
    ok: true,
    columns: out.columns,
    rows: out.rows,
    pageIds: out.pageIds,
    noEmailColumn: Boolean(filtered.noEmailColumn),
  };
}

/**
 * PATCH a database page date property by exact Notion column name (must match a `date`-type column).
 * @param {string} token
 * @param {string} pageIdRaw
 * @param {string} propertyName
 * @param {string | null} ymd `'YYYY-MM-DD'` or empty/null to clear
 */
async function patchNotionPageDateProperty(
  token,
  pageIdRaw,
  propertyName,
  ymd,
) {
  const id = normalizePageId(pageIdRaw);
  if (!id) {
    const err = new Error("Missing or invalid Notion page id.");
    err.code = "BAD_INPUT";
    throw err;
  }
  const prop = String(propertyName ?? "").trim();
  if (!prop) {
    const err = new Error("Missing property name.");
    err.code = "BAD_INPUT";
    throw err;
  }

  /** @type {Record<string, unknown>} */
  const properties = {};

  const clear =
    ymd === null ||
    String(ymd ?? "")
      .trim() === "";

  properties[prop] = clear
    ? { date: null }
    : { date: { start: String(ymd).trim() } };

  const res = await fetch("https://" + "api.notion.com/v1/pages/" + id, {
    method: "PATCH",
    headers: notionHeaders(token),
    body: JSON.stringify({ properties }),
  });

  const bodyText = await res.text();
  if (!res.ok) {
    let detail = bodyText;
    try {
      const j = JSON.parse(bodyText);
      if (typeof j.message === "string") {
        detail = j.message;
      }
    } catch {
      /* keep bodyText */
    }
    const err = new Error(
      `Could not update Notion (${res.status}): ${detail}`,
    );
    err.code = "API";
    throw err;
  }
}

/**
 * PATCH a database page number property by exact Notion column name (must match a `number`-type column).
 * @param {string} token
 * @param {string} pageIdRaw
 * @param {string} propertyName
 * @param {number | null} value Use `null` to clear
 */
async function patchNotionPageNumberProperty(
  token,
  pageIdRaw,
  propertyName,
  value,
) {
  const id = normalizePageId(pageIdRaw);
  if (!id) {
    const err = new Error("Missing or invalid Notion page id.");
    err.code = "BAD_INPUT";
    throw err;
  }
  const prop = String(propertyName ?? "").trim();
  if (!prop) {
    const err = new Error("Missing property name.");
    err.code = "BAD_INPUT";
    throw err;
  }

  const clear =
    value === null ||
    (typeof value === "number" && !Number.isFinite(value));

  /** @type {Record<string, unknown>} */
  const properties = {};
  properties[prop] = clear ? { number: null } : { number: value };

  const res = await fetch("https://" + "api.notion.com/v1/pages/" + id, {
    method: "PATCH",
    headers: notionHeaders(token),
    body: JSON.stringify({ properties }),
  });

  const bodyText = await res.text();
  if (!res.ok) {
    let detail = bodyText;
    try {
      const j = JSON.parse(bodyText);
      if (typeof j.message === "string") {
        detail = j.message;
      }
    } catch {
      /* keep bodyText */
    }
    const err = new Error(
      `Could not update Notion (${res.status}): ${detail}`,
    );
    err.code = "API";
    throw err;
  }
}

/**
 * PATCH a database page property by exact Notion column name. The existing page schema
 * decides the safe payload shape, so renderer.js never sends raw Notion API bodies.
 * @param {string} token
 * @param {string} pageIdRaw
 * @param {string} propertyName
 * @param {unknown} value
 */
async function patchNotionPageGenericProperty(
  token,
  pageIdRaw,
  propertyName,
  value,
) {
  const id = normalizePageId(pageIdRaw);
  if (!id) {
    const err = new Error("Missing or invalid Notion page id.");
    err.code = "BAD_INPUT";
    throw err;
  }
  const propName = String(propertyName ?? "").trim();
  if (!propName) {
    const err = new Error("Missing property name.");
    err.code = "BAD_INPUT";
    throw err;
  }

  const pageRes = await fetch("https://" + "api.notion.com/v1/pages/" + id, {
    method: "GET",
    headers: notionReadHeaders(token),
  });
  const pageText = await pageRes.text();
  if (!pageRes.ok) {
    const err = new Error(`Could not read Notion page (${pageRes.status}): ${pageText}`);
    err.code = "API";
    throw err;
  }
  const pageJson = JSON.parse(pageText);
  const prop = pageJson?.properties?.[propName];
  if (!prop || typeof prop !== "object") {
    const err = new Error(`Property "${propName}" was not found on this Notion row.`);
    err.code = "BAD_INPUT";
    throw err;
  }

  const raw = value == null ? "" : String(value);
  const trimmed = raw.trim();
  /** @type {Record<string, unknown>} */
  const properties = {};
  switch (prop.type) {
    case "title":
      properties[propName] = { title: trimmed ? [{ text: { content: trimmed } }] : [] };
      break;
    case "rich_text":
      properties[propName] = { rich_text: trimmed ? [{ text: { content: trimmed } }] : [] };
      break;
    case "url":
      properties[propName] = { url: trimmed || null };
      break;
    case "email":
      properties[propName] = { email: trimmed || null };
      break;
    case "phone_number":
      properties[propName] = { phone_number: trimmed || null };
      break;
    case "number": {
      if (!trimmed) {
        properties[propName] = { number: null };
      } else {
        const n = Number.parseFloat(trimmed);
        if (!Number.isFinite(n)) {
          const err = new Error("Invalid number.");
          err.code = "BAD_INPUT";
          throw err;
        }
        properties[propName] = { number: n };
      }
      break;
    }
    case "checkbox":
      properties[propName] = { checkbox: /^(1|true|yes|y|done|checked)$/i.test(trimmed) };
      break;
    case "select":
      properties[propName] = { select: trimmed ? { name: trimmed } : null };
      break;
    case "status":
      properties[propName] = { status: trimmed ? { name: trimmed } : null };
      break;
    case "multi_select":
      properties[propName] = {
        multi_select: trimmed
          ? trimmed.split(",").map((name) => ({ name: name.trim() })).filter((x) => x.name)
          : [],
      };
      break;
    case "date":
      properties[propName] = { date: trimmed ? { start: trimmed } : null };
      break;
    default: {
      const err = new Error(`Property type "${prop.type}" is not editable from the Operations dashboard yet.`);
      err.code = "BAD_INPUT";
      throw err;
    }
  }

  const res = await fetch("https://" + "api.notion.com/v1/pages/" + id, {
    method: "PATCH",
    headers: notionHeaders(token),
    body: JSON.stringify({ properties }),
  });
  const bodyText = await res.text();
  if (!res.ok) {
    let detail = bodyText;
    try {
      const j = JSON.parse(bodyText);
      if (typeof j.message === "string") {
        detail = j.message;
      }
    } catch {
      /* keep bodyText */
    }
    const err = new Error(`Could not update Notion (${res.status}): ${detail}`);
    err.code = "API";
    throw err;
  }
}

function normalizeEmailForPayslip(s) {
  let e = String(s || "")
    .trim()
    .toLowerCase()
    .replace(/^mailto:/i, "");
  if (e.endsWith("@googlemail.com")) {
    const local = e.slice(0, -"@googlemail.com".length);
    e = `${local}@gmail.com`;
  }
  return e;
}

/**
 * Pull every plausible email from a cell (handles "Name <x@y.com>", extra text, multiple addresses).
 * @param {unknown} raw
 * @returns {string[]}
 */
function extractEmailsFromCell(raw) {
  const s = String(raw ?? "");
  const set = new Set();
  const add = (v) => {
    const n = normalizeEmailForPayslip(v);
    if (n) {
      set.add(n);
    }
  };
  add(s);
  for (const part of s.split(/[\s,;|]+/)) {
    add(part);
  }
  const re = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    add(m[0]);
  }
  return [...set];
}

function cellMatchesTeacherEmail(cellValue, want) {
  if (!want) {
    return false;
  }
  const inCell = extractEmailsFromCell(cellValue);
  return inCell.includes(want);
}

/**
 * @param {string[]} columns
 * @returns {number[]}
 */
function findPayslipEmailColumnIndices(columns) {
  const indices = [];
  columns.forEach((c, i) => {
    const s = String(c).trim();
    if (!s) {
      return;
    }
    if (/^e-?mails?$/i.test(s)) {
      indices.push(i);
      return;
    }
    if (/\b(e-?mails?|email\s+address)\b/i.test(s)) {
      indices.push(i);
      return;
    }
    if (/\be\s*mail\b/i.test(s)) {
      indices.push(i);
      return;
    }
    if (/\bemail\b/i.test(s)) {
      indices.push(i);
      return;
    }
    if (/\b(e-?mail|electronic\s+mail)\b/i.test(s)) {
      indices.push(i);
      return;
    }
    if (
      /\b(teacher|contact|work|staff|payee|pay\s*roll|payroll)\b/i.test(s) &&
      /\b(e-?mail|email)\b/i.test(s)
    ) {
      indices.push(i);
    }
  });
  return indices;
}

/**
 * @param {object} table
 * @param {string} teacherEmail
 */
function filterPayslipsForTeacher(table, teacherEmail) {
  const want = normalizeEmailForPayslip(teacherEmail);
  if (!want) {
    return {
      columns: table.columns || [],
      rows: [],
      pageIds: [],
      noEmailColumn: false,
    };
  }
  const cols = table.columns || [];
  const indices = findPayslipEmailColumnIndices(cols);
  const rows = [];
  const pageIds = [];
  const tableRows = table.rows || [];
  const tablePageIds = table.pageIds || [];
  tableRows.forEach((row, i) => {
    if (!row || !row.length) {
      return;
    }
    const match = row.some((cell) => cellMatchesTeacherEmail(cell, want));
    if (match) {
      rows.push(row);
      pageIds.push(tablePageIds[i] || "");
    }
  });
  return {
    columns: cols,
    rows,
    pageIds,
    noEmailColumn: indices.length === 0 && rows.length === 0,
  };
}

/**
 * Normalize Notion UUID for loose comparison (hyphens optional).
 * @param {unknown} raw
 */
function normalizeNotionUuidLoose(raw) {
  const s = String(raw ?? "")
    .replace(/-/g, "")
    .toLowerCase()
    .trim();
  return /^[0-9a-f]{20,}$/.test(s) ? s : "";
}

/**
 * Keep payslip rows tied to a teacher's Notion person/page id (from admin links).
 * Matches row page id or any cell text containing the id (e.g. relation rollups).
 * @param {object} table
 * @param {string} personIdRaw
 */
function filterPayslipsForNotionPerson(table, personIdRaw) {
  const want = normalizeNotionUuidLoose(personIdRaw);
  if (!want) {
    return {
      columns: table.columns || [],
      rows: [],
      pageIds: [],
      noEmailColumn: false,
    };
  }
  const withHyphens = String(personIdRaw ?? "").trim();
  const cols = table.columns || [];
  const rows = [];
  const pageIds = [];
  const tableRows = table.rows || [];
  const tablePageIds = table.pageIds || [];
  tableRows.forEach((row, i) => {
    if (!row || !row.length) {
      return;
    }
    const pid = normalizeNotionUuidLoose(tablePageIds[i]);
    if (pid && pid === want) {
      rows.push(row);
      pageIds.push(tablePageIds[i] || "");
      return;
    }
    const hay = row
      .map((c) => String(c ?? "").toLowerCase())
      .join(" \n ");
    if (
      hay.includes(want) ||
      (withHyphens.length > 8 && hay.includes(withHyphens.toLowerCase()))
    ) {
      rows.push(row);
      pageIds.push(tablePageIds[i] || "");
    }
  });
  return {
    columns: cols,
    rows,
    pageIds,
    noEmailColumn: false,
  };
}

function sanitizePaySlipFileStem(title) {
  const base = String(title || "Pay slip")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return base || "Pay slip";
}

/** HTTPS Discord channel/message links only (teachers portal support + totals). */
function isAllowedDiscordExternalUrl(rawUrl) {
  let u;
  try {
    u = new URL(String(rawUrl ?? "").trim());
  } catch {
    return false;
  }
  if (u.protocol !== "https:") {
    return false;
  }
  const host = u.hostname.toLowerCase();
  const allowed =
    host === "discord.com" ||
    host.endsWith(".discord.com") ||
    host === "discordapp.com" ||
    host.endsWith(".discordapp.com");
  if (!allowed) {
    return false;
  }
  const parts = u.pathname.split("/").filter(Boolean);
  return parts[0] === "channels" && parts.length >= 2;
}

/**
 * discord:// links are handled by the Discord desktop app; https:// opens in the browser.
 * @param {string} httpsUrl
 * @returns {string[]}
 */
function discordDesktopUrlCandidates(httpsUrl) {
  const u = new URL(String(httpsUrl ?? "").trim());
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts[0] !== "channels" || parts.length < 2) {
    return [];
  }
  const guildId = parts[1];
  const channelId = parts[2];
  const messageId = parts[3];
  const channelPath =
    messageId != null && String(messageId).length > 0
      ? `/channels/${guildId}/${channelId}/${messageId}`
      : `/channels/${guildId}/${channelId}`;
  return [
    `discord://discord.com${channelPath}`,
    `discord://-${channelPath}`,
  ];
}

/**
 * @param {string} deepUrl
 * @returns {Promise<boolean>}
 */
async function launchDiscordDesktopUrl(deepUrl) {
  try {
    await shell.openExternal(deepUrl, { activate: true });
    return true;
  } catch {
    /* fall through */
  }
  if (process.platform === "win32") {
    try {
      await execFileAsync("cmd.exe", ["/d", "/c", "start", "", deepUrl], {
        windowsHide: true,
      });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * @param {string} httpsUrl
 * @returns {Promise<{ ok: boolean; message?: string; opened?: string; fallback?: string }>}
 */
async function openDiscordExternal(httpsUrl) {
  const url = String(httpsUrl ?? "").trim();
  if (!isAllowedDiscordExternalUrl(url)) {
    return { ok: false, message: "Invalid URL." };
  }
  const candidates = discordDesktopUrlCandidates(url);
  for (const deep of candidates) {
    if (await launchDiscordDesktopUrl(deep)) {
      return { ok: true, opened: deep };
    }
  }
  try {
    await shell.openExternal(url, { activate: true });
    return { ok: true, opened: url, fallback: "browser" };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

function getMainBrowserWindow() {
  return (
    BrowserWindow.getFocusedWindow() ||
    mainWindow ||
    BrowserWindow.getAllWindows()[0] ||
    null
  );
}

function focusMainWindow() {
  const w = getMainBrowserWindow();
  if (w && !w.isDestroyed()) {
    if (w.isMinimized()) {
      w.restore();
    }
    w.focus();
  }
}

function minimizeMainWindow() {
  const w = getMainBrowserWindow();
  if (w && !w.isDestroyed()) {
    w.minimize();
  }
}

/** @param {"background" | "foreground"} profile */
function syncWindowsEfficiencyMode(profile) {
  if (!winEfficiencyMode) {
    return;
  }
  try {
    winEfficiencyMode.applyToCurrentProcess(profile);
    const w = getMainBrowserWindow();
    if (w && !w.isDestroyed()) {
      winEfficiencyMode.applyToBrowserWindow(w, profile);
    }
  } catch (e) {
    console.warn("Windows efficiency mode sync:", e);
  }
}

function attachWindowsEfficiencyModeHandlers(win) {
  if (!winEfficiencyMode || !win) {
    return;
  }
  const applyBackground = () => syncWindowsEfficiencyMode("background");
  const applyForeground = () => syncWindowsEfficiencyMode("foreground");

  win.webContents.on("did-finish-load", () => {
    applyBackground();
    setTimeout(() => applyBackground(), 1200);
  });

  win.on("minimize", applyBackground);
  win.on("hide", applyBackground);
  win.on("blur", applyBackground);

  win.on("restore", applyForeground);
  win.on("show", applyForeground);
  win.on("focus", applyForeground);

  app.on("browser-window-blur", () => {
    if (BrowserWindow.getFocusedWindow() == null) {
      applyBackground();
    }
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1024,
    height: 800,
    show: false,
    fullscreenable: true,
    // Avoid a white native surface flash before the renderer paints (app defaults to dark).
    backgroundColor: "#191919",
    icon: path.join(__dirname, "assets", "rme-logo.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow = win;

  attachWindowsEfficiencyModeHandlers(win);

  win.once("ready-to-show", () => {
    try {
      win.setFullScreen(true);
    } catch {
      /* ignore */
    }
    win.show();
  });

  let lifecyclePersistCloseHandled = false;
  win.on("close", (e) => {
    if (lifecyclePersistCloseHandled) {
      return;
    }
    e.preventDefault();
    lifecyclePersistCloseHandled = true;
    void (async () => {
      try {
        if (!win.webContents.isDestroyed()) {
          await win.webContents.executeJavaScript(
            RENDERER_FLUSH_FLOATING_DRAFTS_JS,
            true,
          );
          await win.webContents.executeJavaScript(
            RENDERER_FLUSH_PLANNER_JS,
            true,
          );
        }
      } catch {
        /* WebContents may refuse during teardown */
      }
      try {
        if (!win.isDestroyed()) {
          win.destroy();
        }
      } catch {
        /* ignore */
      }
    })();
  });

  win.on("closed", () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });

  win.loadFile(path.join(__dirname, "index.html"));
}

/** @type {Map<string, number>} */
const recentCalendarNotifications = new Map();

const CALENDAR_APP_USER_MODEL_ID = "com.recruitmyenglish.app";

/** @returns {string | undefined} */
function calendarReminderIconPath() {
  // Prefer the small PNG — loading the multi-MB JPG blocks Windows toasts.
  const candidates = [
    path.join(__dirname, "assets", "tolerance-bridge-bg.png"),
    path.join(__dirname, "assets", "tolerance-new.jpg"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

/** @type {import("electron").NativeImage | null | undefined} */
let cachedReminderNotificationIcon;

/** @returns {import("electron").NativeImage | null} */
function getCachedReminderNotificationIcon() {
  if (cachedReminderNotificationIcon !== undefined) {
    return cachedReminderNotificationIcon;
  }
  const iconPath = calendarReminderIconPath();
  if (!iconPath) {
    cachedReminderNotificationIcon = null;
    return null;
  }
  try {
    const img = nativeImage.createFromPath(iconPath);
    cachedReminderNotificationIcon = img.isEmpty() ? null : img;
  } catch {
    cachedReminderNotificationIcon = null;
  }
  return cachedReminderNotificationIcon;
}

function warmReminderNotificationAssets() {
  ensureWindowsNotificationShortcut();
  getCachedReminderNotificationIcon();
}

/** Windows toast notifications require a Start Menu shortcut with AppUserModelID. */
function ensureWindowsNotificationShortcut() {
  if (process.platform !== "win32") return;

  app.setAppUserModelId(CALENDAR_APP_USER_MODEL_ID);

  const shortcutPath = path.join(
    app.getPath("appData"),
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Recruit My English.lnk",
  );
  const projectRoot = path.resolve(__dirname);
  /** @type {import("electron").ShortcutDetails} */
  const details = {
    target: process.execPath,
    args: app.isPackaged ? "" : ".",
    cwd: app.isPackaged ? path.dirname(process.execPath) : projectRoot,
    description: "Recruit My English",
    appUserModelId: CALENDAR_APP_USER_MODEL_ID,
  };
  const iconPath = calendarReminderIconPath();
  if (iconPath) {
    details.icon = iconPath;
    details.iconIndex = 0;
  }
  let ok = false;
  try {
    ok = shell.writeShortcutLink(shortcutPath, "replace", details);
    if (!ok) {
      ok = shell.writeShortcutLink(shortcutPath, "create", details);
    }
  } catch (e) {
    console.warn("[calendar notifications] Start Menu shortcut:", e);
  }
  if (!ok) {
    console.warn(
      "[calendar notifications] Could not write Start Menu shortcut — Windows toasts may not appear until the app is installed.",
    );
  }
}

function flashMainWindowAttention() {
  const win =
    mainWindow && !mainWindow.isDestroyed()
      ? mainWindow
      : BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (!win || win.isDestroyed()) return false;
  try {
    win.flashFrame(true);
    const stop = () => {
      if (!win.isDestroyed()) win.flashFrame(false);
      win.removeListener("focus", stop);
    };
    win.on("focus", stop);
    return true;
  } catch {
    return false;
  }
}

/**
 * Show a native toast immediately (do not wait for the "show" event — that lags IPC).
 * @param {Electron.NotificationConstructorOptions} opts
 * @returns {{ ok: boolean; reason?: string }}
 */
function showNativeReminderNotification(opts) {
  try {
    const n = new Notification(opts);
    n.on("click", () => {
      focusMainWindow();
    });
    n.show();
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    focusMainWindow();
  });

  function spawnVadSidecar() {
    try {
      _vadPort = Number(process.env.RME_VAD_PORT || "8125") || 8125;
      const scriptPath = path.join(process.env.RME_TOOLS_ROOT || path.join(__dirname, "tools"), "vad", "vad-server.py");
      if (!fs.existsSync(scriptPath)) {
        console.warn("[vad] Server script not found at", scriptPath);
        return;
      }
      const pythonCmd = process.env.RME_PYTHON_EXE || (process.platform === "win32" ? "py" : "python3");
      console.log(`[vad] Starting Silero VAD server: ${pythonCmd} ${scriptPath} --port ${_vadPort}`);
      _vadProc = spawn(pythonCmd, [scriptPath, "--port", String(_vadPort)], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      _vadProc.on("error", (err) => {
        console.error("[vad] FAILED to start Silero VAD sidecar:", err.message, "— voice input will be DEGRADED (no speech detection). Ensure Python is installed and run: pip install -r tools/vad/requirements.txt");
        _vadProc = null;
      });
      _vadProc.stdout.on("data", (d) => {
        const text = d.toString().trim();
        if (text) console.log("[vad-server]", text);
      });
      _vadProc.stderr.on("data", (d) => {
        const text = d.toString().trim();
        if (text) console.log("[vad-server]", text);
      });
      _vadProc.on("exit", (code) => {
        _vadProc = null;
        if (code === 0 || code === null) {
          console.log(`[vad] VAD server exited code=${code}`);
        } else {
          console.error(`[vad] Silero VAD sidecar EXITED abnormally (code=${code}) — voice input will be DEGRADED (no speech detection). Check deps: pip install -r tools/vad/requirements.txt (needs websockets>=13, silero-vad, torch).`);
        }
      });
    } catch (e) {
      console.warn("[vad] Failed to start VAD sidecar:", e instanceof Error ? e.message : String(e));
    }
  }

  app.whenReady().then(async () => {
    const tBoot = Date.now();
    loadDotenv();
    applyVoiceEnvPaths(__dirname);
    console.log("[perf] boot:dotenv ready in", Date.now() - tBoot, "ms");
    if (!cudaRuntimeLikelyAvailable()) {
      console.warn(
        "[voice] CUDA 12.x toolkit not detected. STT will use CPU (Whisper fallback).",
      );
    }
    void ensureSttServer().catch((e) => {
      console.warn(
        `[voice] STT server did not start: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
    const userDataPath = app.getPath("userData");
    seedPackagedEnvTemplate(userDataPath);
    try {
      void getVoiceAgent().warmVoiceStack().then(() => {
        console.log("[voice] Voice stack fully warmed (TTS + STT).");
      }).catch((e) => {
        console.warn(
          `[voice] background warm failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
      void getVoiceAgent().warmFillerClips().then((r) => {
        if (r.ok) {
          console.log(`[voice] Filler clips warmed: ${r.existed} cached, ${r.generated} generated / ${r.total}`);
        }
      }).catch((e) => {
        console.warn(`[voice] filler warm failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    } catch (e) {
      console.warn(
        `[voice] getVoiceAgent threw during init (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    void spawnVadSidecar();
    setTimeout(() => warmReminderNotificationAssets(), 2000);

    notionApi = new NotionApi();
    /* AI Chat service (non-voice, reuses notionApi for REST tools) */
    (function initAiChat() {
      const { getAiChatService } = require("./lib/ai-chat");
      const { ALLOWED_ADMIN_EMAIL } = require("./auth-store");
      const svc = getAiChatService();
      svc._notionApi = notionApi;
      svc.setUserEmail(ALLOWED_ADMIN_EMAIL);
    })();

    /* Load persisted voice preference — always force Ryan English as the only voice */
    try {
      const { setVoice } = require("./lib/tts/index");
      if (typeof setVoice === "function") setVoice("ryan-english");
    } catch (e) {
      /* ignore */
    }

    log.info("notion", { tokenSet: !!process.env.NOTION_TOKEN, status: "ready" });

    /* Pre-warm embedding model in background so first voice turn isn't slowed */
    setTimeout(() => {
      embed("warm up").then(r => {
        if (r.ok) log.info("memory", { embedWarm: "ok" });
        else log.warn("memory", { embedWarm: "failed", error: r.error?.message });
      });
    }, 3000);

    /* Warm-load studio master so ffmpeg binary resolves at startup */
    setTimeout(() => {
      require("./lib/tts/studio-master");
      console.log("[tts] Studio TTS chain ready");
    }, 1000);

    ipcMain.handle("calendar:notification-supported", () => Notification.isSupported());
    ipcMain.handle("calendar:flash-attention", () => flashMainWindowAttention());
    ipcMain.on("calendar:show-reminder", (_evt, payload) => {
      if (!Notification.isSupported()) return;
      const p =
        payload && typeof payload === "object" && !Array.isArray(payload)
          ? payload
          : {};
      const title =
        typeof p.title === "string" && p.title.trim()
          ? p.title.trim()
          : "Reminder";
      const body = typeof p.body === "string" ? p.body.trim() : "";
      const tag = typeof p.tag === "string" ? p.tag.trim() : "";
      const silent = p.silent === true;
      if (tag) {
        const prev = recentCalendarNotifications.get(tag) ?? 0;
        if (Date.now() - prev < 90000) return;
      }

      flashMainWindowAttention();

      const icon = getCachedReminderNotificationIcon();
      /** @type {Electron.NotificationConstructorOptions} */
      const withIcon = {
        title,
        body: body || undefined,
        silent,
        ...(tag ? { tag } : {}),
        ...(icon ? { icon } : {}),
      };
      let result = showNativeReminderNotification(withIcon);
      if (!result.ok) {
        result = showNativeReminderNotification({
          title,
          body: body || undefined,
          silent,
        });
      }
      if (!result.ok) {
        console.warn("[calendar notifications] show failed:", result.reason || "unknown");
        return;
      }

      if (tag) {
        recentCalendarNotifications.set(tag, Date.now());
        if (recentCalendarNotifications.size > 200) {
          const cutoff = Date.now() - 3600000;
          for (const [k, t] of recentCalendarNotifications) {
            if (t < cutoff) recentCalendarNotifications.delete(k);
          }
        }
      }
    });

    ipcMain.handle("auth:has-admin", (_evt, email) => hasAdmin(email));
    ipcMain.handle("auth:allowed-admin-email", () => ({
      email: ALLOWED_ADMIN_EMAIL,
    }));
    ipcMain.handle("notion:query-database", async (_evt, opts) => {
      try {
        loadDotenv();
        const o =
          opts && typeof opts === "object" && !Array.isArray(opts) ? opts : {};
        const table = await queryNotionTableForSource(o);
        return { ok: true, ...table };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const code = e instanceof Error && "code" in e ? e.code : "UNKNOWN";
        return { ok: false, code, message };
      }
    });

    ipcMain.handle("notion:retrieve-page-table", async (_evt, rawPayload) => {
      try {
        loadDotenv();
        const token = normalizeNotionToken(process.env.NOTION_TOKEN);
        if (!token) {
          return {
            ok: false,
            code: "CONFIG",
            message: notionMissingTokenMessage(),
            columns: [],
            rows: [],
            pageIds: [],
          };
        }
        let pageIdRaw = "";
        let rowTitleHint = "";
        if (typeof rawPayload === "string") {
          pageIdRaw = rawPayload;
        } else if (
          rawPayload &&
          typeof rawPayload === "object" &&
          !Array.isArray(rawPayload)
        ) {
          const o = rawPayload;
          pageIdRaw =
            typeof o.pageId === "string"
              ? o.pageId.trim()
              : typeof o.id === "string"
                ? o.id.trim()
                : "";
          rowTitleHint =
            typeof o.rowTitleHint === "string" ? o.rowTitleHint.trim() : "";
        }
        const table = await retrieveNotionPageAsTable(token, pageIdRaw, {
          rowTitleHint,
        });
        return { ok: true, ...table };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const code = e instanceof Error && "code" in e ? e.code : "UNKNOWN";
        return {
          ok: false,
          code,
          message,
          columns: [],
          rows: [],
          pageIds: [],
        };
      }
    });

    ipcMain.handle("notion:update-page-date", async (_evt, payload) => {
      try {
        loadDotenv();
        const token = normalizeNotionToken(process.env.NOTION_TOKEN);
        if (!token) {
          return { ok: false, message: notionMissingTokenMessage() };
        }
        const p =
          payload && typeof payload === "object" && !Array.isArray(payload)
            ? payload
            : {};
        const pageId =
          typeof p.pageId === "string"
            ? p.pageId.trim()
            : "";
        const propertyName =
          typeof p.propertyName === "string"
            ? p.propertyName.trim()
            : "";
        const rawYmd =
          typeof p.ymd === "string"
            ? p.ymd.trim()
            : p.ymd == null ? null : "";

        await patchNotionPageDateProperty(
          token,
          pageId,
          propertyName,
          rawYmd == null ? null : rawYmd,
        );

        return { ok: true };
      } catch (e) {
        const message =
          e instanceof Error ? e.message : String(e);
        return { ok: false, message };
      }
    });

    ipcMain.handle("notion:update-page-number", async (_evt, payload) => {
      try {
        loadDotenv();
        const token = normalizeNotionToken(process.env.NOTION_TOKEN);
        if (!token) {
          return { ok: false, message: notionMissingTokenMessage() };
        }
        const p =
          payload && typeof payload === "object" && !Array.isArray(payload)
            ? payload
            : {};
        const pageId =
          typeof p.pageId === "string"
            ? p.pageId.trim()
            : "";
        const propertyName =
          typeof p.propertyName === "string"
            ? p.propertyName.trim()
            : "";
        const rawNum = p.number;

        let num = null;
        if (rawNum === null || rawNum === undefined || rawNum === "") {
          num = null;
        } else if (typeof rawNum === "number" && Number.isFinite(rawNum)) {
          num = rawNum;
        } else if (typeof rawNum === "string" && rawNum.trim() !== "") {
          const parsed = Number.parseFloat(rawNum.trim());
          num = Number.isFinite(parsed) ? parsed : NaN;
        } else {
          num = NaN;
        }

        if (num !== null && Number.isNaN(num)) {
          return { ok: false, message: "Invalid number." };
        }

        await patchNotionPageNumberProperty(
          token,
          pageId,
          propertyName,
          num,
        );

        return { ok: true };
      } catch (e) {
        const message =
          e instanceof Error ? e.message : String(e);
        return { ok: false, message };
      }
    });

    ipcMain.handle("notion:update-page-property", async (_evt, payload) => {
      try {
        loadDotenv();
        const token = normalizeNotionToken(process.env.NOTION_TOKEN);
        if (!token) {
          return { ok: false, message: notionMissingTokenMessage() };
        }
        const p =
          payload && typeof payload === "object" && !Array.isArray(payload)
            ? payload
            : {};
        const pageId =
          typeof p.pageId === "string"
            ? p.pageId.trim()
            : "";
        const propertyName =
          typeof p.propertyName === "string"
            ? p.propertyName.trim()
            : "";
        await patchNotionPageGenericProperty(
          token,
          pageId,
          propertyName,
          p.value,
        );
        return { ok: true };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const code = e instanceof Error && "code" in e ? e.code : "UNKNOWN";
        return { ok: false, code, message };
      }
    });

    ipcMain.handle("notion:query-teacher-databases", async (_evt, sources) => {
      try {
        loadDotenv();
        const list = Array.isArray(sources) ? sources : [];
        const sections = await Promise.all(
          list.map(async (s) => {
            const key = String(s?.key ?? "");
            const label = String(s?.label ?? (key || "Teacher"));
            const databaseId =
              typeof s?.databaseId === "string" ? s.databaseId : "";
            const dataSourceId =
              typeof s?.dataSourceId === "string" ? s.dataSourceId : "";
            try {
              const table = await queryNotionTableForSource({
                databaseId,
                dataSourceId,
              });
              return {
                key,
                label,
                ok: true,
                message: "",
                databaseId,
                dataSourceId,
                ...table,
              };
            } catch (e) {
              const message = e instanceof Error ? e.message : String(e);
              return {
                key,
                label,
                ok: false,
                message,
                databaseId,
                dataSourceId,
                columns: [],
                rows: [],
                pageIds: [],
              };
            }
          }),
        );
        return { ok: true, sections };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const code = e instanceof Error && "code" in e ? e.code : "UNKNOWN";
        return { ok: false, code, message, sections: [] };
      }
    });

    ipcMain.handle("notion:query-teacher-payslips", async (_evt, payload) => {
      try {
        loadDotenv();
        let email = "";
        let databaseId = "";
        let dataSourceId = "";
        let notionPersonRecordId = "";
        if (
          payload &&
          typeof payload === "object" &&
          !Array.isArray(payload)
        ) {
          email =
            typeof payload.email === "string" ? payload.email.trim() : "";
          databaseId =
            typeof payload.databaseId === "string"
              ? payload.databaseId.trim()
              : "";
          dataSourceId =
            typeof payload.dataSourceId === "string"
              ? payload.dataSourceId.trim()
              : "";
          notionPersonRecordId =
            typeof payload.notionPersonRecordId === "string"
              ? payload.notionPersonRecordId.trim()
              : "";
        } else if (typeof payload === "string") {
          email = payload.trim();
        }

        const hasDedicatedSource =
          normalizeDatabaseId(databaseId) || normalizeDataSourceId(dataSourceId);

        if (hasDedicatedSource) {
          if (notionPersonRecordId) {
            return await queryNotionTeacherPayslipRowsPartialEnrich(
              { databaseId, dataSourceId },
              email,
              notionPersonRecordId,
              { personOnly: true },
            );
          }
          const table = await queryNotionTableForSource({
            databaseId,
            dataSourceId,
          });
          return { ok: true, ...table, noEmailColumn: false };
        }

        return await queryNotionTeacherPayslipRowsPartialEnrich(
          {},
          email,
          notionPersonRecordId,
          { personOnly: false },
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const code = e instanceof Error && "code" in e ? e.code : "UNKNOWN";
        return {
          ok: false,
          code,
          message,
          columns: [],
          rows: [],
          pageIds: [],
          noEmailColumn: false,
        };
      }
    });

    ipcMain.handle("payslip:save-pdf", async (_evt, payload) => {
      try {
        const title =
          payload && payload.title != null ? String(payload.title) : "Pay slip";
        const columns = Array.isArray(payload?.columns) ? payload.columns : [];
        const row = Array.isArray(payload?.row) ? payload.row : [];
        const buf = buildPaySlipPdfBuffer({ title, columns, row });
        const win = BrowserWindow.getFocusedWindow() || mainWindow;
        const stem = sanitizePaySlipFileStem(title);
        const { canceled, filePath } = await dialog.showSaveDialog(win, {
          title: "Save pay slip as PDF",
          defaultPath: path.join(app.getPath("documents"), `${stem}.pdf`),
          filters: [{ name: "PDF", extensions: ["pdf"] }],
        });
        if (canceled || !filePath) {
          return { ok: false, canceled: true };
        }
        fs.writeFileSync(filePath, buf);
        return { ok: true, path: filePath };
      } catch (e) {
        return {
          ok: false,
          message: e instanceof Error ? e.message : String(e),
        };
      }
    });

    ipcMain.handle("shell:open-user-data", () => {
      shell.openPath(app.getPath("userData"));
      return { ok: true };
    });

    ipcMain.handle("shell:open-external-url", async (_evt, rawUrl) => {
      return openDiscordExternal(rawUrl);
    });

    ipcMain.handle("app:relaunch", () => {
      app.relaunch();
      app.exit(0);
    });

    ipcMain.handle("app:quit", async () => {
      const w = getMainBrowserWindow();
      if (w && !w.isDestroyed() && !w.webContents.isDestroyed()) {
        try {
          await w.webContents.executeJavaScript(
            RENDERER_FLUSH_FLOATING_DRAFTS_JS,
            true,
          );
          await w.webContents.executeJavaScript(
            RENDERER_FLUSH_PLANNER_JS,
            true,
          );
        } catch {
          /* WebContents may refuse during teardown */
        }
      }
      console.log("[voice] Sign-out — quitting app (will-quit will shut down voice stack)...");
      app.quit();
      return { ok: true };
    });

    ipcMain.handle("devlog:read", () => {
      return { entries: devLogBuffer.slice(-200) };
    });

    ipcMain.handle("devlog:clear", () => {
      devLogBuffer.length = 0;
      return { ok: true };
    });

    ipcMain.handle("window:minimize", () => {
      minimizeMainWindow();
      return { ok: true };
    });

    // Turn 39 — file-backed admin auto-sign-in across restart.
    // Stores admin email+password to <userData>/admin-creds.json so the renderer
    // can auto-sign-in on the next boot (app.relaunch(), npm start, or PC reboot).
    // Strictly gated to ALLOWED_ADMIN_EMAIL — never saves any other user's creds.
    const adminCredsFilePath = () =>
      path.join(app.getPath("userData"), "admin-creds.json");

    function isAllowedAdminEmail(raw) {
      const want = String(ALLOWED_ADMIN_EMAIL || "").trim().toLowerCase();
      const got = String(raw || "").trim().toLowerCase();
      return Boolean(want) && want === got;
    }

    ipcMain.handle("admin-creds:save", (_evt, payload) => {
      try {
        const email = String(payload?.email ?? "").trim();
        const password = String(payload?.password ?? "");
        if (!email || !password) {
          return { ok: false, message: "Missing email or password." };
        }
        if (!isAllowedAdminEmail(email)) {
          // Silently no-op for non-admin users — never persist their creds.
          return { ok: false, message: "Not admin." };
        }
        const p = adminCredsFilePath();
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(
          p,
          JSON.stringify({
            email,
            password,
            savedAt: new Date().toISOString(),
          }),
          "utf8",
        );
        return { ok: true };
      } catch (e) {
        return {
          ok: false,
          message: e instanceof Error ? e.message : String(e),
        };
      }
    });

    ipcMain.handle("admin-creds:load", () => {
      try {
        const p = adminCredsFilePath();
        if (!fs.existsSync(p)) {
          return { ok: true, creds: null };
        }
        const raw = fs.readFileSync(p, "utf8");
        let j = null;
        try {
          j = JSON.parse(raw);
        } catch {
          return { ok: true, creds: null };
        }
        const email = typeof j?.email === "string" ? j.email : "";
        const password = typeof j?.password === "string" ? j.password : "";
        if (!email || !password) {
          return { ok: true, creds: null };
        }
        if (!isAllowedAdminEmail(email)) {
          return { ok: true, creds: null };
        }
        return { ok: true, creds: { email, password } };
      } catch (e) {
        return {
          ok: false,
          creds: null,
          message: e instanceof Error ? e.message : String(e),
        };
      }
    });

    ipcMain.handle("admin-creds:clear", () => {
      try {
        const p = adminCredsFilePath();
        if (fs.existsSync(p)) {
          fs.unlinkSync(p);
        }
        return { ok: true };
      } catch (e) {
        return {
          ok: false,
          message: e instanceof Error ? e.message : String(e),
        };
      }
    });

    /** Planner — cloud-backed via Supabase; local files retained as migration source only. */
    const plannerUserDataPath = app.getPath("userData");
    const plannerSupabase = require("./lib/planner-store-supabase");
    let activePlannerScope = "";
    let activePlannerEmail = "";
    let activePlannerFirstName = "";
    /** @type {Set<string>} */
    const backfilledScopes = new Set();

    /** @type {Record<string, string>} cached content for renderer reads (JSON strings). */
    const plannerCache = {};
    /** @type {Record<string, string>} last-written content hash — skips duplicate Supabase writes */
    const plannerWriteHashCache = {};
    let plannerInitialized = false;

    function plannerScoped() {
      return plannerSupabase.isValidScope(activePlannerScope);
    }

    const plannerFileKeySet = new Set(PLANNER_FILE_KEYS);

    const keywordIndex = createKeywordIndexService({
      readSettings: () => {
        if (!plannerScoped()) return null;
        return null;
      },
      writeSettings: (json) => {
        if (!plannerScoped()) return;
        plannerSupabase.saveKv(activePlannerScope, "settings", typeof json === "string" ? JSON.parse(json) : json, activePlannerEmail).catch(e => console.warn("[planner] embed hook failed:", e instanceof Error ? e.message : String(e)));
      },
    });

    ipcMain.handle("planner:set-scope", (_evt, payload) => {
      try {
        const p = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
        const userId = sanitizePlannerScopeId(p.userId);
        const email = String(p.email ?? "").trim().toLowerCase();
        const firstName = String(p.firstName ?? "").trim();

        activePlannerScope = userId;
        activePlannerEmail = email;
        activePlannerFirstName = firstName;
        plannerInitialized = false;
        for (const k of Object.keys(plannerCache)) delete plannerCache[k];
        for (const k of Object.keys(plannerWriteHashCache)) delete plannerWriteHashCache[k];

        /* Auto-backfill embeddings on first scope set (once per account) */
        if (userId && !backfilledScopes.has(userId)) {
          backfilledScopes.add(userId);
          plannerSearch.backfillAll(userId, email).then(r => {
            if (r.ok) console.log("[perf] Embedding backfill done:", r.results, "in", Date.now() - tBoot, "ms from boot");
            else console.warn("[planner] Embedding backfill failed:", r.error);
          }).catch(() => {});
        }

        keywordIndex.reloadSettings();
        return { ok: true, scope: userId, dir: "" };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
    });

    ipcMain.handle("planner:migrate-to-supabase", async () => {
      try {
        if (!plannerScoped()) return { ok: false, message: "Planner scope not set (sign in first)." };
        const migrate = require("./lib/planner-migrate-to-supabase");
        const result = await migrate.migratePlannerToSupabase(plannerUserDataPath, activePlannerScope, activePlannerEmail, activePlannerFirstName);
        if (result.ok) plannerInitialized = true;
        return result;
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
    });

    ipcMain.handle("planner:is-initialized", async () => {
      try {
        if (!plannerScoped()) return { ok: false, initialized: false, message: "Planner scope not set (sign in first)." };
        if (plannerInitialized) return { ok: true, initialized: true, scope: activePlannerScope };
        const r = await plannerSupabase.fetchKv(activePlannerScope, "meta");
        plannerInitialized = r?.data != null;
        return { ok: true, initialized: plannerInitialized, scope: activePlannerScope };
      } catch (e) {
        return { ok: false, initialized: false, message: e instanceof Error ? e.message : String(e) };
      }
    });

    ipcMain.handle("planner:read", async (_evt, rawKey) => {
      try {
        const key = String(rawKey ?? "").trim();
        if (!plannerFileKeySet.has(key)) {
          return { ok: false, content: null, message: "Unknown planner store key." };
        }
        if (!plannerScoped()) {
          return { ok: false, content: null, message: "Planner scope not set (sign in first)." };
        }
        const db = require("./lib/supabase/admin-client").getAdminClient();
        if (!db) return { ok: false, content: null, message: "Supabase not configured." };

        if (key === "events") {
          const r = await plannerSupabase.fetchEvents(activePlannerScope);
          return { ok: true, content: r?.data ? JSON.stringify(r.data) : "[]" };
        }
        if (key === "day-pages") {
          const r = await plannerSupabase.fetchDayPages(activePlannerScope);
          if (r?.data && Array.isArray(r.data) && r.data.length) {
            const obj = {};
            for (const row of r.data) {
              obj[row.id] = { title: row.title, notes: row.notes, todos: row.todos || [] };
            }
            return { ok: true, content: JSON.stringify(obj) };
          }
          return { ok: true, content: "{}" };
        }
        if (key === "obsidian-notes") {
          const r = await plannerSupabase.fetchObsidianNotes(activePlannerScope);
          if (r?.data && Array.isArray(r.data) && r.data.length) {
            return { ok: true, content: JSON.stringify({ notes: r.data.map(n => ({ id: n.id, title: n.title, content: n.content, createdAt: n.created_at, updatedAt: n.updated_at })), updatedAt: new Date().toISOString() }) };
          }
          return { ok: true, content: '{"notes":[],"updatedAt":null}' };
        }
        /* KV keys: settings, trash, deferrals, meta */
        const kr = await plannerSupabase.fetchKv(activePlannerScope, key);
        return { ok: true, content: kr?.data?.json ? JSON.stringify(kr.data.json) : null };
      } catch (e) {
        return { ok: false, content: null, message: e instanceof Error ? e.message : String(e) };
      }
    });

    ipcMain.handle("planner:write", async (_evt, payload) => {
      try {
        const key = String(payload?.key ?? "").trim();
        const content = typeof payload?.content === "string" ? payload.content : null;
        if (!plannerFileKeySet.has(key)) {
          return { ok: false, message: "Unknown planner store key." };
        }
        if (!plannerScoped()) {
          return { ok: false, message: "Planner scope not set (sign in first)." };
        }
        if (content == null) {
          return { ok: false, message: "Missing content." };
        }

        const contentHash = crypto.createHash("sha256").update(content).digest("base64");
        if (plannerWriteHashCache[key] === contentHash) {
          return { ok: true };
        }
        plannerWriteHashCache[key] = contentHash;

        if (key === "events") {
          const arr = JSON.parse(content);
          const existing = await plannerSupabase.fetchEvents(activePlannerScope);
          const existingIds = new Set((existing?.data || []).map(r => r.id));
          const rows = Array.isArray(arr) ? arr.filter(e => e && typeof e.id === "string" && typeof e.title === "string") : [];
          const incomingIds = new Set(rows.map(r => String(r.id)));
          const toDelete = [...existingIds].filter(id => !incomingIds.has(id));
          await plannerSupabase.deleteEventsById(activePlannerScope, toDelete);
          if (rows.length) await plannerSupabase.saveEvents(activePlannerScope, rows, activePlannerEmail);
        } else if (key === "day-pages") {
          const obj = JSON.parse(content);
          if (obj && typeof obj === "object" && !Array.isArray(obj)) {
            const existing = await plannerSupabase.fetchDayPages(activePlannerScope);
            const existingIds = new Set((existing?.data || []).map(r => r.id));
            const incomingIds = new Set(Object.keys(obj));
            const toDelete = [...existingIds].filter(id => !incomingIds.has(id));
            await plannerSupabase.deleteDayPagesById(activePlannerScope, toDelete);
            const rows = Object.entries(obj)
              .filter(([id]) => /^\d{4}-\d{2}-\d{2}$/.test(id))
              .map(([id, v]) => {
                const p = /** @type {{ title?: string; notes?: string; todos?: object[] }} */ (v);
                return { id, title: p.title || null, notes: p.notes || null, todos: Array.isArray(p.todos) ? p.todos : [] };
              });
            if (rows.length) await plannerSupabase.saveDayPages(activePlannerScope, rows, activePlannerEmail);
          }
        } else if (key === "obsidian-notes") {
          const obj = JSON.parse(content);
          if (obj && Array.isArray(obj.notes)) {
            const existing = await plannerSupabase.fetchObsidianNotes(activePlannerScope);
            const existingIds = new Set((existing?.data || []).map(r => r.id));
            const notes = obj.notes.filter(n => n && typeof n.id === "string");
            const incomingIds = new Set(notes.map(n => n.id));
            const toDelete = [...existingIds].filter(id => !incomingIds.has(id));
            await plannerSupabase.deleteObsidianNotesById(activePlannerScope, toDelete);
            if (notes.length) await plannerSupabase.saveObsidianNotes(activePlannerScope, notes, activePlannerEmail);
          }
        } else {
          /* KV keys: settings, trash, deferrals, meta */
          const json = JSON.parse(content);
          await plannerSupabase.saveKv(activePlannerScope, key, json || {}, activePlannerEmail);
          if (key === "meta") plannerInitialized = true;
        }
        if (key === "events" || key === "day-pages" || key === "settings") {
          keywordIndex.reloadSettings();
        }
        return { ok: true };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
    });

    ipcMain.handle("keywords:rebuild", (_evt, payload) => keywordIndex.rebuild(payload));
    ipcMain.handle("keywords:sync-vault", (_evt, payload) => {
      keywordIndex.scheduleSync(payload);
      return { ok: true };
    });
    ipcMain.handle("keywords:get-mentions", (_evt, payload) =>
      keywordIndex.getMentions(payload?.filePath),
    );
    ipcMain.handle("keywords:get-edges", () => keywordIndex.getEdges());
    ipcMain.handle("keywords:get-config", () => keywordIndex.getConfig());
    ipcMain.handle("keywords:update-config", (_evt, partial) =>
      keywordIndex.updateConfig(partial),
    );
    ipcMain.handle("keywords:promote-edges-toggle", (_evt, payload) =>
      keywordIndex.promoteEdgesToggle(payload?.enabled),
    );

    ipcMain.handle("planner:mark-initialized", async (_evt, meta) => {
      try {
        if (!plannerScoped()) {
          return { ok: false, message: "Planner scope not set (sign in first)." };
        }
        const detail = meta && typeof meta === "object" && !Array.isArray(meta) ? meta : {};
        await plannerSupabase.saveKv(activePlannerScope, "meta", detail, activePlannerEmail);
        plannerInitialized = true;
        return { ok: true };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
    });

    ipcMain.handle("planner:storage-info", async () => {
      try {
        if (!plannerScoped()) return { ok: true, scope: activePlannerScope, dir: "", totalBytes: 0, files: {} };
        return { ok: true, scope: activePlannerScope, dir: "supabase", totalBytes: 0, files: {} };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
    });

    ipcMain.handle("planner:search-semantic", async (_evt, payload) => {
      try {
        if (!plannerScoped()) return { ok: false, message: "Planner scope not set (sign in first)." };
        const query = String(payload?.query || "").trim();
        const limit = Number(payload?.limit) || 10;
        const threshold = typeof payload?.threshold === "number" ? payload.threshold : 0.35;
        if (!query) return { ok: false, message: "query required" };
        return plannerSearch.semanticSearch(activePlannerScope, query, limit, threshold);
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
    });

    ipcMain.handle("planner:backfill-embeddings", async () => {
      try {
        if (!plannerScoped()) return { ok: false, message: "Planner scope not set (sign in first)." };
        return plannerSearch.backfillAll(activePlannerScope, activePlannerEmail, true);
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
    });

    ipcMain.handle("config:get-supabase", () => {
      loadDotenv();
      return {
        url: normalizeSupabaseUrlForClient(process.env.SUPABASE_URL),
        anonKey: normalizeSupabaseAnonKey(process.env.SUPABASE_ANON_KEY),
      };
    });

    ipcMain.handle("voice:status", () => getVoiceAgent().getStatus());
    ipcMain.handle("voice:system-prompt", () => VOICE_SYSTEM_PROMPT);
    ipcMain.handle("voice:vad-port", () => ({ url: `ws://127.0.0.1:${_vadPort}`, port: _vadPort }));
     ipcMain.handle("voice:warm-tts", async () => {
       const voiceAgent = getVoiceAgent();
       if (typeof voiceAgent.warmVoiceStack !== "function") {
         return { ok: false, error: "Voice warm not available." };
       }
       const results = await voiceAgent.warmVoiceStack();
       const ttsOk = results[0]?.status === "fulfilled";
       const whisperOk = results[1]?.status === "fulfilled";
       return { ok: ttsOk, whisperOk };
     });

     ipcMain.handle("voice:health-snapshot", async () => {
       const voiceAgent = getVoiceAgent();
       if (typeof voiceAgent.getHealthSnapshot !== "function") {
         return { master: "offline", services: {}, perf: {} };
       }
       try {
         return await voiceAgent.getHealthSnapshot();
       } catch (e) {
         console.warn("[voice] health snapshot failed:", e);
         return { master: "offline", error: e instanceof Error ? e.message : String(e) };
       }
     });

     ipcMain.handle("voice:set-stt-engine", (_evt, payload) => {
       const engine = payload && typeof payload === "object" && payload.engine ? String(payload.engine).trim().toLowerCase() : "auto";
       const voiceAgent = getVoiceAgent();
       if (typeof voiceAgent.setSttEngine === "function") {
         voiceAgent.setSttEngine(engine);
       }
       return { ok: true, engine };
     });

     ipcMain.handle("voice:test-voice", async () => {
       const voiceAgent = getVoiceAgent();
       if (typeof voiceAgent.speak !== "function") {
         return { ok: false, error: "Voice agent not available." };
       }
       try {
         const result = await voiceAgent.speak("Voice system check complete.");
         return result;
       } catch (e) {
         return { ok: false, error: e instanceof Error ? e.message : String(e) };
       }
     });

     ipcMain.handle("voice:record-wake", () => {
       const va = getVoiceAgent();
       if (va && typeof va.recordWakeEvent === "function") va.recordWakeEvent();
       return { ok: true };
     });
     
     ipcMain.handle("voice:start-wake-word-listening", async () => {
       voiceMemory.newSession();
       console.log(`[memory] New session started: ${voiceMemory.getCurrentSessionId()}`);
       const voiceAgent = getVoiceAgent();
       return voiceAgent.startWakeWordListening();
     });
     
     ipcMain.handle("voice:stop-wake-word-listening", async () => {
       const voiceAgent = getVoiceAgent();
       return voiceAgent.stopWakeWordListening();
     });
     
     ipcMain.handle("voice:detect-wake-word", async (_evt, payload) => {
       const buf = voicePayloadToBuffer(payload);
       if (!buf || !buf.length) {
         return { ok: false, wakeWordDetected: false, error: "No audio data received." };
       }
       const mimeType =
         payload && typeof payload === "object" && typeof payload.mimeType === "string"
           ? payload.mimeType
           : "audio/webm";
       return getVoiceAgent().detectWakeWordInAudio(buf, mimeType);
     });

     ipcMain.handle("voice:detect-stop-command", async (_evt, payload) => {
       const text =
         payload && typeof payload === "object" && typeof payload.text === "string"
           ? payload.text
           : "";
       return { ok: true, stop: getVoiceAgent().detectStopCommand(text) };
     });
    // Dream cycle runtime state
let _lastDreamCycleFiredAt = 0;
const DREAM_DEBOUNCE_MS = 90000; // 90s
const DREAM_INACTIVITY_TIMEOUT_MS = Number(process.env.DREAM_INACTIVITY_TIMEOUT_MS || 30 * 60 * 1000);
let _activeDream = null; // { sessionId, filePath, startedAt, speakerId, triggerPhrase, inactivityTimer, factsBeforeCount }

const DREAM_START_PATTERNS = [
	/start (the )?dream cycle/i,
	/start dreaming/i,
	/begin (the )?dream cycle/i,
	/begin dreaming/i,
	/run (the )?dream cycle/i,
	/let'?s (start (the )?)?dream( cycle)?/i,
	/let'?s (start )?dreaming/i,
];
const DREAM_END_PATTERNS = [
	/end (the )?dream cycle/i,
	/finish (the )?dream cycle/i,
	/stop dreaming/i,
	/we'?re done( with the dream( cycle)?)?/i,
];

function dreamDir() {
	return path.join(app.getPath('userData'), 'dream-sessions');
}
function sessionFilePath(startedAtIso) {
	const safe = startedAtIso.replace(/:/g, '-');
	return path.join(dreamDir(), `dream-session-${safe}.json`);
}

async function startDreamSession(matchedSubstring, speakerId, triggerPhrase) {
	try {
		const sessionId = crypto.randomUUID();
		const startedAt = new Date().toISOString();
		const lf = await voiceMemory.listFacts({ userEmail: 'inforecruitmyenglish@gmail.com' });
		const factsBefore = lf && lf.ok && Array.isArray(lf.data) ? lf.data : [];
		const factsBeforeCount = factsBefore.length;
		const doc = {
			sessionId,
			startedAt,
			triggeredBy: speakerId || 'unknown',
			triggerPhrase: matchedSubstring || triggerPhrase || null,
			factsBeforeCount,
			factsBefore,
			status: 'in_progress',
		};
		try { fs.mkdirSync(dreamDir(), { recursive: true }); } catch {}
		const filePath = sessionFilePath(startedAt);
		try { fs.writeFileSync(filePath, JSON.stringify(doc, null, 2), 'utf8'); } catch (e) { console.error('[dream] write start file failed', e); }
		_activeDream = { sessionId, filePath, startedAt, speakerId, triggerPhrase: doc.triggerPhrase, inactivityTimer: null, factsBeforeCount };
		voiceMemory.enableDreamMode(true, sessionId);
		console.log(` Dream session started: ${sessionId} by ${speakerId} → ${filePath}`);
		if (_activeDream.inactivityTimer) clearTimeout(_activeDream.inactivityTimer);
		_activeDream.inactivityTimer = setTimeout(() => {
			endDreamSession('inactivity', null).catch(e => console.error('[dream] end error', e));
		}, DREAM_INACTIVITY_TIMEOUT_MS);
	} catch (e) {
		console.error('[dream] start error', e);
	}
}

async function endDreamSession(endReason = 'phrase', endPhrase = null) {
	if (!_activeDream) return;
	const { sessionId, filePath, startedAt, speakerId } = _activeDream;
	if (_activeDream.inactivityTimer) { clearTimeout(_activeDream.inactivityTimer); _activeDream.inactivityTimer = null; }
	try {
		const factsAfterRes = await voiceMemory.listFacts({ userEmail: 'inforecruitmyenglish@gmail.com' });
		const factsAfter = factsAfterRes && factsAfterRes.ok && Array.isArray(factsAfterRes.data) ? factsAfterRes.data : [];
		const factsAfterCount = factsAfter.length;
		const ops = voiceMemory.getDreamOps();
		const inserted = ops.filter(o => o.op === 'store' && (o.before == null)).length;
		const contradictions = ops.filter(o => o.op === 'store' && o.before != null && o.before !== o.after).length;
		const merged = ops.filter(o => o.op === 'store' && o.before != null && o.before === o.after).length;
		const deleted = ops.filter(o => o.op === 'delete').length;
		const summary = `${inserted} inserted, ${merged} merged, ${deleted} deleted, ${contradictions} contradictions`;
		const finalDoc = {
			sessionId,
			startedAt,
			endedAt: new Date().toISOString(),
			endReason,
			endPhrase: endPhrase || null,
			triggeredBy: speakerId || 'unknown',
			triggerPhrase: _activeDream.triggerPhrase || null,
			factsBeforeCount: _activeDream.factsBeforeCount,
			factsAfterCount,
			factsBefore: null,
			factsAfter,
			dreamOps: ops,
			summary,
			status: 'complete',
		};
		// attempt to read existing start file to include factsBefore if present
		try {
			if (fs.existsSync(filePath)) {
				const raw = fs.readFileSync(filePath, 'utf8');
				try { const parsed = JSON.parse(raw); if (parsed && parsed.factsBefore) finalDoc.factsBefore = parsed.factsBefore; }
				catch {}
			}
		} catch {}
		try { fs.writeFileSync(filePath, JSON.stringify(finalDoc, null, 2), 'utf8'); } catch (e) { console.error('[dream] write end file failed', e); }
		console.log(` Dream session ended: ${sessionId}, reason: ${endReason}, ops: ${ops.length} → ${filePath}`);
	} catch (e) {
		console.error('[dream] end error', e);
	} finally {
		voiceMemory.enableDreamMode(false);
		voiceMemory.clearDreamOps();
		_activeDream = null;
	}
}

ipcMain.handle("voice:transcribe", async (_evt, payload) => {
	const buf = voicePayloadToBuffer(payload);
	const mimeType =
		payload && typeof payload === "object" && typeof payload.mimeType === "string"
			? payload.mimeType
			: "audio/webm";
	if (!buf || !buf.length) {
		return { ok: false, error: "No audio data received." };
	}
	const result = await getVoiceAgent().transcribe(buf, mimeType);
	try {
		const text = result && result.ok && typeof result.text === "string" ? result.text : null;
		if (text) {
			const t = String(text || "");
			const speakerId = detectSpeaker(t) || _lastKnownSpeaker || 'unknown';
			const now = Date.now();
			// detect start
			for (const re of DREAM_START_PATTERNS) {
				const m = t.match(re);
				if (m) {
					if (now - _lastDreamCycleFiredAt < DREAM_DEBOUNCE_MS) {
						console.log('[dream] trigger ignored due to debounce');
						break;
					}
					_lastDreamCycleFiredAt = now;
					const matched = m[0];
					await startDreamSession(matched, speakerId, matched);
					break;
				}
			}
			// detect end
			if (_activeDream) {
				for (const re of DREAM_END_PATTERNS) {
					const m = t.match(re);
					if (m) {
						await endDreamSession('phrase', m[0]);
						break;
					}
				}
			}
			
			// detect stop commands to end listening session
			const voiceAgent = getVoiceAgent();
			if (voiceAgent && typeof voiceAgent.detectStopCommand === "function" && voiceAgent.detectStopCommand(t)) {
				console.log('[voice] Stop command detected:', t);
				// Stop the wake word listening session
				if (typeof voiceAgent.stopWakeWordListening === "function") {
					const stopResult = voiceAgent.stopWakeWordListening();
					console.log('[voice] Wake word listening stopped:', stopResult);
				}
			}
		}
	} catch (e) {
		console.error('[dream] detection error', e);
	}
	return result;
});

ipcMain.handle('dream:reset', async () => {
	const wasActive = Boolean(_activeDream);
	if (_activeDream) {
		try { await endDreamSession('manual_reset', null); } catch (e) { console.error('[dream] reset end error', e); }
	}
	voiceMemory.clearDreamOps();
	voiceMemory.enableDreamMode(false);
	console.log(' Dream mode manually reset');
	return { reset: true, wasActive };
});
    ipcMain.handle("voice:ask-claude", async (evt, payload) => {
      const p =
        payload && typeof payload === "object" && !Array.isArray(payload)
          ? payload
          : {};
      return getVoiceAgent().askClaude({
        messages: Array.isArray(p.messages) ? p.messages : [],
        system: typeof p.system === "string" ? p.system : undefined,
        maxTokens: typeof p.maxTokens === "number" ? p.maxTokens : undefined,
        onDelta: (chunk) => {
          try {
            if (!evt.sender.isDestroyed()) {
              evt.sender.send("voice:claude-delta", { text: chunk });
            }
          } catch {
            /* ignore */
          }
        },
      });
    });

    ipcMain.handle("voice:speak", async (_evt, payload) => {
      const text =
        payload && typeof payload === "object" && typeof payload.text === "string"
          ? payload.text
          : "";
      return getVoiceAgent().speak(text);
    });
    ipcMain.handle("voice:assistant-turn", async (evt, payload) => {
      const turnStartedAt = Date.now();
      const p = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
      const sender = evt.sender;
      const cid = crypto.randomUUID();

      /* --- Retrieval pipeline: multi-stage facts + page refs + memories + stale detection --- */
      let systemText = typeof p.system === "string" ? p.system : VOICE_SYSTEM_PROMPT;
      const messages = Array.isArray(p.messages) ? p.messages : [];
      const lastUserMsg = messages.reduceRight((acc, m) => {
        if (acc === null && m.role === "user" && typeof m.content === "string") return m.content;
        return acc;
      }, null);

      const contextBlocks = [];

      /* --- Speaker detection: identify Ayaaz or Yushra from their self-introduction --- */
      let detectedSpeaker = null;
      if (lastUserMsg) {
        detectedSpeaker = detectSpeaker(lastUserMsg);
        /* Fall back to last known speaker, or Ayaaz on first turn */
        if (!detectedSpeaker) detectedSpeaker = _lastKnownSpeaker || "ayaaz";
        const profileResult = await voiceProfiles.getProfile({ userEmail: ALLOWED_ADMIN_EMAIL, name: detectedSpeaker });
        if (profileResult.ok && profileResult.data) {
          const p = profileResult.data;
          contextBlocks.push(
            "## Current user (this is who is speaking RIGHT NOW — OVERRIDES any stored facts about identity, greetings, or addressing)\n" +
            `- Name: ${p.display_name}\n` +
            `- Role: ${p.title}\n` +
            `- About: ${p.bio || "No bio"}\n` +
            `- Suggestions for today: ${p.suggestions || "None"}\n` +
            `- Tone: ${p.tone || "Direct"}`
          );
          log.info("voice-profiles", { speaker: detectedSpeaker, display: p.display_name, cid });
        }
        _lastKnownSpeaker = detectedSpeaker;
      }

      let retrievalResult = null;
      if (lastUserMsg) {
        retrievalResult = await Promise.race([
          retrievalPipeline.retrieve({ userEmail: ALLOWED_ADMIN_EMAIL, query: lastUserMsg, k: 10, confidenceThreshold: 0.4, staleDays: 90 }),
          new Promise(resolve => setTimeout(() => resolve({ facts: [], pageRefs: [], memories: [], staleFacts: [], writeStaleFacts: [], temporalSummary: null, temporalConversations: [] }), 700)),
        ]);

        if (Array.isArray(retrievalResult.memories) && retrievalResult.memories.length > 0) {
          const lines = retrievalResult.memories.map(h =>
            `- [${h.source_table}] (similarity ${(h.similarity || 0).toFixed(2)}) ${h.content}`
          );
          contextBlocks.push("## Relevant memories from past conversations:\n" + lines.join("\n"));
          log.info("memory", { recallHits: retrievalResult.memories.length, cid });
        }

        if (Array.isArray(retrievalResult.staleFacts) && retrievalResult.staleFacts.length > 0) {
          const staleLines = retrievalResult.staleFacts.slice(0, 3).map(f =>
            `  - ${f.fact_key}: ${f.fact_value} (stored ${new Date(f.updated_at || f.created_at).toLocaleDateString()}) — ask user if still current`
          );
          contextBlocks.push("## Facts to verify (may be outdated):\n" + staleLines.join("\n"));
          log.info("memory", { staleCount: retrievalResult.staleFacts.length, cid });
        }

        if (Array.isArray(retrievalResult.writeStaleFacts) && retrievalResult.writeStaleFacts.length > 0) {
          const writeStaleLines = retrievalResult.writeStaleFacts.map(f =>
            `  - ${f.fact_key}: ${f.fact_value} (updated ${new Date(f.updated_at || f.created_at).toLocaleDateString()})`
          );
          contextBlocks.push("## Facts older than 30 days (verify before writes):\n" + writeStaleLines.join("\n"));
          log.info("memory", { writeStaleCount: retrievalResult.writeStaleFacts.length, cid });
        }

        if (retrievalResult.temporalSummary) {
          const ts = retrievalResult.temporalSummary;
          const label = ts.week_label || "";
          let block = "## Past conversation summary";
          if (label) block += ` (${label})`;
          block += ":\n" + (ts.summaryText || ts.summary_text || "");
          if (Array.isArray(retrievalResult.temporalConversations) && retrievalResult.temporalConversations.length > 0) {
            const excerptLines = retrievalResult.temporalConversations.slice(0, 6).map(r =>
              `- ${r.turn_role === "assistant" ? "Assistant" : "User"}: ${r.content.slice(0, 200)}`
            );
            block += "\n\nRelevant conversations:\n" + excerptLines.join("\n");
          }
          contextBlocks.push(block);
          log.info("memory", { temporalInjected: 1, cid });
        }
      }

      /* Inject facts and page refs from retrieval pipeline result (no duplicate queries) */
      const rr = retrievalResult || {};
      let fallbackFacts = Array.isArray(rr.facts) ? rr.facts.slice(0, 30) : [];
      const fallbackRefs = Array.isArray(rr.pageRefs) ? rr.pageRefs.slice(0, 30) : [];

      if (!rr.facts && !rr.pageRefs) {
        const [ff, rf] = await Promise.all([
          voiceMemory.listFacts({ userEmail: ALLOWED_ADMIN_EMAIL, userName: detectedSpeaker }),
          pageMemory.listPageRefs({ userEmail: ALLOWED_ADMIN_EMAIL }),
        ]);
        fallbackFacts = (ff.ok ? ff.data : []).slice(0, 30);
      }
      /* If a speaker was detected, exclude stored facts that conflict with the Current user profile */
      if (detectedSpeaker) {
        const CONFLICT_KEYS = /^(greeting|address(ing)?|speaker_identity|current_speaker|who_is_speaking)/i;
        const before = fallbackFacts.length;
        fallbackFacts = fallbackFacts.filter(f => !CONFLICT_KEYS.test(f.fact_key));
        if (fallbackFacts.length !== before) {
          log.info("memory", { filteredConflictingFacts: before - fallbackFacts.length, cid });
        }
      }

      if (fallbackFacts.length > 0) {
        const factLines = fallbackFacts.map(f => `  - ${f.fact_key}: ${f.fact_value} (updated ${new Date(f.updated_at || f.created_at).toLocaleDateString()})`);
        contextBlocks.push("## Stored facts (most recent 30):\n" + factLines.join("\n"));
        log.info("memory", { injectedFacts: fallbackFacts.length, cid });
      }
      if (fallbackRefs.length > 0) {
        const refLines = fallbackRefs.map(r => `  - ${r.page_name} → page_id: ${r.page_id}${r.database_id ? ` (database: ${r.database_id})` : ""}`);
        contextBlocks.push("## Stored page references (most recent 30):\n" + refLines.join("\n"));
        log.info("memory", { injectedPageRefs: fallbackRefs.length, cid });
      }

      /* --- Voice memory digest: session summaries + durable facts (auto-injected every turn within token budget) --- */
      const digestResult = await voiceMemory.getMemoryDigest({
        userEmail: ALLOWED_ADMIN_EMAIL,
        maxTokens: 500,
        userName: detectedSpeaker,
        currentCid: cid,
      });
      if (digestResult.ok && digestResult.data) {
        contextBlocks.push(digestResult.data);
        const hasTurns = digestResult.data.includes("## Memory: Recent conversation");
        const hasSummaries = digestResult.data.includes("## Memory: Recent sessions");
        const hasFacts = digestResult.data.includes("## Memory: What I know");
        console.log(`[memory] injecting: digestLen=${digestResult.data.length} turns=${hasTurns} summaries=${hasSummaries} facts=${hasFacts} cid=${cid}`);
      } else {
        console.warn(`[memory] WARNING: digest injection SKIPPED — ok=${digestResult.ok} dataLen=${digestResult.data ? digestResult.data.length : 0} cid=${cid}`);
      }

      // Emit memory snapshot to renderer for live panel
      try {
        if (!sender.isDestroyed()) {
          const counts = digestResult.counts || {};
          sender.send("voice:memory-snapshot", {
            injected: digestResult.ok && Boolean(digestResult.data),
            currentTurns: counts.currentTurns || 0,
            priorSessionTurns: counts.priorSessionTurns || 0,
            summaries: counts.summaries || 0,
            facts: counts.facts || 0,
            tokens: counts.tokens || 0,
            preview: (digestResult.data || "").slice(0, 200),
            ts: Date.now(),
          });
        }
      } catch { /* non-fatal */ }

      if (contextBlocks.length > 0) {
        systemText = contextBlocks.join("\n\n") + "\n\n" + systemText;
        const hasMemory = systemText.includes("## Memory:");
        console.log(`[memory] system prompt assembled: len=${systemText.length} memoryPresent=${hasMemory} cid=${cid}`);
      }

      /* --- Recent conversation history from Supabase (persistent context across sessions) --- */
      const convResult = await voiceMemory.getRecentConversations({
        userEmail: ALLOWED_ADMIN_EMAIL,
        userName: detectedSpeaker,
        limit: 100,
      });
      if (convResult.ok && Array.isArray(convResult.data) && convResult.data.length > 0) {
        const historyMessages = convResult.data
          .slice()
          .reverse()
          .map(row => ({
            role: row.turn_role === "assistant" ? "assistant" : "user",
            content: row.content,
          }));
        messages.unshift(...historyMessages);
        log.info("memory", { convHistoryRows: convResult.data.length, cid });
      }

      /* --- Build tool list (Notion REST API + memory tools) --- */
      const toolDefs = notionApi.buildClaudeToolDefs();
      const tools = [];
      if (Array.isArray(toolDefs)) {
        for (const t of toolDefs) tools.push(t);
      }
      /* Memory tools — always available */
      tools.push(
        {
          name: "memory_store_fact",
          description: "Store a fact or preference the user asked you to remember. INPUT: key (short snake_case tag), value (plain English fact).",
          input_schema: { type: "object", properties: { key: { type: "string" }, value: { type: "string" } }, required: ["key", "value"] },
        },
        {
          name: "memory_forget_fact",
          description: "Delete a stored fact by its key. INPUT: key (snake_case tag).",
          input_schema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
        },
        {
          name: "memory_list_facts",
          description: "List all stored facts and preferences.",
          input_schema: { type: "object", properties: {} },
        },
        {
          name: "memory_recall",
          description: "Search stored facts, page references, and past conversation memories by keyword OR time range. Use this when the pre-injected data doesn't contain what you need. INPUT: search (string, optional keyword) OR timeRange (string: 'today', '7d', '30d', optional). RETURNS: matching facts, pageRefs, and relevant past conversation snippets.",
          input_schema: { type: "object", properties: { search: { type: "string", description: "Word or phrase to search for" }, timeRange: { type: "string", description: "Time window: today, 7d, or 30d" } } },
        },
      );

      /* Page reference tools — auto-stored page IDs for cross-restart recall */
      tools.push(
        {
          name: "page_ref_find",
          description: "Find a stored Notion page ID by the teacher/page name. CALL THIS BEFORE notion_fetch or notion_update_page when the user refers to a page by name. INPUT: pageName (string, the teacher or page name to look up). RETURNS: the page record with page_id, page_name, database_id, created_at.",
          input_schema: { type: "object", properties: { pageName: { type: "string", description: "Teacher or page name to look up" } }, required: ["pageName"] },
        },
        {
          name: "page_ref_list",
          description: "List all stored page references — every page or record that was created or updated and auto-saved. RETURNS: array of {page_id, page_name, database_id, created_at}.",
          input_schema: { type: "object", properties: {} },
        },
        {
          name: "page_ref_remove",
          description: "Remove a stored page reference by name. INPUT: pageName (string, the teacher or page name).",
          input_schema: { type: "object", properties: { pageName: { type: "string" } }, required: ["pageName"] },
        },
      );

      /* Web search + Wikipedia tools */
      const searchDefs = searchTools.buildToolDefs();
      if (Array.isArray(searchDefs)) {
        for (const t of searchDefs) tools.push(t);
      }

      /* --- Planner voice tools (reminders, to-dos, day notes) --- */
      const pvtDefs = plannerVoiceTools.buildToolDefs();
      for (const t of pvtDefs) tools.push(t);

      /* --- Time tool --- */
      tools.push({
        name: "get_current_time",
        description: "Get the current date and time in the user's timezone (Africa/Johannesburg, UTC+2, South Africa). Use this whenever the user asks what time it is, what day it is, or mentions any time-related query.",
        input_schema: { type: "object", properties: {} },
      });

      /* --- Semantic search tool --- */
      tools.push({
        name: "planner_search",
        description: "Search ALL planner data (obsidian notes, reminders, day notes) by MEANING, not keywords. Use this for open-ended queries like 'find notes about cats', 'what reminders do I have about money', or anything where the user wants to find content by topic or concept. Returns ranked results with source type, title, and a content preview.",
        input_schema: {
          type: "object",
          properties: {
            query: { type: "string", description: "What to search for — a phrase, concept, or question" },
          },
          required: ["query"],
        },
      });

      /* --- Obsidian planner tools --- */
      tools.push(
        {
          name: "obsidian_list",
          description: "List all Obsidian notes in the planner — returns titles only, not full content. Use this to see what notes exist before reading a specific one.",
          input_schema: { type: "object", properties: {} },
        },
        {
          name: "obsidian_read",
          description: "Read a specific Obsidian note by title. Returns the note's full content and metadata. If multiple notes match the title, returns all matches.",
          input_schema: { type: "object", properties: { title: { type: "string", description: "The note title to read (fuzzy match)" } }, required: ["title"] },
        },
        {
          name: "obsidian_search",
          description: "Search Obsidian notes for a phrase or keyword. Returns matching notes with content previews showing where the match was found.",
          input_schema: { type: "object", properties: { query: { type: "string", description: "The word or phrase to search for in note titles and content" } }, required: ["query"] },
        },
        {
          name: "obsidian_create",
          description: "Create a new Obsidian note with a title and content. The note is saved to the planner and will appear in the Obsidian section UI.",
          input_schema: { type: "object", properties: { title: { type: "string", description: "A unique, descriptive title" }, content: { type: "string", description: "The note content in Markdown" } }, required: ["title", "content"] },
        },
        {
          name: "obsidian_append",
          description: "Append content to the end of an existing Obsidian note. Find the note by title. Non-destructive — the existing content is preserved.",
          input_schema: { type: "object", properties: { title: { type: "string", description: "Title of the note to append to" }, content: { type: "string", description: "Content to append" } }, required: ["title", "content"] },
        },
        {
          name: "obsidian_edit",
          description: "Replace the entire content of an existing Obsidian note. Find the note by title. DESTRUCTIVE — overwrites all existing content. If multiple notes match, edits the first match.",
          input_schema: { type: "object", properties: { title: { type: "string", description: "Title of the note to edit" }, content: { type: "string", description: "New content to replace the old" } }, required: ["title", "content"] },
        },
        {
          name: "obsidian_delete",
          description: "Delete an Obsidian note by title. DESTRUCTIVE — cannot be undone. If multiple notes match, deletes the first match.",
          input_schema: { type: "object", properties: { title: { type: "string", description: "Title of the note to delete" } }, required: ["title"] },
        },
      );

      /* Discord tools — always register definitions; handler routes via onToolCall */
      try {
        const discordTools = require('./lib/discord/ai-tools');
        if (discordTools && typeof discordTools.buildToolDefs === 'function') {
          const defs = discordTools.buildToolDefs(global.__discord_client || null);
          if (Array.isArray(defs)) for (const d of defs) tools.push(d);
          console.log('[tool-registry] discord_* tools added:', defs.length, defs.map(d => d.name).join(','));
        }
      } catch (e) {
        console.error('[tool-registry:main] discord require FAILED:', e && e.message);
      }

      if (tools.length > 0) {
        log.info("memory", { toolsCount: tools.length, toolNames: tools.map(t => t.name).join(","), cid });
      }

      /* --- Obsidian planner helper (Supabase-backed) --- */
      async function loadObsidianNotes() {
        try {
          if (!plannerScoped()) return [];
          const r = await plannerSupabase.fetchObsidianNotes(activePlannerScope);
          if (!r?.data || !Array.isArray(r.data)) return [];
          return r.data.map(n => ({ id: n.id, title: n.title, content: n.content, createdAt: n.created_at, updatedAt: n.updated_at }));
        } catch {
          return [];
        }
      }
      async function saveObsidianNotes(notes) {
        if (!plannerScoped()) throw new Error("Planner scope not set");
        await plannerSupabase.saveObsidianNotes(activePlannerScope, notes, activePlannerEmail);
      }
      function normalizeObsidianTitle(raw) {
        return String(raw || "").toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
      }
      async function findObsidianNotes(title) {
        const norm = normalizeObsidianTitle(title);
        if (!norm) return [];
        const all = await loadObsidianNotes();
        return all.filter(n => normalizeObsidianTitle(n.title) === norm || normalizeObsidianTitle(n.title).includes(norm) || norm.includes(normalizeObsidianTitle(n.title)));
      }
      async function handleObsidianTool(tName, tInput) {
        try {
          if (tName === "obsidian_list") {
            const notes = await loadObsidianNotes();
            const list = notes.map(n => ({ id: n.id, title: n.title, createdAt: n.createdAt, updatedAt: n.updatedAt }));
            return { ok: true, data: list };
          }
          if (tName === "obsidian_read") {
            const title = String(tInput.title || "").trim();
            if (!title) return { ok: false, error: { code: "BAD_INPUT", message: "title required" } };
            const matches = await findObsidianNotes(title);
            if (!matches.length) return { ok: true, data: [] };
            return { ok: true, data: matches };
          }
          if (tName === "obsidian_search") {
            const query = String(tInput.query || "").toLowerCase().trim();
            if (!query) return { ok: false, error: { code: "BAD_INPUT", message: "query required" } };
            const all = await loadObsidianNotes();
            const hits = all.filter(n => {
              const hay = `${n.title} ${n.content}`.toLowerCase();
              return hay.includes(query);
            }).map(n => ({ id: n.id, title: n.title, preview: n.content.slice(0, 300) }));
            return { ok: true, data: hits };
          }
          if (tName === "obsidian_create") {
            const title = String(tInput.title || "").trim();
            const content = String(tInput.content || "").trim();
            if (!title || !content) return { ok: false, error: { code: "BAD_INPUT", message: "title and content required" } };
            const all = await loadObsidianNotes();
            const now = new Date().toISOString();
            const note = { id: crypto.randomUUID(), title, content, createdAt: now, updatedAt: now };
            all.push(note);
            await saveObsidianNotes(all);
            plannerSearch.embedAndUpsert(activePlannerScope, activePlannerEmail, "obsidian", note.id, note.title + "\n" + note.content).catch(e => console.warn("[planner] embed hook failed:", e instanceof Error ? e.message : String(e)));
            return { ok: true, data: { id: note.id, title: note.title } };
          }
          if (tName === "obsidian_append") {
            const title = String(tInput.title || "").trim();
            const content = String(tInput.content || "").trim();
            if (!title || !content) return { ok: false, error: { code: "BAD_INPUT", message: "title and content required" } };
            const all = await loadObsidianNotes();
            const norm = normalizeObsidianTitle(title);
            const note = all.find(n => normalizeObsidianTitle(n.title) === norm || normalizeObsidianTitle(n.title).includes(norm));
            if (!note) return { ok: false, error: { code: "NOT_FOUND", message: `No note matching "${title}"` } };
            note.content += "\n\n" + content;
            note.updatedAt = new Date().toISOString();
            await saveObsidianNotes(all);
            plannerSearch.embedAndUpsert(activePlannerScope, activePlannerEmail, "obsidian", note.id, note.title + "\n" + note.content).catch(e => console.warn("[planner] embed hook failed:", e instanceof Error ? e.message : String(e)));
            return { ok: true, data: { id: note.id, title: note.title } };
          }
          if (tName === "obsidian_edit") {
            const title = String(tInput.title || "").trim();
            const content = String(tInput.content || "").trim();
            if (!title || !content) return { ok: false, error: { code: "BAD_INPUT", message: "title and content required" } };
            const all = await loadObsidianNotes();
            const norm = normalizeObsidianTitle(title);
            const note = all.find(n => normalizeObsidianTitle(n.title) === norm || normalizeObsidianTitle(n.title).includes(norm));
            if (!note) return { ok: false, error: { code: "NOT_FOUND", message: `No note matching "${title}"` } };
            note.content = content;
            note.updatedAt = new Date().toISOString();
            await saveObsidianNotes(all);
            plannerSearch.embedAndUpsert(activePlannerScope, activePlannerEmail, "obsidian", note.id, note.title + "\n" + note.content).catch(e => console.warn("[planner] embed hook failed:", e instanceof Error ? e.message : String(e)));
            return { ok: true, data: { id: note.id, title: note.title } };
          }
          if (tName === "obsidian_delete") {
            const title = String(tInput.title || "").trim();
            if (!title) return { ok: false, error: { code: "BAD_INPUT", message: "title required" } };
            const all = await loadObsidianNotes();
            const norm = normalizeObsidianTitle(title);
            const idx = all.findIndex(n => normalizeObsidianTitle(n.title) === norm || normalizeObsidianTitle(n.title).includes(norm));
            if (idx === -1) return { ok: false, error: { code: "NOT_FOUND", message: `No note matching "${title}"` } };
            const removed = all.splice(idx, 1)[0];
            await saveObsidianNotes(all);
            plannerSearch.removeEmbeddings(activePlannerScope, "obsidian", removed.id).catch(e => console.warn("[planner] embed hook failed:", e instanceof Error ? e.message : String(e)));
            return { ok: true, data: { deleted: removed.title, id: removed.id } };
          }
          return { ok: false, error: { code: "UNKNOWN_TOOL", message: `Unknown obsidian tool: ${tName}` } };
        } catch (e) {
          return { ok: false, error: { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) } };
        }
      }

      const onToolCall = async (toolCall) => {
        const tName = typeof toolCall.name === "string" ? toolCall.name : "";
        const tInput = toolCall.input && typeof toolCall.input === "object" ? toolCall.input : {};
        if (!tName) {
          return { ok: false, error: { code: "INVALID_TOOL_CALL", message: "No tool name", cid } };
        }

        /* --- Discord tools --- */
        if (typeof tName === 'string' && tName.startsWith('discord_')) {
          const discordTools = require('./lib/discord/ai-tools');
          if (discordTools && typeof discordTools.callTool === 'function') {
            console.log('[ai-chat] dispatching discord tool:', tName);
            const turnId = crypto.randomUUID();
            return await discordTools.callTool(global.__discord_client || null, tName, tInput, 'main', turnId);
          }
          return { ok: false, error: { code: 'DISCORD_NOT_FOUND', message: 'Discord tools module not loaded.' } };
        }

        /* --- Memory tools handled locally --- */
        if (tName === "memory_store_fact") {
          const key = typeof tInput.key === "string" ? tInput.key.trim() : "";
          const value = typeof tInput.value === "string" ? tInput.value.trim() : "";
          if (!key || !value) {
            return { ok: false, error: { code: "BAD_INPUT", message: "key and value required" } };
          }
          const result = await voiceMemory.storeFact({ userEmail: ALLOWED_ADMIN_EMAIL, key, value, sourceCid: cid });
          return {
            ok: result.ok,
            data: result.ok ? { stored: true, key, value, previousValue: result.previousValue || null, contradiction: !!result.contradiction } : null,
            error: result.ok ? null : result.error,
          };
        }
        if (tName === "memory_forget_fact") {
          const key = typeof tInput.key === "string" ? tInput.key.trim() : "";
          if (!key) return { ok: false, error: { code: "BAD_INPUT", message: "key required" } };
          const result = await voiceMemory.forgetFact({ userEmail: ALLOWED_ADMIN_EMAIL, key });
          return { ok: result.ok, data: result.ok ? result.data : null, error: result.ok ? null : result.error };
        }
        if (tName === "memory_list_facts") {
          const result = await voiceMemory.listFacts({ userEmail: ALLOWED_ADMIN_EMAIL });
          return { ok: result.ok, data: result.ok ? result.data : null, error: result.ok ? null : result.error };
        }
        if (tName === "memory_recall") {
          const search = typeof tInput.search === "string" ? tInput.search.trim() : "";
          const timeRange = typeof tInput.timeRange === "string" ? tInput.timeRange.trim() : "";
          if (!search && !timeRange) return { ok: false, error: { code: "BAD_INPUT", message: "search or timeRange required" } };
          if (search && timeRange) {
            // Both semantic + time-filtered search
            const result = await voiceMemory.recallConversations({
              userEmail: ALLOWED_ADMIN_EMAIL,
              query: search,
              timeRange,
              k: 5,
            });
            return { ok: result.ok, data: result.ok ? result.data : null, error: result.ok ? null : result.error };
          }
          if (timeRange) {
            // Time-range summary only
            const result = await voiceMemory.recallConversations({
              userEmail: ALLOWED_ADMIN_EMAIL,
              timeRange,
            });
            return { ok: result.ok, data: result.ok ? result.data : null, error: result.ok ? null : result.error };
          }
          const [factResults, pageRefResults, semanticResults] = await Promise.all([
            voiceMemory.searchFacts({ userEmail: ALLOWED_ADMIN_EMAIL, search, limit: 5 }),
            pageMemory.searchPageRefs({ userEmail: ALLOWED_ADMIN_EMAIL, search, limit: 5 }),
            voiceMemory.recallSemantic({ userEmail: ALLOWED_ADMIN_EMAIL, queryText: search, k: 3 }),
          ]);
          return { ok: true, data: {
            facts: factResults.ok ? factResults.data : [],
            pageRefs: pageRefResults.ok ? pageRefResults.data : [],
            memories: semanticResults.ok ? semanticResults.data : [],
          }};
        }

        /* --- Page reference tools (stored in Supabase voice_page_refs table) --- */
        if (tName === "page_ref_find") {
          const pageName = typeof tInput.pageName === "string" ? tInput.pageName.trim() : "";
          if (!pageName) return { ok: false, error: { code: "BAD_INPUT", message: "pageName required" } };
          const result = await pageMemory.findPageRef({ userEmail: ALLOWED_ADMIN_EMAIL, pageName });
          return { ok: result.ok, data: result.ok ? result.data : null, error: result.ok ? null : result.error };
        }
        if (tName === "page_ref_list") {
          const result = await pageMemory.listPageRefs({ userEmail: ALLOWED_ADMIN_EMAIL });
          return { ok: result.ok, data: result.ok ? result.data : null, error: result.ok ? null : result.error };
        }
        if (tName === "page_ref_remove") {
          const pageName = typeof tInput.pageName === "string" ? tInput.pageName.trim() : "";
          if (!pageName) return { ok: false, error: { code: "BAD_INPUT", message: "pageName required" } };
          const result = await pageMemory.removePageRef({ userEmail: ALLOWED_ADMIN_EMAIL, pageName });
          return { ok: result.ok, data: result.ok ? result.data : null, error: result.ok ? null : result.error };
        }

        /* --- Web search + Wikipedia tools --- */
        if (tName === "web_search" || tName === "web_fetch" || tName === "wiki_search" || tName === "wiki_lookup") {
          const result = await searchTools.callTool(tName, tInput);
          return { ok: result.ok, data: result.data, error: result.ok ? null : { message: typeof result.data === "string" ? result.data : "Search tool failed" } };
        }

        /* --- Time tool --- */
        if (tName === "get_current_time") {
          const now = new Date();
          const formatted = now.toLocaleString("en-ZA", {
            timeZone: "Africa/Johannesburg",
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
          });
          return { ok: true, data: { iso: now.toISOString(), formatted, timezone: "Africa/Johannesburg (UTC+2)" } };
        }

        /* --- Semantic search --- */
        if (tName === "planner_search") {
          const query = String(tInput.query || "").trim();
          if (!query) return { ok: false, error: { code: "BAD_INPUT", message: "query required" } };
          return plannerSearch.semanticSearch(activePlannerScope, query, 10, 0.35);
        }

        /* --- Planner voice tools (reminders, to-dos, day notes) --- */
        if (tName.startsWith("reminder_") || tName.startsWith("todo_") || tName.startsWith("daynote_")) {
          return plannerVoiceTools.callTool(tName, tInput, activePlannerScope, activePlannerEmail);
        }

        /* --- Obsidian planner tools --- */
        if (tName.startsWith("obsidian_")) {
          return handleObsidianTool(tName, tInput);
        }

        /* --- Notion tools via REST API --- */
        log.info("notion", { tool: tName, cid });
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
          const result = await notionApi.callTool(tName, tInput);
          log.info("notion", { tool: tName, ok: result.ok, ms: result.ms, cid });
          /* Auto-store page IDs on successful writes so Claude can reference them later */
          if (result.ok && (tName === "notion_create_page" || tName === "notion_update_page")) {
            try {
              const body = JSON.parse(result.data[0].text);
              const pageId = body.id;
              if (pageId) {
                const teacherName = body.title || "";
                if (teacherName) {
                  const dbId = tName === "notion_create_page" ? String(tInput.database_id || "").trim() : "";
                  pageMemory.storePageRef({ userEmail: ALLOWED_ADMIN_EMAIL, pageId, pageName: teacherName, databaseId: dbId, sourceCid: cid }).catch(e => console.warn("[planner] embed hook failed:", e instanceof Error ? e.message : String(e)));
                  log.info("memory", { storedPageRef: pageId, teacherName, cid });
                }
              }
            } catch {}
          }
          return result;
        } finally {
          clearTimeout(timeout);
        }
      };

      let turnResult;
      try {
        turnResult = await getVoiceAgent().runAssistantTurn({
          messages,
          system: systemText,
          speaker: detectedSpeaker || _lastKnownSpeaker || null,
          maxTokens: typeof p.maxTokens === "number" ? p.maxTokens : undefined,
          tools: tools.length > 0 ? tools : undefined,
          onToolCall,
          onClaudeDelta: (chunk) => {
            try {
              if (!sender.isDestroyed()) {
                sender.send("voice:claude-delta", { text: chunk });
              }
            } catch {
              /* ignore */
            }
          },
          onTtsChunk: (detail) => {
            try {
              if (!sender.isDestroyed()) {
                const payload = { ...detail };
                if (!Buffer.isBuffer(payload.audio) && payload.audioBase64) {
                  payload.audio = Buffer.from(String(payload.audioBase64), "base64");
                  delete payload.audioBase64;
                }
                sender.send("voice:tts-chunk", payload);
              }
            } catch {
              /* ignore */
            }
          },
        });
      } catch (e) {
        console.error("[voice:assistant-turn] ERROR:", e && e.name, e && e.message);
        if (e && e.stack) console.error("[voice:assistant-turn] STACK:", e.stack);
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }

      /* --- Fire-and-forget: store conversation turns --- */
      if (lastUserMsg) {
        voiceMemory.storeTurn({ userEmail: ALLOWED_ADMIN_EMAIL, role: "user", content: lastUserMsg, cid, userName: detectedSpeaker }).catch(e => console.warn("[planner] embed hook failed:", e instanceof Error ? e.message : String(e)));
      }
      if (turnResult && turnResult.ok && turnResult.text) {
        voiceMemory.storeTurn({ userEmail: ALLOWED_ADMIN_EMAIL, role: "assistant", content: turnResult.text, cid, userName: detectedSpeaker }).catch(e => console.warn("[planner] embed hook failed:", e instanceof Error ? e.message : String(e)));
        /* Phase 2 stub: fact extraction runs after turn, doesn't block */
        extractFacts({ userMessage: lastUserMsg, assistantReply: turnResult.text, userEmail: ALLOWED_ADMIN_EMAIL, cid }).catch(e => console.warn("[planner] embed hook failed:", e instanceof Error ? e.message : String(e)));
        distillation.maybeDistill({ userEmail: ALLOWED_ADMIN_EMAIL, interval: 50 }).catch(e => console.warn("[planner] embed hook failed:", e instanceof Error ? e.message : String(e)));
      }

      /* --- Session tracking: count turns, auto-summarise every 10 turns --- */
      const sessionId = voiceMemory.getCurrentSessionId();
      const turnCount = voiceMemory.bumpTurnCount();
      if (turnCount > 0 && turnCount % 10 === 0) {
        // Fire-and-forget background summary generation
        void (async () => {
          try {
            const convResult = await voiceMemory.getRecentConversations({
              userEmail: ALLOWED_ADMIN_EMAIL,
              userName: detectedSpeaker,
              limit: 20,
            });
            if (convResult.ok && Array.isArray(convResult.data) && convResult.data.length >= 6) {
              const convText = convResult.data
                .slice(0, 20)
                .reverse()
                .map(r => `${r.turn_role === 'assistant' ? 'Retron' : 'User'}: ${(r.content || '').slice(0, 300)}`)
                .join('\n');
              // Generate concise summary via Claude (fire-and-forget, doesn't block voice)
              const summaryPrompt = `Summarise the last 10 conversation turns between RME founders and their voice assistant Retron. Keep under 150 words. Focus on: topics discussed, decisions made, tasks requested, facts shared. Output the summary only — no preamble.\n\n${convText}`;
              try {
                const anthropicKey = process.env.ANTHROPIC_API_KEY;
                if (anthropicKey) {
                  const res = await fetch('https://api.anthropic.com/v1/messages', {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'x-api-key': anthropicKey,
                      'anthropic-version': '2023-06-01',
                    },
                    body: JSON.stringify({
                      model: 'claude-haiku-4-5-20251001',
                      max_tokens: 200,
                      system: 'You are a summariser. Output only the summary, no preamble.',
                      messages: [{ role: 'user', content: summaryPrompt }],
                    }),
                  });
                  if (res.ok) {
                    const body = await res.json();
                    const summary = ((body.content && body.content[0] && body.content[0].text) || '').trim().slice(0, 800);
                    if (summary) {
                      await voiceMemory.storeSessionSummary({
                        userEmail: ALLOWED_ADMIN_EMAIL,
                        sessionId,
                        summary,
                        userName: detectedSpeaker,
                      });
                      console.log(`[memory] Auto-summary stored for session ${sessionId} (turn ${turnCount}): ${summary.slice(0, 80)}...`);
                    }
                  }
                }
              } catch (summaryErr) {
                console.warn('[memory] Summary generation failed:', summaryErr instanceof Error ? summaryErr.message : String(summaryErr));
              }
            }
          } catch (e) {
            // Non-fatal — fails silently
          }
        })();
      }

      const va = getVoiceAgent();
      if (va && typeof va.recordTurnStart === "function") {
        va.recordTurnStart();
      }
      if (va && typeof va.recordTurnLatencyMs === "function") {
        va.recordTurnLatencyMs(Date.now() - turnStartedAt);
      }

      return turnResult;
    });

    /* --- Voice config IPC (preset selection, no restart needed) — Ryan English is the only voice --- */
    ipcMain.handle("voice:set-voice", async (_evt, payload) => {
      const { setVoice } = require("./lib/tts/index");
      if (typeof setVoice !== "function") return { ok: false, error: "TTS not initialized" };
      setVoice("ryan-english");
      const voiceConfigPath = path.join(app.getPath("userData"), "voice-preference.json");
      try {
        fs.writeFileSync(voiceConfigPath, JSON.stringify({ voice: "ryan-english" }), "utf8");
      } catch {}
      console.log(`[voice] voice set to "ryan-english"`);
      return { ok: true };
    });
    ipcMain.handle("voice:get-voice", () => {
      return { ok: true, voice: "ryan-english" };
    });

    /* --- Memory IPC handlers (admin-only) --- */
    const adminGate = () => {
      if (!ALLOWED_ADMIN_EMAIL) return false;
      return true;
    };
    const forbid = () => ({ ok: false, error: { code: "FORBIDDEN", message: "Admin only" } });

    ipcMain.handle("memory:recall", async (_evt, args) => {
      if (!adminGate()) return forbid();
      const p = args && typeof args === "object" ? args : {};
      const queryText = typeof p.queryText === "string" ? p.queryText : "";
      const k = typeof p.k === "number" ? p.k : 5;
      if (!queryText) return { ok: false, error: { code: "BAD_INPUT", message: "queryText required" } };
      return voiceMemory.recallSemantic({ userEmail: ALLOWED_ADMIN_EMAIL, queryText, k });
    });

    ipcMain.handle("memory:list-facts", async () => {
      if (!adminGate()) return forbid();
      return voiceMemory.listFacts({ userEmail: ALLOWED_ADMIN_EMAIL });
    });

    ipcMain.handle("memory:forget-fact", async (_evt, args) => {
      if (!adminGate()) return forbid();
      const p = args && typeof args === "object" ? args : {};
      const key = typeof p.key === "string" ? p.key.trim() : "";
      if (!key) return { ok: false, error: { code: "BAD_INPUT", message: "key required" } };
      return voiceMemory.forgetFact({ userEmail: ALLOWED_ADMIN_EMAIL, key });
    });

    ipcMain.handle("memory:store-fact", async (_evt, args) => {
      if (!adminGate()) return forbid();
      const p = args && typeof args === "object" ? args : {};
      const key = typeof p.key === "string" ? p.key.trim() : "";
      const value = typeof p.value === "string" ? p.value.trim() : "";
      if (!key || !value) return { ok: false, error: { code: "BAD_INPUT", message: "key and value required" } };
      return voiceMemory.storeFact({ userEmail: ALLOWED_ADMIN_EMAIL, key, value, sourceCid: null });
    });

    ipcMain.handle("memory:distill", async () => {
      if (!adminGate()) return forbid();
      return distillation.distillSession({ userEmail: ALLOWED_ADMIN_EMAIL, messageCount: 50 });
    });

    /* AI Chat (non-voice) */
    ipcMain.handle("ai:chat", async (_evt, payload) => {
      if (!adminGate()) return forbid();
      const p = payload && typeof payload === "object" ? payload : {};
      const messages = Array.isArray(p.messages) ? p.messages : [];
      if (messages.length === 0) return { ok: false, error: { code: "BAD_INPUT", message: "messages required" } };
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120000);
      try {
        const service = require("./lib/ai-chat").getAiChatService();
        return await service.chat({
          messages,
          model: typeof p.model === "string" ? p.model : undefined,
          maxTokens: typeof p.maxTokens === "number" ? p.maxTokens : undefined,
          systemPrompt: typeof p.systemPrompt === "string" ? p.systemPrompt : undefined,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
    });

    ipcMain.handle("ai:chat-stream", async (evt, payload) => {
      if (!adminGate()) return forbid();
      const p = payload && typeof payload === "object" ? payload : {};
      const messages = Array.isArray(p.messages) ? p.messages : [];
      if (messages.length === 0) return { ok: false, error: { code: "BAD_INPUT", message: "messages required" } };
      const cid = require("crypto").randomUUID();
      const sender = evt.sender;
      const service = require("./lib/ai-chat").getAiChatService();
      const controller = new AbortController();
      const totalTimeout = setTimeout(() => controller.abort(), 120000);
      try {
        let result = await service.chat({
          messages,
          model: typeof p.model === "string" ? p.model : undefined,
          maxTokens: typeof p.maxTokens === "number" ? p.maxTokens : undefined,
          systemPrompt: typeof p.systemPrompt === "string" ? p.systemPrompt : undefined,
          signal: controller.signal,
          onDelta: (text) => {
            try { if (!sender.isDestroyed()) sender.send("ai:chat-chunk", { cid, delta: text }); } catch {}
          },
          onToolUse: (event) => {
            try { if (!sender.isDestroyed()) sender.send("ai:chat-chunk", { cid, toolEvent: { type: event.type, name: event.name, ok: event.ok } }); } catch {}
          },
        });
        try { if (!sender.isDestroyed()) sender.send("ai:chat-done", result); } catch {}
        return result;
      } finally {
        clearTimeout(totalTimeout);
      }
    });

    ipcMain.handle("ai:list-tools", async () => {
      if (!adminGate()) return forbid();
      const service = require("./lib/ai-chat").getAiChatService();
      const status = await service.listStatus();
      return { ok: true, data: status };
    });

    registerAutoUpdateIpc(ipcMain);
    createWindow();
    initAutoUpdate(() => mainWindow);
    // Start Discord bot if configured
    const __fmtDiscordErr = (e) => {
      if (!e) return String(e);
      const code = e.code || (e.rawError && e.rawError.code);
      let msg = e.stack || e.message;
      if (!msg) { try { msg = JSON.stringify(e); } catch (x) { msg = String(e); } }
      const text = String((e.message || '') + ' ' + (code || '')).toLowerCase();
      let hint = '';
      if (text.includes('disallowed') || text.includes('intent')) {
        hint = ' | HINT: In the Discord Developer Portal (your app -> Bot), enable BOTH "Message Content Intent" and "Server Members Intent", then restart.';
      } else if (text.includes('token') || code === 'TokenInvalid') {
        hint = ' | HINT: DISCORD_BOT_TOKEN is missing/invalid. Reset it in the Developer Portal (Bot -> Reset Token) and update your .env.';
      }
      return (code ? '[' + code + '] ' : '') + msg + hint;
    };
    try {
      discordBot.start().catch((e) => console.warn('[discord] start failed:', __fmtDiscordErr(e)));
    } catch (e) {
      console.warn('[discord] require/start failed:', __fmtDiscordErr(e));
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
    console.log("[perf] boot:total", Date.now() - tBoot, "ms");
      }
    });
  });

  app.on("will-quit", () => {
    console.log("[voice] will-quit — shutting down voice stack...");
    try { getVoiceAgent().shutdownVoiceStack(); } catch (e) {
      console.warn("[voice] shutdownVoiceStack error:", e);
    }
    console.log("[voice] Voice stack shut down.");
    if (_vadProc) {
      console.log("[vad] Killing VAD server...");
      try { _vadProc.kill(); } catch {}
      _vadProc = null;
    }
    try { discordBot.stop().catch(e => console.warn("[planner] embed hook failed:", e instanceof Error ? e.message : String(e))); } catch {}
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}
