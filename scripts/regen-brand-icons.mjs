// Regenerate the app brand icons from a single clean source.
//
// Usage:
//   1) Save the clean circular BreeXe icon as: public/brand/icon-source.png
//      (high-res, the full seal with the copper/navy rings — NOT a cropped one)
//   2) Run:  node scripts/regen-brand-icons.mjs
//
// It trims stray border pixels, centres the mark on a square canvas with even
// padding, and writes the sizes the app already references (icon-64/icon-256)
// plus logo-256/512 seals and a favicon. No app code changes needed — the
// sidebar, login screen and invoice all point at these files.

import sharp from "sharp";
import { existsSync } from "node:fs";
import path from "node:path";

const brandDir = path.resolve("public/brand");
const source = path.join(brandDir, "icon-source.png");

if (!existsSync(source)) {
  console.error(`\n✗ Missing source: ${source}`);
  console.error("  Save the clean circular icon there first, then re-run.\n");
  process.exit(1);
}

// Padding fraction around the trimmed mark (keeps the ring off the edge).
const PAD = 0.06;

const meta = await sharp(source).metadata();
console.log(`source: ${meta.width}x${meta.height}`);

// Trim uniform border, then measure the tight mark.
const trimmed = await sharp(source).trim({ threshold: 10 }).png().toBuffer();
const tm = await sharp(trimmed).metadata();
const side = Math.round(Math.max(tm.width, tm.height) * (1 + PAD * 2));

// Centre on a transparent square so it sits cleanly on any surface.
const square = await sharp({
  create: { width: side, height: side, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
})
  .composite([{ input: trimmed, gravity: "center" }])
  .png()
  .toBuffer();

// Only the square ICON files — leave logo-256/512 (the horizontal wordmark
// used on the landing page) untouched.
const outputs = [
  ["icon-32.png", 32],
  ["icon-64.png", 64],
  ["icon-256.png", 256],
  ["favicon.png", 48],
];

for (const [name, size] of outputs) {
  await sharp(square).resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toFile(path.join(brandDir, name));
  console.log(`✓ ${name} (${size}x${size})`);
}

console.log("\nDone. Rebuild/restart the app (update-local.cmd) to see the new icon.");
