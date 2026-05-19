// One-shot generator for the OG / Twitter card image at v2/og-image.png.
// 1200x630 PNG is the standard for Twitter/LinkedIn/Facebook sharing.
//
// Run from repo root:
//   node scripts/generate-og-image.js
//
// Re-run any time the branding changes (logo, tagline). The output is
// committed to git so Vercel serves it at /og-image.png.

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const OUT_PATH = path.resolve(__dirname, "..", "v2", "og-image.png");

// Branded card. Same color palette as the boot splash (dark navy
// gradient + cyan #22e3ff + brand wordmark colors). The diamond mark
// mirrors logo-mark.svg.
const SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0f172a"/>
      <stop offset="100%" stop-color="#05070f"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.2" cy="0.3" r="0.6">
      <stop offset="0%" stop-color="rgba(34, 227, 255, 0.18)"/>
      <stop offset="100%" stop-color="rgba(34, 227, 255, 0)"/>
    </radialGradient>
    <linearGradient id="diamondFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="rgba(34, 227, 255, 0.14)"/>
      <stop offset="100%" stop-color="rgba(34, 227, 255, 0.04)"/>
    </linearGradient>
  </defs>

  <!-- Dark gradient background -->
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect width="1200" height="630" fill="url(#glow)"/>

  <!-- Diamond mark, vertically centered with the wordmark -->
  <g transform="translate(140, 315)">
    <rect x="-86" y="-86" width="172" height="172" rx="10" ry="10"
          transform="rotate(45)"
          fill="url(#diamondFill)"
          stroke="#22e3ff" stroke-width="5"/>
    <rect x="-64" y="-64" width="128" height="128" rx="6" ry="6"
          transform="rotate(45)"
          fill="none"
          stroke="#22e3ff" stroke-width="1.5" stroke-opacity="0.5"/>
    <text x="0" y="22" text-anchor="middle"
          font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif"
          font-weight="700" font-size="64" fill="#f8fbff" letter-spacing="0.04em">CB</text>
  </g>

  <!-- Wordmark -->
  <text x="290" y="295"
        font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif"
        font-weight="800" font-size="92" letter-spacing="-0.02em">
    <tspan fill="#f8fbff">Career</tspan><tspan fill="#38bdf8">Boost</tspan>
  </text>

  <!-- Cyan divider -->
  <line x1="290" y1="330" x2="1080" y2="330" stroke="#22e3ff" stroke-opacity="0.4" stroke-width="2"/>

  <!-- Tagline -->
  <text x="290" y="385"
        font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif"
        font-weight="600" font-size="32" fill="#cbd5e1">
    Your AI Job-Search Command Center
  </text>

  <!-- Sub-tagline -->
  <text x="290" y="430"
        font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif"
        font-weight="400" font-size="22" fill="#94a3b8">
    Plan, tailor, apply, and prep with confidence. No spam.
  </text>

  <!-- Bottom-right URL -->
  <text x="1140" y="595" text-anchor="end"
        font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, monospace"
        font-weight="500" font-size="22" fill="#475569" letter-spacing="0.05em">
    www.careerboost.co.za
  </text>

  <!-- Top-right tagline pill -->
  <g transform="translate(1080, 100)">
    <rect x="-160" y="-22" width="160" height="44" rx="22"
          fill="rgba(34, 227, 255, 0.10)"
          stroke="#22e3ff" stroke-opacity="0.4" stroke-width="1"/>
    <text x="-80" y="8" text-anchor="middle"
          font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif"
          font-weight="600" font-size="16" fill="#22e3ff" letter-spacing="0.18em">
      BUILT FOR AMBITION
    </text>
  </g>
</svg>`;

(async function main() {
  const png = await sharp(Buffer.from(SVG))
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
  fs.writeFileSync(OUT_PATH, png);
  const sizeKB = (png.length / 1024).toFixed(1);
  console.log(`✓ Wrote ${OUT_PATH} (${sizeKB}KB)`);
})().catch((err) => {
  console.error("Failed to generate OG image:", err);
  process.exit(1);
});
