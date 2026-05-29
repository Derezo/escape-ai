#!/usr/bin/env node
/**
 * Placeholder SFX Generator  (TINS 2026 starter kit)
 *
 * Synthesises a handful of short WAV blips/beeps using PURE Node — we write the
 * 44-byte canonical WAV header and PCM sine samples by hand. ZERO dependencies,
 * no ffmpeg, no API key. Runs on a clean clone:
 *   node scripts/gen-placeholder-sfx.js
 *
 * This GUARANTEES a SOUND/MUSIC Rule-O-Matic rule ("sound on every action",
 * etc.) can be satisfied immediately — wire these into entity/UI events in the
 * client. Hook points are listed in docs/PLAYBOOK.md (SOUND row).
 *
 * Modia's real pipeline (scripts/audio/generate-sfx.js + generate-music.js) uses
 * the ElevenLabs and Suno APIs and ffmpeg for waveforms — heavy + needs keys, so
 * it is intentionally NOT ported. If a rule rewards rich audio, install those at
 * hour 0; until then these synthesised blips cover the requirement for free.
 *
 * Output: WAV, 16-bit PCM, mono, 44.1 kHz.
 *
 * Usage:
 *   node scripts/gen-placeholder-sfx.js          # generate all
 *   node scripts/gen-placeholder-sfx.js --force  # overwrite existing
 *   node scripts/gen-placeholder-sfx.js --help
 */

'use strict';

const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = path.join(__dirname, '..', 'assets', 'sfx');
const SAMPLE_RATE = 44100;
const BITS_PER_SAMPLE = 16;
const CHANNELS = 1;
const AMPLITUDE = 0.35; // headroom; avoids clipping when several play at once

// --- args -------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    help: args.includes('--help') || args.includes('-h'),
    force: args.includes('--force'),
  };
}

function showHelp() {
  console.log(`
Placeholder SFX Generator (hand-written WAV, zero deps)

Usage:
  node scripts/gen-placeholder-sfx.js [options]

Options:
  --force      Overwrite SFX that already exist
  --help, -h   Show this help

Output: assets/sfx/*.wav  (16-bit PCM mono ${SAMPLE_RATE / 1000}kHz)
`);
}

// --- sfx catalogue ----------------------------------------------------------
// Game-agnostic event sounds. `wave` shapes the timbre; `freq` the pitch (Hz);
// `ms` the duration; `sweep` optionally glides to an end frequency.
// Rename/retune at hour 0 to match the genre and the "action" set.

const SFX = [
  { name: 'blip', wave: 'square', freq: 880, ms: 90 },
  { name: 'select', wave: 'square', freq: 660, ms: 70 },
  { name: 'confirm', wave: 'triangle', freq: 523, ms: 140, sweep: 784 }, // C5 -> G5 rise
  { name: 'pickup', wave: 'sine', freq: 988, ms: 120, sweep: 1319 }, // sparkle up
  { name: 'hit', wave: 'square', freq: 200, ms: 110, sweep: 90 }, // thud down
  { name: 'error', wave: 'sawtooth', freq: 160, ms: 220 }, // harsh buzz
  { name: 'jump', wave: 'sine', freq: 392, ms: 160, sweep: 880 }, // boing up
  // Ability FX sounds (Phase E). Map: flit/leap/burrow → whoosh, dash → whoosh,
  // shove → thud, cloak/hush → sparkle2 (calm), peacock dazzle → dazzle (bright).
  { name: 'whoosh', wave: 'sine', freq: 300, ms: 200, sweep: 1200 }, // airy rising whoosh
  { name: 'thud', wave: 'square', freq: 140, ms: 160, sweep: 60 }, // heavy impact down
  { name: 'sparkle2', wave: 'triangle', freq: 1175, ms: 220, sweep: 1568 }, // soft chime up
  { name: 'dazzle', wave: 'sine', freq: 660, ms: 260, sweep: 1760 }, // bright flourish up
];

// --- oscillators ------------------------------------------------------------

function oscillator(wave, phase) {
  // `phase` is in turns [0,1).
  switch (wave) {
    case 'sine':
      return Math.sin(2 * Math.PI * phase);
    case 'square':
      return phase < 0.5 ? 1 : -1;
    case 'triangle':
      return 4 * Math.abs(phase - 0.5) - 1;
    case 'sawtooth':
      return 2 * phase - 1;
    default:
      return Math.sin(2 * Math.PI * phase);
  }
}

// Short attack + exponential decay envelope so blips don't click.
function envelope(t, duration) {
  const attack = Math.min(0.005, duration * 0.1);
  if (t < attack) return t / attack;
  const decay = (t - attack) / (duration - attack);
  return Math.exp(-4 * decay);
}

function renderSamples({ wave, freq, ms, sweep }) {
  const duration = ms / 1000;
  const total = Math.floor(SAMPLE_RATE * duration);
  const samples = new Int16Array(total);
  let phase = 0;
  for (let i = 0; i < total; i++) {
    const t = i / SAMPLE_RATE;
    const f = sweep ? freq + (sweep - freq) * (t / duration) : freq;
    phase += f / SAMPLE_RATE;
    if (phase >= 1) phase -= 1;
    const v = oscillator(wave, phase) * envelope(t, duration) * AMPLITUDE;
    samples[i] = Math.max(-1, Math.min(1, v)) * 0x7fff;
  }
  return samples;
}

// --- WAV container (canonical 44-byte PCM header) ---------------------------

function encodeWav(samples) {
  const byteRate = (SAMPLE_RATE * CHANNELS * BITS_PER_SAMPLE) / 8;
  const blockAlign = (CHANNELS * BITS_PER_SAMPLE) / 8;
  const dataSize = samples.length * blockAlign;
  const buf = Buffer.alloc(44 + dataSize);

  // RIFF chunk descriptor
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4); // ChunkSize
  buf.write('WAVE', 8, 'ascii');

  // "fmt " sub-chunk
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // Subchunk1Size (PCM)
  buf.writeUInt16LE(1, 20); // AudioFormat = PCM
  buf.writeUInt16LE(CHANNELS, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(BITS_PER_SAMPLE, 34);

  // "data" sub-chunk
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(samples[i], 44 + i * 2);
  }
  return buf;
}

// --- main -------------------------------------------------------------------

function main() {
  const opts = parseArgs();
  if (opts.help) {
    showHelp();
    return;
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  let written = 0;
  let skipped = 0;
  for (const sfx of SFX) {
    const file = path.join(OUTPUT_DIR, `${sfx.name}.wav`);
    if (fs.existsSync(file) && !opts.force) {
      console.log(`  skip   ${sfx.name}.wav (exists; --force to overwrite)`);
      skipped++;
      continue;
    }
    const wav = encodeWav(renderSamples(sfx));
    fs.writeFileSync(file, wav);
    const sweep = sfx.sweep ? `->${sfx.sweep}Hz` : '';
    console.log(`  write  ${sfx.name}.wav  [${sfx.wave} ${sfx.freq}Hz${sweep} ${sfx.ms}ms ${wav.length}b]`);
    written++;
  }

  console.log(`\nDone. ${written} written, ${skipped} skipped -> ${path.relative(process.cwd(), OUTPUT_DIR)}/`);
}

main();
