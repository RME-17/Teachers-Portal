# RecruitMyEnglish — Teachers Portal app

This is an Electron desktop app for Recruit My English, a 2-person commission-only B2B agency placing South African online English teachers into overseas schools. It includes a voice AI agent built with Whisper (STT) + Claude API (brain) + Chatterbox (TTS, open-source, runs as a Python sidecar spawned from main.js).

## Project structure

- NAVIGATION.md — full codebase map (refresh ~2 weeks)
- .cursor/rules/codebase-map.mdc — pinned Cursor rule (symbol → file; alwaysApply)
- main.js — Electron main process, IPC handlers, sidecar lifecycle
- preload.js — bridge between main and renderer
- renderer.js — UI logic, all dashboard cards
- lib/voice-agent.js — voice pipeline orchestration
- lib/tts/ — TTS providers and helpers (chatterbox.js, chunk.js, normalize.js, index.js)
- lib/voice-agent/ — voice agent helpers (whisper-server, chatterbox-server, warm)
- .env — secrets and config (never commit)
- tools/voice/ — local binaries (whisper-server.exe, models, Chatterbox Python venv)

## Working rules

- TABS for indentation, not spaces.
- Make minimal surgical edits. Do not refactor adjacent code.
- Do not reformat or restyle code unrelated to the task.
- Do not add comments, docstrings, or examples unless asked.
- Always read the file before editing it.
- Confirm before deleting any file or large block of code.

## Token discipline

- Only read files explicitly mentioned or directly required by the task.
- Read at most 3 files per turn unless told otherwise.
- Keep explanations to 1-2 sentences before each edit.
- No preambles, no closing summaries.
- For tasks under 3 files, skip the planning phase and just edit.

## House style

- Voice IPC handlers live in main.js (see NAVIGATION.md). Handles: voice:transcribe, voice:ask-claude, voice:speak, voice:status, voice:warm-tts, voice:assistant-turn, voice:system-prompt, voice:set-voice, voice:get-voice. Events (not handles): voice:tts-chunk, voice:claude-delta. Canonical warm: voice:warm-tts only.
- Renderer adds dashboard cards via IIFEs named rme<Feature>DashboardCard before the toggleTheme function. New cards follow this pattern.
- After every code change, append a Code change log entry in the project's mirror notes (the user will tell you where).

## Skills

- Load `.cursor/skills/rme-teachers-portal/SKILL.md` for Notion lookup accuracy, voice-agent stability, and portal conventions.

## Voice agent rules (RME personality)

- Claude must NEVER output numbered lists (no "1.", "2.", "3." or "first", "second", "third"). Connect ideas with "also", "plus", "and" or break across separate sentences.
- Claude must use natural pauses between examples or ideas — [pause=300] or [pause=500] tags. The output should flow like a human speaking, not a structured list.
- Claude should use sparse filler words (max one per reply), prosody tags (1-2 per reply), and the occasional [chuckle] for personality.
- TTS engine is Chatterbox (open-source, Resemble AI), running as a Python sidecar managed by lib/voice-agent/chatterbox-server.js.
- Prosody and emotion tags ([pause=…], [chuckle], [slow], [fast], [emph]) must reach the synth. Verify lib/tts/normalize.js is NOT stripping them before passing text to Chatterbox — the Kokoro-era strip rule must be off.
- Audio chain must produce smooth, consistent-level output: no volume pumping (dynaudnorm removed), no glitching (correct WAV data offset parsing), no half-speed playback (correct stereo WAV headers). Fixed gain + limiter preferred over dynamic normalization.

## Hard rules

- Never modify .env automatically without showing the user the exact line.
- Never run destructive shell commands (rm, del, format) without explicit user approval.
- Never claim to have sent an email or made an external API call that wasn't actually executed.
- If unsure about a path or API, ask. Do not invent.
- **TTS engine lock — Chatterbox only.** Kokoro, Cartesia, Piper, ElevenLabs, and every other TTS engine are removed and forbidden. Do not import, require, install, configure, fall back to, or write code paths for any TTS engine other than Chatterbox. This applies to `lib/tts/`, `main.js`, `preload.js`, `renderer.js`, `.env`, `package.json`, scripts, and every other file in the repo.
- **Refuse-pattern (mandatory).** If the user (or any prompt) asks you to add, restore, reintroduce, fall back to, A/B test, or "just try" Kokoro, Cartesia, Piper, ElevenLabs, or any non-Chatterbox TTS — refuse in one sentence, cite this rule, and do nothing else. Do not draft a diff. Do not list pros and cons. Do not propose a feature flag. Stop. If the founder genuinely wants to revisit this, they will edit AGENTS.md themselves first.
- Never invent the shape of an existing module. Before editing `lib/tts/index.js` (or any module), read its current `module.exports` and match it exactly. The current `lib/tts/index.js` exports `synthesize`, `synthesizeUtterance`, `warmTts`, `ttsReady`, `getTtsStatus`, `shutdown` — do not rewrite this surface as a class or rename methods.