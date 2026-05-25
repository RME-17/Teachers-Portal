const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("authApi", {
  hasAdmin: (email) => ipcRenderer.invoke("auth:has-admin", email),
  allowedAdminEmail: () =>
    ipcRenderer.invoke("auth:allowed-admin-email"),
});

contextBridge.exposeInMainWorld("notionApi", {
  queryDatabase: (opts) =>
    ipcRenderer.invoke("notion:query-database", opts ?? {}),
  queryTeacherDatabases: (sources) =>
    ipcRenderer.invoke("notion:query-teacher-databases", sources),
  queryTeacherPaySlips: (payload) =>
    ipcRenderer.invoke("notion:query-teacher-payslips", payload),
  retrievePageTable: (payload) =>
    ipcRenderer.invoke("notion:retrieve-page-table", payload),
  updatePageDate: (payload) =>
    ipcRenderer.invoke("notion:update-page-date", payload ?? {}),
  updatePageNumber: (payload) =>
    ipcRenderer.invoke("notion:update-page-number", payload ?? {}),
  updatePageProperty: (payload) =>
    ipcRenderer.invoke("notion:update-page-property", payload ?? {}),
});

contextBridge.exposeInMainWorld("payslipApi", {
  savePaySlipPdf: (payload) => ipcRenderer.invoke("payslip:save-pdf", payload),
});

contextBridge.exposeInMainWorld("shellApi", {
  openUserDataFolder: () => ipcRenderer.invoke("shell:open-user-data"),
  openExternalUrl: (url) => ipcRenderer.invoke("shell:open-external-url", url),
  relaunchApp: () => ipcRenderer.invoke("app:relaunch"),
  quitApp: () => ipcRenderer.invoke("app:quit"),
});

contextBridge.exposeInMainWorld("appUpdateApi", {
  status: () => ipcRenderer.invoke("app-update:status"),
  check: () => ipcRenderer.invoke("app-update:check"),
  quitAndInstall: () => ipcRenderer.invoke("app-update:quit-and-install"),
  onDownloaded: (handler) => {
    if (typeof handler !== "function") {
      return () => {};
    }
    const listener = (_evt, detail) => {
      handler(detail);
    };
    ipcRenderer.on("app-update:downloaded", listener);
    return () => ipcRenderer.removeListener("app-update:downloaded", listener);
  },
});



contextBridge.exposeInMainWorld("calendarNotificationApi", {
  isSupported: () => ipcRenderer.invoke("calendar:notification-supported"),
  /** Fire-and-forget — Windows toast is shown in main without blocking the renderer. */
  showReminder: (payload) => {
    ipcRenderer.send("calendar:show-reminder", payload ?? {});
  },
  flashAttention: () => ipcRenderer.invoke("calendar:flash-attention"),
  /**
   * When the user taps a snooze action on a main-process reminder notification.
   * @param {(detail: { tag: string; preset: string }) => void} handler
   * @returns {() => void}
   */
  onSnoozeFromOs: (handler) => {
    const channel = "calendar:snooze-from-os";
    const listener = (_event, detail) => {
      try {
        if (typeof handler === "function") handler(detail);
      } catch {
        /* ignore */
      }
    };
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },
});

contextBridge.exposeInMainWorld("calendarStorageApi", {
  /**
   * Bind planner/Obsidian storage to the signed-in teacher (auth user id + profile).
   * @param {{ userId: string; email?: string; firstName?: string; lastName?: string }} payload
   */
  setScope: (payload) => ipcRenderer.invoke("planner:set-scope", payload ?? {}),
  isInitialized: () => ipcRenderer.invoke("planner:is-initialized"),
  read: (key) => ipcRenderer.invoke("planner:read", key),
  write: (key, content) =>
    ipcRenderer.invoke("planner:write", { key, content }),
  markInitialized: (meta) => ipcRenderer.invoke("planner:mark-initialized", meta),
  storageInfo: () => ipcRenderer.invoke("planner:storage-info"),
});

contextBridge.exposeInMainWorld("keywordsApi", {
  rebuild: (payload) => ipcRenderer.invoke("keywords:rebuild", payload),
  syncVault: (payload) => ipcRenderer.invoke("keywords:sync-vault", payload),
  getMentions: (filePath) =>
    ipcRenderer.invoke("keywords:get-mentions", { filePath }),
  getEdges: () => ipcRenderer.invoke("keywords:get-edges"),
  getConfig: () => ipcRenderer.invoke("keywords:get-config"),
  updateConfig: (partial) => ipcRenderer.invoke("keywords:update-config", partial),
  promoteEdgesToggle: (enabled) =>
    ipcRenderer.invoke("keywords:promote-edges-toggle", { enabled }),
});

// Turn 39 — Bridge for admin file-backed credential auto-sign-in on restart.
// Main process gates by ALLOWED_ADMIN_EMAIL so non-admin callers cannot persist creds.
contextBridge.exposeInMainWorld("adminCredsApi", {
  save: (payload) => ipcRenderer.invoke("admin-creds:save", payload),
  load: () => ipcRenderer.invoke("admin-creds:load"),
  clear: () => ipcRenderer.invoke("admin-creds:clear"),
});

