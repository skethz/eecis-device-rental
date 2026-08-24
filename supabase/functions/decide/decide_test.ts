import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { handleDecide, handleDecideGet, handleDecidePost } from "./index.ts";
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
  status: "pending",
  device: { name: "Saleae", maker: null, model: null, unit_no: 3 },
};

function harness(resolver: (table: string, calls: Call[], idx: number) => Result, send?: (m: Mail) => Promise<void>) {
  const db = new FakeClient(resolver);
  const sent: Mail[] = [];
  const deps = { db, send: send ?? ((m: Mail) => { sent.push(m); return Promise.resolve(); }) };
  return { db, sent, deps };
}

function url(token?: string, action?: string) {
  const u = new URL("https://f/decide");
  if (token !== undefined) u.searchParams.set("token", token);
  if (action !== undefined) u.searchParams.set("action", action);
  return u;
}

// The POST body the confirmation page submits.
function form(token: string | null, action: string | null) {
  return { token, action };
}

async function body(res: Response) {
  return await res.json();
}

Deno.test("missing token returns 400", async () => {
  const { deps } = harness(() => { throw new Error("no db call expected"); });
  const res = await handleDecidePost(form(null, "approve"), deps);
  assertEquals(res.status, 400);
  const b = await body(res);
  assertEquals(b.ok, false);
});

Deno.test("unknown action returns 400", async () => {
  const { deps } = harness(() => { throw new Error("no db call expected"); });
  const res = await handleDecidePost(form("abc", "explode"), deps);
  assertEquals(res.status, 400);
  assertEquals((await body(res)).ok, false);
});

Deno.test("token not found or already used returns 410", async () => {
  const { deps } = harness((_table, _calls, idx) => {
    if (idx === 0) return { data: null, error: null };
    throw new Error("unexpected call " + idx);
  });
  const res = await handleDecidePost(form("abc", "approve"), deps);
  assertEquals(res.status, 410);
  const b = await body(res);
  assertEquals(b.ok, false);
  assertStringIncludes(b.message, "already used or is invalid");
});

Deno.test("rental approve updates status, marks token used, mails borrower", async () => {
  const { sent, deps } = harness((table, _calls, idx) => {
    if (idx === 0) return { data: { token: "abc", kind: "rental", target_id: 7, used_at: null }, error: null };
    if (idx === 1) { assertEquals(table, "rentals"); return { data: { ...rentalFixture, status: "approved" }, error: null }; }
    if (idx === 2) { assertEquals(table, "action_tokens"); return { data: null, error: null }; }
    throw new Error("unexpected call " + idx);
  });
  const res = await handleDecidePost(form("abc", "approve"), deps);
  assertEquals(res.status, 200);
  const b = await body(res);
  assertEquals(b.ok, true);
  assertEquals(b.title, "Approved");
  assertStringIncludes(b.message, "approved");
  assertEquals(sent.length, 1);
  assertEquals(sent[0].to, ["ana@ethz.ch"]);
});

Deno.test("rental deny updates status to denied", async () => {
  const { sent, deps } = harness((_table, _calls, idx) => {
    if (idx === 0) return { data: { token: "abc", kind: "rental", target_id: 7, used_at: null }, error: null };
    if (idx === 1) return { data: { ...rentalFixture, status: "denied" }, error: null };
    if (idx === 2) return { data: null, error: null };
    throw new Error("unexpected call " + idx);
  });
  const res = await handleDecidePost(form("abc", "deny"), deps);
  assertEquals(res.status, 200);
  assertEquals(sent.length, 1);
  assertStringIncludes(sent[0].subject, "denied");
});

Deno.test("rental approve: email send failure still returns 200 and keeps the decision", async () => {
  let tokenMarkedUsed = false;
  const { deps } = harness(
    (table, calls, idx) => {
      if (idx === 0) return { data: { token: "abc", kind: "rental", target_id: 7, used_at: null }, error: null };
      if (idx === 1) return { data: { ...rentalFixture, status: "approved" }, error: null };
      if (idx === 2 && table === "action_tokens" && calls.some((c) => c.method === "update")) { tokenMarkedUsed = true; return { data: null, error: null }; }
      throw new Error("unexpected call " + idx);
    },
    () => Promise.reject(new Error("mailer down")),
  );
  const origError = console.error;
  console.error = () => {};
  try {
    const res = await handleDecidePost(form("abc", "approve"), deps);
    assertEquals(res.status, 200);
    const b = await body(res);
    assertEquals(b.ok, true);
    assertStringIncludes(b.message, "approved");
    assertStringIncludes(b.message, "could not be notified automatically");
    assertEquals(tokenMarkedUsed, true);
  } finally {
    console.error = origError;
  }
});

