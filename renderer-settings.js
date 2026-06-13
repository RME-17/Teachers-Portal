/**
 * App Settings page — mounted in #rmeSettingsRoot after renderer.js loads.
 */
(function rmeAppSettingsPage() {
  "use strict";

  const CAL_STORAGE_SETTINGS = "recruit-rme-calendar-settings-v1";
  const THEME_KEY = "recruit-my-english-theme";

  /** @type {readonly { id: string; label: string }[]} */
  const REMINDER_SOUNDS = [
    { id: "windows", label: "Windows default" },
    { id: "chime", label: "Chime" },
    { id: "bell", label: "Bell" },
    { id: "ping", label: "Ping" },
    { id: "soft", label: "Soft" },
    { id: "urgent", label: "Urgent" },
    { id: "off", label: "Silent" },
  ];

  /** @type {AudioContext | null} */
  let previewAudioCtx = null;

  /** @type {{ weekStartsOn: 0 | 1; reminderSound: string }} */
  let plannerSettingsCache = { weekStartsOn: 1, reminderSound: "windows" };

  /** @param {string | null | undefined} raw */
  function parsePlannerSettings(raw) {
    try {
      if (!raw) return { weekStartsOn: 1, reminderSound: "windows" };
      const o = JSON.parse(raw);
      const w = Number(o?.weekStartsOn);
      const id = String(o?.reminderSound || "windows").trim();
      return {
        weekStartsOn: w === 0 ? 0 : 1,
        reminderSound: REMINDER_SOUNDS.some((s) => s.id === id) ? id : "windows",
      };
    } catch {
      return { weekStartsOn: 1, reminderSound: "windows" };
    }
  }

  async function refreshPlannerSettingsFromStore() {
    const api = window.calendarStorageApi;
    let raw = null;
    if (api && typeof api.read === "function") {
      try {
        const init = await api.isInitialized();
        if (init && init.ok && init.initialized) {
          const res = await api.read("settings");
          if (res && res.ok && typeof res.content === "string") {
            raw = res.content;
          }
        }
      } catch {
        /* fall through */
      }
    }
    if (raw == null) {
      try {
        raw = window.localStorage.getItem(CAL_STORAGE_SETTINGS);
      } catch {
        raw = null;
      }
    }
    plannerSettingsCache = parsePlannerSettings(raw);
  }

  /** @returns {{ weekStartsOn: 0 | 1; reminderSound: string }} */
  function loadPlannerSettings() {
    return { ...plannerSettingsCache };
  }

  /** @param {Partial<{ weekStartsOn: 0 | 1; reminderSound: string }>} patch */
  function savePlannerSettings(patch) {
    const next = { ...loadPlannerSettings(), ...patch };
    plannerSettingsCache = next;
    const json = JSON.stringify(next);
    const api = window.calendarStorageApi;
    if (api && typeof api.write === "function") {
      void api.write("settings", json).then((res) => {
        if (!res || !res.ok) {
          try {
            window.localStorage.setItem(CAL_STORAGE_SETTINGS, json);
          } catch (e) {
            console.warn("planner settings save:", e);
          }
        }
      });
    } else {
      try {
        window.localStorage.setItem(CAL_STORAGE_SETTINGS, json);
      } catch (e) {
        console.warn("planner settings save:", e);
      }
    }
    window.dispatchEvent(
      new CustomEvent("rme-cal-settings-changed", { detail: next }),
    );
    return next;
  }

  /** @returns {"light" | "dark"} */
  function readThemeFromDom() {
    return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  }

  /** @returns {"light" | "dark"} */
  function getThemePreference() {
    const api = window.rmeAppSettings;
    if (api && typeof api.getTheme === "function") {
      return api.getTheme() === "dark" ? "dark" : "light";
    }
    if (typeof window.getAppTheme === "function") {
      return window.getAppTheme() === "dark" ? "dark" : "light";
    }
    return readThemeFromDom();
  }

  /** @param {"light" | "dark"} theme */
  function applyThemePreference(theme) {
    const next = theme === "dark" ? "dark" : "light";
    if (typeof window.setAppTheme === "function") {
      window.setAppTheme(next);
      return;
    }
    const api = window.rmeAppSettings;
    if (api && typeof api.setTheme === "function") {
      api.setTheme(next);
      return;
    }
    document.documentElement.dataset.theme = next;
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      /* ignore */
    }
    try {
      window.dispatchEvent(
        new CustomEvent("rme-app-theme-changed", { detail: { theme: next } }),
      );
    } catch {
      /* ignore */
    }
  }

  function openWallpaperPicker() {
    const api = window.rmeAppSettings;
    if (api && typeof api.openBackgroundPicker === "function") {
      api.openBackgroundPicker();
      return;
    }
    if (typeof window.openAppBackgroundPickerModal === "function") {
      void window.openAppBackgroundPickerModal();
      return;
    }
    const legacy = document.getElementById("navOpenAppBackgroundPicker");
    if (legacy instanceof HTMLButtonElement) {
      legacy.click();
    }
  }

  function restartAppFromSettings() {
    if (typeof window.restartDesktopApp === "function") {
      window.restartDesktopApp();
      return;
    }
    const api = window.rmeAppSettings;
    if (api && typeof api.restartApp === "function") {
      api.restartApp();
      return;
    }
    const legacy = document.getElementById("navRestartAppBtn");
    if (legacy instanceof HTMLButtonElement) {
      legacy.click();
    }
  }

  /** @returns {boolean} */
  function isTeacherPortal() {
    const api = window.rmeAppSettings;
    if (api && typeof api.isTeacherNavMode === "function") {
      return Boolean(api.isTeacherNavMode());
    }
    return document.getElementById("appMain")?.classList.contains(
      "teacher-nav-portal",
    );
  }

  /** Admin portal settings (maintenance, restart, storage diagnostics). */
  function isAdminSettingsViewer() {
    return !isTeacherPortal();
  }

  const SYSTEM_CARD_COLLAPSED_KEY = "rme-settings-system-card-collapsed:v1";

  /** @returns {boolean} */
  function readSystemCardCollapsed() {
    try {
      return window.sessionStorage.getItem(SYSTEM_CARD_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  }

  /** @param {boolean} collapsed */
  function writeSystemCardCollapsed(collapsed) {
    try {
      window.sessionStorage.setItem(
        SYSTEM_CARD_COLLAPSED_KEY,
        collapsed ? "1" : "0",
      );
    } catch {
      /* ignore */
    }
  }

  /** @returns {boolean} */
  function readSidebarCollapsedPref() {
    const api = window.rmeAppSettings;
    if (api && typeof api.getEditorSidebarCollapsed === "function") {
      return Boolean(api.getEditorSidebarCollapsed());
    }
    try {
      return window.localStorage.getItem("recruit-editor-sidebar-collapsed-v1") === "1";
    } catch {
      return false;
    }
  }

  /** @param {boolean} collapsed */
  function applySidebarCollapsedPref(collapsed) {
    const api = window.rmeAppSettings;
    if (api && typeof api.setEditorSidebarCollapsed === "function") {
      api.setEditorSidebarCollapsed(collapsed);
      return;
    }
    try {
      window.localStorage.setItem(
        "recruit-editor-sidebar-collapsed-v1",
        collapsed ? "1" : "0",
      );
    } catch {
      /* ignore */
    }
    const ws = document.getElementById("notionWorkspace");
    if (ws instanceof HTMLElement) {
      ws.classList.toggle("notion-workspace--sidebar-collapsed", collapsed);
    }
  }

  function getSignedInEmailLabel() {
    const api = window.rmeAppSettings;
    if (api && typeof api.getSignedInEmail === "function") {
      const em = String(api.getSignedInEmail() || "").trim();
      if (em) return em;
    }
    try {
      const em = window.localStorage.getItem("recruit-auth-saved-email");
      if (em) return String(em).trim();
    } catch {
      /* ignore */
    }
    return "";
  }

  function getPreviewAudioCtx() {
    if (previewAudioCtx && previewAudioCtx.state !== "closed") return previewAudioCtx;
    const Ctx =
      /** @type {typeof AudioContext | undefined} */ (window.AudioContext) ||
      /** @type {typeof AudioContext | undefined} */ (window.webkitAudioContext);
    if (!Ctx) return null;
    previewAudioCtx = new Ctx();
    return previewAudioCtx;
  }

  /** @param {string} soundId */
  async function previewReminderSound(soundId) {
    let id = String(soundId || "windows").trim();
    if (id === "off") return;
    if (id === "windows") id = "chime";
    if (!REMINDER_SOUNDS.some((s) => s.id === id)) return;

    const ctx = getPreviewAudioCtx();
    if (!ctx) return;
    try {
      await ctx.resume();
    } catch {
      return;
    }

    const master = ctx.createGain();
    master.gain.value = 0.42;
    master.connect(ctx.destination);
    const t0 = ctx.currentTime;

    /** @param {number} freq @param {number} start @param {number} dur @param {OscillatorType} [type] @param {number} [vol] */
    function beep(freq, start, dur, type = "sine", vol = 1) {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0 + start);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0001, vol), t0 + start + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
      g.connect(master);
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(freq, t0 + start);
      o.connect(g);
      o.start(t0 + start);
      o.stop(t0 + start + dur + 0.03);
    }

    switch (id) {
      case "chime":
        beep(880, 0, 0.2, "sine", 0.9);
        beep(1174.66, 0.15, 0.24, "sine", 0.82);
        beep(1318.51, 0.32, 0.4, "sine", 0.75);
        break;
      case "bell":
        beep(622.25, 0, 0.58, "triangle", 1);
        beep(1244.5, 0.05, 0.48, "sine", 0.38);
        break;
      case "ping":
        beep(1400, 0, 0.09, "sine", 1);
        beep(1046.5, 0.07, 0.14, "sine", 0.55);
        break;
      case "soft":
        beep(523.25, 0, 0.38, "sine", 0.52);
        beep(659.25, 0.22, 0.42, "sine", 0.38);
        break;
      case "urgent":
        for (let i = 0; i < 3; i++) {
          const off = i * 0.24;
          beep(880, off, 0.13, "square", 0.22);
          beep(659.25, off + 0.13, 0.09, "square", 0.18);
        }
        break;
      default:
        break;
    }
  }

  /**
   * @param {string} title
   * @param {string} blurb
   * @returns {{ card: HTMLElement; body: HTMLElement }}
   */
  function settingsCard(title, blurb) {
    const card = document.createElement("article");
    card.className = "rme-settings-card";
    const h2 = document.createElement("h2");
    h2.className = "rme-settings-card-title";
    h2.textContent = title;
    const p = document.createElement("p");
    p.className = "rme-settings-card-blurb";
    p.textContent = blurb;
    const body = document.createElement("div");
    body.className = "rme-settings-card-body";
    card.appendChild(h2);
    card.appendChild(p);
    card.appendChild(body);
    return { card, body };
  }

  /**
   * @param {string} label
   * @param {HTMLElement} control
   * @returns {HTMLElement}
   */
  function settingsRow(label, control) {
    const row = document.createElement("div");
    row.className = "rme-settings-row";
    const lb = document.createElement("label");
    lb.className = "rme-settings-row-label";
    lb.textContent = label;
    const val = document.createElement("div");
    val.className = "rme-settings-row-control";
    val.appendChild(control);
    row.appendChild(lb);
    row.appendChild(val);
    return row;
  }

  /** @param {HTMLElement} themeSeg */
  function syncThemeSegUi(themeSeg) {
    const cur = getThemePreference();
    themeSeg.querySelectorAll("button[data-theme]").forEach((btn) => {
      if (btn instanceof HTMLButtonElement) {
        btn.classList.toggle("rme-settings-seg--on", btn.dataset.theme === cur);
      }
    });
  }

  function renderAppearanceCard() {
    const { card, body } = settingsCard(
      "Appearance",
      "Theme and full-screen background for this device.",
    );
    const themeSeg = document.createElement("div");
    themeSeg.className = "rme-settings-seg";
    themeSeg.id = "rmeSettingsThemeSeg";
    for (const t of /** @type {const} */ (["light", "dark"])) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.theme = t;
      b.textContent = t === "light" ? "Light" : "Dark";
      b.addEventListener("click", (ev) => {
        ev.preventDefault();
        applyThemePreference(t);
        syncThemeSegUi(themeSeg);
      });
      themeSeg.appendChild(b);
    }
    syncThemeSegUi(themeSeg);
    body.appendChild(settingsRow("Color mode", themeSeg));

    const bgBtn = document.createElement("button");
    bgBtn.type = "button";
    bgBtn.className = "rme-settings-action-btn";
    bgBtn.textContent = "Choose background";
    bgBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      openWallpaperPicker();
    });
    body.appendChild(settingsRow("Wallpaper", bgBtn));
    return card;
  }

  function renderPlannerCard() {
    const planner = loadPlannerSettings();
    const { card, body } = settingsCard(
      "Planner & reminders",
      "My planner calendar and desktop reminder alerts.",
    );

    const soundWrap = document.createElement("div");
    soundWrap.className = "rme-settings-sound-row";
    const soundSel = document.createElement("select");
    soundSel.className = "rme-settings-select";
    soundSel.id = "rmeSettingsReminderSound";
    for (const s of REMINDER_SOUNDS) {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = s.label;
      if (s.id === planner.reminderSound) opt.selected = true;
      soundSel.appendChild(opt);
    }
    soundSel.addEventListener("change", () => {
      savePlannerSettings({ reminderSound: soundSel.value });
    });
    const previewBtn = document.createElement("button");
    previewBtn.type = "button";
    previewBtn.className = "rme-settings-action-btn rme-settings-action-btn--ghost";
    previewBtn.textContent = "Preview ▶";
    previewBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      void previewReminderSound(soundSel.value);
    });
    soundWrap.appendChild(soundSel);
    soundWrap.appendChild(previewBtn);
    body.appendChild(settingsRow("Reminder sound", soundWrap));

    const weekSeg = document.createElement("div");
    weekSeg.className = "rme-settings-seg";
    for (const opt of /** @type {const} */ ([
      { v: 1, label: "Monday" },
      { v: 0, label: "Sunday" },
    ])) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = opt.label;
      if (planner.weekStartsOn === opt.v) b.classList.add("rme-settings-seg--on");
      b.addEventListener("click", (ev) => {
        ev.preventDefault();
        savePlannerSettings({ weekStartsOn: opt.v });
        weekSeg.querySelectorAll("button").forEach((x) => {
          x.classList.toggle("rme-settings-seg--on", x === b);
        });
      });
      weekSeg.appendChild(b);
    }
    body.appendChild(settingsRow("Week starts on", weekSeg));

    const note = document.createElement("p");
    note.className = "rme-settings-note";
    note.textContent =
      "Desktop notifications are always on. If Windows hides banners, turn off Do Not Disturb (bell with Z near the clock).";
    body.appendChild(note);
    return card;
  }

  function renderWorkspaceCard() {
    const { card, body } = settingsCard(
      "Workspace",
      "Layout preferences for the admin Notion workspace.",
    );
    const collapsed = readSidebarCollapsedPref();
    const sideSeg = document.createElement("div");
    sideSeg.className = "rme-settings-seg";
    for (const opt of [
      { v: false, label: "Expanded" },
      { v: true, label: "Collapsed" },
    ]) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = opt.label;
      if (collapsed === opt.v) b.classList.add("rme-settings-seg--on");
      b.addEventListener("click", (ev) => {
        ev.preventDefault();
        applySidebarCollapsedPref(opt.v);
        sideSeg.querySelectorAll("button").forEach((x) => {
          x.classList.toggle("rme-settings-seg--on", x === b);
        });
      });
      sideSeg.appendChild(b);
    }
    body.appendChild(settingsRow("Pages sidebar", sideSeg));
    return card;
  }

  function renderSystemCard() {
    const admin = isAdminSettingsViewer();
    const card = document.createElement("article");
    card.className = "rme-settings-card rme-settings-card--system";
    card.classList.toggle("rme-settings-card--collapsed", readSystemCardCollapsed());

    const headBtn = document.createElement("button");
    headBtn.type = "button";
    headBtn.className = "rme-settings-card-head-btn";
    headBtn.setAttribute("aria-expanded", readSystemCardCollapsed() ? "false" : "true");

    const headText = document.createElement("span");
    headText.className = "rme-settings-card-head-text";

    const h2 = document.createElement("h2");
    h2.className = "rme-settings-card-title rme-settings-card-title--system";
    h2.textContent = "System";
    headText.appendChild(h2);

    if (admin) {
      const blurb = document.createElement("p");
      blurb.className = "rme-settings-card-blurb";
      blurb.textContent = "App maintenance on this device.";
      headText.appendChild(blurb);
    }

    const chevron = document.createElement("span");
    chevron.className = "rme-settings-card-chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.textContent = "▾";

    headBtn.appendChild(headText);
    headBtn.appendChild(chevron);
    card.appendChild(headBtn);

    const body = document.createElement("div");
    body.className = "rme-settings-card-body";

    const email = getSignedInEmailLabel();
    if (email) {
      const em = document.createElement("p");
      em.className = "rme-settings-meta";
      em.textContent = `Signed in as ${email}`;
      body.appendChild(em);
    }

    if (admin) {
      const restartSeg = document.createElement("div");
      restartSeg.className = "rme-settings-seg";
      restartSeg.setAttribute("role", "group");
      restartSeg.setAttribute("aria-label", "Restart application");

      /** @param {"running" | "restart"} mode */
      function syncRestartSeg(mode) {
        restartSeg.querySelectorAll("button[data-restart-mode]").forEach((btn) => {
          if (btn instanceof HTMLButtonElement) {
            btn.classList.toggle(
              "rme-settings-seg--on",
              btn.dataset.restartMode === mode,
            );
          }
        });
      }

      for (const opt of /** @type {const} */ ([
        { id: "running", label: "Running" },
        { id: "restart", label: "Restart app" },
      ])) {
        const b = document.createElement("button");
        b.type = "button";
        b.dataset.restartMode = opt.id;
        b.textContent = opt.label;
        if (opt.id === "running") {
          b.classList.add("rme-settings-seg--on");
        }
        b.addEventListener("click", (ev) => {
          ev.preventDefault();
          if (opt.id === "running") {
            syncRestartSeg("running");
            return;
          }
          if (
            !window.confirm(
              "Restart the desktop app? Unsaved work in other apps is unaffected; this app will quit and reopen.",
            )
          ) {
            syncRestartSeg("running");
            return;
          }
          restartAppFromSettings();
        });
        restartSeg.appendChild(b);
      }
      body.appendChild(settingsRow("Restart", restartSeg));

      const storageNote = document.createElement("p");
      storageNote.className = "rme-settings-note";
      storageNote.textContent =
        "Planner data is stored on this device in your app data folder (file-backed). Theme and wallpaper use device storage / account sync where enabled.";
      body.appendChild(storageNote);

      const plannerStoreMeta = document.createElement("p");
      plannerStoreMeta.className =
        "rme-settings-meta rme-settings-planner-store-meta";
      plannerStoreMeta.textContent = "Planner storage: checking…";
      body.appendChild(plannerStoreMeta);
      const api = window.calendarStorageApi;
      if (api && typeof api.storageInfo === "function") {
        void api.storageInfo().then((info) => {
          if (!info || !info.ok) {
            plannerStoreMeta.textContent = "Planner storage: unavailable";
            return;
          }
          const kb = info.totalBytes / 1024;
          const label =
            kb >= 1024
              ? `${(kb / 1024).toFixed(2)} MB`
              : `${Math.max(1, Math.round(kb))} KB`;
          plannerStoreMeta.textContent = `Planner storage on disk: ${label}`;
        });
      } else {
        plannerStoreMeta.textContent =
          "Planner storage: local files when running in the desktop app";
      }
    }

    card.appendChild(body);

    headBtn.addEventListener("click", () => {
      const collapsed = !card.classList.contains("rme-settings-card--collapsed");
      card.classList.toggle("rme-settings-card--collapsed", collapsed);
      writeSystemCardCollapsed(collapsed);
      headBtn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    });

    return card;
  }

  const RME_VOICE_MIC_KEY = "rme-voice-mic-v1";

  function loadVoiceMicSettings() {
    try {
      const raw = window.localStorage.getItem(RME_VOICE_MIC_KEY);
      const p = raw ? JSON.parse(raw) : {};
      let gain = Number(p && p.gain);
      if (!isFinite(gain) || gain < 1) gain = 1;
      if (gain > 10) gain = 10;
      return {
        deviceId: typeof (p && p.deviceId) === "string" ? p.deviceId : "",
        noiseSuppression: (p && p.noiseSuppression) === false ? false : true,
        gain,
      };
    } catch {
      return { deviceId: "", noiseSuppression: true, gain: 1 };
    }
  }

  function saveVoiceMicSettings(patch) {
    const next = Object.assign(loadVoiceMicSettings(), patch || {});
    try {
      window.localStorage.setItem(RME_VOICE_MIC_KEY, JSON.stringify(next));
    } catch {}
    try {
      window.dispatchEvent(new CustomEvent("rme-voice-mic-changed", { detail: next }));
    } catch {}
    return next;
  }

  function renderVoiceCard() {
    const cur = loadVoiceMicSettings();
    const { card, body } = settingsCard(
      "Voice & microphone",
      "Pick the mic the assistant listens to and boost a quiet input.",
    );

    const micSel = document.createElement("select");
    micSel.className = "rme-settings-select";
    micSel.id = "rmeSettingsMicDevice";
    const defOpt = document.createElement("option");
    defOpt.value = "";
    defOpt.textContent = "System default";
    micSel.appendChild(defOpt);
    micSel.addEventListener("change", () => {
      saveVoiceMicSettings({ deviceId: micSel.value });
    });
    body.appendChild(settingsRow("Microphone", micSel));

    function populateMics() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
      navigator.mediaDevices
        .enumerateDevices()
        .then((devices) => {
          const inputs = devices.filter((d) => d.kind === "audioinput");
          while (micSel.children.length > 1) micSel.removeChild(micSel.lastChild);
          let n = 0;
          for (const d of inputs) {
            n++;
            const opt = document.createElement("option");
            opt.value = d.deviceId;
            opt.textContent = d.label || ("Microphone " + n);
            if (d.deviceId === cur.deviceId) opt.selected = true;
            micSel.appendChild(opt);
          }
        })
        .catch(() => {});
    }
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then((s) => {
          s.getTracks().forEach((t) => t.stop());
          populateMics();
        })
        .catch(() => {
          populateMics();
        });
    } else {
      populateMics();
    }

    const nsSeg = document.createElement("div");
    nsSeg.className = "rme-settings-seg";
    for (const opt of [
      { v: true, label: "On" },
      { v: false, label: "Off" },
    ]) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = opt.label;
      if (cur.noiseSuppression === opt.v) b.classList.add("rme-settings-seg--on");
      b.addEventListener("click", (ev) => {
        ev.preventDefault();
        saveVoiceMicSettings({ noiseSuppression: opt.v });
        nsSeg.querySelectorAll("button").forEach((x) => {
          x.classList.toggle("rme-settings-seg--on", x === b);
        });
      });
      nsSeg.appendChild(b);
    }
    body.appendChild(settingsRow("Noise suppression", nsSeg));

    const gainWrap = document.createElement("div");
    gainWrap.className = "rme-settings-sound-row";
    const gain = document.createElement("input");
    gain.type = "range";
    gain.min = "1";
    gain.max = "10";
    gain.step = "1";
    gain.value = String(cur.gain);
    gain.className = "rme-settings-range";
    const gainVal = document.createElement("span");
    gainVal.className = "rme-settings-note";
    gainVal.textContent = "x" + cur.gain;
    gain.addEventListener("input", () => {
      gainVal.textContent = "x" + gain.value;
    });
    gain.addEventListener("change", () => {
      saveVoiceMicSettings({ gain: Number(gain.value) });
    });
    gainWrap.appendChild(gain);
    gainWrap.appendChild(gainVal);
    body.appendChild(settingsRow("Input boost", gainWrap));

    const note = document.createElement("p");
    note.className = "rme-settings-note";
    note.textContent =
      "Microphone and noise-suppression changes take effect next time you start a voice session. Input boost applies right away. If speech still is not detected, also raise the mic level in Windows Sound settings.";
    body.appendChild(note);
    return card;
  }

  async function render() {
    const root = document.getElementById("rmeSettingsRoot");
    const page = document.getElementById("pageSettings");
    if (!root || !page || page.hidden) return;

    await refreshPlannerSettingsFromStore();
    root.replaceChildren();

    const grid = document.createElement("div");
    grid.className = "rme-settings-grid-inner";
    grid.appendChild(renderAppearanceCard());
    grid.appendChild(renderPlannerCard());
    grid.appendChild(renderVoiceCard());
    if (!isTeacherPortal()) {
      grid.appendChild(renderWorkspaceCard());
    }
    grid.appendChild(renderSystemCard());
    root.appendChild(grid);
  }

  function boot() {
    const root = document.getElementById("rmeSettingsRoot");
    if (!root || root.dataset.rmeSettingsReady === "1") return;
    root.dataset.rmeSettingsReady = "1";

    window.addEventListener("rme-app-settings-page-open", () => {
      void render();
    });
    window.addEventListener("rme-app-theme-changed", () => {
      const seg = document.getElementById("rmeSettingsThemeSeg");
      if (seg instanceof HTMLElement) {
        syncThemeSegUi(seg);
      }
    });
    window.addEventListener("rme-cal-settings-changed", () => {
      const page = document.getElementById("pageSettings");
      if (page && !page.hidden) void render();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      void refreshPlannerSettingsFromStore();
      boot();
    }, { once: true });
  } else {
    void refreshPlannerSettingsFromStore();
    boot();
  }

  window.rmeSettingsPage = { render };
})();
