(function () {
  window.CBV2 = window.CBV2 || {};
  window.CBV2.routes = window.CBV2.routes || {};
  window.CBV2.afterRender = window.CBV2.afterRender || {};

  const TYPE_TONE = {
    interview: "blue",
    followup: "cyan",
    deadline: "warning",
    task: "violet"
  };
  const TYPE_ICON = {
    interview: "fa-user-tie",
    followup: "fa-paper-plane",
    deadline: "fa-hourglass-half",
    task: "fa-list-check"
  };
  const VIEW_OPTIONS = ["month", "week", "day", "agenda"];
  const FILTER_OPTIONS = ["all", "interview", "followup", "deadline", "task"];
  const state = {
    view: "month",
    filter: "all",
    query: "",
    editingId: null,
    cursorDate: new Date().toISOString().slice(0, 10),
    searchDebounce: null
  };
  const HOUR_START = 7;
  const HOUR_END = 21;
  const STARTER_TEMPLATES = [
    { title: "Follow up on latest application", type: "followup", offsetDays: 3, durationMins: 30 },
    { title: "Interview prep deep work", type: "interview", offsetDays: 1, durationMins: 60 },
    { title: "Deadline check-in", type: "deadline", offsetDays: 5, durationMins: 30 }
  ];

  function daysUntil(dateStr) {
    const target = new Date(dateStr + "T00:00:00");
    const now = new Date();
    const diff = Math.round((target - now) / (1000 * 60 * 60 * 24));
    return diff;
  }

  function getStatusLabel(deltaDays) {
    if (deltaDays < 0) return "Done";
    if (deltaDays === 0) return "Today";
    if (deltaDays <= 3) return "Soon";
    return "Planned";
  }

  function getEventMeta(event) {
    const d = daysUntil(event.date);
    return {
      days: d,
      relative: d === 0 ? "Today" : d > 0 ? "In " + d + "d" : Math.abs(d) + "d ago",
      status: getStatusLabel(d)
    };
  }

  function normalizeInputDate(value) {
    if (!value) return "";
    return String(value).slice(0, 16);
  }

  function parseDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? new Date() : date;
  }

  function formatDateKey(date) {
    return date.toISOString().slice(0, 10);
  }

  function formatDateLabel(date) {
    return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  }

  function startOfWeek(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - d.getDay());
    return d;
  }

  function startOfMonthGrid(date) {
    const first = new Date(date.getFullYear(), date.getMonth(), 1);
    return startOfWeek(first);
  }

  function daysBetween(a, b) {
    const left = new Date(a);
    const right = new Date(b);
    left.setHours(0, 0, 0, 0);
    right.setHours(0, 0, 0, 0);
    return Math.round((left - right) / (1000 * 60 * 60 * 24));
  }

  function shiftDate(dateString, days) {
    const next = parseDate(dateString);
    next.setDate(next.getDate() + days);
    return formatDateKey(next);
  }

  function toDateOnly(value) {
    return String(value || "").slice(0, 10);
  }

  function toLocalDateTimeInput(date) {
    const pad = function (n) { return String(n).padStart(2, "0"); };
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + "T" + pad(date.getHours()) + ":" + pad(date.getMinutes());
  }

  function getLocalTimezone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "Local time";
    } catch (error) {
      return "Local time";
    }
  }

  function getNextBusinessSlot(baseDate) {
    const now = baseDate ? new Date(baseDate) : new Date();
    now.setSeconds(0, 0);
    if (now.getHours() >= 17) {
      now.setDate(now.getDate() + 1);
      now.setHours(9, 0, 0, 0);
    } else if (now.getHours() < 9) {
      now.setHours(9, 0, 0, 0);
    } else {
      now.setHours(now.getHours() + 1, 0, 0, 0);
    }
    while (now.getDay() === 0 || now.getDay() === 6) {
      now.setDate(now.getDate() + 1);
      now.setHours(9, 0, 0, 0);
    }
    return now;
  }

  function withDuration(startDate, mins) {
    const end = new Date(startDate);
    end.setMinutes(end.getMinutes() + mins);
    return end;
  }

  function buildStarterEvent(template) {
    const start = getNextBusinessSlot(new Date());
    start.setDate(start.getDate() + (template.offsetDays || 0));
    const end = withDuration(start, template.durationMins || 30);
    return {
      title: template.title,
      type: template.type || "task",
      status: "planned",
      start: toLocalDateTimeInput(start),
      end: toLocalDateTimeInput(end),
      date: formatDateKey(start),
      reminder: "15m",
      location: "",
      notes: "Starter template",
      allDay: false,
      recurrence: "none",
      recurrenceUntil: ""
    };
  }

  function normalizeEvent(event) {
    const start = normalizeInputDate(event.start || event.date || new Date().toISOString().slice(0, 16));
    const end = normalizeInputDate(event.end || start);
    return {
      id: event.id || "",
      date: event.date || toDateOnly(start),
      start: start,
      end: end,
      allDay: !!event.allDay,
      title: event.title || "",
      type: event.type || "task",
      status: event.status || "planned",
      location: event.location || "",
      notes: event.notes || "",
      reminder: event.reminder || "none",
      recurrence: event.recurrence || "none",
      recurrenceUntil: event.recurrenceUntil || "",
      appId: event.appId || null
    };
  }

  function getRenderId(event) {
    return event.renderId || event.id;
  }

  function addDays(date, days) {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
  }

  function addMonths(date, months) {
    const next = new Date(date);
    next.setMonth(next.getMonth() + months);
    return next;
  }

  function expandRecurringEvents(events) {
    const normalized = events.map(normalizeEvent);
    const rangeStart = addDays(parseDate(state.cursorDate), -42);
    const rangeEnd = addDays(parseDate(state.cursorDate), 84);
    const out = [];
    normalized.forEach(function (event) {
      const recurrence = event.recurrence || "none";
      const until = event.recurrenceUntil ? parseDate(event.recurrenceUntil + "T23:59:00") : rangeEnd;
      if (recurrence === "none") {
        out.push(Object.assign({}, event, { renderId: event.id, sourceId: event.id, isRecurringInstance: false }));
        return;
      }
      let cursor = parseDate(event.start || (event.date + "T09:00"));
      let guard = 0;
      while (cursor <= until && cursor <= rangeEnd && guard < 260) {
        if (cursor >= rangeStart) {
          const startStr = toLocalDateTimeInput(cursor);
          const srcStart = parseDate(event.start || startStr);
          const srcEnd = parseDate(event.end || event.start || startStr);
          const duration = Math.max(0, srcEnd.getTime() - srcStart.getTime());
          const end = new Date(cursor.getTime() + duration);
          const dayKey = formatDateKey(cursor);
          out.push(Object.assign({}, event, {
            date: dayKey,
            start: startStr,
            end: toLocalDateTimeInput(end),
            renderId: event.id + "__" + dayKey,
            sourceId: event.id,
            isRecurringInstance: true
          }));
        }
        if (recurrence === "daily") cursor = addDays(cursor, 1);
        else if (recurrence === "weekly") cursor = addDays(cursor, 7);
        else cursor = addMonths(cursor, 1);
        guard += 1;
      }
    });
    return out;
  }

  function getOverlapMap(events) {
    const map = {};
    const byDate = groupEventsByDate(events);
    Object.keys(byDate).forEach(function (key) {
      const list = byDate[key].map(normalizeEvent);
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const aStart = parseDate(list[i].start || (list[i].date + "T09:00"));
          const aEnd = parseDate(list[i].end || list[i].start || (list[i].date + "T09:00"));
          const bStart = parseDate(list[j].start || (list[j].date + "T09:00"));
          const bEnd = parseDate(list[j].end || list[j].start || (list[j].date + "T09:00"));
          if (aStart < bEnd && bStart < aEnd) {
            map[getRenderId(list[i])] = true;
            map[getRenderId(list[j])] = true;
          }
        }
      }
    });
    return map;
  }

  // Phase 7: calendar-wide actions in the toolbar. Two buttons:
  //   - "Export all" → bundles every event into a single .ics file
  //   - Notifications toggle → on/off, with permission-prompt fallback
  // The notifications button visually reflects three states:
  //   active   (notifications enabled + permission granted)
  //   inactive (disabled or permission default)
  //   blocked  (permission denied — user must un-block in browser settings)
  function renderCalendarToolbarActions() {
    const notif = window.CBV2.calendarNotifications;
    const permission = notif ? notif.permission() : "unsupported";
    const enabled = notif ? notif.isEnabled() : false;
    const isActive = enabled && permission === "granted";
    const isBlocked = permission === "denied";
    const isUnsupported = permission === "unsupported";
    let notifLabel, notifIcon, notifTitle, notifTone;
    if (isUnsupported) {
      notifLabel = "Notifications unavailable";
      notifIcon = "fa-bell-slash";
      notifTitle = "Browser doesn't support notifications.";
      notifTone = "btn-ghost is-disabled";
    } else if (isBlocked) {
      notifLabel = "Notifications blocked";
      notifIcon = "fa-bell-slash";
      notifTitle = "Notifications were denied. Re-enable in browser settings.";
      notifTone = "btn-ghost is-disabled";
    } else if (isActive) {
      notifLabel = "Notifications on";
      notifIcon = "fa-bell";
      notifTitle = "Browser reminders are on. Click to disable.";
      notifTone = "btn-primary";
    } else {
      notifLabel = "Enable notifications";
      notifIcon = "fa-bell";
      notifTitle = "Get a browser reminder before events.";
      notifTone = "btn-ghost";
    }
    return (
      '<button type="button" class="btn-ghost" id="calendar-export-all" title="Download all events as one .ics file">' +
        '<i class="fa-solid fa-file-arrow-down"></i> Export all' +
      '</button>' +
      '<button type="button" class="' + notifTone + '" id="calendar-notifications-toggle" title="' + notifTitle + '"' + (isUnsupported || isBlocked ? ' aria-disabled="true"' : '') + '>' +
        '<i class="fa-solid ' + notifIcon + '"></i> ' + notifLabel +
      '</button>'
    );
  }

  function renderTimeRange(event) {
    const start = parseDate(event.start || (event.date + "T09:00"));
    const end = parseDate(event.end || event.start || (event.date + "T10:00"));
    if (event.allDay) return "All day";
    return start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + " - " +
      end.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function getDirectEmailAddress() {
    const auth = window.CBV2.auth;
    const user = auth && typeof auth.getUser === "function" ? auth.getUser() : null;
    return user && user.email ? String(user.email).trim() : "";
  }

  function buildEventEmailLink(event) {
    const directEmail = getDirectEmailAddress();
    if (!directEmail) return "";
    const e = normalizeEvent(event || {});
    const subject = "Calendar event: " + (e.title || "Event");
    const lines = [
      "Event: " + (e.title || "Untitled"),
      "Type: " + (e.type || "task"),
      "Status: " + (e.status || "planned"),
      "Date: " + (e.date || ""),
      "Time: " + renderTimeRange(e),
      "Location: " + (e.location || "N/A"),
      "Notes: " + (e.notes || "N/A")
    ];
    return "mailto:" + encodeURIComponent(directEmail) +
      "?subject=" + encodeURIComponent(subject) +
      "&body=" + encodeURIComponent(lines.join("\n"));
  }

  function getHourSlots() {
    const slots = [];
    for (let h = HOUR_START; h <= HOUR_END; h++) slots.push(h);
    return slots;
  }

  function sortedEvents(events) {
    return events.slice().sort(function (a, b) {
      return String(a.start || a.date).localeCompare(String(b.start || b.date));
    });
  }

  function formatViewName(view) {
    return view.charAt(0).toUpperCase() + view.slice(1);
  }

  function renderViewToggle() {
    return VIEW_OPTIONS.map(function (view) {
      const active = state.view === view ? " is-active" : "";
      return (
        '<button type="button" class="calendar-view-btn' +
        active +
        '" data-calendar-view="' +
        view +
        '">' +
        formatViewName(view) +
        "</button>"
      );
    }).join("");
  }

  function renderFilterChips() {
    return FILTER_OPTIONS.map(function (type) {
      const label = type === "all" ? "All" : formatViewName(type);
      const active = state.filter === type ? " is-active" : "";
      return (
        '<button type="button" class="calendar-filter-chip' +
        active +
        '" data-calendar-filter="' +
        type +
        '">' +
        label +
        "</button>"
      );
    }).join("");
  }

  function renderEvent(event, overlapMap) {
    const st = window.CBV2.sanitizeText;
    const normalized = normalizeEvent(event);
    const meta = getEventMeta(normalized);
    const tone = TYPE_TONE[normalized.type] || "cyan";
    const icon = TYPE_ICON[event.type] || "fa-calendar-days";
    const location = normalized.location
      ? '<p class="event-location ai-meta"><i class="fa-solid fa-location-dot"></i> ' + st(normalized.location) + "</p>"
      : "";
    const recurrence = normalized.recurrence && normalized.recurrence !== "none"
      ? '<p class="event-meta-tag ai-meta"><i class="fa-solid fa-rotate"></i> Repeats ' + st(normalized.recurrence) + "</p>"
      : "";
    const conflict = overlapMap && overlapMap[getRenderId(normalized)]
      ? '<p class="event-conflict"><i class="fa-solid fa-triangle-exclamation"></i> Time conflict</p>'
      : "";
    return (
      '<article class="card event-card event-card--' +
      tone +
      (conflict ? " event-card--conflict" : "") +
      '" draggable="true" data-calendar-drag-id="' +
      st(getRenderId(normalized)) +
      '" data-calendar-source-id="' +
      st(normalized.sourceId || normalized.id) +
      '" data-calendar-recurring-instance="' +
      (normalized.isRecurringInstance ? "1" : "0") +
      '">' +
      '<div class="event-head"><span class="chip ' +
      tone +
      '">' +
      st(normalized.type) +
      "</span>" +
      '<span class="event-status event-status--' +
      tone +
      '">' +
      st(normalized.status || meta.status) +
      "</span></div>" +
      '<p class="event-date"><i class="fa-regular fa-calendar"></i> ' +
      st(normalized.date) +
      '<span class="ai-meta"> · ' +
      st(renderTimeRange(normalized)) +
      "</span></p>" +
      '<h3 class="event-title">' +
      '<i class="fa-solid ' +
      icon +
      '"></i><span>' +
      st(normalized.title) +
      "</span>" +
      "</h3>" +
      location +
      recurrence +
      conflict +
      '<div class="event-actions">' +
      '<button type="button" class="btn-ghost" data-calendar-edit="' + st(normalized.sourceId || normalized.id) + '">Edit</button>' +
      // Phase 7: ICS export + Google Calendar push. Both work for any
      // event with a start time; the buttons are always rendered so the
      // user can rely on them being there.
      '<button type="button" class="btn-ghost" data-calendar-export="' + st(normalized.sourceId || normalized.id) + '" title="Download as .ics for any calendar app"><i class="fa-solid fa-file-arrow-down"></i> .ics</button>' +
      '<button type="button" class="btn-ghost" data-calendar-gcal="' + st(normalized.sourceId || normalized.id) + '" title="Add to Google Calendar"><i class="fa-brands fa-google"></i> Google</button>' +
      '<button type="button" class="btn-ghost" data-calendar-email="' + st(normalized.sourceId || normalized.id) + '">Email</button>' +
      '<button type="button" class="btn-ghost" data-calendar-delete="' + st(normalized.sourceId || normalized.id) + '">Delete</button>' +
      "</div>" +
      "</article>"
    );
  }

  function renderViewNav() {
    const cursor = parseDate(state.cursorDate);
    let title = cursor.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    if (state.view === "week") {
      const start = startOfWeek(cursor);
      const end = new Date(start);
      end.setDate(end.getDate() + 6);
      title = start.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
        " - " +
        end.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    }
    if (state.view === "day") {
      title = cursor.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    }
    if (state.view === "agenda") {
      title = "Upcoming Agenda";
    }
    return (
      '<section class="card calendar-nav-row">' +
      '<div class="calendar-nav-actions">' +
      '<button type="button" class="btn-ghost" data-calendar-nav="prev"><i class="fa-solid fa-chevron-left"></i></button>' +
      '<button type="button" class="btn-ghost" data-calendar-nav="today">Today</button>' +
      '<button type="button" class="btn-ghost" data-calendar-nav="next"><i class="fa-solid fa-chevron-right"></i></button>' +
      "</div>" +
      '<h2 class="calendar-nav-title">' + window.CBV2.sanitizeText(title) + "</h2>" +
      "</section>"
    );
  }

  function groupEventsByDate(events) {
    return events.reduce(function (acc, event) {
      const key = normalizeEvent(event).date;
      if (!acc[key]) acc[key] = [];
      acc[key].push(event);
      return acc;
    }, {});
  }

  function renderMonthView(events, overlapMap) {
    const cursor = parseDate(state.cursorDate);
    const gridStart = startOfMonthGrid(cursor);
    const byDate = groupEventsByDate(events);
    let html = '<section class="calendar-month-grid">';
    for (let i = 0; i < 42; i++) {
      const day = new Date(gridStart);
      day.setDate(gridStart.getDate() + i);
      const key = formatDateKey(day);
      const inMonth = day.getMonth() === cursor.getMonth();
      const list = sortedEvents(byDate[key] || []).map(function (event) { return renderEvent(event, overlapMap); }).join("");
      html +=
        '<section class="calendar-day-cell' +
        (inMonth ? "" : " is-dim") +
        '" data-calendar-drop-date="' +
        key +
        '">' +
        '<header><strong>' + day.getDate() + '</strong><span class="ai-meta">' + formatDateLabel(day) + "</span></header>" +
        '<div class="calendar-day-events">' + list + "</div>" +
        "</section>";
    }
    html += "</section>";
    return html;
  }

  function renderWeekView(events, overlapMap) {
    const start = startOfWeek(parseDate(state.cursorDate));
    const byDate = groupEventsByDate(events);
    const slots = getHourSlots();
    let html = '<section class="calendar-week-grid">';
    for (let i = 0; i < 7; i++) {
      const day = new Date(start);
      day.setDate(start.getDate() + i);
      const key = formatDateKey(day);
      const dayEvents = sortedEvents(byDate[key] || []);
      html +=
        '<section class="calendar-week-col" data-calendar-drop-date="' +
        key +
        '">' +
        "<header><strong>" + formatDateLabel(day) + "</strong></header>" +
        '<div class="calendar-time-grid">' +
        slots.map(function (hour) {
          const hourItems = dayEvents.filter(function (event) {
            return parseDate(normalizeEvent(event).start).getHours() === hour;
          });
          const slotDateTime = key + "T" + String(hour).padStart(2, "0") + ":00";
          return (
            '<section class="calendar-time-slot" data-calendar-drop-date="' +
            key +
            '" data-calendar-drop-datetime="' +
            slotDateTime +
            '">' +
            '<span class="calendar-slot-label">' + String(hour).padStart(2, "0") + ":00</span>" +
            '<div class="calendar-day-events">' + hourItems.map(function (event) { return renderEvent(event, overlapMap); }).join("") + "</div>" +
            "</section>"
          );
        }).join("") +
        "</div>" +
        "</section>";
    }
    html += "</section>";
    return html;
  }

  function renderDayView(events, overlapMap) {
    const key = formatDateKey(parseDate(state.cursorDate));
    const list = sortedEvents(events.filter(function (event) {
      return normalizeEvent(event).date === key;
    }));
    const slots = getHourSlots();
    return (
      '<section class="calendar-day-focus" data-calendar-drop-date="' +
      key +
      '">' +
      "<header><strong>" + window.CBV2.sanitizeText(formatDateLabel(parseDate(key))) + "</strong></header>" +
      '<div class="calendar-time-grid">' +
      slots.map(function (hour) {
        const hourItems = list.filter(function (event) {
          return parseDate(normalizeEvent(event).start).getHours() === hour;
        });
        const slotDateTime = key + "T" + String(hour).padStart(2, "0") + ":00";
        const slotLabel = String(hour).padStart(2, "0") + ":00";
        return (
          '<section class="calendar-time-slot" data-calendar-drop-date="' +
          key +
          '" data-calendar-drop-datetime="' +
          slotDateTime +
          '">' +
          '<span class="calendar-slot-label">' + slotLabel + "</span>" +
          '<div class="calendar-day-events">' +
          (hourItems.length ? hourItems.map(function (event) { return renderEvent(event, overlapMap); }).join("") : "") +
          "</div></section>"
        );
      }).join("") +
      (list.length ? "" : '<p class="ai-meta">No events for this day.</p>') +
      "</div>" +
      "</section>"
    );
  }

  function renderAgendaView(events, overlapMap) {
    if (!events.length) return '<article class="card calendar-empty"><p class="ai-meta">No events to show.</p></article>';
    const byDate = groupEventsByDate(events);
    const keys = Object.keys(byDate).sort();
    return '<section class="calendar-agenda-list">' + keys.map(function (key) {
      return (
        '<article class="card calendar-agenda-group" data-calendar-drop-date="' +
        key +
        '">' +
        "<h3>" + window.CBV2.sanitizeText(formatDateLabel(parseDate(key))) + "</h3>" +
        '<div class="calendar-day-events">' + sortedEvents(byDate[key]).map(function (event) { return renderEvent(event, overlapMap); }).join("") + "</div>" +
        "</article>"
      );
    }).join("") + "</section>";
  }

  function getFilteredEvents(events) {
    const needle = state.query.trim().toLowerCase();
    return events.filter(function (event) {
      if (state.filter !== "all" && event.type !== state.filter) {
        return false;
      }
      if (!needle) return true;
      const title = String(event.title || "").toLowerCase();
      const type = String(event.type || "").toLowerCase();
      return title.indexOf(needle) >= 0 || type.indexOf(needle) >= 0 || String(event.date || "").indexOf(needle) >= 0;
    });
  }

  function renderSummary(events) {
    const total = events.length;
    const upcoming = events.filter(function (event) {
      return getEventMeta(event).days >= 0;
    }).length;
    return (
      '<p class="calendar-summary ai-meta">' +
      total +
      " events · " +
      upcoming +
      " upcoming · " +
      formatViewName(state.view) +
      " view · " +
      getLocalTimezone() +
      "</p>"
    );
  }

  function renderSidebar(events, overlapMap) {
    const upcoming = sortedEvents(events).slice(0, 6);
    const conflictCount = Object.keys(overlapMap || {}).length;
    const upcomingList = upcoming.length
      ? upcoming.map(function (event) {
          const e = normalizeEvent(event);
          return (
            '<li class="calendar-side-item">' +
            '<p><strong>' + window.CBV2.sanitizeText(e.title) + "</strong></p>" +
            '<p class="ai-meta">' + window.CBV2.sanitizeText(e.date) + " · " + window.CBV2.sanitizeText(renderTimeRange(e)) + "</p>" +
            "</li>"
          );
        }).join("")
      : '<p class="ai-meta">No upcoming events.</p>';
    return (
      '<aside class="calendar-sidebar">' +
      '<article class="card calendar-side-card calendar-side-card--priority">' +
      "<h3>Upcoming</h3>" +
      '<ul class="calendar-side-list">' + upcomingList + "</ul>" +
      "</article>" +
      '<article class="card calendar-side-card">' +
      "<h3>Conflict Center</h3>" +
      '<p class="ai-meta">Current overlaps flagged in this view.</p>' +
      '<p class="calendar-side-value">' + conflictCount + " conflict" + (conflictCount === 1 ? "" : "s") + "</p>" +
      "</article>" +
      '<article class="card calendar-side-card">' +
      "<h3>Templates</h3>" +
      '<div class="calendar-template-actions">' +
      '<button type="button" class="btn-secondary" data-calendar-template="seed">Set up starter calendar</button>' +
      "</div>" +
      "</article>" +
      "</aside>"
    );
  }

  function renderBottomStats(events, overlapMap) {
    const total = events.length;
    const conflictCount = Object.keys(overlapMap || {}).length;
    const doneCount = events.filter(function (event) {
      return normalizeEvent(event).status === "done";
    }).length;
    const doneRate = total ? Math.round((doneCount / total) * 100) : 0;
    return (
      '<section class="card calendar-stats-strip">' +
      '<p><strong>' + total + "</strong> events</p>" +
      '<p><strong>' + conflictCount + "</strong> conflicts</p>" +
      '<p><strong>' + doneRate + "%</strong> completed</p>" +
      '<p><strong>' + getLocalTimezone() + "</strong> timezone</p>" +
      "</section>"
    );
  }

  function detectFormConflicts(payload) {
    const events = expandRecurringEvents(window.CBV2.store.getEvents());
    const nextStart = parseDate(payload.start);
    const nextEnd = parseDate(payload.end);
    const clashes = events.filter(function (event) {
      if (state.editingId && (event.sourceId === state.editingId || event.id === state.editingId)) return false;
      const cur = normalizeEvent(event);
      if (cur.date !== payload.date) return false;
      const curStart = parseDate(cur.start);
      const curEnd = parseDate(cur.end || cur.start);
      return nextStart < curEnd && curStart < nextEnd;
    });
    return clashes.slice(0, 3);
  }

  function renderView() {
    const events = window.CBV2.store.getEvents();
    const expanded = expandRecurringEvents(events);
    const filtered = getFilteredEvents(expanded);
    const overlapMap = getOverlapMap(filtered);
    const list = !filtered.length
      ? '<article class="card calendar-empty"><p class="ai-meta">No events match your current filters.</p></article>'
      : state.view === "month"
        ? renderMonthView(filtered, overlapMap)
        : state.view === "week"
          ? renderWeekView(filtered, overlapMap)
          : state.view === "day"
            ? renderDayView(filtered, overlapMap)
            : renderAgendaView(filtered, overlapMap);
    return `
      <section class="page-container calendar-page">
        <section class="hero-panel calendar-hero">
          <div>
            <p class="eyebrow">Calendar</p>
            <h1 class="page-title">Calendar Overview</h1>
            <p class="page-subtitle">Interviews, follow-ups, and deadlines at a glance.</p>
            ${renderSummary(filtered)}
          </div>
          <div class="hero-actions">
            <button class="btn-primary" type="button" id="calendar-new-event">
              <i class="fa-solid fa-plus"></i> New Event
            </button>
          </div>
        </section>

        <section class="card calendar-toolbar">
          <div class="calendar-toolbar-row">
            <div class="calendar-view-toggle" role="tablist" aria-label="Calendar views">
              ${renderViewToggle()}
            </div>
            <label class="calendar-search-wrap" aria-label="Search events">
              <i class="fa-solid fa-magnifying-glass"></i>
              <input
                id="calendar-search-input"
                type="search"
                placeholder="Search by title, type, or date"
                value="${window.CBV2.sanitizeText(state.query)}"
              />
            </label>
            <!-- Phase 7: calendar-wide actions live to the right of search. -->
            <div class="calendar-toolbar-actions">
              ${renderCalendarToolbarActions()}
            </div>
          </div>
          <div class="calendar-filter-row">
            ${renderFilterChips()}
          </div>
        </section>

        ${renderViewNav()}

        <section class="calendar-workspace">
          <article class="card calendar-main-card">
            <header class="calendar-main-head">
              <div>
                <p class="eyebrow">Schedule</p>
                <h2>Schedule</h2>
              </div>
              <p class="ai-meta">Drag to reschedule, edit for details, track conflicts in real time.</p>
            </header>
            <section class="calendar-stage">
              ${list}
            </section>
          </article>
          ${renderSidebar(filtered, overlapMap)}
        </section>

        ${renderBottomStats(filtered, overlapMap)}

        <dialog id="calendar-event-modal" class="calendar-modal">
          <form method="dialog" class="card calendar-modal-card" id="calendar-event-form">
            <div class="calendar-modal-head">
              <h2>${state.editingId ? "Edit Event" : "Create Event"}</h2>
              <button type="button" class="btn-ghost" id="calendar-modal-close">Close</button>
            </div>
            <div class="form-grid">
              <label class="form-row-full">Title
                <input name="title" placeholder="Interview prep session" required />
              </label>
              <div class="form-row-full calendar-quick-presets">
                <span class="ai-meta">Quick add:</span>
                <button type="button" class="btn-ghost" data-calendar-preset="followup">Follow-up</button>
                <button type="button" class="btn-ghost" data-calendar-preset="interview">Interview Prep</button>
                <button type="button" class="btn-ghost" data-calendar-preset="deadline">Deadline Reminder</button>
              </div>
              <label>Type
                <select name="type">
                  <option value="interview">Interview</option>
                  <option value="followup">Follow-up</option>
                  <option value="deadline">Deadline</option>
                  <option value="task" selected>Task</option>
                </select>
              </label>
              <label>Status
                <select name="status">
                  <option value="planned" selected>Planned</option>
                  <option value="soon">Soon</option>
                  <option value="today">Today</option>
                  <option value="done">Done</option>
                </select>
              </label>
              <label>Start
                <input type="datetime-local" name="start" required />
              </label>
              <label>End
                <input type="datetime-local" name="end" required />
              </label>
              <div class="form-row-full calendar-duration-row">
                <span class="ai-meta">Duration:</span>
                <button type="button" class="btn-ghost" data-calendar-duration="15">15m</button>
                <button type="button" class="btn-ghost" data-calendar-duration="30">30m</button>
                <button type="button" class="btn-ghost" data-calendar-duration="60">1h</button>
              </div>
              <label>Reminder
                <select name="reminder">
                  <option value="none">None</option>
                  <option value="5m">5 mins before</option>
                  <option value="15m">15 mins before</option>
                  <option value="1h">1 hour before</option>
                  <option value="1d">1 day before</option>
                </select>
              </label>
              <label>Location
                <input name="location" placeholder="Google Meet / Office address" />
              </label>
              <label>Recurrence
                <select name="recurrence">
                  <option value="none" selected>Does not repeat</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </label>
              <label>Repeat Until
                <input type="date" name="recurrenceUntil" />
              </label>
              <label class="form-row-full">
                <span class="calendar-checkbox"><input type="checkbox" name="allDay" /> All day</span>
              </label>
              <p class="ai-meta form-row-full" id="calendar-conflict-hint"></p>
              <label class="form-row-full">Notes
                <textarea name="notes" rows="3" placeholder="Preparation notes, links, key points..."></textarea>
              </label>
            </div>
            <div class="form-actions">
              <button type="button" class="btn-ghost" id="calendar-modal-cancel">Cancel</button>
              <button type="submit" class="btn-primary">${state.editingId ? "Save Changes" : "Create Event"}</button>
            </div>
          </form>
        </dialog>
      </section>
    `;
  }

  function openModal(event) {
    const modal = document.getElementById("calendar-event-modal");
    const form = document.getElementById("calendar-event-form");
    if (!modal || !form) return;
    const source = normalizeEvent(event || {});
    form.elements.title.value = source.title || "";
    form.elements.type.value = source.type || "task";
    form.elements.status.value = source.status || "planned";
    const fallbackStart = getNextBusinessSlot(new Date());
    const fallbackEnd = withDuration(fallbackStart, 30);
    form.elements.start.value = normalizeInputDate(source.start || toLocalDateTimeInput(fallbackStart));
    form.elements.end.value = normalizeInputDate(source.end || source.start || toLocalDateTimeInput(fallbackEnd));
    form.elements.reminder.value = source.reminder || "none";
    form.elements.recurrence.value = source.recurrence || "none";
    form.elements.recurrenceUntil.value = source.recurrenceUntil || "";
    form.elements.location.value = source.location || "";
    form.elements.notes.value = source.notes || "";
    form.elements.allDay.checked = !!source.allDay;
    if (typeof modal.showModal === "function") modal.showModal();
  }

  function applyQuickPreset(form, presetType) {
    if (!form) return;
    const presets = {
      followup: { title: "Follow up with recruiter", type: "followup", reminder: "1h", duration: 30 },
      interview: { title: "Interview prep session", type: "interview", reminder: "1d", duration: 60 },
      deadline: { title: "Application deadline reminder", type: "deadline", reminder: "1d", duration: 15 }
    };
    const preset = presets[presetType];
    if (!preset) return;
    const start = getNextBusinessSlot(new Date());
    const end = withDuration(start, preset.duration);
    form.elements.title.value = preset.title;
    form.elements.type.value = preset.type;
    form.elements.reminder.value = preset.reminder;
    form.elements.start.value = toLocalDateTimeInput(start);
    form.elements.end.value = toLocalDateTimeInput(end);
  }

  function applyDurationPreset(form, mins) {
    if (!form) return;
    const startRaw = form.elements.start.value;
    if (!startRaw) return;
    const start = parseDate(startRaw);
    const end = withDuration(start, mins);
    form.elements.end.value = toLocalDateTimeInput(end);
  }

  function seedStarterCalendar() {
    if (!window.CBV2.store || typeof window.CBV2.store.addEvent !== "function") return;
    if (window.CBV2.store.getEvents().length) return;
    STARTER_TEMPLATES.forEach(function (template) {
      window.CBV2.store.addEvent(buildStarterEvent(template));
    });
    if (window.CBV2.toast && typeof window.CBV2.toast.success === "function") {
      window.CBV2.toast.success("Starter calendar created.");
    }
    window.CBV2.renderCurrentRoute();
  }

  function closeModal() {
    const modal = document.getElementById("calendar-event-modal");
    if (modal && modal.open) modal.close();
  }

  function saveEventFromForm(form) {
    if (!form) return;
    const fd = new FormData(form);
    const start = normalizeInputDate(fd.get("start"));
    const end = normalizeInputDate(fd.get("end"));
    if (!start || !end) return;
    const payload = {
      title: String(fd.get("title") || "").trim(),
      type: String(fd.get("type") || "task"),
      status: String(fd.get("status") || "planned"),
      start: start,
      end: end,
      date: toDateOnly(start),
      reminder: String(fd.get("reminder") || "none"),
      recurrence: String(fd.get("recurrence") || "none"),
      recurrenceUntil: String(fd.get("recurrenceUntil") || ""),
      location: String(fd.get("location") || "").trim(),
      notes: String(fd.get("notes") || "").trim(),
      allDay: fd.get("allDay") === "on"
    };
    if (!payload.title) return;
    if (parseDate(payload.end).getTime() <= parseDate(payload.start).getTime()) {
      if (window.CBV2.toast && typeof window.CBV2.toast.error === "function") {
        window.CBV2.toast.error("End time must be after start time.");
      }
      return;
    }
    const hint = document.getElementById("calendar-conflict-hint");
    const clashes = detectFormConflicts(payload);
    if (hint) {
      if (clashes.length) {
        hint.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> Conflict with ' + clashes.length + " existing event(s).";
        hint.classList.add("event-conflict");
      } else {
        hint.textContent = "";
        hint.classList.remove("event-conflict");
      }
    }
    if (state.editingId && typeof window.CBV2.store.updateEvent === "function") {
      window.CBV2.store.updateEvent(state.editingId, payload);
      if (window.CBV2.toast && typeof window.CBV2.toast.success === "function") {
        window.CBV2.toast.success("Event updated.");
      }
    } else {
      window.CBV2.store.addEvent(payload);
      if (window.CBV2.toast && typeof window.CBV2.toast.success === "function") {
        window.CBV2.toast.success("Event created.");
      }
    }
    state.editingId = null;
    closeModal();
    window.CBV2.renderCurrentRoute();
  }

  function shiftCursor(direction) {
    if (state.view === "day") {
      state.cursorDate = shiftDate(state.cursorDate, direction > 0 ? 1 : -1);
    } else if (state.view === "week") {
      state.cursorDate = shiftDate(state.cursorDate, direction > 0 ? 7 : -7);
    } else {
      const cursor = parseDate(state.cursorDate);
      cursor.setMonth(cursor.getMonth() + (direction > 0 ? 1 : -1));
      state.cursorDate = formatDateKey(cursor);
    }
  }

  function bindViewToggle() {
    const buttons = document.querySelectorAll("[data-calendar-view]");
    buttons.forEach(function (button) {
      button.addEventListener("click", function () {
        const nextView = String(button.getAttribute("data-calendar-view") || "");
        if (!nextView || VIEW_OPTIONS.indexOf(nextView) === -1) return;
        state.view = nextView;
        window.CBV2.renderCurrentRoute();
      });
    });
  }

  function bindTypeFilter() {
    const buttons = document.querySelectorAll("[data-calendar-filter]");
    buttons.forEach(function (button) {
      button.addEventListener("click", function () {
        const nextFilter = String(button.getAttribute("data-calendar-filter") || "");
        if (!nextFilter || FILTER_OPTIONS.indexOf(nextFilter) === -1) return;
        state.filter = nextFilter;
        window.CBV2.renderCurrentRoute();
      });
    });
  }

  function bindSearch() {
    const input = document.getElementById("calendar-search-input");
    if (!input) return;
    input.addEventListener("input", function () {
      if (state.searchDebounce) clearTimeout(state.searchDebounce);
      const nextQuery = input.value || "";
      state.searchDebounce = setTimeout(function () {
        state.query = nextQuery;
        window.CBV2.renderCurrentRoute();
      }, 120);
    });
  }

  function bindModalActions() {
    const newBtn = document.getElementById("calendar-new-event");
    const closeBtn = document.getElementById("calendar-modal-close");
    const cancelBtn = document.getElementById("calendar-modal-cancel");
    const form = document.getElementById("calendar-event-form");
    const templateBtn = document.querySelector("[data-calendar-template='seed']");
    if (newBtn) {
      newBtn.addEventListener("click", function () {
        state.editingId = null;
        openModal({});
      });
    }
    if (closeBtn) closeBtn.addEventListener("click", closeModal);
    if (cancelBtn) cancelBtn.addEventListener("click", closeModal);
    if (form) {
      form.addEventListener("submit", function (event) {
        event.preventDefault();
        saveEventFromForm(form);
      });
      const presetButtons = form.querySelectorAll("[data-calendar-preset]");
      presetButtons.forEach(function (button) {
        button.addEventListener("click", function () {
          applyQuickPreset(form, String(button.getAttribute("data-calendar-preset") || ""));
        });
      });
      const durationButtons = form.querySelectorAll("[data-calendar-duration]");
      durationButtons.forEach(function (button) {
        button.addEventListener("click", function () {
          const mins = Number(button.getAttribute("data-calendar-duration") || 0);
          if (mins > 0) applyDurationPreset(form, mins);
        });
      });
    }
    if (templateBtn) templateBtn.addEventListener("click", seedStarterCalendar);
  }

  function bindNavigation() {
    const controls = document.querySelectorAll("[data-calendar-nav]");
    controls.forEach(function (button) {
      button.addEventListener("click", function () {
        const action = String(button.getAttribute("data-calendar-nav") || "");
        if (action === "today") {
          state.cursorDate = new Date().toISOString().slice(0, 10);
        } else if (action === "prev") {
          shiftCursor(-1);
        } else if (action === "next") {
          shiftCursor(1);
        }
        window.CBV2.renderCurrentRoute();
      });
    });
  }

  function bindDragAndDrop() {
    const cards = document.querySelectorAll("[data-calendar-drag-id]");
    const lanes = document.querySelectorAll("[data-calendar-drop-date]");
    cards.forEach(function (card) {
      card.addEventListener("dragstart", function (event) {
        if (card.getAttribute("data-calendar-recurring-instance") === "1") {
          event.preventDefault();
          return;
        }
        const id = String(card.getAttribute("data-calendar-drag-id") || "");
        if (!id) return;
        if (event.dataTransfer) {
          event.dataTransfer.setData("text/plain", id);
          event.dataTransfer.effectAllowed = "move";
        }
        card.classList.add("is-dragging");
      });
      card.addEventListener("dragend", function () {
        card.classList.remove("is-dragging");
      });
    });
    lanes.forEach(function (lane) {
      lane.addEventListener("dragover", function (event) {
        event.preventDefault();
        lane.classList.add("is-drop-hover");
      });
      lane.addEventListener("dragleave", function () {
        lane.classList.remove("is-drop-hover");
      });
      lane.addEventListener("drop", function (event) {
        event.preventDefault();
        lane.classList.remove("is-drop-hover");
        const renderId = event.dataTransfer ? event.dataTransfer.getData("text/plain") : "";
        const id = renderId.split("__")[0];
        const nextDate = String(lane.getAttribute("data-calendar-drop-date") || "");
        const nextDateTime = String(lane.getAttribute("data-calendar-drop-datetime") || "");
        if (!id || !nextDate) return;
        const current = window.CBV2.store.getEvents().find(function (item) { return item.id === id; });
        if (!current || typeof window.CBV2.store.updateEvent !== "function") return;
        const normalized = normalizeEvent(current);
        const start = parseDate(normalized.start || normalized.date);
        const end = parseDate(normalized.end || normalized.start || normalized.date);
        const durationMs = Math.max(0, end.getTime() - start.getTime());
        const nextStart = nextDateTime
          ? parseDate(nextDateTime)
          : parseDate(nextDate + "T" + String(normalized.start || "").slice(11, 16));
        const nextEnd = new Date(nextStart.getTime() + durationMs);
        window.CBV2.store.updateEvent(id, {
          date: nextDate,
          start: normalizeInputDate(toLocalDateTimeInput(nextStart)),
          end: normalizeInputDate(toLocalDateTimeInput(nextEnd))
        });
        if (window.CBV2.toast && typeof window.CBV2.toast.info === "function") {
          window.CBV2.toast.info("Event rescheduled.");
        }
        window.CBV2.renderCurrentRoute();
      });
    });
  }

  function bindCardActions() {
    const editButtons = document.querySelectorAll("[data-calendar-edit]");
    const emailButtons = document.querySelectorAll("[data-calendar-email]");
    const deleteButtons = document.querySelectorAll("[data-calendar-delete]");
    // Phase 7: per-event ICS download + Google Calendar template link.
    const exportButtons = document.querySelectorAll("[data-calendar-export]");
    const gcalButtons = document.querySelectorAll("[data-calendar-gcal]");
    const ics = window.CBV2.calendarIcs;
    const gcal = window.CBV2.calendarGcal;
    function findEvent(id) {
      if (!id) return null;
      const events = (window.CBV2.store && window.CBV2.store.getEvents()) || [];
      return events.find(function (e) { return e.id === id || e.sourceId === id; }) || null;
    }
    exportButtons.forEach(function (button) {
      button.addEventListener("click", function () {
        const id = String(button.getAttribute("data-calendar-export") || "");
        const event = findEvent(id);
        if (!event || !ics) {
          if (window.CBV2.toast) window.CBV2.toast.error("Cannot export event.");
          return;
        }
        const body = ics.buildEventIcs(normalizeEvent(event));
        if (!body) {
          if (window.CBV2.toast) window.CBV2.toast.error("Event is missing a start time.");
          return;
        }
        // Safe filename: lowercased title with non-alphanumerics → "-".
        const slug = String(event.title || "event").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "event";
        ics.downloadIcs("careerboost-" + slug + ".ics", body);
        if (window.CBV2.toast) window.CBV2.toast.success(".ics downloaded.");
      });
    });
    gcalButtons.forEach(function (button) {
      button.addEventListener("click", function () {
        const id = String(button.getAttribute("data-calendar-gcal") || "");
        const event = findEvent(id);
        if (!event || !gcal) {
          if (window.CBV2.toast) window.CBV2.toast.error("Cannot build Google Calendar link.");
          return;
        }
        const url = gcal.buildGoogleCalUrl(normalizeEvent(event));
        if (!url) {
          if (window.CBV2.toast) window.CBV2.toast.error("Event is missing a title or start time.");
          return;
        }
        // Open in a new tab; user confirms with one click in Google's
        // template page. No OAuth, no scope grants.
        window.open(url, "_blank", "noopener,noreferrer");
      });
    });
    editButtons.forEach(function (button) {
      button.addEventListener("click", function () {
        const id = String(button.getAttribute("data-calendar-edit") || "");
        const event = window.CBV2.store.getEvents().find(function (item) { return item.id === id; });
        if (!event) return;
        state.editingId = id;
        openModal(event);
      });
    });
    emailButtons.forEach(function (button) {
      button.addEventListener("click", function () {
        const id = String(button.getAttribute("data-calendar-email") || "");
        const event = window.CBV2.store.getEvents().find(function (item) { return item.id === id; });
        if (!event) return;
        const mailto = buildEventEmailLink(event);
        if (!mailto) {
          if (window.CBV2.toast && typeof window.CBV2.toast.error === "function") {
            window.CBV2.toast.error("No account email found for direct event email.");
          }
          return;
        }
        window.location.href = mailto;
      });
    });
    deleteButtons.forEach(function (button) {
      button.addEventListener("click", function () {
        const id = String(button.getAttribute("data-calendar-delete") || "");
        if (!id) return;
        window.CBV2.store.deleteEvent(id);
        if (window.CBV2.toast && typeof window.CBV2.toast.success === "function") {
          window.CBV2.toast.success("Event deleted.");
        }
        if (state.editingId === id) state.editingId = null;
        window.CBV2.renderCurrentRoute();
      });
    });
  }

  // Phase 7: bind the toolbar action buttons (Export all + notifications).
  function bindToolbarActions() {
    const exportAll = document.getElementById("calendar-export-all");
    const notifBtn = document.getElementById("calendar-notifications-toggle");
    const ics = window.CBV2.calendarIcs;
    const notif = window.CBV2.calendarNotifications;
    if (exportAll && ics) {
      exportAll.addEventListener("click", function () {
        const events = (window.CBV2.store && window.CBV2.store.getEvents()) || [];
        if (!events.length) {
          if (window.CBV2.toast) window.CBV2.toast.info("No events to export.");
          return;
        }
        const normalized = events.map(normalizeEvent);
        const body = ics.buildEventsIcs(normalized, { calendarName: "CareerBoost" });
        ics.downloadIcs("careerboost-calendar.ics", body);
        if (window.CBV2.toast) window.CBV2.toast.success("Exported " + events.length + " event" + (events.length === 1 ? "" : "s") + ".");
      });
    }
    if (notifBtn && notif) {
      const permission = notif.permission();
      const blocked = permission === "denied" || permission === "unsupported";
      if (blocked) {
        // Button is informational only when blocked/unsupported. Clicking
        // shows a toast explaining what to do.
        notifBtn.addEventListener("click", function () {
          if (!window.CBV2.toast) return;
          if (permission === "unsupported") {
            window.CBV2.toast.info("This browser doesn't support notifications.");
          } else {
            window.CBV2.toast.info("Notifications are blocked. Re-enable in your browser site settings.");
          }
        });
        return;
      }
      notifBtn.addEventListener("click", async function () {
        if (notif.isEnabled() && notif.permission() === "granted") {
          notif.setEnabled(false);
          if (window.CBV2.toast) window.CBV2.toast.info("Event notifications disabled.");
          window.CBV2.renderCurrentRoute();
          return;
        }
        // Not enabled (or no permission yet) → request + enable.
        const state = await notif.requestPermission();
        if (state === "granted") {
          notif.setEnabled(true);
          if (window.CBV2.toast) window.CBV2.toast.success("Notifications enabled. You'll get reminders before events.");
        } else if (state === "denied") {
          if (window.CBV2.toast) window.CBV2.toast.error("Notifications denied. Update your browser site settings to re-enable.");
        }
        window.CBV2.renderCurrentRoute();
      });
    }
  }

  window.CBV2.routes.calendar = renderView;
  window.CBV2.afterRender.calendar = function () {
    bindViewToggle();
    bindTypeFilter();
    bindSearch();
    bindNavigation();
    bindModalActions();
    bindCardActions();
    bindDragAndDrop();
    bindToolbarActions();
  };
})();
