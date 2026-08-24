// Run with: deno test site/app_test.js
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { deviceLabel, isEthz, overlaps, sortDevices, sortStatusRows, statusLine, todayLocal, addDays } from "./helpers.js";

Deno.test("deviceLabel joins name/maker/model and appends unit number", () => {
  assertEquals(
    deviceLabel({ name: "Precision Source", maker: "Keysight", model: "B2912A/B", unit_no: 2 }),
    "Precision Source Keysight B2912A/B Nr.2",
  );
});

Deno.test("deviceLabel skips missing maker/model", () => {
  assertEquals(deviceLabel({ name: "Saleae", maker: null, model: null, unit_no: 5 }), "Saleae Nr.5");
});

Deno.test("deviceLabel omits the unit number for an unlabelled device", () => {
  assertEquals(
    deviceLabel({ name: "Isolation Transformer", maker: "Eaton", model: "IS1000HGDV", unit_no: 1, labelled: false }),
    "Isolation Transformer Eaton IS1000HGDV",
  );
  assertEquals(
    deviceLabel({ name: "Opal Kelly XEM7360-K410T", maker: null, model: null, unit_no: 1, labelled: false }),
    "Opal Kelly XEM7360-K410T",
  );
});

Deno.test("deviceLabel keeps the unit number when labelled is true or absent", () => {
  assertEquals(deviceLabel({ name: "Saleae", maker: null, model: null, unit_no: 5, labelled: true }), "Saleae Nr.5");
});

Deno.test("isEthz accepts ethz.ch and subdomains", () => {
  assertEquals(isEthz("alice@ethz.ch"), true);
  assertEquals(isEthz("bob@student.ethz.ch"), true);
});

Deno.test("isEthz rejects non-ethz and malformed addresses", () => {
  assertEquals(isEthz("alice@example.com"), false);
  assertEquals(isEthz("notethz.ch"), false);
  assertEquals(isEthz("alice@notethz.ch"), false);
});

Deno.test("overlaps detects a conflicting range from a plain JS array (normal PostgREST shape)", () => {
  const busy = ["[2026-09-01,2026-09-06)"];
  assertEquals(overlaps(busy, "2026-09-05", "2026-09-10"), true);
  assertEquals(overlaps(busy, "2026-09-06", "2026-09-10"), false); // upper bound exclusive
  assertEquals(overlaps(busy, "2026-08-01", "2026-08-31"), false);
});

Deno.test("overlaps normalises a Postgres array-literal string (quoted ranges)", () => {
  const busy = '{"[2026-09-01,2026-09-06)","[2026-10-01,2026-10-06)"}';
  assertEquals(overlaps(busy, "2026-09-05", "2026-09-10"), true);
  assertEquals(overlaps(busy, "2026-10-05", "2026-10-10"), true);
  assertEquals(overlaps(busy, "2026-09-06", "2026-09-30"), false);
});

Deno.test("overlaps normalises a Postgres array-literal string (unquoted single range)", () => {
  const busy = "{[2026-09-01,2026-09-06)}";
  assertEquals(overlaps(busy, "2026-09-01", "2026-09-02"), true);
  assertEquals(overlaps(busy, "2026-09-06", "2026-09-07"), false);
});

Deno.test("overlaps returns false for empty busy list", () => {
  assertEquals(overlaps([], "2026-09-01", "2026-09-02"), false);
  assertEquals(overlaps("{}", "2026-09-01", "2026-09-02"), false);
});

Deno.test("todayLocal uses local calendar date, not the UTC date", () => {
  // Constructed with explicit local y/m/d/h/min args, so this is local 2026-01-15
  // 00:30 regardless of the machine's timezone. Using toISOString().slice(0,10)
  // instead (which converts to UTC first) would return 2026-01-14 for any
  // positive UTC offset (e.g. Zurich, UTC+1/+2) at this local time.
  const d = new Date(2026, 0, 15, 0, 30);
  assertEquals(todayLocal(d), "2026-01-15");
});

