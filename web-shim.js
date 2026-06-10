/**
 * RME web-shim.js
 * ---------------------------------------------------------------------------
 * Browser compatibility layer that lets the Teachers Portal (an Electron app)
 * run in a plain browser, e.g. GitHub Pages.
 *
 * In Electron, preload.js runs via webPreferences.preload and exposes the
 * window.* bridges (teacherAuth, notionApi, ...) BEFORE any page script runs.
 * In that case this shim detects the existing environment and does NOTHING,
 * so the desktop app is completely unaffected.
 *
 * In a browser there is no Electron, no preload, no require(). This shim:
 *   1. Provides require("electron") -> mocked { contextBridge, ipcRenderer }.
 *   2. Provides require("@supabase/supabase-js") -> vendored UMD global.
 *   3. Feeds Supabase config through ipcRenderer channel "config:get-supabase".
 *   4. Backs admin-creds channels with localStorage.
 *   5. Loads the vendored supabase-js, then the app's REAL preload.js, which
 *      then builds every window.* bridge using the real app logic.
 */
(function rmeWebShim() {
  "use strict";

  // --- Environment detection -------------------------------------------------
  var ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
  var isElectron =
    /Electron/i.test(ua) ||
    (window.teacherAuth && typeof window.teacherAuth.signInWithEmail === "function");
  if (isElectron) return;
  if (window.__RME_WEB_SHIM_ACTIVE__) return;
  window.__RME_WEB_SHIM_ACTIVE__ = true;

  // --- Supabase public config (anon key is designed to be public) ------------
  var SUPABASE_URL = "https://rlewulpivpqkbsvhaafp.supabase.co";
  var SUPABASE_ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJsZXd1bHBpdnBxa2JzdmhhYWZwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc1NDkzOTksImV4cCI6MjA5MzEyNTM5OX0.XacFfKcniMntC8cCYpFTPN5-j5GAgM2ZijFQdgavA4U";

  var ADMIN_CREDS_KEY = "rme.web.adminCreds";
  // Admin role for the browser build. The app already hard-codes this same
  // address in renderer.js (ADMIN_EMAILS), so this is not a new secret. Real
  // admin-data protection must live in Supabase RLS, not this UI role check.
  var ADMIN_EMAIL = "inforecruitmyenglish@gmail.com";
  function resolve(v) { return Promise.resolve(v); }

  // Reads the persisted Supabase session access token from localStorage
  // (supabase-js v2 stores it under "sb-<ref>-auth-token").
  function rmeGetAccessToken() {
    try {
      for (var i = 0; i < window.localStorage.length; i++) {
        var k = window.localStorage.key(i);
        if (!k || k.indexOf("sb-") !== 0 || k.indexOf("-auth-token") === -1) continue;
        var raw = window.localStorage.getItem(k);
        if (!raw) continue;
        var obj = JSON.parse(raw);
        var tok = obj && (obj.access_token || (obj.currentSession && obj.currentSession.access_token));
        if (tok) return tok;
      }
    } catch (e) {}
    return "";
  }

  // Pay slips require the secret NOTION_TOKEN, which must NEVER ship to a browser.
  // Instead we call the Supabase Edge Function "notion-payslips", which holds the
  // token server-side and returns the SAME shape as the desktop IPC handler.
  function rmeQueryPayslips(payload) {
    var token = rmeGetAccessToken();
    return fetch(SUPABASE_URL + "/functions/v1/notion-payslips", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + (token || SUPABASE_ANON_KEY),
        "apikey": SUPABASE_ANON_KEY,
      },
      body: JSON.stringify(payload || {}),
    })
      .then(function (r) { return r.json(); })
      .catch(function (e) {
        return { ok: false, message: String((e && e.message) || e), columns: [], rows: [], pageIds: [], noEmailColumn: false };
      });
  }

  // --- Mocked ipcRenderer ----------------------------------------------------
  var ipcRenderer = {
    invoke: function (channel, payload) {
      try {
        switch (channel) {
          case "config:get-supabase":
            return resolve({ url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY });
          case "auth:allowed-admin-email":
            // Lets supabaseSessionUserIsAdmin() resolve admin mode in-browser,
            // unlocking the admin dock (incl. the AI / Voice agent section).
            return resolve({ email: ADMIN_EMAIL });
          case "notion:query-teacher-payslips":
            return rmeQueryPayslips(payload);
          case "admin-creds:save":
            try { window.localStorage.setItem(ADMIN_CREDS_KEY, JSON.stringify(payload || {})); } catch (e) {}
            return resolve({ ok: true });
          case "admin-creds:load":
            try {
              var raw = window.localStorage.getItem(ADMIN_CREDS_KEY);
              return resolve(raw ? JSON.parse(raw) : null);
            } catch (e) { return resolve(null); }
          case "admin-creds:clear":
            try { window.localStorage.removeItem(ADMIN_CREDS_KEY); } catch (e) {}
            return resolve({ ok: true });
          default:
            // Desktop-only feature (voice, auto-update, native file IO, etc.).
            // Safe no-op so renderer code awaiting it does not crash.
            return resolve(null);
        }
      } catch (e) { return resolve(null); }
    },
    on: function () { return ipcRenderer; },
    once: function () { return ipcRenderer; },
    addListener: function () { return ipcRenderer; },
    removeListener: function () { return ipcRenderer; },
    removeAllListeners: function () { return ipcRenderer; },
    send: function () {},
    sendSync: function () { return null; },
    postMessage: function () {},
  };

  // --- Mocked contextBridge --------------------------------------------------
  var contextBridge = {
    exposeInMainWorld: function (key, api) {
      try { window[key] = api; }
      catch (e) { console.error("[RME web-shim] exposeInMainWorld failed for", key, e); }
    },
  };

  var electronModule = { contextBridge: contextBridge, ipcRenderer: ipcRenderer };

  // --- require() shim --------------------------------------------------------
  window.require = function (mod) {
    if (mod === "electron") return electronModule;
    if (mod === "@supabase/supabase-js") {
      if (window.supabase && typeof window.supabase.createClient === "function") return window.supabase;
      throw new Error("[RME web-shim] supabase-js global not loaded yet");
    }
    throw new Error("[RME web-shim] module not available in browser: " + mod);
  };

  // --- Load vendored supabase-js, then the real preload.js -------------------
  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = src;
      s.async = false;
      s.addEventListener("load", function () { res(); });
      s.addEventListener("error", function () { rej(new Error("Failed to load " + src)); });
      (document.head || document.documentElement).appendChild(s);
    });
  }

  console.info("[RME web-shim] Browser mode active - initialising Supabase bridge.");
  loadScript("vendor/supabase.js")
    .then(function () { return loadScript("preload.js"); })
    .then(function () { console.info("[RME web-shim] teacherAuth bridge ready:", !!window.teacherAuth); })
    .catch(function (e) { console.error("[RME web-shim] init failed:", e); });
})();
