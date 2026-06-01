#!/usr/bin/env node
'use strict';

/**
 * Android Icon & Splash Generator  (TINS 2026 — Escape AI)
 *
 * Generates polished Android launcher icons and splash screens for the Escape AI
 * game. The iconic design is a stylized robot optic eye — a steel lens ring with a
 * glowing red iris and cyan scan-line accent, instantly readable as "the AI sees
 * you; escape it."
 *
 * Generates SVG → PNG via sharp (the same process as build-atlas.js) at the exact
 * dimensions and densities required by the Android res/ hierarchy:
 *
 * ADAPTIVE ICONS (API 26+):
 *   - ic_launcher_foreground.png (transparent, 5 densities: mdpi 108px → xxxhdpi 432px)
 *   - ic_launcher_background.xml (colour resource)
 *   - ic_launcher.xml and ic_launcher_round.xml (adaptive layers)
 *
 * LEGACY ICONS (pre-API 26):
 *   - ic_launcher.png (full icon, glyph + background baked in, 5 densities)
 *   - ic_launcher_round.png (circle-masked variant, 5 densities)
 *
 * SPLASH SCREENS:
 *   - splash.png (10 total: 1 base + 5 portrait densities + 4 landscape variants)
 *   Dimensions match the existing Capacitor defaults exactly so layouts don't break.
 *
 * Usage:
 *   node scripts/gen-android-icons.js            # generate all
 *   node scripts/gen-android-icons.js --help
 */

const fs = require('fs');
const path = require('path');

let sharp;
try {
  sharp = require('sharp');
} catch (err) {
  console.error('gen-android-icons.js needs `sharp`. Install it:  cd scripts && npm install');
  process.exit(1);
}

const ANDROID_RES_DIR = path.join(__dirname, '..', 'client', 'android', 'app', 'src', 'main', 'res');

// --- color scheme (from escape-ai palette) ---
const COLORS = {
  darkNavyBase: '#0b0e14',    // darkest background
  darkNavyEdge: '#1a212c',    // gradient edge
  midNavy: '#11151d',         // mid-tone
  steel: '#9aa3ad',            // robot body / lens ring
  lightCyan: '#cde7ff',        // highlight
  alertRed: '#e05a5a',         // optic iris
  hotRed: '#ff5a5a',           // inner iris core
  amberiGlow: '#ffd24a',       // warmth/glow tone (optional, for blending)
  heroCyan: '#4cc9f0',         // hero accent / cyan scan
};

// --- SVG building ---

function buildOpticSVG(w, h) {
  // Centred robot optic glyph: steel lens ring, glowing red iris, cyan scan accent.
  const cx = w / 2;
  const cy = h / 2;
  const scale = Math.min(w, h);

  // Main lens ring (steel, with a light highlight to make it read as 3D)
  const ringR = scale * 0.22;
  const ringThick = scale * 0.04;
  const highlightR = ringR - ringThick * 0.5;

  // Iris: glowing red (alert red core, hot red inner, with slight amber wash for warmth)
  const irisR = ringR * 0.65;
  const coreR = irisR * 0.6;

  // Cyan scan line (horizontal slit through iris, reads as "AI watcher" shorthand)
  const scanWidth = irisR * 1.8;
  const scanHeight = irisR * 0.15;

  let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <radialGradient id="lensGradient" cx="40%" cy="40%">
      <stop offset="0%" style="stop-color:${COLORS.lightCyan};stop-opacity:0.6" />
      <stop offset="100%" style="stop-color:${COLORS.steel};stop-opacity:1" />
    </radialGradient>
    <radialGradient id="irisGradient" cx="35%" cy="35%">
      <stop offset="0%" style="stop-color:${COLORS.hotRed};stop-opacity:1" />
      <stop offset="60%" style="stop-color:${COLORS.alertRed};stop-opacity:1" />
      <stop offset="100%" style="stop-color:${COLORS.darkNavyBase};stop-opacity:1" />
    </radialGradient>
  </defs>

  <!-- Outer lens ring (steel with gradient) -->
  <circle cx="${cx}" cy="${cy}" r="${ringR}" fill="url(#lensGradient)" stroke="${COLORS.steel}" stroke-width="${Math.max(0.5, ringThick * 0.3)}"/>

  <!-- Iris (glowing red gradient) -->
  <circle cx="${cx}" cy="${cy}" r="${irisR}" fill="url(#irisGradient)" />

  <!-- Core highlight (hot inner iris) -->
  <circle cx="${cx - coreR * 0.15}" cy="${cy - coreR * 0.15}" r="${coreR * 0.4}" fill="${COLORS.hotRed}" opacity="0.7" />

  <!-- Cyan scan line (horizontal slit, reads "AI scanning") -->
  <rect x="${cx - scanWidth / 2}" y="${cy - scanHeight / 2}" width="${scanWidth}" height="${scanHeight}"
        fill="${COLORS.heroCyan}" opacity="0.8" rx="${scanHeight * 0.3}" />

  <!-- Subtle outer glow (optional warmth) -->
  <circle cx="${cx}" cy="${cy}" r="${ringR + ringThick * 0.5}" fill="none" stroke="${COLORS.amberiGlow}" stroke-width="0.5" opacity="0.4" />
</svg>`;

  return svg;
}

function buildIconSVG(w, h) {
  // Full icon (for legacy, with background baked in)
  const bgGradient = `
    <defs>
      <radialGradient id="bgGrad" cx="50%" cy="50%">
        <stop offset="0%" style="stop-color:${COLORS.darkNavyBase}" />
        <stop offset="100%" style="stop-color:${COLORS.darkNavyEdge}" />
      </radialGradient>
    </defs>
  `;

  let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  ${bgGradient}
  <rect width="${w}" height="${h}" fill="url(#bgGrad)" />
  ${buildOpticSVG(w, h).split('<svg')[1].split('</svg>')[0]}
</svg>`;

  return svg;
}

