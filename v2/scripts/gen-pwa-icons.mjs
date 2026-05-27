/**
 * gen-pwa-icons.mjs — render PWA icons from favicon.svg
 *
 * Generates the icon sizes Chrome requires for PWA installability:
 *   - favicon-192.png     (Android home screen, "any" purpose)
 *   - favicon-512.png     (large/splash, "any" purpose)
 *   - favicon-192-maskable.png  (Android adaptive icon, with safe zone)
 *   - favicon-512-maskable.png  (same, larger)
 *
 * Maskable icons need ~10% safe-zone padding on each edge because Android
 * masks them into device-specific shapes (circle, squircle, teardrop). We
 * scale the SVG to 80% of canvas and pad with the brand background colour.
 *
 * Run from v2/: node scripts/gen-pwa-icons.mjs
 * The output PNGs land in v2/ next to favicon-{16,48,128}.png.
 */
import sharp from 'sharp';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const svgBuf = readFileSync(join(root, 'favicon.svg'));

// Brand background — matches manifest.json background_color so the maskable
// safe zone blends seamlessly into the rest of the icon.
const BG = { r: 5, g: 7, b: 15, alpha: 1 }; // #05070f

async function renderAny(size) {
  // "any" purpose icons fill the whole canvas — the SVG's rounded-rect
  // background extends to the edge naturally.
  const out = join(root, `favicon-${size}.png`);
  await sharp(svgBuf, { density: 384 })
    .resize(size, size, { fit: 'contain', background: BG })
    .png({ compressionLevel: 9 })
    .toFile(out);
  console.log(`[icon] wrote ${out} (${size}×${size}, any)`);
}

async function renderMaskable(size) {
  // Maskable icons need a safe zone — the icon's *content* must fit within
  // a circle of diameter 80% of the canvas. We render the SVG at 80% size
  // and centre it on a brand-colour background.
  const inner = Math.round(size * 0.8);
  const pad = Math.round((size - inner) / 2);

  const innerBuf = await sharp(svgBuf, { density: 384 })
    .resize(inner, inner)
    .png()
    .toBuffer();

  const out = join(root, `favicon-${size}-maskable.png`);
  await sharp({
    create: { width: size, height: size, channels: 4, background: BG },
  })
    .composite([{ input: innerBuf, top: pad, left: pad }])
    .png({ compressionLevel: 9 })
    .toFile(out);
  console.log(`[icon] wrote ${out} (${size}×${size}, maskable)`);
}

await renderAny(192);
await renderAny(512);
await renderMaskable(192);
await renderMaskable(512);
console.log('[icon] done.');
