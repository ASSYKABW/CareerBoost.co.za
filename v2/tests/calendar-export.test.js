/* eslint-disable no-console */
// Phase 7 tests: ICS export + Google Calendar URL + browser notifications module.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadScript(ctx, relPath) {
  const abs = path.resolve(__dirname, "..", relPath);
  const src = fs.readFileSync(abs, "utf8");
  vm.runInContext(src, ctx, { filename: relPath });
}

function makeContext() {
  // Minimal browser-shaped sandbox.
  const localStorageMap = {};
  const window = {
    CBV2: {},
    localStorage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(localStorageMap, k) ? localStorageMap[k] : null; },
      setItem: function (k, v) { localStorageMap[k] = String(v); },
      removeItem: function (k) { delete localStorageMap[k]; }
    },
    // No-op Notification; individual tests stub this when needed.
    Notification: undefined,
  };
  return vm.createContext({
    window: window,
    document: { readyState: "complete", addEventListener: function () {} },
    console: console,
    Date: Date,
    Math: Math,
    Number: Number,
    String: String,
    Object: Object,
    Array: Array,
    JSON: JSON,
    setTimeout: setTimeout,
    setInterval: function () { return 1; },
    clearInterval: function () {},
    Promise: Promise,
    encodeURIComponent: encodeURIComponent,
    URL: URL,
    Blob: function () {},
  });
}

