import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { deviceLabel, requestMail, overdueMail, decisionMail, returnMail, extensionMail, receiptMail,
  deviceRequestMail, deviceReceiptMail, deviceDecisionMail } from "./email.ts";
const r = { id:7, borrower_name:"Ana", borrower_email:"ana@ethz.ch", manager_name:"Max", manager_email:"max@ethz.ch",
  professor_name:"Prof X", professor_email:"x@ethz.ch", start_date:"2026-09-01", end_date:"2026-09-05", status:"approved",
  device:{ name:"Precision Source", maker:"Keysight", model:"B2912A/B", unit_no:2 } };
Deno.test("deviceLabel", () => {
  assertEquals(deviceLabel(r.device), "Precision Source Keysight B2912A/B Nr.2");
  assertEquals(deviceLabel({name:"Saleae",maker:null,model:null,unit_no:3}), "Saleae Nr.3");
  assertEquals(deviceLabel({name:"Precision Source",maker:"Keysight",model:"B2912A/B",unit_no:2,labelled:true}),
    "Precision Source Keysight B2912A/B Nr.2");
});
Deno.test("deviceLabel omits the unit number for an unlabelled device", () => {
  assertEquals(deviceLabel({name:"Isolation Transformer",maker:"Eaton",model:"IS1000HGDV",unit_no:1,labelled:false}),
    "Isolation Transformer Eaton IS1000HGDV");
  assertEquals(deviceLabel({name:"Opal Kelly XEM7360-K410T",maker:null,model:null,unit_no:1,labelled:false}),
    "Opal Kelly XEM7360-K410T");
});
Deno.test("an unlabelled device's mail never mentions a unit number", () => {
  const u = { ...r, device: { ...r.device, labelled: false } };
  for (const m of [requestMail(u, "https://f/decide?token=abc", "lab@ethz.ch"), returnMail(u, "lab@ethz.ch"), receiptMail(u, "rental")]) {
    assertEquals(m.subject.includes("Nr."), false);
    assertEquals(m.html.includes("Nr."), false);
  }
});
Deno.test("requestMail has both links and all names", () => {
  const m = requestMail(r, "https://f/decide?token=abc", "lab@ethz.ch");
  assertEquals(m.to, ["lab@ethz.ch"]);
  assertStringIncludes(m.html, "https://f/decide?token=abc&action=approve");
  assertStringIncludes(m.html, "https://f/decide?token=abc&action=deny");
  for (const s of ["Ana","Max","Prof X","2026-09-01","2026-09-05","Nr.2"]) assertStringIncludes(m.html, s);
});
Deno.test("receiptMail for a rental request", () => {
  const m = receiptMail(r, "rental");
  assertEquals(m.to, ["ana@ethz.ch"]);
  assertEquals(m.subject, "[EECIS rental] Request #7 received: Precision Source Keysight B2912A/B Nr.2");
  for (const s of ["Ana", "Max", "Prof X", "2026-09-01", "2026-09-05", "review", "approved or denied"]) {
    assertStringIncludes(m.html, s);
  }
});
Deno.test("receiptMail for an extension request", () => {
  const m = receiptMail(r, "extension", "2026-09-12");
  assertEquals(m.to, ["ana@ethz.ch"]);
  assertEquals(m.subject, "[EECIS rental] Extension request #7 received: Precision Source Keysight B2912A/B Nr.2");
  assertStringIncludes(m.html, "2026-09-05"); // current end date
  assertStringIncludes(m.html, "2026-09-12"); // requested new end date
});
Deno.test("overdueMail goes to all four", () => {
  const m = overdueMail(r, "lab@ethz.ch", "2026-09-08");
  assertEquals(m.to, ["ana@ethz.ch","max@ethz.ch","x@ethz.ch","lab@ethz.ch"]);
  assertStringIncludes(m.subject, "OVERDUE");
});
Deno.test("decisionMail denied", () => {
  const m = decisionMail(r, "rental", false);
  assertEquals(m.to, ["ana@ethz.ch"]); assertStringIncludes(m.subject, "denied");
});
Deno.test("subjects never contain CR/LF (header injection guard)", () => {
  const evil = { ...r, borrower_name: "Ana\r\nBcc: attacker@evil.com" };
  const subjects = [
    requestMail(evil, "https://f/decide?token=abc", "lab@ethz.ch").subject,
    extensionMail(evil, "2026-09-10", "https://f/decide?token=abc", "lab@ethz.ch").subject,
    decisionMail(evil, "rental", true).subject,
    returnMail(evil, "lab@ethz.ch").subject,
    overdueMail(evil, "lab@ethz.ch", "2026-09-08").subject,
    receiptMail(evil, "rental").subject,
  ];
  for (const s of subjects) {
    assertEquals(/[\r\n]/.test(s), false, `CR/LF in subject: ${JSON.stringify(s)}`);
  }
  assertStringIncludes(subjects[0], "Ana Bcc: attacker@evil.com");
});

