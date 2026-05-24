/**
 * build.mjs — CareerBoost JS + CSS bundler
 *
 * JS:  Concatenates + minifies the 109 source files listed in SCRIPTS
 *      into src/js/bundle.min.js.
 * CSS: Concatenates + minifies the 9 stylesheets listed in SHEETS
 *      into src/styles/bundle.min.css.
 *
 * Usage:
 *   npm run build          — one-shot bundle (JS + CSS)
 *   npm run build:watch    — rebuild on any src/js or src/styles change
 *
 * Workflow (after changing any source file):
 *   1. Edit the source file
 *   2. Run: npm run build
 *   3. Commit both the source file AND the updated bundle artifact
 *   4. Push — Vercel serves the committed bundles (no build step needed)
 *
 * Adding a new stylesheet: add it to SHEETS at the correct cascade position,
 * then run npm run build. Do NOT add a <link> tag to index.html.
 * Adding a new script:    add it to SCRIPTS at the correct load position,
 * then run npm run build. Do NOT add a <script> tag to index.html.
 */

import { readFileSync, writeFileSync, watch } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { transform } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Ordered list of source files to bundle. Order is load order — do not
// reorder without checking cross-file dependencies (see index.html comments
// for dependency notes; they are preserved there for reference).
const SCRIPTS = [
  "./src/js/app/config.js",
  "./src/js/services/observability/observability.js",
  "./src/js/services/sync-monitor/sync-monitor.js",
  "./src/js/auth/auth.service.js",
  "./src/js/auth/auth.attribution.js",
  "./src/js/app/usage-tracker.js",
  "./src/js/app/profile.js",
  "./src/js/ai/ai.schemas.js",
  "./src/js/ai/ai.providers.js",
  "./src/js/ai/ai.telemetry.js",
  "./src/js/ai/ai.orchestrator.js",
  "./src/js/app/state.js",
  "./src/js/app/store.js",
  "./src/js/app/store.remote.js",
  "./src/js/app/utils/strings.js",
  "./src/js/app/utils/download.js",
  "./src/js/app/utils/semantic-match.js",
  "./src/js/app/shared/loading.js",
  "./src/js/app/shared/placeholder-view.js",
  "./src/js/app/shared/toast.js",
  "./src/js/app/shortcuts.js",
  "./src/js/components/brand-kit.js",
  "./src/js/components/app-shell.js",
  "./src/js/components/global-search.js",
  "./src/js/components/status-pill.js",
  "./src/js/components/logos.js",
  "./src/js/components/ui-kit.js",
  "./src/js/services/jobs/job.notes.js",
  "./src/js/components/modal-service.js",
  "./src/js/components/cookie-banner.js",
  "./src/js/services/entitlements/entitlements.js",
  "./src/js/components/upgrade-modal.js",
  "./src/js/components/deletion-banner.js",
  "./src/js/services/entitlements/entitlement-gate.js",
  "./src/js/components/app-drawer.js",
  "./src/js/components/ai-chat-knowledge.js",
  "./src/js/components/ai-chat-panel.js",
  "./src/js/components/command-palette.js",
  "./src/js/services/jobs/job.normalize.js",
  "./src/js/services/jobs/job.providers.custom.js",
  "./src/js/services/jobs/job.intent.js",
  "./src/js/services/jobs/job.search.js",
  "./src/js/services/jobs/job.matcher.js",
  "./src/js/services/jobs/job.workflow.js",
  "./src/js/services/candidate/candidate.intelligence.js",
  "./src/js/services/candidate/role.context.js",
  "./src/js/services/candidate/application.command-center.js",
  "./src/js/services/candidate/product.intelligence.js",
  "./src/js/auth/auth.route.js",
  "./src/js/auth/auth.confirmed.js",
  "./src/js/auth/auth.verify.js",
  "./src/js/auth/auth.reset.js",
  "./src/js/marketing/welcome.route.js",
  "./src/js/marketing/privacy.route.js",
  "./src/js/marketing/terms.route.js",
  "./src/js/modules/onboarding/onboarding.route.js",
  "./src/js/modules/dashboard/dashboard.route.js",
  "./src/js/modules/job-search/job-search.shared.js",
  "./src/js/modules/job-search/job-search.route.js",
  "./src/js/modules/applications/applications.route.js",
  "./src/js/modules/calendar/calendar.ics.js",
  "./src/js/modules/calendar/calendar.gcal.js",
  "./src/js/modules/calendar/calendar.notifications.js",
  "./src/js/modules/calendar/calendar.route.js",
  "./src/js/modules/resume/resume.model.js",
  "./src/js/modules/resume/resume.parser.js",
  "./src/js/modules/resume/resume.templates.js",
  "./src/js/modules/resume/resume.docx.js",
  "./src/js/modules/resume/resume.export.js",
  "./src/js/modules/resume/resume.quality.js",
  "./src/js/modules/resume/resume.route.js",
  "./src/js/modules/cover-letter/cover-letter.route.js",
  "./src/js/services/interview/company-intel.service.js",
  "./src/js/modules/interview/interview.personas.js",
  "./src/js/modules/interview/interview.voice.js",
  "./src/js/modules/interview/interview.route.js",
  "./src/js/modules/analytics/analytics.shared.js",
  "./src/js/modules/analytics/analytics.route.js",
  "./src/js/services/apply-assist/apply-profile.js",
  "./src/js/modules/settings/settings.meta.js",
  "./src/js/modules/settings/settings.billing.js",
  "./src/js/modules/settings/settings.intel.js",
  "./src/js/modules/settings/settings.route.js",
  "./src/js/modules/admin/admin-helpers.js",
  "./src/js/modules/admin/admin-realtime.js",
  "./src/js/modules/admin/sections/command-center.js",
  "./src/js/modules/admin/sections/growth.js",
  "./src/js/modules/admin/sections/product-intelligence.js",
  "./src/js/modules/admin/sections/overview.js",
  "./src/js/modules/admin/sections/usage-engagement.js",
  "./src/js/modules/admin/sections/funnel.js",
  "./src/js/modules/admin/sections/users.js",
  "./src/js/modules/admin/sections/job-feed.js",
  "./src/js/modules/admin/sections/ai-cost.js",
  "./src/js/modules/admin/sections/extension.js",
  "./src/js/modules/admin/sections/sync.js",
  "./src/js/modules/admin/sections/risk-center.js",
  "./src/js/modules/admin/sections/reports.js",
  "./src/js/modules/admin/sections/logs.js",
  "./src/js/modules/admin/sections/settings.js",
  "./src/js/modules/admin/sections/health.js",
  "./src/js/modules/admin/sections/operations.js",
  "./src/js/modules/admin/sections/credentials.js",
  "./src/js/modules/admin/sections/tracked-companies.js",
  "./src/js/modules/admin/sections/apply-assist.js",
  "./src/js/modules/admin/sections/testimonials.js",
  "./src/js/modules/admin/admin.mfa.js",
  "./src/js/modules/admin/admin.route.js",
  "./src/js/app/router.js",
  "./src/js/app/bootstrap.js",
];