function run() {
  // ─── ICS module ──────────────────────────────────────────────────────
  const icsCtx = makeContext();
  loadScript(icsCtx, "src/js/modules/calendar/calendar.ics.js");
  const ics = icsCtx.window.CBV2.calendarIcs;
  assert.ok(ics, "calendar.ics.js should expose window.CBV2.calendarIcs");
  assert.strictEqual(typeof ics.buildEventIcs, "function", "buildEventIcs should be a function");
  assert.strictEqual(typeof ics.buildEventsIcs, "function", "buildEventsIcs should be a function");
  assert.strictEqual(typeof ics.downloadIcs, "function", "downloadIcs should be a function");

  // Escape behavior
  assert.strictEqual(ics._icsEscape("hello, world"), "hello\\, world", "comma should be escaped");
  assert.strictEqual(ics._icsEscape("a;b"), "a\\;b", "semicolon should be escaped");
  assert.strictEqual(ics._icsEscape("line1\nline2"), "line1\\nline2", "newline should be escaped");
  assert.strictEqual(ics._icsEscape("back\\slash"), "back\\\\slash", "backslash should be escaped");

  // Date conversion
  const fixedDate = new Date("2026-06-15T14:30:00Z");
  assert.strictEqual(ics._toIcsDate(fixedDate), "20260615T143000Z", "toIcsDate should produce UTC stamp");
  assert.strictEqual(ics._toIcsDateOnly(new Date("2026-06-15T00:00:00Z")), "20260615", "toIcsDateOnly should produce YYYYMMDD");

  // Line folding (RFC 5545: 75 octets max)
  const long = "X".repeat(180);
  const folded = ics._foldLine(long);
  const parts = folded.split("\r\n");
  assert.ok(parts.length > 1, "long line should be folded into multiple parts");
  assert.ok(parts[0].length <= 75, "first folded part should be ≤75 chars");
  parts.slice(1).forEach(function (p, i) {
    assert.ok(p.startsWith(" "), "continuation part " + (i + 2) + " should start with a space");
  });

  // RRULE building
  assert.strictEqual(ics._buildRrule({ recurrence: "none" }), null, "no recurrence → null RRULE");
  assert.strictEqual(ics._buildRrule({ recurrence: "weekly" }), "RRULE:FREQ=WEEKLY", "weekly recurrence");
  const rruleUntil = ics._buildRrule({ recurrence: "daily", recurrenceUntil: "2026-12-31" });
  assert.ok(/RRULE:FREQ=DAILY;UNTIL=20261231T235959Z/.test(rruleUntil), "daily recurrence with until");

  // Single event ICS. Z-suffixed start/end so the test is deterministic
  // across timezones (Node's Date parser treats unsuffixed timestamps as
  // local time, which would vary by machine).
  const ev = {
    id: "evt-1",
    title: "Phone interview at Acme",
    date: "2026-06-15",
    start: "2026-06-15T14:00:00Z",
    end:   "2026-06-15T15:00:00Z",
    type: "interview",
    status: "confirmed",
    location: "Zoom: zoom.us/j/abc",
    notes: "Bring portfolio.\nPractice walking through it.",
    reminder: "10min",
    recurrence: "none",
    allDay: false,
  };
  const body = ics.buildEventIcs(ev);
  assert.ok(/BEGIN:VCALENDAR/.test(body) && /END:VCALENDAR/.test(body), "ICS should be wrapped in VCALENDAR");
  assert.ok(/BEGIN:VEVENT/.test(body) && /END:VEVENT/.test(body), "ICS should contain a VEVENT");
  assert.ok(/UID:evt-1@careerboost\.app/.test(body), "UID should include event id and domain");
  assert.ok(/SUMMARY:Phone interview at Acme/.test(body), "SUMMARY should match title");
  assert.ok(/DTSTART:/.test(body) && /DTEND:/.test(body), "ICS should contain DTSTART + DTEND");
  assert.ok(/LOCATION:Zoom: zoom\.us\/j\/abc/.test(body), "LOCATION should appear");
  assert.ok(/STATUS:CONFIRMED/.test(body), "STATUS should map status field");
  assert.ok(/CATEGORIES:INTERVIEW/.test(body), "CATEGORIES should map type field");
  assert.ok(/BEGIN:VALARM/.test(body) && /TRIGGER:-PT10M/.test(body), "VALARM with 10min trigger should be present");
  // Notes with literal newline should be escaped to \n in DESCRIPTION.
  assert.ok(/DESCRIPTION:Bring portfolio\.\\nPractice walking through it\./.test(body), "newlines in notes should be escaped");

  // All-day event. Z-suffixed for cross-TZ determinism.
  const allDay = { id: "evt-2", title: "Application deadline", date: "2026-07-01", allDay: true, start: "2026-07-01T00:00:00Z", end: "2026-07-01T00:00:00Z", type: "deadline", status: "planned" };
  const allDayBody = ics.buildEventIcs(allDay);
  assert.ok(/DTSTART;VALUE=DATE:20260701/.test(allDayBody), "all-day events should use DATE form for DTSTART");
  assert.ok(/DTEND;VALUE=DATE:20260702/.test(allDayBody), "all-day DTEND should be the day after (exclusive)");
  assert.ok(!/T\d{6}Z/.test(allDayBody.split("DTSTART")[1].split("\r\n")[0]), "all-day DTSTART should have no time component");

  // Multi-event bundle
  const bundle = ics.buildEventsIcs([ev, allDay], { calendarName: "Test Cal" });
  assert.ok(/X-WR-CALNAME:Test Cal/.test(bundle), "bundle should include calendar name");
  assert.strictEqual(bundle.match(/BEGIN:VEVENT/g).length, 2, "bundle should contain 2 VEVENTs");
  assert.strictEqual(bundle.match(/END:VEVENT/g).length, 2, "bundle should contain 2 END:VEVENTs");

  // Empty event should produce empty string (no start)
  assert.strictEqual(ics.buildEventIcs({ title: "no date" }), "", "event without start should produce empty ICS");

  // CRLF line endings (RFC 5545)
  assert.ok(body.includes("\r\n"), "ICS should use CRLF line endings");
  assert.ok(body.endsWith("\r\n"), "ICS should end with CRLF");

  console.log("Calendar ICS tests passed.");

  // ─── Google Calendar URL ─────────────────────────────────────────────
  const gcalCtx = makeContext();
  loadScript(gcalCtx, "src/js/modules/calendar/calendar.gcal.js");
  const gcal = gcalCtx.window.CBV2.calendarGcal;
  assert.ok(gcal, "calendar.gcal.js should expose window.CBV2.calendarGcal");

  const url = gcal.buildGoogleCalUrl(ev);
  assert.ok(/^https:\/\/calendar\.google\.com\/calendar\/render\?/.test(url), "URL should be a Google Calendar template URL");
  assert.ok(/action=TEMPLATE/.test(url), "URL should use action=TEMPLATE");
  assert.ok(/text=Phone%20interview%20at%20Acme/.test(url), "title should be URL-encoded");
  assert.ok(/dates=20260615T140000Z%2F20260615T150000Z/.test(url), "dates param should be start/end in UTC");
  assert.ok(/location=Zoom%3A%20zoom\.us%2Fj%2Fabc/.test(url), "location should be URL-encoded");
  assert.ok(/details=/.test(url), "details param should be present");

  // All-day
  const allDayUrl = gcal.buildGoogleCalUrl(allDay);
  assert.ok(/dates=20260701%2F20260702/.test(allDayUrl), "all-day URL should use DATE form, end-exclusive");

  // Bad event
  assert.strictEqual(gcal.buildGoogleCalUrl({}), "", "empty event should produce empty URL");
  assert.strictEqual(gcal.buildGoogleCalUrl({ title: "no start" }), "", "event without start should produce empty URL");
  assert.strictEqual(gcal.buildGoogleCalUrl({ date: "2026-01-01", start: "2026-01-01T09:00:00", end: "2026-01-01T10:00:00" }), "", "event without title should produce empty URL");

  // Recurrence
  const recurUrl = gcal.buildGoogleCalUrl(Object.assign({}, ev, { recurrence: "weekly", recurrenceUntil: "2026-12-31" }));
  assert.ok(/recur=RRULE%3AFREQ%3DWEEKLY%3BUNTIL%3D20261231T235959Z/.test(recurUrl), "recur param should encode RRULE");

  console.log("Calendar Google URL tests passed.");

  // ─── Notifications module ────────────────────────────────────────────
  const notifCtx = makeContext();
  // Stub Notification API as supported with default permission.
  notifCtx.window.Notification = function () {};
  notifCtx.window.Notification.permission = "default";
  notifCtx.window.Notification.requestPermission = function (cb) {
    notifCtx.window.Notification.permission = "granted";
    if (cb) cb("granted");
    return Promise.resolve("granted");
  };
  loadScript(notifCtx, "src/js/modules/calendar/calendar.notifications.js");
  const notif = notifCtx.window.CBV2.calendarNotifications;
  assert.ok(notif, "calendar.notifications.js should expose window.CBV2.calendarNotifications");
  assert.strictEqual(typeof notif.requestPermission, "function", "requestPermission should be a function");
  assert.strictEqual(typeof notif.isEnabled, "function", "isEnabled should be a function");
  assert.strictEqual(typeof notif.setEnabled, "function", "setEnabled should be a function");
  assert.strictEqual(typeof notif.tick, "function", "tick should be a function");

  // isSupported
  assert.strictEqual(notif.isSupported(), true, "Notifications should be supported with stubbed API");

  // Permission state
  assert.strictEqual(notif.permission(), "default", "initial permission should be default");

  // Default: not enabled before permission is granted
  assert.strictEqual(notif.isEnabled(), false, "should be disabled when permission is default");

  // After granting permission, isEnabled returns true by default
  notifCtx.window.Notification.permission = "granted";
  assert.strictEqual(notif.isEnabled(), true, "should be enabled when permission is granted");

  // setEnabled persists
  notif.setEnabled(false);
  assert.strictEqual(notif.isEnabled(), false, "setEnabled(false) should disable");
  notif.setEnabled(true);
  assert.strictEqual(notif.isEnabled(), true, "setEnabled(true) should re-enable");

  // requestPermission
  return notif.requestPermission().then(function (state) {
    assert.strictEqual(state, "granted", "requestPermission should resolve to granted in test");

    // Lead-time map sanity
    assert.strictEqual(notif._leadMs["10min"], 10 * 60_000, "10min lead should be 10 minutes");
    assert.strictEqual(notif._leadMs["1h"], 60 * 60_000, "1h lead should be 1 hour");
    assert.strictEqual(notif._leadMs["1d"], 24 * 60 * 60_000, "1d lead should be 1 day");

    // Fired marker dedupes per minute
    const k1 = notif._makeFireKey("evt-1", "10min", 1_700_000_000_000);
    const k2 = notif._makeFireKey("evt-1", "10min", 1_700_000_000_001);
    assert.strictEqual(k1, k2, "fire keys for same minute should be equal (dedupe within a minute)");
    const k3 = notif._makeFireKey("evt-1", "10min", 1_700_000_060_000);
    assert.notStrictEqual(k1, k3, "fire keys for different minutes should differ");

    // Tick doesn't throw when store is absent
    assert.doesNotThrow(function () { notif.tick(); }, "tick() should be safe when store is missing");

    console.log("Calendar notifications tests passed.");
  });
}

const result = run();
if (result && typeof result.then === "function") {
  result.catch(function (err) {
    console.error(err);
    process.exit(1);
  });
}