Deno.test("extension approve updates rental end_date and extension status", async () => {
  const { sent, deps } = harness((table, _calls, idx) => {
    if (idx === 0) return { data: { token: "abc", kind: "extension", target_id: 5, used_at: null }, error: null };
    if (idx === 1) { assertEquals(table, "extension_requests"); return { data: { id: 5, rental_id: 7, new_end_date: "2026-09-10", status: "pending" }, error: null }; }
    if (idx === 2) { assertEquals(table, "rentals"); return { data: { ...rentalFixture, status: "approved" }, error: null }; } // active-rental check
    if (idx === 3) { assertEquals(table, "rentals"); return { data: { ...rentalFixture, end_date: "2026-09-10" }, error: null }; } // end_date update
    if (idx === 4) { assertEquals(table, "extension_requests"); return { data: { id: 5, status: "approved" }, error: null }; } // conditional pending->approved
    if (idx === 5) { assertEquals(table, "action_tokens"); return { data: null, error: null }; }
    throw new Error("unexpected call " + idx);
  });
  const res = await handleDecidePost(form("abc", "approve"), deps);
  assertEquals(res.status, 200);
  assertEquals(sent.length, 1);
  assertEquals(sent[0].to, ["ana@ethz.ch"]);
});

Deno.test("extension approve: rental no longer active returns 410, nothing changed", async () => {
  const { sent, deps } = harness((table, _calls, idx) => {
    if (idx === 0) return { data: { token: "abc", kind: "extension", target_id: 5, used_at: null }, error: null };
    if (idx === 1) return { data: { id: 5, rental_id: 7, new_end_date: "2026-09-10", status: "pending" }, error: null };
    if (idx === 2) { assertEquals(table, "rentals"); return { data: null, error: null }; } // rental not approved anymore
    throw new Error("unexpected call " + idx);
  });
  const res = await handleDecidePost(form("abc", "approve"), deps);
  assertEquals(res.status, 410);
  assertStringIncludes((await body(res)).message, "no longer active");
  assertEquals(sent.length, 0);
});

Deno.test("extension approve conflict (23P01) returns 409, stays pending, token not consumed", async () => {
  let extensionUpdated = false, tokenUpdated = false;
  const { sent, deps } = harness((table, calls, idx) => {
    if (idx === 0) return { data: { token: "abc", kind: "extension", target_id: 5, used_at: null }, error: null };
    if (idx === 1) return { data: { id: 5, rental_id: 7, new_end_date: "2026-09-10", status: "pending" }, error: null };
    if (idx === 2) return { data: { ...rentalFixture, status: "approved" }, error: null }; // active-rental check passes
    if (idx === 3) return { data: null, error: { code: "23P01", message: "conflict" } }; // end_date update conflicts
    if (table === "extension_requests" && calls.some((c) => c.method === "update")) { extensionUpdated = true; return { data: null, error: null }; }
    if (table === "action_tokens" && calls.some((c) => c.method === "update")) { tokenUpdated = true; return { data: null, error: null }; }
    throw new Error("unexpected call " + idx);
  });
  const res = await handleDecidePost(form("abc", "approve"), deps);
  assertEquals(res.status, 409);
  assertStringIncludes((await body(res)).message, "conflicts");
  assertEquals(sent.length, 0);
  assertEquals(extensionUpdated, false);
  assertEquals(tokenUpdated, false);
});

Deno.test("extension approve: duplicate click (already decided) returns 410, no double mail", async () => {
  let tokenUpdated = false;
  const { sent, deps } = harness((table, calls, idx) => {
    if (idx === 0) return { data: { token: "abc", kind: "extension", target_id: 5, used_at: null }, error: null };
    if (idx === 1) return { data: { id: 5, rental_id: 7, new_end_date: "2026-09-10", status: "pending" }, error: null };
    if (idx === 2) return { data: { ...rentalFixture, status: "approved" }, error: null };
    if (idx === 3) return { data: { ...rentalFixture, end_date: "2026-09-10" }, error: null };
    if (idx === 4) return { data: null, error: null }; // conditional update lost the race: 0 rows
    if (table === "action_tokens" && calls.some((c) => c.method === "update")) { tokenUpdated = true; return { data: null, error: null }; }
    throw new Error("unexpected call " + idx);
  });
  const res = await handleDecidePost(form("abc", "approve"), deps);
  assertEquals(res.status, 410);
  assertStringIncludes((await body(res)).message, "already decided");
  assertEquals(sent.length, 0);
  assertEquals(tokenUpdated, false);
});

