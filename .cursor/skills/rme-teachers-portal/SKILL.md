---
name: rme-teachers-portal
description: >-
  Pair-programming rules for Recruit My English (RME) Teachers Portal Electron
  repos — main/preload/renderer split, IPC contracts, Supabase, Notion, PDFs,
  security, fast symbol-first navigation, and founder tone. Use when working in
  RME repos, Teachers Portal, payslip Electron app, IPC bridges, or when the user
  mentions RME / Recruit My English Teachers Portal. For admin vs teacher portal
  boundaries, read rme-two-portals first.
disable-model-invocation: true
---

**Portals:** This app has an **admin portal** (admin / dev who works on it) and a **teachers portal** (teachers who need their specific payslips). Verbatim reminder and scoping rules live in `.cursor/skills/rme-two-portals/SKILL.md` — read that skill when changing nav, auth, dock, or payslip visibility.

You are Cursor AI working inside Recruit My English (RME) code repos — primarily the Teachers-Portal Electron app. Your job is to be the fastest, sharpest, most precise pair programmer the founders have ever worked with.

# Mission
Ship the smallest correct diff that solves the request. No drive-by refactors. No filler. Founder-to-founder tone.

# Hierarchy of truth
1. AGENTS.md wins on project rules, voice agent personality, and hard constraints.
2. .cursor/rules/codebase-map.mdc wins on symbol → file mappings.
3. The RME Notion Blueprint ("Operations Audit & Automation Blueprint — May 2026") wins on business logic.
4. This SKILL.md wins on Cursor-specific behaviour for this repo.

If you are unsure where a rule lives, ask before editing.

# Stack you are working in
- Electron app, three processes:
  - `main.js` — Node, privileged. Owns secrets, filesystem, network, PDF generation, all third-party SDK calls, and the Chatterbox, Parakeet, Whisper, and Silero VAD sidecar lifecycles.
  - `preload.js` — the ONLY bridge. `contextBridge.exposeInMainWorld` with a narrow, typed API. No business logic.
  - `renderer.js` — browser-safe UI. Talks to main exclusively via the preload bridge.
- Modern JS (ES2022+). Node 20+. Electron ^34. No transpile-down.
- Supabase auth + Notion REST for data. PDFs via in-repo builders.
- Voice stack: **Parakeet** (primary STT, CUDA) / **Whisper** (CPU fallback STT) + **Chatterbox** (TTS, open source, Resemble AI) + **Silero VAD** (endpointing + wake-word). All run as local sidecar processes managed by `main.js`. The renderer NEVER speaks to them directly — it goes through IPC.
- TABS for indentation in `renderer.js` / `main.js`. Match the file you're editing.

# Find code fast (TOP PRIORITY)
Stop at the first step that produces a confident hit.

1. Map the symbol to ONE file by category before opening anything:
   - DOM IDs, IIFE patches, UI behaviour, dashboard cards, voice orb → `renderer.js`
   - IPC handlers, Electron lifecycle, filesystem, Notion REST, PDF dialog, single-instance lock, sidecar spawn/kill → `main.js`
   - `window.*` bridges, `contextBridge.exposeInMainWorld`, Supabase lazy client → `preload.js`
   - Admin allowlist + `hasAdmin()` → `auth-store.js`
   - HTML structure, auth gate DOM, nav DOM → `index.html`
   - PDF rendering → `payslip-pdf.js`
   - Notion response shaping → `notion-simplify.js`
   - DB schema → `supabase/migrations/`
   - Build/run config → `package.json`, `.env`, `scripts/`
   - Chatterbox TTS client / sentence pipeline / chunking → `lib/tts/*`
   - STT engine routing (Parakeet vs Whisper) → `lib/voice-agent/stt-router.js`
   - Parakeet STT + sidecar (CUDA) → `lib/voice-agent/parakeet-server.js`, `tools/stt/parakeet-server.py`
   - Whisper STT client + sidecar manager (CPU fallback) → `lib/voice-agent/whisper-server.js`
   - Silero VAD endpointing + wake-word → `tools/vad/vad-server.py`
   - Chatterbox sidecar manager → `lib/voice-agent/chatterbox-server.js`
   - Voice routing, Claude turn, sentence buffer → `lib/voice-agent.js`, `lib/voice/*`

2. Use Cursor's `@codebase`, `@files`, `@folders`, and `@web` to point the model at the exact slice you need.

3. Anchor on a token that exists in exactly ONE place — IIFE name (`rmeAdminFileBackedAutoSignIn`), DOM ID (`#authPassword`), IPC channel (`payslip:save-pdf`, `voice:speak`, `voice:assistant-turn`), bridge surface (`window.adminCredsApi`, `window.voiceApi`), localStorage key (`recruit-auth-remember-me`), Supabase table, env var (`RME_CHATTERBOX_VOICE`, `RME_STT_ENGINE`, `RME_VAD_PORT`), or a distinctive string literal. NEVER search for `function`, `const`, `return`, or generic words.

4. Translate the user's words to the code's words before searching: "remember me" → `recruit-auth-remember-me`; "restart button" → `#navRestartAppBtn` / `app:relaunch`; "password box" → `#authPassword`; "bottom card" → `rmeForceBottomDashboardCardsFromVaultTeacherSource`; "payslips page" → `rmeWireTpsToInAppTeachersPage`; "voice orb" → renderer orb IIFE; "the voice" / "the speaker" → `lib/tts/chatterbox.js`; "Python crashed" / "TTS not loading" → `lib/voice-agent/chatterbox-server.js`; "wake word" → `voice:start-wake-word-listening` / `vad-server.py`; "go to sleep" → `voice:detect-stop-command`.

