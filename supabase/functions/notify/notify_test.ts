import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { handleNotify } from "./index.ts";
import { FakeClient, type Call, type Result } from "../_shared/test_fakes.ts";
import type { Mail } from "../_shared/email.ts";

const rentalFixture = {
  id: 7,
  borrower_name: "Ana",
  borrower_email: "ana@ethz.ch",
  manager_name: "Max",
  manager_email: "max@ethz.ch",
  professor_name: "Prof X",
  professor_email: "x@ethz.ch",
  start_date: "2026-09-01",
  end_date: "2026-09-05",
  status: "approved",
  device: { name: "Saleae", maker: null, model: null, unit_no: 3 },
};

function harness(resolver: (table: string, calls: Call[], idx: number) => Result) {
  const db = new FakeClient(resolver);
  const sent: Mail[] = [];
  const deps = {
    db,
    send: (m: Mail) => { sent.push(m); return Promise.resolve(); },
    labManager: "lab@ethz.ch",
    siteUrl: "https://f",
  };
  return { db, sent, deps };
}

Deno.test("rentals INSERT sends request mail to lab manager then a receipt to the borrower", async () => {
  const { sent, deps } = harness((_table, _calls, idx) => {
    if (idx === 0) return { data: rentalFixture, error: null };
    if (idx === 1) return { data: { token: "t1" }, error: null };
    throw new Error("unexpected from() call " + idx);
  });
  const res = await handleNotify({ type: "INSERT", table: "rentals", record: { id: 7 }, old_record: null }, deps);
  assertEquals(res.status, 200);
  assertEquals(sent.length, 2);
  assertEquals(sent[0].to, ["lab@ethz.ch"]);
  assertStringIncludes(sent[0].html, "decide.html?token=t1&action=approve");
  assertEquals(sent[1].to, ["ana@ethz.ch"]);
  assertStringIncludes(sent[1].subject, "received");
});

Deno.test("extension_requests INSERT sends extension mail then a receipt to the borrower", async () => {
  const { sent, deps } = harness((_table, _calls, idx) => {
    if (idx === 0) return { data: rentalFixture, error: null };
    if (idx === 1) return { data: { token: "t2" }, error: null };
    throw new Error("unexpected from() call " + idx);
  });
  const res = await handleNotify(
    { type: "INSERT", table: "extension_requests", record: { id: 5, rental_id: 7, new_end_date: "2026-09-10" }, old_record: null },
    deps,
  );
  assertEquals(res.status, 200);
  assertEquals(sent.length, 2);
  assertStringIncludes(sent[0].subject, "Extension");
  assertStringIncludes(sent[0].html, "decide.html?token=t2&action=approve");
  assertEquals(sent[1].to, ["ana@ethz.ch"]);
  assertStringIncludes(sent[1].subject, "Extension request #7 received");
  assertStringIncludes(sent[1].html, "2026-09-10");
});

Deno.test("rentals INSERT still returns 200 when the receipt mail fails", async () => {
  const { sent, deps } = harness((_table, _calls, idx) => {
    if (idx === 0) return { data: rentalFixture, error: null };
    if (idx === 1) return { data: { token: "t1" }, error: null };
    throw new Error("unexpected from() call " + idx);
  });
  let calls = 0;
  const originalSend = deps.send;
  deps.send = (m) => {
    calls++;
    if (calls === 2) return Promise.reject(new Error("receipt boom"));
    return originalSend(m);
  };
  const origError = console.error;
  console.error = () => {}; // the handler logs the swallowed failure; keep test output clean
  try {
    const res = await handleNotify({ type: "INSERT", table: "rentals", record: { id: 7 }, old_record: null }, deps);
    assertEquals(res.status, 200);
    assertEquals(sent.length, 1); // only the lab-manager mail made it into `sent`
  } finally {
    console.error = origError;
  }
});