// --- Device proposals ---

const q = { id: 3, proposer_name: "Ana", proposer_email: "ana@ethz.ch", name: "Precision Source",
  maker: "Keysight", model: "B2912A/B", unit_no: 2, labelled: true, note: "bought by our group", status: "pending" };

Deno.test("deviceRequestMail goes to the lab manager with both decision links", () => {
  const m = deviceRequestMail(q, "https://f/decide.html?token=abc", "lab@ethz.ch");
  assertEquals(m.to, ["lab@ethz.ch"]);
  assertEquals(m.subject, "[EECIS rental] New device proposed: Precision Source Keysight B2912A/B Nr.2 by Ana");
  assertStringIncludes(m.html, "https://f/decide.html?token=abc&action=approve");
  assertStringIncludes(m.html, "https://f/decide.html?token=abc&action=deny");
  for (const s of ["Precision Source", "Keysight", "B2912A/B", "Ana", "ana@ethz.ch", "bought by our group"]) {
    assertStringIncludes(m.html, s);
  }
});

Deno.test("deviceReceiptMail goes to the proposer", () => {
  const m = deviceReceiptMail(q);
  assertEquals(m.to, ["ana@ethz.ch"]);
  assertEquals(m.subject, "[EECIS rental] Device proposal #3 received: Precision Source Keysight B2912A/B Nr.2");
  assertStringIncludes(m.html, "approved or denied");
});

Deno.test("deviceDecisionMail states the verdict", () => {
  const yes = deviceDecisionMail(q, true);
  assertEquals(yes.to, ["ana@ethz.ch"]);
  assertStringIncludes(yes.subject, "was approved");
  assertStringIncludes(yes.html, "can be rented");
  const no = deviceDecisionMail(q, false);
  assertStringIncludes(no.subject, "was denied");
  assertEquals(no.html.includes("can be rented"), false);
});

Deno.test("an unlabelled proposed device is never named with a unit number", () => {
  const u = { ...q, labelled: false };
  for (const m of [deviceRequestMail(u, "https://f/d?token=a", "lab@ethz.ch"), deviceReceiptMail(u), deviceDecisionMail(u, true)]) {
    assertEquals(m.subject.includes("Nr."), false);
  }
  // The "Nr." details row stays (the number is still recorded), but the name has no suffix.
  assertStringIncludes(deviceReceiptMail(u).html, "Precision Source Keysight B2912A/B</strong>");
});

Deno.test("device proposal mails escape HTML and scrub CR/LF from subjects", () => {
  const evil = { ...q, proposer_name: "Ana\r\nBcc: attacker@evil.com", name: "<img src=x onerror=alert(1)>",
    note: "5 > 3 & \"quoted\"" };
  const mails = [deviceRequestMail(evil, "https://f/d?token=a", "lab@ethz.ch"), deviceReceiptMail(evil), deviceDecisionMail(evil, false)];
  for (const m of mails) {
    assertEquals(/[\r\n]/.test(m.subject), false, `CR/LF in subject: ${JSON.stringify(m.subject)}`);
    assertEquals(m.html.includes("<img src=x"), false);
    assertStringIncludes(m.html, "&lt;img src=x onerror=alert(1)&gt;");
    assertStringIncludes(m.html, "5 &gt; 3 &amp; &quot;quoted&quot;");
  }
  assertStringIncludes(mails[0].subject, "Ana Bcc: attacker@evil.com");
});

Deno.test("missing maker/model/note render as a dash, not 'null'", () => {
  const bare = { ...q, maker: null, model: null, note: null };
  const html = deviceRequestMail(bare, "https://f/d?token=a", "lab@ethz.ch").html;
  assertEquals(html.includes("null"), false);
  assertStringIncludes(html, "&mdash;");
});
