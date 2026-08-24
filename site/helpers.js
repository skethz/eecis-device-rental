// Pure helper functions shared by app.js and app_test.js.
// Keep this file free of any side effects (no supabase client creation, no DOM access
// at import time) so it can be imported under Deno for unit tests.

// A device with `labelled === false` exists but carries no physical "Nr.x" sticker,
// so naming a unit number for it would be misleading.
export function deviceLabel(d) {
  const base = [d.name, d.maker, d.model].filter(Boolean).join(" ");
  return d.labelled === false ? base : `${base} Nr.${d.unit_no}`;
}

// Deterministic device ordering: name, then maker, then model (all compared
// case-insensitively), then unit number ascending so Nr.1 comes before Nr.2 ... Nr.6.
// Plain < / > rather than localeCompare, so the order does not depend on the browser's
// locale; the row id is the final tiebreak so it never depends on server row order.
export function compareDevices(a, b) {
  const text = (v) => String(v ?? "").toLowerCase();
  const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  const rowId = (d) => Number(d.id ?? d.device_id ?? 0);
  return (
    cmp(text(a.name), text(b.name)) ||
    cmp(text(a.maker), text(b.maker)) ||
    cmp(text(a.model), text(b.model)) ||
    (Number(a.unit_no) || 0) - (Number(b.unit_no) || 0) ||
    rowId(a) - rowId(b)
  );
}

// Copy first: the caller's array (a PostgREST result) is left untouched.
export function sortDevices(rows) {
  return [...rows].sort(compareDevices);
}

// One line of a device's status column, e.g.
// "2026-09-01 – 2026-09-05 — Borrower: Ana (ana@ethz.ch); Lab manager: Max (max@ethz.ch); Professor: Prof X (x@ethz.ch)"
// Pending (not yet approved) requests get a "Pending: " prefix.
// The row comes from the device_status view, which every signed-in user may read.
export function statusLine(s) {
  const prefix = s.status === "approved" ? "" : "Pending: ";
  return `${prefix}${s.start_date} \u2013 ${s.end_date} \u2014 ` +
    `Borrower: ${s.borrower_name} (${s.borrower_email}); ` +
    `Lab manager: ${s.manager_name} (${s.manager_email}); ` +
    `Professor: ${s.professor_name} (${s.professor_email})`;
}

// Approved rentals first (they are the ones actually holding the device), then pending
// requests; within each, earliest start first, with the rental id as the final tiebreak.
export function sortStatusRows(rows) {
  const rank = (r) => (r.status === "approved" ? 0 : 1);
  const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  return [...rows].sort((a, b) =>
    rank(a) - rank(b) ||
    cmp(String(a.start_date), String(b.start_date)) ||
    (Number(a.rental_id) || 0) - (Number(b.rental_id) || 0)
  );
}

export function isEthz(email) {
  return /(^|@|\.)ethz\.ch$/i.test(email) && email.includes("@");
}

// PostgREST normally serialises a daterange[] column as a JS array of range-text
// strings, e.g. ["[2026-09-01,2026-09-06)", ...]. Some drivers/paths instead hand
// back the raw Postgres array literal as a single string, e.g.
// '{"[2026-09-01,2026-09-06)"}' (or without quotes: '{[2026-09-01,2026-09-06)}').
// Normalise both shapes to a plain array of range-text strings.
export function normaliseBusy(busy) {
  if (Array.isArray(busy)) return busy;
  if (typeof busy === "string") {
    const inner = busy.trim().replace(/^\{/, "").replace(/\}$/, "");
    if (inner === "") return [];
    // Split on commas that are between range entries, i.e. right after a ')' or ']'
    // and optionally a closing quote. This avoids splitting on the comma that
    // separates the two dates inside a single range.
    return inner
      .split(/(?<=[)\]]"?),(?="?\[)/)
      .map((s) => s.trim().replace(/^"/, "").replace(/"$/, ""))
      .filter(Boolean);
  }
  return [];
}

// Today's date as YYYY-MM-DD in the browser's local timezone. Do NOT use
// `new Date().toISOString().slice(0,10)` for this: toISOString() converts to UTC
// first, so for users in Zurich (UTC+1/+2) the date would be wrong for the first
// 1-2 hours after local midnight.
export function todayLocal(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Add n days to a YYYY-MM-DD date string, done via local calendar components so it
// matches todayLocal() and handles month/year rollover correctly.
export function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return todayLocal(dt);
}

export function overlaps(busy, start, end) {
  // busy: ["[2026-09-01,2026-09-06)", ...] (Postgres daterange text), or the raw
  // array-literal string form; see normaliseBusy above. Upper bound is exclusive.
  return normaliseBusy(busy).some((r) => {
    const m = r.match(/\[(\d{4}-\d{2}-\d{2}),(\d{4}-\d{2}-\d{2})\)/);
    return m && start < m[2] && end >= m[1];
  });
}

export const $ = (s) => document.querySelector(s);
