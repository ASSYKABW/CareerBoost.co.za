# Brand assets

## Logo

Drop your logo file here as **`logo.svg`** (preferred) or **`logo.png`**.
The landing page + auth screens auto-prefer it over the default
`logo-default.svg`.

### Recommended specs

| Format | Use case                              | Dimensions     |
| ------ | ------------------------------------- | -------------- |
| SVG    | Best. Crisp at every size.            | Square 64×64 viewBox (any pixel size) |
| PNG    | Fallback. Needs @2x for retina.       | 128×128 minimum, transparent background |

Keep the logo readable at ~32px tall (nav size). If your full logo
has wide horizontal text, also drop a `logo-mark.svg` containing
just the icon — the landing page nav uses it when there's no room
for the full wordmark.

### How the swap works

1. Save `logo.svg` (or `.png`) in this folder.
2. Hard-refresh the page (Cmd+Shift+R / Ctrl+Shift+R).
3. The landing page picks it up automatically — no code change needed.

If you want to swap the wordmark text "CareerBoost" too, edit
`renderBrand()` in `v2/src/js/marketing/welcome.route.js`.
