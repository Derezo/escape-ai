#!/usr/bin/env node
'use strict';

/**
 * Audio binding generator  (TINS 2026 — Escape AI)
 *
 * Reads asset-pipeline/manifest.json and emits client/src/audio.generated.ts —
 * the single-source-of-truth binding between the audio asset catalogue and the
 * TypeScript client. The generated file is deterministic (same manifest → same
 * output byte-for-byte) and committed to the repo so the client can build without
 * running this script.
 *
 * Never hand-edit client/src/audio.generated.ts — edit manifest.json and re-run.
 *
 * Usage:
 *   node scripts/audio/gen-bindings.js          # writes client/src/audio.generated.ts
 *   node scripts/audio/gen-bindings.js --help
 *
 * This script is also require()'d by scripts/audio/verify-audio.js so the
 * render(manifest) function can be called without re-reading the manifest.
 *
 * Mirrors the style of scripts/build-tileset.js.
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const MANIFEST_PATH = path.join(__dirname, '..', '..', 'asset-pipeline', 'manifest.json');
const OUT_PATH = path.join(__dirname, '..', '..', 'client', 'src', 'audio.generated.ts');

// ---------------------------------------------------------------------------
// Synth-only sounds: the 11 original WAVs minus the 3 the manifest regenerates
// (hit, error, confirm → those come from the manifest as .mp3).
// These keys exist ONLY as committed synth WAVs and are never in the manifest.
// ---------------------------------------------------------------------------
const SYNTH_ONLY_KEYS = [
  'blip',
  'select',
  'pickup',
  'jump',
  'whoosh',
  'thud',
  'sparkle2',
  'dazzle',
];

// ---------------------------------------------------------------------------
// render(manifest) — PURE: same input → same output.
// Exported for use by verify-audio.js without re-reading the manifest.
// ---------------------------------------------------------------------------
function render(manifest) {
  const sfxEntries = manifest.sfx;   // 18 manifest SFX entries
  const musicEntries = manifest.music; // 8 manifest music entries
  const voiceEntries = manifest.voice || []; // narration clips (intro cinematic)

  // Build SFX_FILES: manifest sfx (as .mp3) + synth-only (as .wav)
  // Manifest sfx come first (in manifest order), then synth-only.
  const sfxFilesLines = [];
  for (const e of sfxEntries) {
    // e.output is e.g. "assets/sfx/robot_alert.mp3"
    const url = './' + e.output.replace(/^assets\//, '');
    sfxFilesLines.push(`  ${e.key}: '${url}',`);
  }
  for (const key of SYNTH_ONLY_KEYS) {
    sfxFilesLines.push(`  ${key}: './sfx/${key}.wav',`);
  }

  // Build SFX_FALLBACK: for every manifest sfx that has a placeholder,
  // map key → './sfx/<placeholder>.wav' (pointing at the committed synth wav).
  // This always exists for every manifest sfx (placeholder is required).
  const sfxFallbackLines = [];
  for (const e of sfxEntries) {
    if (e.placeholder) {
      sfxFallbackLines.push(`  ${e.key}: './sfx/${e.placeholder}.wav',`);
    }
  }

  // Build SFX_VOLUME: manifest sfx get their defaultVolume; synth-only default 0.6.
  const sfxVolumeLines = [];
  for (const e of sfxEntries) {
    const vol = typeof e.defaultVolume === 'number' ? e.defaultVolume : 0.6;
    sfxVolumeLines.push(`  ${e.key}: ${vol},`);
  }
  for (const key of SYNTH_ONLY_KEYS) {
    sfxVolumeLines.push(`  ${key}: 0.6,`);
  }

  // Build MUSIC_FILES: 8 music entries → './music/<key>.mp3'
  const musicFilesLines = [];
  for (const e of musicEntries) {
    const url = './' + e.output.replace(/^assets\//, '');
    musicFilesLines.push(`  ${e.key}: '${url}',`);
  }

  // Build MUSIC_META: loop (bool) + volume (number)
  const musicMetaLines = [];
  for (const e of musicEntries) {
    const loop = e.loop === true ? 'true' : 'false';
    const vol = typeof e.defaultVolume === 'number' ? e.defaultVolume : 0.5;
    musicMetaLines.push(`  ${e.key}: { loop: ${loop}, volume: ${vol} },`);
  }

  // Build VOICE_FILES: each voice entry → './voice/<key>.mp3'
  const voiceFilesLines = [];
  for (const e of voiceEntries) {
    const url = './' + e.output.replace(/^assets\//, '');
    voiceFilesLines.push(`  ${e.key}: '${url}',`);
  }

  // Build VOICE_META: the narration text (== the on-screen subtitle), the baked clip
  // durationMs (null until generate-voice.py measures it), and the default volume.
  // JSON.stringify the text so embedded quotes/unicode/ellipsis are escaped safely.
  const voiceMetaLines = [];
  for (const e of voiceEntries) {
    const text = JSON.stringify(e.text || '');
    const dur = typeof e.durationMs === 'number' ? e.durationMs : 'null';
    const vol = typeof e.defaultVolume === 'number' ? e.defaultVolume : 0.9;
    voiceMetaLines.push(`  ${e.key}: { text: ${text}, durationMs: ${dur}, volume: ${vol} },`);
  }

  // Assemble the file text
  return [
    `// DO NOT EDIT — generated by scripts/audio/gen-bindings.js from asset-pipeline/manifest.json`,
    `// Run \`npm run audio:codegen\` (from scripts/) to regenerate.`,
    ``,
    `// ---------------------------------------------------------------------------`,
    `// SFX`,
    `// ---------------------------------------------------------------------------`,
    ``,
    `/**`,
    ` * All SFX keys → their asset URL.`,
    ` * Manifest SFX (18) use .mp3 paths; synth-only sounds (8) keep their .wav paths.`,
    ` * Synth-only keys: ${SYNTH_ONLY_KEYS.join(', ')}.`,
    ` */`,
    `export const SFX_FILES = {`,
    ...sfxFilesLines,
    `} as const;`,
    ``,
    `export type SfxName = keyof typeof SFX_FILES;`,
    ``,
    `/**`,
    ` * Fallback URLs: for each manifest SFX, the committed synth WAV to use until`,
    ` * the real .mp3 is generated. audio.ts uses this to auto-degrade gracefully.`,
    ` */`,
    `export const SFX_FALLBACK: Partial<Record<SfxName, string>> = {`,
    ...sfxFallbackLines,
    `};`,
    ``,
    `/**`,
    ` * Per-SFX default volume (0..1). Pass to playSfx() for consistent mix levels.`,
    ` */`,
    `export const SFX_VOLUME: Record<SfxName, number> = {`,
    ...sfxVolumeLines,
    `};`,
    ``,
    `// ---------------------------------------------------------------------------`,
    `// Music`,
    `// ---------------------------------------------------------------------------`,
    ``,
    `/**`,
    ` * All music keys → their asset URL (./music/<key>.mp3).`,
    ` */`,
    `export const MUSIC_FILES = {`,
    ...musicFilesLines,
    `} as const;`,
    ``,
    `export type MusicName = keyof typeof MUSIC_FILES;`,
    ``,
    `/**`,
    ` * Per-track playback metadata: loop flag and default volume.`,
    ` */`,
    `export const MUSIC_META: Record<MusicName, { loop: boolean; volume: number }> = {`,
    ...musicMetaLines,
    `};`,
    ``,
    `// ---------------------------------------------------------------------------`,
    `// Voice — cinematic intro narration (ElevenLabs)`,
    `// ---------------------------------------------------------------------------`,
    ``,
    `/**`,
    ` * All narration clip keys → their asset URL (./voice/<key>.mp3).`,
    ` */`,
    `export const VOICE_FILES = {`,
    ...voiceFilesLines,
    `} as const;`,
    ``,
    `export type VoiceName = keyof typeof VOICE_FILES;`,
    ``,
    `/**`,
    ` * Per-clip metadata. \`text\` is the narration (also the on-screen subtitle);`,
    ` * \`durationMs\` is the baked clip length the intro uses to pace each subtitle`,
    ` * (null until generate-voice.py measures it — the client then falls back to`,
    ` * fixed timing); \`volume\` is the playback gain 0..1.`,
    ` */`,
    `export const VOICE_META: Record<VoiceName, { text: string; durationMs: number | null; volume: number }> = {`,
    ...voiceMetaLines,
    `};`,
    ``,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log([
    'Audio binding generator (TINS 2026 — Escape AI)',
    '',
    'Usage: node scripts/audio/gen-bindings.js',
    '',
    'Reads:  asset-pipeline/manifest.json',
    'Writes: client/src/audio.generated.ts',
    '',
    'The generated file is deterministic: same manifest => same output byte-for-byte.',
    'Never hand-edit the generated file — edit manifest.json and re-run.',
    '',
    'Also used as a module by scripts/audio/verify-audio.js (exports render(manifest)).',
  ].join('\n'));
  process.exit(0);
}

// Only run the write when invoked directly (not when require()'d by the verifier).
if (require.main === module) {
  let manifest;
  try {
    manifest = require(MANIFEST_PATH);
  } catch (e) {
    console.error(`Cannot read manifest: ${e.message}`);
    process.exit(1);
  }

  const text = render(manifest);
  fs.writeFileSync(OUT_PATH, text, 'utf8');
  console.log(`Wrote: client/src/audio.generated.ts`);
  console.log(`  ${manifest.sfx.length} manifest SFX + ${SYNTH_ONLY_KEYS.length} synth-only = ${manifest.sfx.length + SYNTH_ONLY_KEYS.length} total SFX keys`);
  console.log(`  ${manifest.music.length} music tracks`);
  console.log(`  ${(manifest.voice || []).length} voice clips`);
  console.log(`Verify: node scripts/audio/verify-audio.js`);
}

module.exports = { render, SYNTH_ONLY_KEYS, MANIFEST_PATH, OUT_PATH };
