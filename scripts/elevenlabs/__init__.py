"""
ElevenLabs voice pipeline for Escape AI's cinematic intro narration.

Mirrors scripts/sunoapi/ (stdlib-only, user-run, the same manifest single-source-of-
truth + drift-gate conventions). Generates one TTS MP3 per `voice` manifest entry via
the ElevenLabs text-to-speech API, places it at assets/voice/<key>.mp3, and bakes the
measured clip duration back into the manifest so the client can pace each subtitle.

Reads ELEVENLABS_API_KEY from the system environment, never from a repo .env file.
"""