Deno.test("extension deny mails borrower that it was denied", async () => {
  const { sent, deps } = harness((table, _calls, idx) => {
    if (idx === 0) return { data: { token: "abc", kind: "extension", target_id: 5, used_at: null }, error: null };
    if (idx === 1) return { data: { id: 5, rental_id: 7, new_end_date: "2026-09-10", status: "pending" }, error: null };
    if (idx === 2) { assertEquals(table, "rentals"); return { data: rentalFixture, error: null }; }
    if (idx === 3) { assertEquals(table, "extension_requests"); return { data: { id: 5, status: "denied" }, error: null }; }
    if (idx === 4) { assertEquals(table, "action_tokens"); return { data: null, error: null }; }
    throw new Error("unexpected call " + idx);
  });
  const res = await handleDecidePost(form("abc", "deny"), deps);
  assertEquals(res.status, 200);
  assertEquals(sent.length, 1);
  assertStringIncludes(sent[0].subject, "denied");
});

// --- Device proposals ---

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
  note: null,
  status: "pending",
};

const deviceToken = { token: "abc", kind: "device", target_id: 3, used_at: null };

Deno.test("device approve inserts the device, records device_id and mails the proposer", async () => {
  let insertedDevice: unknown, decidedWith: unknown;
  const { db, sent, deps } = harness((table, calls, idx) => {
    if (idx === 0) return { data: deviceToken, error: null };
    if (idx === 1) { assertEquals(table, "device_requests"); return { data: proposalFixture, error: null }; }
    if (idx === 2) {
      assertEquals(table, "devices");
      insertedDevice = calls.find((c) => c.method === "insert")?.args[0];
      return { data: { id: 42 }, error: null };
    }
    if (idx === 3) {
      assertEquals(table, "device_requests");
      decidedWith = calls.find((c) => c.method === "update")?.args[0];
      return { data: { ...proposalFixture, status: "approved", device_id: 42 }, error: null };
    }
    if (idx === 4) { assertEquals(table, "action_tokens"); return { data: null, error: null }; }
    throw new Error("unexpected call " + idx);
  });
  const res = await handleDecidePost(form("abc", "approve"), deps);
  assertEquals(res.status, 200);
  const b = await body(res);
  assertEquals(b.ok, true);
  assertEquals(b.title, "Approved");
  assertStringIncludes(b.message, "Device proposal #3 approved");
  assertStringIncludes(b.message, "the proposer has been notified");
  assertEquals(insertedDevice, { name: "Precision Source", maker: "Keysight", model: "B2912A/B", unit_no: 2, labelled: true, active: true });
  assertEquals((decidedWith as { status: string; device_id: number }).status, "approved");
  assertEquals((decidedWith as { status: string; device_id: number }).device_id, 42);
  assertEquals(sent.length, 1);
  assertEquals(sent[0].to, ["ana@ethz.ch"]);
  assertStringIncludes(sent[0].subject, "device proposal #3 was approved");
  assertEquals(db.fromCalls.length, 5);
});

Deno.test("device deny mails the proposer and creates no device", async () => {
  let touchedDevices = false, decidedWith: unknown;
  const { sent, deps } = harness((table, calls, idx) => {
    if (idx === 0) return { data: deviceToken, error: null };
    if (idx === 1) return { data: proposalFixture, error: null };
    if (table === "devices") { touchedDevices = true; return { data: null, error: null }; }
    if (idx === 2) {
      assertEquals(table, "device_requests");
      decidedWith = calls.find((c) => c.method === "update")?.args[0];
      return { data: { ...proposalFixture, status: "denied" }, error: null };
    }
    if (idx === 3) { assertEquals(table, "action_tokens"); return { data: null, error: null }; }
    throw new Error("unexpected call " + idx);
  });
  const res = await handleDecidePost(form("abc", "deny"), deps);
  assertEquals(res.status, 200);
  assertStringIncludes((await body(res)).message, "Device proposal #3 denied");
  assertEquals(touchedDevices, false);
  assertEquals((decidedWith as { status: string; device_id: number | null }).status, "denied");
  assertEquals((decidedWith as { status: string; device_id: number | null }).device_id, null);
  assertEquals(sent.length, 1);
  assertStringIncludes(sent[0].subject, "denied");
});