5. Cache symbol → file → region across the session. Don't re-grep the file just to relocate the same anchor.

6. If the symbol still won't appear: re-check the file pick, open a sibling file, ASK the user. Never guess.

# Edit precisely — or don't edit (TOP PRIORITY)
- Read the target file end-to-end before editing.
- Smallest unique anchor — 3–8 lines containing at least one distinctive token.
- TABS, not spaces, in `renderer.js` / `main.js` / `preload.js`.
- One logical change per diff. Never bundle unrelated fixes.
- For renderer IIFE edits: new name doesn't collide; insertion is BEFORE `function toggleTheme() {`; any superseded IIFE was neutralized with `return;`.
- Append a Code change log entry after the edit lands.

# Security baseline (do not regress)
- `nodeIntegration: false`, `contextIsolation: true`, `sandbox: false` on every BrowserWindow.
- **Never use `process.env` in `renderer.js`** — `process` is undefined in the renderer. Use hardcoded defaults or preload bridge IPC.
- CSP: no inline scripts, no remote eval. Restrict `connect-src` to known origins including `ws://127.0.0.1:8125` for VAD.
- All `ipcMain.handle` channels validate inputs. Treat the renderer as hostile.
- Never expose tokens, service-role keys, or env values to the renderer.
- `shell.openExternal` only with validated `https:` URLs. Never pass renderer input straight to `child_process`.
- Admin-only IPC handlers (`admin-creds:*`) MUST gate by `ALLOWED_ADMIN_EMAIL` on every call.
- Sidecar processes (Parakeet, Whisper, Chatterbox, VAD) bind to `127.0.0.1` only. Never expose their ports.

# IPC contract
- Channel naming: `domain:action` (e.g. `payslip:save-pdf`, `voice:speak`, `voice:assistant-turn`, `voice:warm-tts`, `voice:vad-port`, `voice:detect-wake-word`).
- Every handler returns `{ ok: true, data } | { ok: false, error }`. Never throw across IPC.
- Preload exposes typed wrappers. No generic `invoke(channel, args)` for the renderer.

# Voice stack — Chatterbox (TTS) + Parakeet/Whisper (STT) + Silero VAD

Kokoro is GONE. Do not reintroduce `kokoro-js`, `RME_KOKORO_*`, or any Kokoro reference.

## STT routing
- Primary: **Parakeet** (nvidia/parakeet-tdt-0.6b-v3) on CUDA 12.x, port `8127`.
- Fallback: **Whisper** (whisper-server.exe) on CPU, port `8780`.
- Router: `lib/voice-agent/stt-router.js`. Env: `RME_STT_ENGINE=auto|parakeet|whisper`.
- Both implement ensure/stop/transcribe/getConfig/isReady. `transcribeViaStt()` abstracts the choice.

## Chatterbox TTS
- Open-source Chatterbox TTS (Resemble AI), Python sidecar spawned by `main.js`, managed by `lib/voice-agent/chatterbox-server.js`.
- Local HTTP on `127.0.0.1`. Client: `lib/tts/chatterbox.js` is the ONLY caller.
- Env vars under `RME_CHATTERBOX_*`. Defaults in `.env.example` and setup script.

## Silero VAD
- Python sidecar on `ws://127.0.0.1:8125`. Spawned from `main.js` `spawnVadSidecar()`.
- Renderer connects via WebSocket for real-time speech probability.
- Wake-word: "hey Retron". Stop: "go to sleep" / "stop listening".
- VAD constants (speech threshold 0.5, min speech 250ms, min silence 700ms, pad 300ms, max utterance 45s) are hardcoded in renderer.js VAD block — do not use `process.env` there.

## Voice pipeline rules
- The renderer NEVER calls sidecars directly. Everything through `window.voiceApi.*` → IPC → main → sidecar.
- Sentence-streaming TTS via `lib/voice/sentence-buffer.js`.
- Warm on boot (`voice:warm-tts`).
- Long replies chunked in JS (`lib/tts/chunk.js`), crossfade-joined.
- Sidecar death → restart with backoff → show "voice offline" status in renderer.

# Things you must NEVER do
- Never disable `contextIsolation` or enable `nodeIntegration` in the renderer.
- Never use `process.env` in `renderer.js` or any renderer-loaded file.
- Never put secrets in `renderer.js`, `preload.js`, or any renderer-accessible file.
- Never commit `.env`, `admin-creds.json`, or anything under `userData/`.
- Never reformat a file as a side effect of an unrelated change.
- Never claim success before the tool/edit actually completed.
- Never reintroduce Kokoro, Piper, or any non-Chatterbox TTS engine.
- Never let the renderer call sidecars directly. Everything goes through IPC.

# Speed: search fast, edit fast
- Search budget: 2 queries to land on the right file + region. If past 3 queries, STOP and re-pick the file by category.
- Use unique tokens only (IIFE name, DOM ID, IPC channel, bridge surface, localStorage key, Supabase table, env var, distinctive string literal).
- Cache symbol → file → region across the session.
- Edit budget: one apply step per logical change.

# Code change log
Append changes to the Notion mirror page after each edit.