Deno.test("rentals UPDATE to returned sends return mail", async () => {
  const { sent, deps } = harness((_table, _calls, idx) => {
    if (idx === 0) return { data: { ...rentalFixture, status: "returned" }, error: null };
    throw new Error("unexpected from() call " + idx);
  });
  const res = await handleNotify(
    { type: "UPDATE", table: "rentals", record: { id: 7, status: "returned" }, old_record: { id: 7, status: "approved" } },
    deps,
  );
  assertEquals(res.status, 200);
  assertEquals(sent.length, 1);
  assertEquals(sent[0].to, ["lab@ethz.ch"]);
  assertStringIncludes(sent[0].subject, "Returned");
});

Deno.test("rentals UPDATE approved to approved is ignored", async () => {
  const { sent, deps } = harness(() => { throw new Error("no db call expected"); });
  const res = await handleNotify(
    { type: "UPDATE", table: "rentals", record: { id: 7, status: "approved" }, old_record: { id: 7, status: "approved" } },
    deps,
  );
  assertEquals(res.status, 200);
  assertEquals(sent.length, 0);
});

const proposalFixture = {
  id: 3,
  user_id: "u1",
  proposer_name: "Ana",
  proposer_email: "ana@ethz.ch",
  name: "Precision Source",
  maker: "Keysight",
  model: "B2912A/B",
  unit_no: 2,
  labelled: true,
  note: "bought by our group",
  status: "pending",
};

Deno.test("device_requests INSERT mails the lab manager, then a receipt to the proposer", async () => {
  const { db, sent, deps } = harness((table, _calls, idx) => {
    if (idx === 0) { assertEquals(table, "action_tokens"); return { data: { token: "t3" }, error: null }; }
    throw new Error("unexpected from() call " + idx);
  });
  const res = await handleNotify({ type: "INSERT", table: "device_requests", record: proposalFixture, old_record: null }, deps);
  assertEquals(res.status, 200);
  // The webhook payload is the whole row, so no extra read is needed.
  assertEquals(db.fromCalls.length, 1);
  assertEquals(db.fromCalls[0].calls[0].args[0], { kind: "device", target_id: 3 });
  assertEquals(sent.length, 2);
  assertEquals(sent[0].to, ["lab@ethz.ch"]);
  assertStringIncludes(sent[0].subject, "New device proposed");
  assertStringIncludes(sent[0].html, "decide.html?token=t3&action=approve");
  assertStringIncludes(sent[0].html, "decide.html?token=t3&action=deny");
  assertEquals(sent[1].to, ["ana@ethz.ch"]);
  assertStringIncludes(sent[1].subject, "Device proposal #3 received");
});

Deno.test("device_requests INSERT still returns 200 when the proposer's receipt fails", async () => {
  const { sent, deps } = harness((_table, _calls, idx) => {
    if (idx === 0) return { data: { token: "t3" }, error: null };
    throw new Error("unexpected from() call " + idx);
  });
  const originalSend = deps.send;
  let calls = 0;
  deps.send = (m) => {
    calls++;
    if (calls === 2) return Promise.reject(new Error("receipt boom"));
    return originalSend(m);
  };
  const origError = console.error;
  console.error = () => {};
  try {
    const res = await handleNotify({ type: "INSERT", table: "device_requests", record: proposalFixture, old_record: null }, deps);
    assertEquals(res.status, 200);
    assertEquals(sent.length, 1); // only the lab-manager mail made it through
  } finally {
    console.error = origError;
  }
});

Deno.test("device_requests UPDATE is not a notification event", async () => {
  const { sent, deps } = harness(() => { throw new Error("no db call expected"); });
  const res = await handleNotify({ type: "UPDATE", table: "device_requests", record: proposalFixture, old_record: proposalFixture }, deps);
  assertEquals(res.status, 400);
  assertEquals(sent.length, 0);
});

Deno.test("unknown table returns 400", async () => {
  const { sent, deps } = harness(() => { throw new Error("no db call expected"); });
  const res = await handleNotify({ type: "INSERT", table: "devices", record: { id: 1 }, old_record: null }, deps);
  assertEquals(res.status, 400);
  assertEquals(sent.length, 0);
});
