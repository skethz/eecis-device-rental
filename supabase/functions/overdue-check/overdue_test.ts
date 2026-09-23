import { assertEquals } from "jsr:@std/assert";
import { runOverdue } from "./index.ts";
import { FakeClient, type Call, type Result } from "../_shared/test_fakes.ts";
import type { Mail } from "../_shared/email.ts";

const today = "2026-09-08";

function device() {
  return { name: "Saleae", maker: null, model: null, unit_no: 3 };
}

const rowNotWarned = {
  id: 7, borrower_name: "Ana", borrower_email: "ana@ethz.ch", manager_name: "Max", manager_email: "max@ethz.ch",
  professor_name: "Prof X", professor_email: "x@ethz.ch", start_date: "2026-08-01", end_date: "2026-09-05",
  status: "approved", last_warned_on: null, device: device(),
};
const rowWarnedToday = { ...rowNotWarned, id: 8, last_warned_on: today };

Deno.test("warns overdue rentals not yet warned today, skips already-warned", async () => {
  let updateCalled = false;
  const db = new FakeClient((table, calls, idx) => {
    if (idx === 0) {
      // DB applies the .or(last_warned_on.is.null, last_warned_on.lt.today) filter.
      const rows = [rowNotWarned, rowWarnedToday].filter((r) => r.last_warned_on === null || r.last_warned_on < today);
      return { data: rows, error: null };
    }
    if (table === "extension_requests") return { data: [], error: null };
    if (table === "rentals" && calls.some((c) => c.method === "update")) { updateCalled = true; return { data: null, error: null }; }
    throw new Error("unexpected call " + idx);
  });
  const sent: Mail[] = [];
  const n = await runOverdue({ db, labManager: "lab@ethz.ch", send: (m: Mail) => { sent.push(m); return Promise.resolve(); } }, today);
  assertEquals(n, 1);
  assertEquals(sent.length, 1);
  assertEquals(sent[0].to.length, 4);
  assertEquals(updateCalled, true);
});

Deno.test("does not mark warned and does not throw when send fails", async () => {
  let updateCalled = false;
  const db = new FakeClient((table, _calls, idx) => {
    if (idx === 0) return { data: [rowNotWarned], error: null };
    if (table === "extension_requests") return { data: [], error: null };
    updateCalled = true;
    return { data: null, error: null };
  });
  const origError = console.error;
  console.error = () => {};
  try {
    const n = await runOverdue({ db, labManager: "lab@ethz.ch", send: () => Promise.reject(new Error("mailer down")) }, today);
    assertEquals(n, 0);
    assertEquals(updateCalled, false);
  } finally {
    console.error = origError;
  }
});

Deno.test("does not count a warning whose last_warned_on update failed", async () => {
  const db = new FakeClient((table, _calls, idx) => {
    if (idx === 0) return { data: [rowNotWarned], error: null };
    if (table === "extension_requests") return { data: [], error: null };
    return { data: null, error: { code: "42501", message: "permission denied" } };
  });
  const sent: Mail[] = [];
  const origError = console.error;
  const logged: unknown[][] = [];
  console.error = (...a: unknown[]) => { logged.push(a); };
  try {
    const n = await runOverdue({ db, labManager: "lab@ethz.ch", send: (m: Mail) => { sent.push(m); return Promise.resolve(); } }, today);
    assertEquals(n, 0);
    assertEquals(sent.length, 1);
    assertEquals(logged.length, 1);
  } finally {
    console.error = origError;
  }
});

// extension_requests rows by rental id; the fake applies the query's eq("status")
// and in("rental_id") filters the way PostgREST would.
function extensionFake(extensions: { rental_id: number; status: string }[], updated: number[]) {
  const rowPaused = { ...rowNotWarned, id: 9 };
  const db = new FakeClient((table, calls, idx) => {
    if (idx === 0) return { data: [rowNotWarned, rowPaused], error: null };
    if (table === "extension_requests") {
      const status = calls.find((c) => c.method === "eq")?.args[1];
      const ids = calls.find((c) => c.method === "in")?.args[1] as number[];
      assertEquals(ids, [7, 9]);
      return { data: extensions.filter((e) => e.status === status && ids.includes(e.rental_id)).map((e) => ({ rental_id: e.rental_id })), error: null };
    }
    if (table === "rentals" && calls.some((c) => c.method === "update")) {
      updated.push(calls.find((c) => c.method === "eq")?.args[1] as number);
      return { data: null, error: null };
    }
    throw new Error("unexpected call " + idx);
  });
  return db;
}

Deno.test("pauses warnings for a rental with a pending extension request", async () => {
  const updated: number[] = [];
  const db = extensionFake([{ rental_id: 9, status: "pending" }], updated);
  const sent: Mail[] = [];
  const n = await runOverdue({ db, labManager: "lab@ethz.ch", send: (m: Mail) => { sent.push(m); return Promise.resolve(); } }, today);
  assertEquals(n, 1);
  assertEquals(sent.length, 1);
  assertEquals(updated, [7]); // rental 9's last_warned_on is left untouched
});

Deno.test("warns as before when the rental's extension requests are all decided", async () => {
  const updated: number[] = [];
  const db = extensionFake([{ rental_id: 9, status: "denied" }, { rental_id: 7, status: "approved" }], updated);
  const sent: Mail[] = [];
  const n = await runOverdue({ db, labManager: "lab@ethz.ch", send: (m: Mail) => { sent.push(m); return Promise.resolve(); } }, today);
  assertEquals(n, 2);
  assertEquals(sent.length, 2);
  assertEquals(updated, [7, 9]);
});

Deno.test("queries extension_requests only for pending status", async () => {
  const db = extensionFake([], []);
  await runOverdue({ db, labManager: "lab@ethz.ch", send: () => Promise.resolve() }, today);
  const ext = db.fromCalls.find((f) => f.table === "extension_requests")!;
  assertEquals(ext.calls.find((c) => c.method === "eq")?.args, ["status", "pending"]);
  assertEquals(db.fromCalls.filter((f) => f.table === "extension_requests").length, 1);
});
