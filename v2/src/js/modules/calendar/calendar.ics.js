// Phase 7: ICS (iCalendar / RFC 5545) export.
//
// Generates a .ics file from one or more CareerBoost events. Compatible
// with: Google Calendar import, Apple Calendar, Outlook, Fastmail,
// Proton Calendar, and every other calendar client that accepts ICS.
//
// Standard reference: https://datatracker.ietf.org/doc/html/rfc5545
//
// Three exports:
//   - buildEventIcs(event)          → string ICS for one event
//   - buildEventsIcs(events, opts)  → string ICS bundle for many events
//   - downloadIcs(filename, body)   → trigger browser save
//
// All three are pure (no DOM, no network) except downloadIcs.

(function () {
  window.CBV2 = window.CBV2 || {};

  // RFC 5545 escape: backslash, comma, semicolon, newlines.
  function icsEscape(value) {
    return String(value == null ? "" : value)
      .replace(/\\/g, "\\\\")
      .replace(/;/g, "\\;")
      .replace(/,/g, "\\,")
      .replace(/\r\n|\r|\n/g, "\\n");
  }

  // RFC 5545 line folding: lines must be ≤75 octets; longer lines fold
  // with CRLF + space. We approximate by character count since CareerBoost
  // event text is overwhelmingly ASCII.
  function foldLine(line) {
    if (line.length <= 75) return line;
    const chunks = [];
    let i = 0;
    while (i < line.length) {
      // First line is 75 chars; continuations are 74 chars (+1 for leading space)
      const size = chunks.length === 0 ? 75 : 74;
      chunks.push((chunks.length === 0 ? "" : " ") + line.slice(i, i + size));
      i += size;
    }
    return chunks.join("\r\n");
  }

  // ICS uses CRLF line endings universally.
  function joinIcs(lines) {
    return lines.map(foldLine).join("\r\n") + "\r\n";
  }

  // Convert a JS Date or ISO string to ICS UTC stamp: YYYYMMDDTHHMMSSZ.
  function toIcsDate(value) {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    const pad = function (n) { return String(n).padStart(2, "0"); };
    return d.getUTCFullYear() +
      pad(d.getUTCMonth() + 1) +
      pad(d.getUTCDate()) +
      "T" +
      pad(d.getUTCHours()) +
      pad(d.getUTCMinutes()) +
      pad(d.getUTCSeconds()) +
      "Z";
  }

  // All-day events use DATE form: YYYYMMDD (no time, no Z).
  // We use UTC getters so a date-only input like "2026-07-01" — which
  // ISO parsers interpret as UTC midnight — always renders as the same
  // calendar date regardless of the machine's local timezone.
  function toIcsDateOnly(value) {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    const pad = function (n) { return String(n).padStart(2, "0"); };
    return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate());
  }

  // RFC 5545 RRULE for our recurrence vocabulary (daily/weekly/monthly).
  // Returns null for no recurrence.
  function buildRrule(event) {
    const rec = String((event && event.recurrence) || "none").toLowerCase();
    if (!rec || rec === "none") return null;
    const map = { daily: "DAILY", weekly: "WEEKLY", monthly: "MONTHLY", yearly: "YEARLY" };
    const freq = map[rec];
    if (!freq) return null;
    let rule = "RRULE:FREQ=" + freq;
    // recurrenceUntil from the event normalizer is a YYYY-MM-DD; ICS
    // expects YYYYMMDDTHHMMSSZ. We treat "until" as end-of-day UTC.
    if (event.recurrenceUntil) {
      const until = new Date(event.recurrenceUntil + "T23:59:59Z");
      if (!Number.isNaN(until.getTime())) {
        rule += ";UNTIL=" + toIcsDate(until);
      }
    }
    return rule;
  }

  // Stable UID for an event. Uses the CareerBoost event ID; falls back
  // to a deterministic synthesis when the event came from a frontend
  // template without persistence. The @careerboost.app suffix is the
  // RFC 5545-recommended domain anchor.
  function eventUid(event) {
    const id = event && (event.id || event.sourceId);
    const base = id ? String(id) : ("event-" + (event && event.date) + "-" + (event && event.title || "untitled").slice(0, 20).replace(/\s+/g, "-"));
    return base + "@careerboost.app";
  }

  // Reminder mapping: CareerBoost stores "10min", "1h", "1d", "1w" — we
  // convert to RFC 5545 TRIGGER duration. Returns the VALARM lines, or
  // an empty array if no reminder.
  function buildReminderLines(event) {
    const rem = String((event && event.reminder) || "none").toLowerCase();
    if (!rem || rem === "none") return [];
    const map = {
      "10min": "-PT10M",
      "30min": "-PT30M",
      "1h":    "-PT1H",
      "1hr":   "-PT1H",
      "2h":    "-PT2H",
      "1d":    "-P1D",
      "1day":  "-P1D",
      "1w":    "-P1W",
      "1week": "-P1W",
    };
    const trigger = map[rem] || "-PT15M";
    return [
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "DESCRIPTION:" + icsEscape((event.title || "CareerBoost reminder")),
      "TRIGGER:" + trigger,
      "END:VALARM",
    ];
  }

  // Build the VEVENT block for one event. Caller wraps in VCALENDAR.
  function buildVevent(event) {
    if (!event) return [];
    const isAllDay = !!event.allDay;
    const startSrc = event.start || (event.date ? event.date + "T09:00:00" : null);
    const endSrc = event.end || event.start || (event.date ? event.date + "T10:00:00" : null);
    if (!startSrc) return [];
    const dtstamp = toIcsDate(new Date());
    const lines = ["BEGIN:VEVENT", "UID:" + eventUid(event), "DTSTAMP:" + dtstamp];
    if (isAllDay) {
      const startOnly = toIcsDateOnly(startSrc);
      // RFC 5545: all-day DTEND is the day AFTER (exclusive end).
      // We add the day in UTC to match toIcsDateOnly which also uses UTC,
      // so the arithmetic is consistent across timezones.
      const endDate = new Date(endSrc);
      endDate.setUTCDate(endDate.getUTCDate() + 1);
      const endOnly = toIcsDateOnly(endDate);
      if (!startOnly || !endOnly) return [];
      lines.push("DTSTART;VALUE=DATE:" + startOnly);
      lines.push("DTEND;VALUE=DATE:" + endOnly);
    } else {
      const startStamp = toIcsDate(startSrc);
      const endStamp = toIcsDate(endSrc);
      if (!startStamp || !endStamp) return [];
      lines.push("DTSTART:" + startStamp);
      lines.push("DTEND:" + endStamp);
    }
    lines.push("SUMMARY:" + icsEscape(event.title || "CareerBoost event"));
    // Build a multi-line DESCRIPTION with notes + type + status + appId.
    const descParts = [];
    if (event.notes) descParts.push(event.notes);
    if (event.type) descParts.push("Type: " + event.type);
    if (event.status) descParts.push("Status: " + event.status);
    if (event.appId) descParts.push("Linked application: " + event.appId);
    descParts.push("Generated by CareerBoost.");
    lines.push("DESCRIPTION:" + icsEscape(descParts.join("\n")));
    if (event.location) lines.push("LOCATION:" + icsEscape(event.location));
    // STATUS — RFC 5545 allows TENTATIVE / CONFIRMED / CANCELLED.
    const statusMap = { planned: "TENTATIVE", confirmed: "CONFIRMED", completed: "CONFIRMED", cancelled: "CANCELLED", canceled: "CANCELLED" };
    const icsStatus = statusMap[String(event.status || "").toLowerCase()] || "CONFIRMED";
    lines.push("STATUS:" + icsStatus);
    // Category for filtering in some calendar clients.
    if (event.type) lines.push("CATEGORIES:" + icsEscape(event.type.toUpperCase()));
    const rrule = buildRrule(event);
    if (rrule) lines.push(rrule);
    // VALARM at the end of VEVENT (before END:VEVENT).
    const valarm = buildReminderLines(event);
    valarm.forEach(function (l) { lines.push(l); });
    lines.push("END:VEVENT");
    return lines;
  }

  // Single-event ICS. Useful for "Export this event" buttons.
  function buildEventIcs(event) {
    const vevent = buildVevent(event);
    if (!vevent.length) return "";
    return joinIcs([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//CareerBoost//CareerBoost Calendar 1.0//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
    ].concat(vevent).concat(["END:VCALENDAR"]));
  }

  // Multi-event ICS bundle. Used for "Export all events" toolbar button.
  // opts.calendarName customizes the X-WR-CALNAME so calendar clients
  // show "CareerBoost" instead of "Untitled calendar".
  function buildEventsIcs(events, opts) {
    const list = Array.isArray(events) ? events : [];
    const name = (opts && opts.calendarName) || "CareerBoost";
    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//CareerBoost//CareerBoost Calendar 1.0//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "X-WR-CALNAME:" + icsEscape(name),
      "X-WR-CALDESC:Job search pipeline calendar exported from CareerBoost",
    ];
    list.forEach(function (event) {
      buildVevent(event).forEach(function (l) { lines.push(l); });
    });
    lines.push("END:VCALENDAR");
    return joinIcs(lines);
  }

  // Trigger a browser download. No-op outside of a browser environment.
  function downloadIcs(filename, body) {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    const safeName = String(filename || "careerboost-calendar.ics");
    // Prefer the shared helper when available (handles encoding edge cases).
    if (window.CBV2.downloadText) {
      window.CBV2.downloadText(safeName, body, "text/calendar;charset=utf-8");
      return;
    }
    const blob = new Blob([body], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = safeName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  window.CBV2.calendarIcs = {
    buildEventIcs: buildEventIcs,
    buildEventsIcs: buildEventsIcs,
    downloadIcs: downloadIcs,
    // Exposed for testing.
    _icsEscape: icsEscape,
    _toIcsDate: toIcsDate,
    _toIcsDateOnly: toIcsDateOnly,
    _buildRrule: buildRrule,
    _foldLine: foldLine,
  };
})();