Deno.test("todayLocal pads month and day to two digits", () => {
  assertEquals(todayLocal(new Date(2026, 8, 5, 12, 0)), "2026-09-05");
});

Deno.test("addDays advances by n days, including month and year rollover", () => {
  assertEquals(addDays("2026-09-06", 1), "2026-09-07");
  assertEquals(addDays("2026-01-31", 1), "2026-02-01");
  assertEquals(addDays("2026-12-31", 1), "2027-01-01");
});

Deno.test("sortDevices orders by name, maker, model, then unit number", () => {
  const rows = [
    { id: 5, name: "Saleae", maker: null, model: null, unit_no: 6 },
    { id: 1, name: "Precision Source", maker: "Keysight", model: "B2912A/B", unit_no: 2 },
    { id: 4, name: "Saleae", maker: null, model: null, unit_no: 1 },
    { id: 2, name: "Precision Source", maker: "Keysight", model: "B2902A", unit_no: 1 },
    { id: 3, name: "Precision Source", maker: "Keysight", model: "B2912A/B", unit_no: 1 },
  ];
  assertEquals(sortDevices(rows).map((d) => d.id), [2, 3, 1, 4, 5]);
});

Deno.test("sortDevices compares names case-insensitively", () => {
  const rows = [
    { device_id: 1, name: "zx60-83LN-S+", maker: null, model: null, unit_no: 1 },
    { device_id: 2, name: "ZX47-60LN-S+", maker: null, model: null, unit_no: 1 },
    { device_id: 3, name: "analog Discovery", maker: null, model: null, unit_no: 1 },
    { device_id: 4, name: "Analog Discovery", maker: null, model: null, unit_no: 2 },
  ];
  assertEquals(sortDevices(rows).map((d) => d.device_id), [3, 4, 2, 1]);
});

Deno.test("sortDevices treats a null maker/model as empty and leaves the input untouched", () => {
  const rows = [
    { id: 2, name: "Opal Kelly", maker: "Digilent", model: null, unit_no: 1 },
    { id: 1, name: "Opal Kelly", maker: null, model: null, unit_no: 1 },
  ];
  assertEquals(sortDevices(rows).map((d) => d.id), [1, 2]);
  assertEquals(rows.map((d) => d.id), [2, 1]);
});

const statusRow = {
  device_id: 3,
  rental_id: 9,
  status: "approved",
  start_date: "2026-09-01",
  end_date: "2026-09-05",
  borrower_name: "Ana Example",
  borrower_email: "ana@ethz.ch",
  manager_name: "Max M",
  manager_email: "max@ethz.ch",
  professor_name: "Prof X",
  professor_email: "x@ethz.ch",
};

Deno.test("statusLine renders an approved rental with all three contacts", () => {
  assertEquals(
    statusLine(statusRow),
    "2026-09-01 \u2013 2026-09-05 \u2014 Borrower: Ana Example (ana@ethz.ch); " +
      "Lab manager: Max M (max@ethz.ch); Professor: Prof X (x@ethz.ch)",
  );
});

Deno.test("statusLine labels a pending request as Pending", () => {
  const line = statusLine({ ...statusRow, status: "pending" });
  assertEquals(line.startsWith("Pending: 2026-09-01"), true);
});

Deno.test("sortStatusRows puts approved before pending, then earliest start first", () => {
  const rows = [
    { ...statusRow, rental_id: 1, status: "pending", start_date: "2026-09-01" },
    { ...statusRow, rental_id: 2, status: "approved", start_date: "2026-10-01" },
    { ...statusRow, rental_id: 3, status: "approved", start_date: "2026-09-01" },
    { ...statusRow, rental_id: 4, status: "pending", start_date: "2026-08-01" },
  ];
  assertEquals(sortStatusRows(rows).map((r) => r.rental_id), [3, 2, 4, 1]);
  assertEquals(rows.map((r) => r.rental_id), [1, 2, 3, 4]);
});
