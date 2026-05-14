// Phase 7: Google Calendar one-click "Add to Calendar" link builder.
//
// We deliberately use Google's template URL (no OAuth) — opens a pre-
// filled Google Calendar event creation page in a new tab. The user
// confirms with one click. Zero credentials, zero scope grants, zero
// failure modes.
//
// Template URL spec (undocumented but stable for 15+ years):
//   https://calendar.google.com/calendar/render?action=TEMPLATE
//     &text=<title>
//     &dates=<start>/<end>     (YYYYMMDDTHHMMSSZ for timed,
//                               YYYYMMDD/YYYYMMDD for all-day)
//     &details=<description>
//     &location=<where>
//     &recur=RRULE:FREQ=...    (RFC 5545 RRULE string)
//
// All values must be URL-encoded. Newlines in details are sent literally
// — Google's template page renders them as line breaks.

(function () {
  window.CBV2 = window.CBV2 || {};

  function pad(n) { return String(n).padStart(2, "0"); }

  function toGcalDate(value) {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return d.getUTCFullYear() +
      pad(d.getUTCMonth() + 1) +
      pad(d.getUTCDate()) +
      "T" +
      pad(d.getUTCHours()) +
      pad(d.getUTCMinutes()) +
      pad(d.getUTCSeconds()) +
      "Z";
  }

  // UTC-based to match calendar.ics.js — date-only inputs ("2026-07-01")
  // parse to UTC midnight, so UTC getters guarantee the same calendar
  // date regardless of the user's timezone.
  function toGcalDateOnly(value) {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate());
  }

  function buildRecur(event) {
    const rec = String((event && event.recurrence) || "none").toLowerCase();
    if (!rec || rec === "none") return "";
    const map = { daily: "DAILY", weekly: "WEEKLY", monthly: "MONTHLY", yearly: "YEARLY" };
    const freq = map[rec];
    if (!freq) return "";
    let rule = "RRULE:FREQ=" + freq;
    if (event.recurrenceUntil) {
      const until = new Date(event.recurrenceUntil + "T23:59:59Z");
      if (!Number.isNaN(until.getTime())) {
        rule += ";UNTIL=" + toGcalDate(until);
      }
    }
    return rule;
  }

  // Build the URL. Returns "" if the event is unusable (no start, no title).
  function buildGoogleCalUrl(event) {
    if (!event) return "";
    const title = String(event.title || "").trim();
    if (!title) return "";
    const startSrc = event.start || (event.date ? event.date + "T09:00:00" : null);
    const endSrc = event.end || event.start || (event.date ? event.date + "T10:00:00" : null);
    if (!startSrc) return "";
    let dates;
    if (event.allDay) {
      const startOnly = toGcalDateOnly(startSrc);
      // All-day end is the day AFTER (exclusive), same as ICS. We do the
      // arithmetic in UTC for consistency with toGcalDateOnly.
      const endDate = new Date(endSrc);
      endDate.setUTCDate(endDate.getUTCDate() + 1);
      const endOnly = toGcalDateOnly(endDate);
      if (!startOnly || !endOnly) return "";
      dates = startOnly + "/" + endOnly;
    } else {
      const startStamp = toGcalDate(startSrc);
      const endStamp = toGcalDate(endSrc);
      if (!startStamp || !endStamp) return "";
      dates = startStamp + "/" + endStamp;
    }
    const descParts = [];
    if (event.notes) descParts.push(event.notes);
    if (event.type) descParts.push("Type: " + event.type);
    if (event.appId) descParts.push("Linked application: " + event.appId);
    descParts.push("Added from CareerBoost.");
    const params = ["action=TEMPLATE"];
    params.push("text=" + encodeURIComponent(title));
    params.push("dates=" + encodeURIComponent(dates));
    params.push("details=" + encodeURIComponent(descParts.join("\n")));
    if (event.location) {
      params.push("location=" + encodeURIComponent(event.location));
    }
    const recur = buildRecur(event);
    if (recur) {
      params.push("recur=" + encodeURIComponent(recur));
    }
    return "https://calendar.google.com/calendar/render?" + params.join("&");
  }

  window.CBV2.calendarGcal = {
    buildGoogleCalUrl: buildGoogleCalUrl,
    _toGcalDate: toGcalDate,
    _toGcalDateOnly: toGcalDateOnly,
  };
})();