// Ordered list of stylesheets to bundle. Cascade order matters — tokens
// must be first (defines CSS custom properties used by everything below).
const SHEETS = [
  "./src/styles/tokens.css",
  "./src/styles/base.css",
  "./src/styles/layout.css",
  "./src/styles/modules.css",
  "./src/styles/auth.css",
  "./src/styles/phase1.css",
  "./src/styles/design-system.css",
  "./src/styles/phase5-cleanup.css",
  "./src/styles/admin.css",
];

async function bundleJS() {
  const start = Date.now();
  const combined = SCRIPTS.map(p => readFileSync(join(__dirname, p), 'utf8')).join('\n');
  const result = await transform(combined, { minify: true, loader: 'js' });
  const outPath = join(__dirname, 'src/js/bundle.min.js');
  writeFileSync(outPath, result.code);
  const rawKB  = (combined.length    / 1024).toFixed(1);
  const minKB  = (result.code.length / 1024).toFixed(1);
  const saving = (100 - (result.code.length / combined.length) * 100).toFixed(0);
  console.log(`[js ] ${SCRIPTS.length} files · ${rawKB} KB → ${minKB} KB (${saving}% smaller) · ${Date.now() - start}ms`);
}

async function bundleCSS() {
  const start = Date.now();
  const combined = SHEETS.map(p => readFileSync(join(__dirname, p), 'utf8')).join('\n');
  const result = await transform(combined, { minify: true, loader: 'css' });
  const outPath = join(__dirname, 'src/styles/bundle.min.css');
  writeFileSync(outPath, result.code);
  const rawKB  = (combined.length    / 1024).toFixed(1);
  const minKB  = (result.code.length / 1024).toFixed(1);
  const saving = (100 - (result.code.length / combined.length) * 100).toFixed(0);
  console.log(`[css] ${SHEETS.length} files · ${rawKB} KB → ${minKB} KB (${saving}% smaller) · ${Date.now() - start}ms`);
}

async function run() {
  await Promise.all([bundleJS(), bundleCSS()]);

  if (!process.argv.includes('--watch')) return;

  console.log('[build] watching src/js/ and src/styles/ for changes…');
  let debounce;
  const onChange = (dir) => (event, filename) => {
    if (!filename) return;
    if (filename.endsWith('bundle.min.js') || filename.endsWith('bundle.min.css')) return;
    clearTimeout(debounce);
    debounce = setTimeout(async () => {
      console.log(`[build] changed: ${dir}/${filename}`);
      const isCSS = filename.endsWith('.css');
      await (isCSS ? bundleCSS() : bundleJS()).catch(console.error);
    }, 80);
  };
  watch(join(__dirname, 'src/js'),     { recursive: true }, onChange('src/js'));
  watch(join(__dirname, 'src/styles'), { recursive: true }, onChange('src/styles'));
}

run().catch(err => { console.error(err); process.exit(1); });