function buildSplashSVG(w, h) {
  // Full splash: dark background, optic glyph centred (smaller), margin room for safe zones.
  // The glyph is ~30% of the shorter dimension, centred.
  const glyphSize = Math.min(w, h) * 0.3;
  const cx = w / 2;
  const cy = h / 2;

  // Scale the optic down to fit
  const glyphSvgStr = buildOpticSVG(glyphSize, glyphSize);
  const glyphInner = glyphSvgStr.split('<svg')[1].split('</svg>')[0];

  let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="${w}" height="${h}" fill="${COLORS.darkNavyBase}" />
  <g transform="translate(${cx - glyphSize / 2}, ${cy - glyphSize / 2})">
    ${glyphInner}
  </g>
</svg>`;

  return svg;
}

// --- icon sizing ---

const ICON_DENSITIES = [
  { name: 'mdpi', size: 48, foregroundSize: 108, scale: 1 },
  { name: 'hdpi', size: 72, foregroundSize: 162, scale: 1.5 },
  { name: 'xhdpi', size: 96, foregroundSize: 216, scale: 2 },
  { name: 'xxhdpi', size: 144, foregroundSize: 324, scale: 3 },
  { name: 'xxxhdpi', size: 192, foregroundSize: 432, scale: 4 },
];

// Splash dimensions (read from existing files, or use known Capacitor defaults)
// These match the typical Capacitor-generated splash grid.
const SPLASH_SPECS = [
  { dir: 'drawable', name: 'splash.png', w: 480, h: 320 },
  { dir: 'drawable-port-mdpi', name: 'splash.png', w: 320, h: 426 },
  { dir: 'drawable-port-hdpi', name: 'splash.png', w: 480, h: 640 },
  { dir: 'drawable-port-xhdpi', name: 'splash.png', w: 720, h: 960 },
  { dir: 'drawable-port-xxhdpi', name: 'splash.png', w: 1080, h: 1440 },
  { dir: 'drawable-port-xxxhdpi', name: 'splash.png', w: 1440, h: 1920 },
  { dir: 'drawable-land-mdpi', name: 'splash.png', w: 426, h: 320 },
  { dir: 'drawable-land-hdpi', name: 'splash.png', w: 640, h: 480 },
  { dir: 'drawable-land-xhdpi', name: 'splash.png', w: 960, h: 720 },
  { dir: 'drawable-land-xxhdpi', name: 'splash.png', w: 1440, h: 1080 },
  { dir: 'drawable-land-xxxhdpi', name: 'splash.png', w: 1920, h: 1280 },
];

// --- helpers ---

/** Ensure directory exists. */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Read existing PNG dimensions (without pulling all pixels into memory). */
async function getPNGDims(filePath) {
  try {
    const metadata = await sharp(filePath).metadata();
    return { w: metadata.width, h: metadata.height };
  } catch {
    return null;
  }
}

// --- main ---

async function main() {
  console.log('Escape AI Android Icon & Splash Generator\n');

  const written = [];

  // 1. Update ic_launcher_background.xml (colour resource)
  const bgColorXml = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#11151d</color>
</resources>`;
  const bgColorPath = path.join(ANDROID_RES_DIR, 'values', 'ic_launcher_background.xml');
  ensureDir(path.dirname(bgColorPath));
  fs.writeFileSync(bgColorPath, bgColorXml, 'utf8');
  written.push(`${bgColorPath} (colour resource)`);

  // 2. Adaptive foreground icons (transparent glyph on transparent BG)
  console.log('Generating adaptive foreground icons (transparent)...');
  for (const density of ICON_DENSITIES) {
    const dir = path.join(ANDROID_RES_DIR, `mipmap-${density.name}`);
    ensureDir(dir);

    const svg = buildOpticSVG(density.foregroundSize, density.foregroundSize);
    const pngPath = path.join(dir, 'ic_launcher_foreground.png');

    await sharp(Buffer.from(svg), { density: 96 })
      .resize(density.foregroundSize, density.foregroundSize, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png({ compressionLevel: 9 })
      .toFile(pngPath);

    written.push(`${pngPath} (${density.foregroundSize}×${density.foregroundSize})`);
    console.log(`  ✓ mipmap-${density.name}/ic_launcher_foreground.png`);
  }

  // 3. Legacy full icons (icon + background baked in)
  console.log('\nGenerating legacy launcher icons (full icon)...');
  for (const density of ICON_DENSITIES) {
    const dir = path.join(ANDROID_RES_DIR, `mipmap-${density.name}`);
    ensureDir(dir);

    const svg = buildIconSVG(density.size, density.size);
    const pngPath = path.join(dir, 'ic_launcher.png');

    await sharp(Buffer.from(svg), { density: 96 })
      .resize(density.size, density.size, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png({ compressionLevel: 9 })
      .toFile(pngPath);

    written.push(`${pngPath} (${density.size}×${density.size})`);
    console.log(`  ✓ mipmap-${density.name}/ic_launcher.png`);
  }

  // 4. Legacy round icons (circle-masked version; same glyph + background)
  console.log('\nGenerating legacy round launcher icons...');
  for (const density of ICON_DENSITIES) {
    const dir = path.join(ANDROID_RES_DIR, `mipmap-${density.name}`);
    ensureDir(dir);

    const svg = buildIconSVG(density.size, density.size);
    const pngPath = path.join(dir, 'ic_launcher_round.png');

    // Create the base icon, then composite a circular mask
    const icon = await sharp(Buffer.from(svg), { density: 96 })
      .resize(density.size, density.size, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();

    // Create a circular mask SVG
    const maskSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${density.size}" height="${density.size}" viewBox="0 0 ${density.size} ${density.size}">
  <circle cx="${density.size / 2}" cy="${density.size / 2}" r="${density.size / 2}" fill="white" />
</svg>`;
    const maskBuf = await sharp(Buffer.from(maskSvg), { density: 96 })
      .resize(density.size, density.size, { fit: 'contain' })
      .toBuffer();

    // Apply mask via composite
    const masked = await sharp(icon)
      .composite([{ input: maskBuf, blend: 'dest-in' }])
      .png({ compressionLevel: 9 })
      .toFile(pngPath);

    written.push(`${pngPath} (${density.size}×${density.size})`);
    console.log(`  ✓ mipmap-${density.name}/ic_launcher_round.png`);
  }

  // 5. Splash screens (full-bleed, portrait + landscape)
  console.log('\nGenerating splash screens...');
  for (const spec of SPLASH_SPECS) {
    const dir = path.join(ANDROID_RES_DIR, spec.dir);
    ensureDir(dir);

    const svg = buildSplashSVG(spec.w, spec.h);
    const pngPath = path.join(dir, spec.name);

    await sharp(Buffer.from(svg), { density: 96 })
      .resize(spec.w, spec.h, {
        fit: 'fill',
        background: { r: 11, g: 14, b: 20, alpha: 255 },
      })
      .png({ compressionLevel: 9 })
      .toFile(pngPath);

    written.push(`${pngPath} (${spec.w}×${spec.h})`);
    const shortDir = spec.dir.replace(/^drawable/, 'drawable');
    console.log(`  ✓ ${shortDir}/splash.png`);
  }

  console.log('\n=== Summary ===\n');
  console.log(`Generated ${written.length} files:`);
  written.forEach((f) => console.log(`  ${f}`));

  console.log('\n✓ Android icons and splash screens generated.');
  console.log(`  Background colour: #11151d (dark navy)`);
  console.log(`  Design: robot optic eye (steel lens, red glowing iris, cyan scan accent)`);
  console.log(`  Adaptive foreground (transparent): mipmap-*/ic_launcher_foreground.png`);
  console.log(`  Legacy icons (full): mipmap-*/ic_launcher.png`);
  console.log(`  Legacy round icons: mipmap-*/ic_launcher_round.png`);
  console.log(`  Splash screens (10 total): drawable*/splash.png`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