contextBridge.exposeInMainWorld("voiceApi", {
  getStatus: () => ipcRenderer.invoke("voice:status"),
  getSystemPrompt: () => ipcRenderer.invoke("voice:system-prompt"),
  /**
   * @param {Blob} blob
   * @returns {Promise<{ ok: boolean; text?: string; error?: string }>}
   */
  transcribe: async (blob) => {
    const audio =
      blob instanceof Blob ? await blob.arrayBuffer() : /** @type {ArrayBuffer} */ (blob);
    const mimeType =
      blob instanceof Blob && blob.type ? blob.type : "audio/webm";
    return ipcRenderer.invoke("voice:transcribe", { audio, mimeType });
  },
  /**
   * @param {{ messages: { role: string; content: string }[]; system?: string; maxTokens?: number }} payload
   */
  askClaude: (payload) => ipcRenderer.invoke("voice:ask-claude", payload ?? {}),
  warmTts: () => ipcRenderer.invoke("voice:warm-tts"),
  /**
   * Claude + sentence-streaming Cartesia TTS in one turn (main synthesizes per sentence).
   * @param {{ messages: { role: string; content: string }[]; system?: string; maxTokens?: number }} payload
   */
  assistantTurn: (payload) =>
    ipcRenderer.invoke("voice:assistant-turn", payload ?? {}),
  /** @param {string} text */
  speak: async (text) => {
    const result = await ipcRenderer.invoke("voice:speak", {
      text: String(text ?? ""),
    });
    if (!result || typeof result !== "object") {
      return result;
    }
    if (result.ok && result.data && typeof result.data === "object") {
      const d = /** @type {{
        audioBase64?: string;
        mimeType?: string;
        chunks?: number;
        bytes?: number;
        durationMs?: number;
        overlapMs?: number;
        trimmedMs?: number;
        speechMs?: number;
      }} */ (result.data);
      return {
        ok: true,
        mimeType: d.mimeType || "audio/wav",
        audioBase64: d.audioBase64,
        chunks: d.chunks,
        bytes: d.bytes,
        durationMs: d.durationMs,
        overlapMs: d.overlapMs,
        trimmedMs: d.trimmedMs,
        speechMs: d.speechMs,
      };
    }
    return result;
  },
  /**
   * Streamed Claude text deltas from main while askClaude runs.
   * @param {(detail: { text?: string }) => void} handler
   * @returns {() => void}
   */
  onClaudeDelta: (handler) => {
    const channel = "voice:claude-delta";
    const listener = (_evt, detail) => {
      try {
        if (typeof handler === "function") handler(detail);
      } catch {
        /* ignore */
      }
    };
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  /**
   * Ordered sentence WAV chunks during voice:assistant-turn.
   * @param {(detail: { index?: number; text?: string; audioBase64?: string; mimeType?: string; durationMs?: number }) => void} handler
   * @returns {() => void}
   */
  onTtsChunk: (handler) => {
    const channel = "voice:tts-chunk";
    const listener = (_evt, detail) => {
      try {
        if (typeof handler === "function") handler(detail);
      } catch {
        /* ignore */
      }
    };
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  setVoice: (name) => ipcRenderer.invoke("voice:set-voice", { name }),
  getVoice: () => ipcRenderer.invoke("voice:get-voice"),
});

contextBridge.exposeInMainWorld("memoryApi", {
  recall: (queryText, k) => ipcRenderer.invoke("memory:recall", { queryText, k }),
  listFacts: () => ipcRenderer.invoke("memory:list-facts"),
  forgetFact: (key) => ipcRenderer.invoke("memory:forget-fact", { key }),
  storeFact: (key, value) => ipcRenderer.invoke("memory:store-fact", { key, value }),
});

contextBridge.exposeInMainWorld("aiApi", {
  chat: (args) => ipcRenderer.invoke("ai:chat", args),
  chatStream: (args, onChunk, onDone, onError) => {
    if (typeof onChunk !== "function" && typeof onDone !== "function") return () => {};
    const channel = "ai:chat-chunk";
    const doneChannel = "ai:chat-done";
    const listener = (_evt, detail) => {
      try { if (typeof onChunk === "function" && detail.cid) onChunk(detail); } catch {}
    };
    const doneListener = (_evt, result) => {
      try {
        ipcRenderer.removeListener(channel, listener);
        ipcRenderer.removeListener(doneChannel, doneListener);
        if (typeof onDone === "function") onDone(result);
      } catch {}
    };
    ipcRenderer.on(channel, listener);
    ipcRenderer.on(doneChannel, doneListener);
    ipcRenderer.invoke("ai:chat-stream", args).catch((e) => {
      ipcRenderer.removeListener(channel, listener);
      ipcRenderer.removeListener(doneChannel, doneListener);
      if (typeof onError === "function") onError(e);
    });
    return () => {
      ipcRenderer.removeListener(channel, listener);
      ipcRenderer.removeListener(doneChannel, doneListener);
    };
  },
  listTools: () => ipcRenderer.invoke("ai:list-tools"),
});

contextBridge.exposeInMainWorld("windowApi", {
  minimize: () => ipcRenderer.invoke("window:minimize"),
});

contextBridge.exposeInMainWorld("devlogApi", {
  read: () => ipcRenderer.invoke("devlog:read"),
  clear: () => ipcRenderer.invoke("devlog:clear"),
  onNew: (handler) => {
    const channel = "devlog:new";
    const listener = (_evt, detail) => {
      try {
        if (typeof handler === "function") handler(detail);
      } catch {
        /* ignore */
      }
    };
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});

/** @type {import("@supabase/supabase-js").SupabaseClient | null} */
let supabaseClient = null;

/**
 * @returns {Promise<{ url: string; anonKey: string }>}
 */
async function loadPublicConfig() {
  const cfg = await ipcRenderer.invoke("config:get-supabase");
  return {
    url: typeof cfg?.url === "string" ? cfg.url : "",
    anonKey: typeof cfg?.anonKey === "string" ? cfg.anonKey : "",
  };
}

function resetSupabaseClient() {
  supabaseClient = null;
}

function loadCreateClient() {
  try {
    return require("@supabase/supabase-js").createClient;
  } catch (e) {
    console.error("teacherAuth: could not load @supabase/supabase-js", e);
    return null;
  }
}

/** Turn opaque fetch/CSP failures into something actionable in the sign-in UI. */
function mapAuthNetworkError(message) {
  const m = String(message || "").trim();
  if (!m) return m;
  if (m === "not_configured") return m;
  const lower = m.toLowerCase();
  if (
    lower === "failed to fetch" ||
    lower.includes("networkerror") ||
    lower.includes("network request failed") ||
    lower.includes("load failed") ||
    lower.includes("fetch failed")
  ) {
    return (
      "Could not reach Supabase (network). In .env set SUPABASE_URL to your HTTPS project URL " +
      "(for example https://xxxx.supabase.co) or http://127.0.0.1:54321 for the Supabase CLI. " +
      "Check SUPABASE_ANON_KEY, VPN/firewall, and try again."
    );
  }
  return m;
}

/** `'1'` = keep session in localStorage; `'0'` = this browser session only (sessionStorage). */
const REMEMBER_ME_PREF_KEY = "recruit-auth-remember-me";

function rememberMePrefersPersistentSession() {
  try {
    return window.localStorage.getItem(REMEMBER_ME_PREF_KEY) !== "0";
  } catch {
    return true;
  }
}

function getAuthPersistenceStorage() {
  // Turn 40 — Always use localStorage so the Supabase session survives every restart path
  // (in-app Restart App, npm start, PC reboot). Combined with autoRefreshToken:true this
  // keeps the admin signed in indefinitely until they explicitly sign out. The "Remember me"
  // checkbox is effectively cosmetic for this single-user admin desktop app.
  try {
    return window.localStorage;
  } catch {
    return window.sessionStorage;
  }
}

function setStoredRememberPreference(_remember) {
  // Turn 40 — Always pin remember-me to "1" so the Supabase session persists in localStorage
  // and survives every restart path. The checkbox cannot demote storage to sessionStorage.
  try {
    window.localStorage.setItem(REMEMBER_ME_PREF_KEY, "1");
  } catch {
    /* ignore */
  }
  resetSupabaseClient();
}

/**
 * @returns {Promise<import("@supabase/supabase-js").SupabaseClient | null>}
 */
async function ensureClient() {
  if (supabaseClient) {
    return supabaseClient;
  }
  const createClient = loadCreateClient();
  if (!createClient) {
    return null;
  }
  const { url, anonKey } = await loadPublicConfig();
  if (!url || !anonKey) {
    return null;
  }
  supabaseClient = createClient(url, anonKey, {
    auth: {
      flowType: "pkce",
      detectSessionInUrl: false,
      persistSession: true,
      autoRefreshToken: true,
      storage: getAuthPersistenceStorage(),
    },
  });
  return supabaseClient;
}

/**
 * @returns {Promise<{ user: { id: string; email: string; user_metadata: Record<string, unknown> } | null; error: string | null }>}
 */
async function getSessionUser() {
  try {
    const client = await ensureClient();
    if (!client) {
      return { user: null, error: "not_configured" };
    }
    const { data, error } = await client.auth.getSession();
    if (error) {
      return { user: null, error: mapAuthNetworkError(error.message) };
    }
    const u = data?.session?.user;
    if (!u) {
      return { user: null, error: null };
    }
    const meta =
      u.user_metadata && typeof u.user_metadata === "object"
        ? JSON.parse(JSON.stringify(u.user_metadata))
        : {};
    return {
      user: {
        id: u.id,
        email: typeof u.email === "string" ? u.email : "",
        user_metadata: meta,
      },
      error: null,
    };
  } catch (e) {
    return {
      user: null,
      error: mapAuthNetworkError(e instanceof Error ? e.message : String(e)),
    };
  }
}

/**
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{ error: string | null }>}
 */
async function signInWithEmail(email, password) {
  try {
    const client = await ensureClient();
    if (!client) {
      return { error: "Supabase is not configured." };
    }
    const cleanEmail = String(email || "").trim();
    const cleanPassword = String(password || "");
    const { error } = await client.auth.signInWithPassword({
      email: cleanEmail,
      password: cleanPassword,
    });
    // Turn 40 — Save creds for cross-restart admin auto-sign-in at the bedrock layer
    // (receives email+password directly — no dependency on DOM submit/click events).
    // Main.js gates by ALLOWED_ADMIN_EMAIL and silently no-ops for non-admin callers,
    // so it is safe to always try.
    if (!error && cleanEmail && cleanPassword) {
      try {
        await ipcRenderer.invoke("admin-creds:save", {
          email: cleanEmail,
          password: cleanPassword,
        });
      } catch {
        /* non-fatal; sign-in still succeeded */
      }
    }
    return { error: error ? mapAuthNetworkError(error.message) : null };
  } catch (e) {
    return {
      error: mapAuthNetworkError(e instanceof Error ? e.message : String(e)),
    };
  }
}

/**
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{ error: string | null; needsEmailConfirmation: boolean }>}
 */
async function signUpWithEmail(email, password) {
  try {
    const client = await ensureClient();
    if (!client) {
      return {
        error: "Supabase is not configured.",
        needsEmailConfirmation: false,
      };
    }
    const { data, error } = await client.auth.signUp({
      email: String(email || "").trim(),
      password: String(password || ""),
    });
    if (error) {
      return {
        error: mapAuthNetworkError(error.message),
        needsEmailConfirmation: false,
      };
    }
    if (data?.session) {
      return { error: null, needsEmailConfirmation: false };
    }
    if (data?.user) {
      return { error: null, needsEmailConfirmation: true };
    }
    return { error: null, needsEmailConfirmation: true };
  } catch (e) {
    return {
      error: mapAuthNetworkError(e instanceof Error ? e.message : String(e)),
      needsEmailConfirmation: false,
    };
  }
}

/**
 * Send a password-reset email. Supabase will email a recovery link; the user follows it
 * (in their browser) to set a new password on the hosted reset page.
 * @param {string} email
 * @returns {Promise<{ error: string | null }>}
 */
async function requestPasswordReset(email) {
  try {
    const client = await ensureClient();
    if (!client) {
      return { error: "Supabase is not configured." };
    }
    const addr = String(email || "").trim();
    if (!addr) {
      return { error: "Enter the email address on your account." };
    }
    const { error } = await client.auth.resetPasswordForEmail(addr);
    return { error: error ? mapAuthNetworkError(error.message) : null };
  } catch (e) {
    return {
      error: mapAuthNetworkError(e instanceof Error ? e.message : String(e)),
    };
  }
}

/**
 * Update the signed-in user's password. Requires an active session.
 * @param {string} newPassword
 * @returns {Promise<{ error: string | null }>}
 */
async function updatePassword(newPassword) {
  try {
    const client = await ensureClient();
    if (!client) {
      return { error: "Supabase is not configured." };
    }
    const pw = String(newPassword || "");
    if (pw.length < 8) {
      return { error: "New password must be at least 8 characters." };
    }
    const { data: authData, error: authErr } = await client.auth.getSession();
    if (authErr) {
      return { error: authErr.message };
    }
    if (!authData?.session?.user) {
      return { error: "You are not signed in." };
    }
    const { error } = await client.auth.updateUser({ password: pw });
    return { error: error ? error.message : null };
  } catch (e) {
    return {
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Start a change-email flow. Supabase will send a confirmation link to the NEW address;
 * the email change only takes effect after the user clicks that link.
 * @param {string} newEmail
 * @returns {Promise<{ error: string | null; needsConfirmation: boolean }>}
 */
async function updateEmail(newEmail) {
  try {
    const client = await ensureClient();
    if (!client) {
      return {
        error: "Supabase is not configured.",
        needsConfirmation: false,
      };
    }
    const addr = String(newEmail || "").trim();
    if (!addr || !addr.includes("@")) {
      return {
        error: "Enter a valid email address.",
        needsConfirmation: false,
      };
    }
    const { data: authData, error: authErr } = await client.auth.getSession();
    if (authErr) {
      return { error: authErr.message, needsConfirmation: false };
    }
    const sessionUser = authData?.session?.user;
    if (!sessionUser) {
      return { error: "You are not signed in.", needsConfirmation: false };
    }
    if (
      typeof sessionUser.email === "string" &&
      sessionUser.email.toLowerCase() === addr.toLowerCase()
    ) {
      return {
        error: "That's already your current email address.",
        needsConfirmation: false,
      };
    }
    const { error } = await client.auth.updateUser({ email: addr });
    if (error) {
      return { error: error.message, needsConfirmation: false };
    }
    return { error: null, needsConfirmation: true };
  } catch (e) {
    return {
      error: e instanceof Error ? e.message : String(e),
      needsConfirmation: false,
    };
  }
}

/**
 * Completes a password reset after the user copies the recovery link from their email.
 * Supports Supabase links that contain either a PKCE `code`, hash tokens, or `token_hash`.
 * @param {string} recoveryLink
 * @param {string} newPassword
 * @returns {Promise<{ error: string | null }>}
 */
async function completePasswordResetFromLink(recoveryLink, newPassword) {
  try {
    const client = await ensureClient();
    if (!client) {
      return { error: "Supabase is not configured." };
    }
    const link = String(recoveryLink || "").trim();
    const pw = String(newPassword || "");
    if (!link) {
      return { error: "Paste the full password reset link from your email." };
    }
    if (pw.length < 8) {
      return { error: "New password must be at least 8 characters." };
    }

    let parsed;
    try {
      parsed = new URL(link);
    } catch {
      return { error: "That does not look like a valid reset link." };
    }

    const search = parsed.searchParams;
    const hash = new URLSearchParams(
      parsed.hash ? parsed.hash.replace(/^#/, "") : "",
    );
    const linkError =
      search.get("error_description") ||
      hash.get("error_description") ||
      search.get("error") ||
      hash.get("error");
    if (linkError) {
      return { error: linkError.replace(/\+/g, " ") };
    }

    const accessToken = hash.get("access_token") || search.get("access_token");
    const refreshToken =
      hash.get("refresh_token") || search.get("refresh_token");
    const code = search.get("code") || hash.get("code");
    const tokenHash =
      search.get("token_hash") ||
      hash.get("token_hash") ||
      search.get("token") ||
      hash.get("token");

    if (accessToken && refreshToken) {
      const { error } = await client.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      });
      if (error) {
        return { error: error.message };
      }
    } else if (code) {
      const { error } = await client.auth.exchangeCodeForSession(code);
      if (error) {
        return { error: error.message };
      }
    } else if (tokenHash) {
      const { error } = await client.auth.verifyOtp({
        type: "recovery",
        token_hash: tokenHash,
      });
      if (error) {
        return { error: error.message };
      }
    } else {
      return {
        error:
          "This reset link is missing the recovery token. Copy the full link from the email and try again.",
      };
    }

    const { error } = await client.auth.updateUser({ password: pw });
    return { error: error ? error.message : null };
  } catch (e) {
    return {
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * @returns {Promise<{ error: string | null }>}
 */
async function signOutSupabase() {
  try {
    clearTeacherProfileStateCache();
    // Turn 40 — Always clear saved admin creds on sign-out so a different user signing in
    // afterwards does not auto-sign-in as the previous admin on the next restart.
    try {
      await ipcRenderer.invoke("admin-creds:clear");
    } catch {
      /* ignore */
    }
    const client = await ensureClient();
    if (!client) {
      return { error: null };
    }
    const { error } = await client.auth.signOut();
    return { error: error ? error.message : null };
  } catch (e) {
    return {
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Session cache for teachers row + auth metadata (avoids Supabase reads on every nav). */
const TEACHER_PROFILE_CACHE_TTL_MS = 5 * 60 * 1000;
/** @type {{ userId: string; fetchedAt: number; state: Record<string, unknown> } | null} */
let teacherProfileStateCache = null;

function clearTeacherProfileStateCache() {
  teacherProfileStateCache = null;
}

/**
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<
 *   | { kind: "not_configured" }
 *   | { kind: "auth_error"; message: string }
 *   | { kind: "not_signed_in" }
 *   | { kind: "ok"; email: string; user_metadata: Record<string, unknown>; row: Record<string, unknown> | null; rowError: string | null; fromCache?: boolean }
 * >}
 */
async function getTeacherProfileState(opts) {
  const force = Boolean(opts?.force);
  const client = await ensureClient();
  if (!client) {
    return { kind: "not_configured" };
  }
  const { data, error } = await client.auth.getSession();
  if (error) {
    return { kind: "auth_error", message: error.message };
  }
  const sessionUser = data?.session?.user;
  if (!sessionUser) {
    clearTeacherProfileStateCache();
    return { kind: "not_signed_in" };
  }
  const userId = String(sessionUser.id || "").trim();
  if (
    !force &&
    userId &&
    teacherProfileStateCache &&
    teacherProfileStateCache.userId === userId &&
    Date.now() - teacherProfileStateCache.fetchedAt < TEACHER_PROFILE_CACHE_TTL_MS
  ) {
    return /** @type {ReturnType<typeof getTeacherProfileState> extends Promise<infer T> ? T : never} */ ({
      ...teacherProfileStateCache.state,
      fromCache: true,
    });
  }

  const meta =
    sessionUser.user_metadata &&
    typeof sessionUser.user_metadata === "object"
      ? JSON.parse(JSON.stringify(sessionUser.user_metadata))
      : {};
  const email =
    typeof sessionUser.email === "string" ? sessionUser.email : "";

  const { data: row, error: rowErr } = await client
    .from("teachers")
    .select("*")
    .eq("id", sessionUser.id)
    .maybeSingle();

  const safeRow = row
    ? JSON.parse(JSON.stringify(row))
    : null;

  /** @type {{ kind: "ok"; email: string; user_metadata: Record<string, unknown>; row: Record<string, unknown> | null; rowError: string | null }} */
  const result = {
    kind: "ok",
    email,
    user_metadata: meta,
    row: safeRow,
    rowError: rowErr ? rowErr.message : null,
  };
  if (userId) {
    teacherProfileStateCache = {
      userId,
      fetchedAt: Date.now(),
      state: result,
    };
  }
  return result;
}

/**
 * Resolves Notion person/page id from admin payslip_notion_person_links by matching
 * teachers.first_name / last_name (via security definer RPC). Returns "" if none.
 * @returns {Promise<{ ok: boolean; id: string; message?: string }>}
 */
async function fetchTeacherNotionPersonRecordId() {
  try {
    const client = await ensureClient();
    if (!client) {
      return { ok: false, id: "", message: "Supabase is not configured." };
    }
    const { data, error } = await client.rpc("get_my_notion_person_record_id");
    if (error) {
      return { ok: false, id: "", message: error.message };
    }
    const id =
      typeof data === "string"
        ? data.trim()
        : data != null
          ? String(data).trim()
          : "";
    return { ok: true, id };
  } catch (e) {
    return {
      ok: false,
      id: "",
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * @param {{
 *   firstName: string;
 *   lastName: string;
 *   contactEmail?: string;
 *   phoneNumber?: string;
 *   bankDetails?: string;
 *   nationalId?: string;
 * }} payload
 * @returns {Promise<{ error: string | null }>}
 */
async function updateTeacherProfile(payload) {
  try {
    const client = await ensureClient();
    if (!client) {
      return { error: "Supabase is not configured." };
    }
    const { data: authData, error: authErr } = await client.auth.getSession();
    if (authErr) {
      return { error: authErr.message };
    }
    const u = authData?.session?.user;
    if (!u?.id) {
      return { error: "You are not signed in." };
    }
    const fn = String(payload?.firstName ?? "").trim();
    const ln = String(payload?.lastName ?? "").trim();
    const fullName =
      fn || ln ? `${fn} ${ln}`.trim() : null;
    const emailRaw =
      payload && "contactEmail" in payload
        ? String(payload.contactEmail ?? "").trim()
        : null;
    const phoneRaw =
      payload && "phoneNumber" in payload
        ? String(payload.phoneNumber ?? "").trim()
        : null;
    const bankRaw =
      payload && "bankDetails" in payload
        ? String(payload.bankDetails ?? "").trim()
        : null;
    const idRaw =
      payload && "nationalId" in payload
        ? String(payload.nationalId ?? "").trim()
        : null;
    /** @type {Record<string, string | null>} */
    const patch = {
      first_name: fn || null,
      last_name: ln || null,
      full_name: fullName,
    };
    if (emailRaw !== null) {
      patch.email = emailRaw || null;
    }
    if (phoneRaw !== null) {
      patch.phone_number = phoneRaw || null;
    }
    if (bankRaw !== null) {
      patch.bank_details = bankRaw || null;
    }
    if (idRaw !== null) {
      patch.national_id = idRaw || null;
    }
    const { error } = await client
      .from("teachers")
      .update(patch)
      .eq("id", u.id);
    if (!error) {
      clearTeacherProfileStateCache();
    }
    return { error: error ? error.message : null };
  } catch (e) {
    return {
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

const AVATAR_ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

const AVATAR_EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

/**
 * @param {{ data: ArrayBuffer; contentType: string }} payload
 * @returns {Promise<{ error: string | null }>}
 */
async function uploadTeacherAvatar(payload) {
  try {
    const client = await ensureClient();
    if (!client) {
      return { error: "Supabase is not configured." };
    }
    const { data: authData, error: authErr } = await client.auth.getSession();
    if (authErr) {
      return { error: authErr.message };
    }
    const u = authData?.session?.user;
    if (!u?.id) {
      return { error: "You are not signed in." };
    }
    const ct = String(payload?.contentType ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (!AVATAR_ALLOWED_TYPES.has(ct)) {
      return {
        error: "Use a JPEG, PNG, WebP, or GIF image.",
      };
    }
    const raw = payload?.data;
    if (!(raw instanceof ArrayBuffer) || raw.byteLength === 0) {
      return { error: "Invalid image data." };
    }
    const maxBytes = 5 * 1024 * 1024;
    if (raw.byteLength > maxBytes) {
      return { error: "Image must be 5 MB or smaller." };
    }
    const ext = AVATAR_EXT[ct] || "jpg";
    const path = `${u.id}/avatar.${ext}`;
    const body = new Uint8Array(raw);
    const { error: upErr } = await client.storage
      .from("teacher-avatars")
      .upload(path, body, {
        contentType: ct,
        upsert: true,
      });
    if (upErr) {
      return { error: upErr.message };
    }
    const { data: pub } = client.storage
      .from("teacher-avatars")
      .getPublicUrl(path);
    const publicUrl =
      pub && typeof pub.publicUrl === "string" ? pub.publicUrl : "";
    if (!publicUrl) {
      return { error: "Could not get public URL for the image." };
    }
    const { error: dbErr } = await client
      .from("teachers")
      .update({ avatar_url: publicUrl })
      .eq("id", u.id);
    if (!dbErr) {
      clearTeacherProfileStateCache();
    }
    return { error: dbErr ? dbErr.message : null };
  } catch (e) {
    return {
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * @returns {Promise<
 *   | { ok: true; teachers: Record<string, unknown>[]; error: null }
 *   | { ok: false; teachers: []; error: string }
 * >}
 */
async function listTeachersForAdmin() {
  try {
    const client = await ensureClient();
    if (!client) {
      return { ok: false, error: "Supabase is not configured.", teachers: [] };
    }
    const { data: authData, error: authErr } = await client.auth.getSession();
    if (authErr) {
      return { ok: false, error: authErr.message, teachers: [] };
    }
    if (!authData?.session?.user) {
      return { ok: false, error: "You are not signed in.", teachers: [] };
    }
    const { data, error } = await client
      .from("teachers")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) {
      return { ok: false, error: error.message, teachers: [] };
    }
    const list = Array.isArray(data) ? data : [];
    const teachers = list.map((row) => JSON.parse(JSON.stringify(row)));
    return { ok: true, error: null, teachers };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      teachers: [],
    };
  }
}

/**
 * @param {Record<string, unknown>} r
 * @returns {{ rowKey: string; givenName: string; familyName: string; notionRecordId: string } | null}
 */
function mapPayslipNotionLinkFromDbRow(r) {
  if (!r || typeof r !== "object") {
    return null;
  }
  const rowKey =
    typeof r.row_key === "string" ? r.row_key.trim() : String(r.row_key ?? "").trim();
  if (!rowKey) {
    return null;
  }
  return {
    rowKey,
    givenName:
      typeof r.given_name === "string"
        ? r.given_name
        : String(r.given_name ?? ""),
    familyName:
      typeof r.family_name === "string"
        ? r.family_name
        : String(r.family_name ?? ""),
    notionRecordId:
      typeof r.notion_record_id === "string"
        ? r.notion_record_id
        : String(r.notion_record_id ?? ""),
  };
}

/**
 * @returns {Promise<
 *   | { ok: true; rows: { rowKey: string; givenName: string; familyName: string; notionRecordId: string }[]; error: null }
 *   | { ok: false; rows: []; error: string }
 * >}
 */
async function fetchPayslipNotionPersonLinksForAdmin() {
  try {
    const client = await ensureClient();
    if (!client) {
      return { ok: false, error: "Supabase is not configured.", rows: [] };
    }
    const { data: authData, error: authErr } = await client.auth.getSession();
    if (authErr) {
      return { ok: false, error: authErr.message, rows: [] };
    }
    if (!authData?.session?.user) {
      return { ok: false, error: "You are not signed in.", rows: [] };
    }
    const { data, error } = await client
      .from("payslip_notion_person_links")
      .select("row_key, given_name, family_name, notion_record_id, sort_order")
      .order("sort_order", { ascending: true })
      .order("row_key", { ascending: true });
    if (error) {
      return { ok: false, error: error.message, rows: [] };
    }
    const list = Array.isArray(data) ? data : [];
    /** @type {{ rowKey: string; givenName: string; familyName: string; notionRecordId: string }[]} */
    const rows = [];
    for (const raw of list) {
      const q = mapPayslipNotionLinkFromDbRow(raw);
      if (q) {
        rows.push(q);
      }
    }
    return { ok: true, error: null, rows };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      rows: [],
    };
  }
}

/**
 * Full replace: upserts all rows and deletes server rows missing from the payload.
 * @param {{ rowKey: string; givenName: string; familyName: string; notionRecordId: string }[]} rows
 * @returns {Promise<{ error: string | null }>}
 */
async function syncPayslipNotionPersonLinksForAdmin(rows) {
  try {
    const client = await ensureClient();
    if (!client) {
      return { error: "Supabase is not configured." };
    }
    const { data: authData, error: authErr } = await client.auth.getSession();
    if (authErr) {
      return { error: authErr.message };
    }
    if (!authData?.session?.user) {
      return { error: "You are not signed in." };
    }
    const arr = Array.isArray(rows) ? rows : [];
    const incomingKeys = new Set(
      arr.map((r) => String(r?.rowKey ?? "").trim()).filter(Boolean),
    );

    const { data: existing, error: exErr } = await client
      .from("payslip_notion_person_links")
      .select("row_key");
    if (exErr) {
      return { error: exErr.message };
    }
    for (const row of existing || []) {
      const k = typeof row?.row_key === "string" ? row.row_key.trim() : "";
      if (k && !incomingKeys.has(k)) {
        const { error: delErr } = await client
          .from("payslip_notion_person_links")
          .delete()
          .eq("row_key", k);
        if (delErr) {
          return { error: delErr.message };
        }
      }
    }

    if (arr.length === 0) {
      return { error: null };
    }
    const payload = arr.map((r, i) => ({
      row_key: String(r.rowKey ?? "").trim(),
      given_name: String(r.givenName ?? "").slice(0, 200),
      family_name: String(r.familyName ?? "").slice(0, 200),
      notion_record_id: String(r.notionRecordId ?? "").slice(0, 200),
      sort_order: i,
      updated_at: new Date().toISOString(),
    }));
    const { error: upErr } = await client
      .from("payslip_notion_person_links")
      .upsert(payload, { onConflict: "row_key" });
    return { error: upErr ? upErr.message : null };
  } catch (e) {
    return {
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * @returns {Promise<
 *   | { ok: true; state: Record<string, unknown>; error: null }
 *   | { ok: false; state: Record<string, unknown>; error: string }
 * >}
 */
async function fetchPayslipAppUserState() {
  try {
    const client = await ensureClient();
    if (!client) {
      return {
        ok: false,
        state: {},
        error: "Supabase is not configured.",
      };
    }
    const { data: authData, error: authErr } = await client.auth.getSession();
    if (authErr) {
      return { ok: false, state: {}, error: authErr.message };
    }
    const uid = authData?.session?.user?.id;
    if (!uid) {
      return { ok: false, state: {}, error: "You are not signed in." };
    }
    const { data, error } = await client
      .from("payslip_app_user_state")
      .select("state")
      .eq("user_id", uid)
      .maybeSingle();
    if (error) {
      return { ok: false, state: {}, error: error.message };
    }
    const s = data?.state;
    const state =
      s && typeof s === "object" && !Array.isArray(s)
        ? /** @type {Record<string, unknown>} */ (
            JSON.parse(JSON.stringify(s))
          )
        : {};
    return { ok: true, state, error: null };
  } catch (e) {
    return {
      ok: false,
      state: {},
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Same keys as `renderer.js` — nested maps keyed by workspace page id. */
const MIRROR_FLOATING_DRAFTS_KEY = "recruit-notion-workspace-page-floating-drafts-v1";
const MIRROR_CANVAS_DRAFTS_KEY = "recruit-notion-workspace-canvas-drafts-v1";

/**
 * @param {unknown} prev
 * @param {unknown} patchVal
 * @returns {Record<string, unknown>}
 */
function shallowMergePageKeyedBlob(prev, patchVal) {
  const a =
    prev && typeof prev === "object" && !Array.isArray(prev)
      ? /** @type {Record<string, unknown>} */ (prev)
      : {};
  const b =
    patchVal && typeof patchVal === "object" && !Array.isArray(patchVal)
      ? /** @type {Record<string, unknown>} */ (patchVal)
      : {};
  return { ...a, ...b };
}

/**
 * Shallow-merge `patch` into the signed-in user's `state` JSON (read-modify-write).
 * Per-page draft blobs are merged with existing server state so a partial patch cannot drop
 * another workspace page's databases (race / bug hardening).
 * @param {Record<string, unknown>} patch
 * @returns {Promise<{ error: string | null }>}
 */
async function mergePayslipAppUserState(patch) {
  try {
    const client = await ensureClient();
    if (!client) {
      return { error: "Supabase is not configured." };
    }
    const { data: authData, error: authErr } = await client.auth.getSession();
    if (authErr) {
      return { error: authErr.message };
    }
    const u = authData?.session?.user;
    if (!u?.id) {
      return { error: "You are not signed in." };
    }
    const p =
      patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {};
    const { data: row, error: selErr } = await client
      .from("payslip_app_user_state")
      .select("state")
      .eq("user_id", u.id)
      .maybeSingle();
    if (selErr) {
      return { error: selErr.message };
    }
    const prevRaw = row?.state;
    const prev =
      prevRaw && typeof prevRaw === "object" && !Array.isArray(prevRaw)
        ? /** @type {Record<string, unknown>} */ (
            JSON.parse(JSON.stringify(prevRaw))
          )
        : {};
    const next = { ...prev };
    for (const [k, v] of Object.entries(p)) {
      if (v === null || v === undefined) {
        delete next[k];
      } else if (k === MIRROR_FLOATING_DRAFTS_KEY || k === MIRROR_CANVAS_DRAFTS_KEY) {
        next[k] = shallowMergePageKeyedBlob(prev[k], v);
      } else {
        next[k] = v;
      }
    }
    const { error: upErr } = await client.from("payslip_app_user_state").upsert(
      {
        user_id: u.id,
        state: next,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    return { error: upErr ? upErr.message : null };
  } catch (e) {
    return {
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * @returns {Promise<
 *   | { ok: true; rows: Record<string, unknown>[]; error: null }
 *   | { ok: false; rows: []; error: string }
 * >}
 */
async function fetchPayslipWorkspaceDatabases() {
  try {
    const client = await ensureClient();
    if (!client) {
      return { ok: false, rows: [], error: "Supabase is not configured." };
    }
    const { data: authData, error: authErr } = await client.auth.getSession();
    if (authErr) {
      return { ok: false, rows: [], error: authErr.message };
    }
    const uid = authData?.session?.user?.id;
    if (!uid) {
      return { ok: false, rows: [], error: "You are not signed in." };
    }
    const { data, error } = await client
      .from("user_workspace_draft_databases")
      .select("workspace_page_id, replica_id, title, snapshot, updated_at")
      .eq("user_id", uid);
    if (error) {
      return { ok: false, rows: [], error: error.message };
    }
    const rows = Array.isArray(data) ? data : [];
    return { ok: true, rows, error: null };
  } catch (e) {
    return {
      ok: false,
      rows: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * @param {{
 *   workspace_page_id: string;
 *   replica_id: string;
 *   title?: string;
 *   snapshot: Record<string, unknown>;
 * }} payload
 * @returns {Promise<{ error: string | null }>}
 */
async function upsertPayslipWorkspaceDatabase(payload) {
  try {
    const client = await ensureClient();
    if (!client) {
      return { error: "Supabase is not configured." };
    }
    const { data: authData, error: authErr } = await client.auth.getSession();
    if (authErr) {
      return { error: authErr.message };
    }
    const u = authData?.session?.user;
    if (!u?.id) {
      return { error: "You are not signed in." };
    }
    const wp = String(payload?.workspace_page_id ?? "").trim();
    const rid = String(payload?.replica_id ?? "").trim();
    if (!wp || !rid) {
      return { error: "workspace_page_id and replica_id are required." };
    }
    const title =
      typeof payload?.title === "string" ? payload.title.slice(0, 400) : "";
    const snap =
      payload?.snapshot && typeof payload.snapshot === "object" && !Array.isArray(payload.snapshot)
        ? payload.snapshot
        : {};
    const { error: upErr } = await client
      .from("user_workspace_draft_databases")
      .upsert(
        {
          user_id: u.id,
          workspace_page_id: wp,
          replica_id: rid,
          title,
          snapshot: snap,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,workspace_page_id,replica_id" },
      );
    return { error: upErr ? upErr.message : null };
  } catch (e) {
    return {
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Heartbeat: marks the signed-in teacher as currently online.
 * Updates `teachers.last_seen_at = now()` for `auth.uid() = id` (RLS-safe).
 * @returns {Promise<{ ok: boolean; error: string | null; lastSeenAt: string | null }>}
 */
async function touchTeacherPresence() {
  try {
    const client = await ensureClient();
    if (!client) {
      return { ok: false, error: "Supabase is not configured.", lastSeenAt: null };
    }
    const { data: authData, error: authErr } = await client.auth.getSession();
    if (authErr) {
      return { ok: false, error: authErr.message, lastSeenAt: null };
    }
    const u = authData?.session?.user;
    if (!u?.id) {
      return { ok: false, error: "You are not signed in.", lastSeenAt: null };
    }
    const nowIso = new Date().toISOString();
    const { error } = await client
      .from("teachers")
      .update({ last_seen_at: nowIso })
      .eq("id", u.id);
    if (error) {
      return { ok: false, error: error.message, lastSeenAt: null };
    }
    return { ok: true, error: null, lastSeenAt: nowIso };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      lastSeenAt: null,
    };
  }
}

/**
 * Curated background images for the app chrome (`payslip_app_backgrounds`).
 * @returns {Promise<
 *   | { ok: true; rows: { id: string; label: string | null; sort_order: number; image_url: string }[]; error: null }
 *   | { ok: false; rows: []; error: string }
 * >}
 */
async function fetchPayslipAppBackgrounds() {
  try {
    const client = await ensureClient();
    if (!client) {
      return { ok: false, rows: [], error: "Supabase is not configured." };
    }
    const { data: authData, error: authErr } = await client.auth.getSession();
    if (authErr) {
      return { ok: false, rows: [], error: authErr.message };
    }
    if (!authData?.session?.user?.id) {
      return { ok: false, rows: [], error: "You are not signed in." };
    }
    const { data, error } = await client
      .from("payslip_app_backgrounds")
      .select("id,label,sort_order,image_url")
      .eq("is_active", true)
      .order("sort_order", { ascending: true });
    if (error) {
      return { ok: false, rows: [], error: error.message };
    }
    const rows = Array.isArray(data) ? data : [];
    return { ok: true, rows, error: null };
  } catch (e) {
    return {
      ok: false,
      rows: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

contextBridge.exposeInMainWorld("teacherAuth", {
  loadPublicConfig,
  resetSupabaseClient,
  getRememberMePreference: rememberMePrefersPersistentSession,
  setRememberMePreference: setStoredRememberPreference,
  getSessionUser,
  signInWithEmail,
  signUpWithEmail,
  signOutSupabase,
  requestPasswordReset,
  completePasswordResetFromLink,
  updatePassword,
  updateEmail,
  getTeacherProfileState,
  clearTeacherProfileStateCache,
  fetchTeacherNotionPersonRecordId,
  updateTeacherProfile,
  uploadTeacherAvatar,
  listTeachersForAdmin,
  touchTeacherPresence,
  fetchPayslipNotionPersonLinksForAdmin,
  syncPayslipNotionPersonLinksForAdmin,
  fetchPayslipAppUserState,
  mergePayslipAppUserState,
  fetchPayslipAppBackgrounds,
  fetchPayslipWorkspaceDatabases,
  upsertPayslipWorkspaceDatabase,
});

