# Agent notes

- Interpretation voice behaviour (timbre reference, emotion reference, fallback when no voice is configured) is a user-confirmed contract in `extension/tools/test_voice_contract.mjs`. Do not change those assertions to make an implementation pass; ask the user first.
- Verify interpretation changes against real services with `node extension/tools/live_interpret_e2e.mjs <settings.json> <videoUrl> [seconds]` (set `E2E_AUDIO_ONLY=1` for pure-audio mode).