Deno.test("device approve: the device already exists (23505) returns 409, proposal stays pending, token unused", async () => {
  let proposalUpdated = false, tokenUpdated = false;
  const { sent, deps } = harness((table, calls, idx) => {
    if (idx === 0) return { data: deviceToken, error: null };
    if (idx === 1) return { data: proposalFixture, error: null };
    if (idx === 2) { assertEquals(table, "devices"); return { data: null, error: { code: "23505", message: "duplicate key" } }; }
    if (table === "device_requests" && calls.some((c) => c.method === "update")) { proposalUpdated = true; return { data: null, error: null }; }
    if (table === "action_tokens" && calls.some((c) => c.method === "update")) { tokenUpdated = true; return { data: null, error: null }; }
    throw new Error("unexpected call " + idx);
  });
  const res = await handleDecidePost(form("abc", "approve"), deps);
  assertEquals(res.status, 409);
  assertStringIncludes((await body(res)).message, "already exists");
  assertEquals(sent.length, 0);
  assertEquals(proposalUpdated, false);
  assertEquals(tokenUpdated, false);
});

Deno.test("device: a proposal that is no longer pending returns 410 and writes nothing", async () => {
  const { db, sent, deps } = harness((table, _calls, idx) => {
    if (idx === 0) return { data: deviceToken, error: null };
    if (idx === 1) { assertEquals(table, "device_requests"); return { data: null, error: null }; }
    throw new Error("unexpected call " + idx);
  });
  const res = await handleDecidePost(form("abc", "approve"), deps);
  assertEquals(res.status, 410);
  assertStringIncludes((await body(res)).message, "no longer pending");
  assertEquals(sent.length, 0);
  assertEquals(db.fromCalls.length, 2);
});

Deno.test("device approve: duplicate click (already decided) returns 410, no double mail, token unused", async () => {
  let tokenUpdated = false;
  const { sent, deps } = harness((table, calls, idx) => {
    if (idx === 0) return { data: deviceToken, error: null };
    if (idx === 1) return { data: proposalFixture, error: null };
    if (idx === 2) return { data: { id: 42 }, error: null };
    if (idx === 3) return { data: null, error: null }; // conditional update lost the race: 0 rows
    if (table === "action_tokens" && calls.some((c) => c.method === "update")) { tokenUpdated = true; return { data: null, error: null }; }
    throw new Error("unexpected call " + idx);
  });
  const res = await handleDecidePost(form("abc", "approve"), deps);
  assertEquals(res.status, 410);
  assertStringIncludes((await body(res)).message, "already decided");
  assertEquals(sent.length, 0);
  assertEquals(tokenUpdated, false);
});

Deno.test("device GET describes a device token without writing", async () => {
  const { db, deps } = harness((table, _calls, idx) => {
    if (idx === 0) { assertEquals(table, "action_tokens"); return { data: deviceToken, error: null }; }
    throw new Error("unexpected call " + idx);
  });
  const res = await handleDecideGet(url("abc"), deps);
  assertEquals(res.status, 200);
  const b = await body(res);
  assertEquals(b.kind, "device");
  assertEquals(b.target_id, 3);
  assertEquals(db.fromCalls.length, 1);
});

// --- GET must never mutate: mail scanners and link previewers prefetch every URL ---

Deno.test("GET with a token describes it as JSON and writes nothing", async () => {
  const { db, sent, deps } = harness((table, _calls, idx) => {
    if (idx === 0) { assertEquals(table, "action_tokens"); return { data: { token: "abc", kind: "rental", target_id: 7, used_at: null }, error: null }; }
    throw new Error("unexpected call " + idx);
  });
  const res = await handleDecideGet(url("abc", "approve"), deps);
  assertEquals(res.status, 200);
  const b = await body(res);
  assertEquals(b.ok, true);
  assertEquals(b.kind, "rental");
  assertEquals(b.target_id, 7);
  assertEquals(b.action, "approve");
  assertEquals(sent.length, 0);
  // exactly one query, a read of action_tokens, with no insert/update in the chain
  assertEquals(db.fromCalls.length, 1);
  assertEquals(db.fromCalls[0].calls.some((c) => c.method === "update" || c.method === "insert"), false);
});

Deno.test("GET with only a token (no action) still describes the token and writes nothing", async () => {
  const { db, deps } = harness((_table, _calls, idx) => {
    if (idx === 0) return { data: { token: "abc", kind: "extension", target_id: 5, used_at: null }, error: null };
    throw new Error("unexpected call " + idx);
  });
  const res = await handleDecideGet(url("abc"), deps);
  assertEquals(res.status, 200);
  const b = await body(res);
  assertEquals(b.ok, true);
  assertEquals(b.kind, "extension");
  assertEquals(b.target_id, 5);
  assertEquals(b.action, null);
  assertEquals(db.fromCalls.length, 1);
});

