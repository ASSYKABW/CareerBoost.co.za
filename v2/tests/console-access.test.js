/* eslint-disable no-console */
// Console admin access-control guard.
//
// Replaces the legacy tests/admin-console.test.js, which loaded the pre-cutover
// admin modules (admin-helpers.js / admin.route.js / sections/*) deleted in
// 8fc2030 when the Console became the admin. Nearly all of that file asserted
// on the deleted UI shell, but one part was worth keeping: the access gate —
// in particular that a *user-writable* user_metadata role must never grant
// admin. That coverage is preserved here against the current Console.
//
// renderConsole() checks hasAccess() first, so the deny path is reachable with
// minimal mocks. For an allowed operator we leave the MFA snapshot "unloaded",
// which short-circuits to the loading screen instead of the full shell (which
// would need the whole data layer stubbed).
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(
  path.resolve(__dirname, "..", "src/js/modules/console/console.route.js"),
  "utf8"
);

function loadConsole(user, opts) {
  opts = opts || {};
  const window = {
    location: { search: "", hash: "#/admin" },
    CBConsole: {},
    CBAdmin: {
      mfa: {
        getSnapshot: function () { return { loaded: false }; },
        renderLoadingScreen: function () { return "MFA_LOADING"; }
      }
    },
    CBV2: {
      routes: {},
      afterRender: {},
      config: { isBackendEnabled: function () { return opts.backend !== false; } },
      auth: {
        isAuthenticated: function () { return opts.authed !== false; },
        getUser: function () { return user; }
      },
      profile: { get: function () { return { preferences: {} }; } }
    }
  };
  const document = {
    addEventListener: function () {},
    querySelector: function () { return null; },
    getElementById: function () { return null; }
  };
  new Function("window", "document", SRC + "\n;")(window, document);
  return window;
}

function render(user, opts) {
  return loadConsole(user, opts).CBV2.routes.admin();
}

const DENIED = /Admin access required/;
let pass = 0;
let total = 0;
function check(label, cond) {
  total += 1;
  if (cond) { pass += 1; console.log("  ok  " + label); }
  else { console.log("  FAIL " + label); }
}

function run() {
  check(
    "console registers window.CBV2.routes.admin",
    typeof loadConsole(null).CBV2.routes.admin === "function"
  );

  // ── Deny paths ──────────────────────────────────────────────────────
  check("signed-out visitor is denied", DENIED.test(render(null, { authed: false })));
  check(
    "candidate with no roles is denied",
    DENIED.test(render({ email: "c@example.com", app_metadata: {}, user_metadata: {} }))
  );
  check(
    "unrelated app_metadata role is denied",
    DENIED.test(render({ email: "c@example.com", app_metadata: { roles: ["candidate"] }, user_metadata: {} }))
  );

  // ── Privilege-escalation guard (the reason this test still exists) ───
  // user_metadata is writable by the user in Supabase; it must never confer admin.
  check(
    "user_metadata.roles=['admin'] does NOT grant admin",
    DENIED.test(render({ email: "c@example.com", app_metadata: {}, user_metadata: { roles: ["admin"] } }))
  );
  check(
    "user_metadata.role='owner' does NOT grant admin",
    DENIED.test(render({ email: "c@example.com", app_metadata: {}, user_metadata: { role: "owner" } }))
  );

  // ── Allow paths (app_metadata only) ─────────────────────────────────
  ["admin", "owner", "developer"].forEach(function (role) {
    const out = render({ email: "a@example.com", app_metadata: { roles: [role] }, user_metadata: {} });
    check(
      "app_metadata role '" + role + "' passes the gate",
      !DENIED.test(out) && /MFA_LOADING/.test(out)
    );
  });
  check(
    "app_metadata.role (singular) passes the gate",
    !DENIED.test(render({ email: "a@example.com", app_metadata: { role: "Admin" }, user_metadata: {} }))
  );

  assert.strictEqual(pass, total, "Console access-control tests failed (" + pass + "/" + total + ")");
  console.log("Console access-control tests passed (" + pass + "/" + total + ").");
}

run();
