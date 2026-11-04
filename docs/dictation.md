# Dictation

The composers (a thread's message box and New thread) have a microphone beside send, as in
ChatGPT. Pressing it turns the box into one row: ✕ throws the recording away, a waveform
scrolls as the person speaks, stop puts the words in the box to read and edit, and send puts
them in and sends at once. While the words are on their way, the row says "Transcribing".
The web code is `apps/web/components/dictation.tsx`, the API's `apps/api/src/dictation.ts`.

## How it works

- The browser records with `MediaRecorder` (WebM/Opus in Chrome and Firefox, MP4/AAC in
  Safari) and posts the recording to `POST /api/dictation` (multipart `audio`).
- The API sends it to Groq's `whisper-large-v3-turbo` (OpenAI-compatible
  `/openai/v1/audio/transcriptions`, language detected) and answers `{ text }`. Nothing is
  stored, in the database or the bucket.
- A recording stops by itself after 10 minutes, and the API takes 20 MB at most
  (`DICTATION_MAX_*` in `@brigade/contracts`). A recording in which the microphone never
  rose above silence is not sent ("Nothing was heard"), which spares Whisper's habit of
  inventing words for silence.
- Groq's errors are not shown as they are: a rate limit is "Dictation is busy", an
  unreadable file "This recording could not be transcribed", the rest "Transcription failed".

## Who has it

- Without `GROQ_API_KEY` on the API, there is no microphone (`GET /api/dictation` answers
  `{ available: false, reason: 'off' }`).
- With it, while billing is on (docs/billing.md), it comes with Brigade Cloud: a workspace
  without the plan sees the microphone greyed, "Dictation comes with Brigade Cloud", which
  opens Settings › Billing, and `POST /api/dictation` answers 402. With billing off
  (self-hosted), everyone has it.

## Brigade.app

The Mac app loads the dashboard, so it has dictation once its bundle names the microphone:
`NSMicrophoneUsageDescription` in `apps/desktop/src-tauri/Info.plist` (Tauri merges it) and
`com.apple.security.device.audio-input` in its entitlements (hardened runtime). Versions
released before that cannot use the microphone; the composer says so.

## Production

`GROQ_API_KEY` is a secret on the `brigade-api` Worker (`wrangler secret put GROQ_API_KEY`).
Whisper Large v3 Turbo costs $0.04 an hour of audio, billed for at least 10 seconds a request.