Deno.test("GET with missing token returns 400 without touching the db", async () => {
  const { db, deps } = harness(() => { throw new Error("no db call expected"); });
  assertEquals((await handleDecideGet(url(undefined, "approve"), deps)).status, 400);
  assertEquals((await handleDecideGet(url("abc", "explode"), deps)).status, 400);
  assertEquals(db.fromCalls.length, 0);
});

Deno.test("GET with an unknown/used token returns 410 and writes nothing", async () => {
  const { db, deps } = harness((_table, _calls, idx) => {
    if (idx === 0) return { data: null, error: null };
    throw new Error("unexpected call " + idx);
  });
  const res = await handleDecideGet(url("abc", "approve"), deps);
  assertEquals(res.status, 410);
  const b = await body(res);
  assertEquals(b.ok, false);
  assertStringIncludes(b.message, "already used or is invalid");
  assertEquals(db.fromCalls.length, 1);
});

Deno.test("OPTIONS returns 204 with CORS headers and touches nothing", async () => {
  const { db, deps } = harness(() => { throw new Error("no db call expected"); });
  const res = await handleDecide(new Request("https://f/decide", { method: "OPTIONS" }), deps);
  assertEquals(res.status, 204);
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  assertStringIncludes(res.headers.get("Access-Control-Allow-Methods") ?? "", "POST");
  assertEquals(db.fromCalls.length, 0);
});

Deno.test("every response carries Access-Control-Allow-Origin: *", async () => {
  const { deps } = harness(() => { throw new Error("no db call expected"); });
  const res = await handleDecidePost(form(null, "approve"), deps);
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
});

Deno.test("handleDecide routes GET to token info and POST form-data to the decision", async () => {
  const resolver = (_table: string, _calls: Call[], idx: number): Result => {
    if (idx === 0) return { data: { token: "abc", kind: "rental", target_id: 7, used_at: null }, error: null };
    if (idx === 1) return { data: { ...rentalFixture, status: "approved" }, error: null };
    if (idx === 2) return { data: null, error: null };
    throw new Error("unexpected call " + idx);
  };
  const getRes = await handleDecide(new Request("https://f/decide?token=abc&action=approve"), harness(resolver).deps);
  const getBody = await body(getRes);
  assertEquals(getBody.ok, true);
  assertEquals(getBody.kind, "rental");
  assertEquals(getBody.target_id, 7);

  const { sent, deps } = harness(resolver);
  const formBody = new FormData();
  formBody.set("token", "abc");
  formBody.set("action", "approve");
  const postRes = await handleDecide(new Request("https://f/decide?token=abc&action=approve", { method: "POST", body: formBody }), deps);
  assertEquals(postRes.status, 200);
  assertStringIncludes((await body(postRes)).message, "approved");
  assertEquals(sent.length, 1);
});

Deno.test("handleDecide POST also accepts a JSON body", async () => {
  const resolver = (_table: string, _calls: Call[], idx: number): Result => {
    if (idx === 0) return { data: { token: "abc", kind: "rental", target_id: 7, used_at: null }, error: null };
    if (idx === 1) return { data: { ...rentalFixture, status: "denied" }, error: null };
    if (idx === 2) return { data: null, error: null };
    throw new Error("unexpected call " + idx);
  };
  const { sent, deps } = harness(resolver);
  const req = new Request("https://f/decide", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "abc", action: "deny" }),
  });
  const res = await handleDecide(req, deps);
  assertEquals(res.status, 200);
  const b = await body(res);
  assertEquals(b.ok, true);
  assertStringIncludes(b.message, "denied");
  assertEquals(sent.length, 1);
});

Deno.test("extension approve: rental returned between the check and the write returns 410", async () => {
  const { sent, deps } = harness((table, _calls, idx) => {
    if (idx === 0) return { data: { token: "abc", kind: "extension", target_id: 5, used_at: null }, error: null };
    if (idx === 1) return { data: { id: 5, rental_id: 7, new_end_date: "2026-09-10", status: "pending" }, error: null };
    if (idx === 2) return { data: { ...rentalFixture, status: "approved" }, error: null }; // still approved here
    if (idx === 3) { assertEquals(table, "rentals"); return { data: null, error: null }; } // ...returned before the update: 0 rows
    throw new Error("unexpected call " + idx);
  });
  const res = await handleDecidePost(form("abc", "approve"), deps);
  assertEquals(res.status, 410);
  assertStringIncludes((await body(res)).message, "no longer active");
  assertEquals(sent.length, 0);
});
