import { assertEquals, assertRejects } from "jsr:@std/assert";
import { sendEmail, smtpConfigFromEnv } from "./mailer.ts";

class FakeTransport {
  calls: any[] = [];
  constructor(private fail?: Error) {}
  sendMail(opts: any): Promise<any> {
    this.calls.push(opts);
    if (this.fail) return Promise.reject(this.fail);
    return Promise.resolve({ messageId: "fake" });
  }
}

Deno.test("sendEmail calls sendMail with from/to/subject/html, no replyTo when absent", async () => {
  const t = new FakeTransport();
  await sendEmail(t as any, "EECIS <a@b.c>", { to: ["z@ethz.ch"], subject: "s", html: "<b>h</b>" });
  assertEquals(t.calls.length, 1);
  assertEquals(t.calls[0].from, "EECIS <a@b.c>");
  assertEquals(t.calls[0].to, "z@ethz.ch");
  assertEquals(t.calls[0].subject, "s");
  assertEquals(t.calls[0].html, "<b>h</b>");
  assertEquals("replyTo" in t.calls[0], false);
});

Deno.test("sendEmail includes replyTo when present", async () => {
  const t = new FakeTransport();
  await sendEmail(t as any, "a@b.c", { to: ["z@ethz.ch"], subject: "s", html: "h", replyTo: "Lab <lab@ethz.ch>" });
  assertEquals(t.calls[0].replyTo, "Lab <lab@ethz.ch>");
});

Deno.test("sendEmail joins multiple recipients with ', '", async () => {
  const t = new FakeTransport();
  await sendEmail(t as any, "a@b.c", { to: ["x@ethz.ch", "y@ethz.ch"], subject: "s", html: "h" });
  assertEquals(t.calls[0].to, "x@ethz.ch, y@ethz.ch");
});

Deno.test("sendEmail de-duplicates recipients case-insensitively, keeping first-seen casing", async () => {
  const t = new FakeTransport();
  await sendEmail(t as any, "a@b.c", { to: ["Z@ethz.ch", "z@ethz.ch", "y@ethz.ch"], subject: "s", html: "h" });
  assertEquals(t.calls[0].to, "Z@ethz.ch, y@ethz.ch");
});

Deno.test("sendEmail throws when the transport rejects", async () => {
  const t = new FakeTransport(new Error("smtp boom"));
  await assertRejects(
    () => sendEmail(t as any, "a@b.c", { to: ["z@ethz.ch"], subject: "s", html: "h" }),
    Error,
    "smtp boom",
  );
});

Deno.test("sendEmail throws on empty recipients without calling the transport", async () => {
  const t = new FakeTransport();
  await assertRejects(() => sendEmail(t as any, "a@b.c", { to: [], subject: "s", html: "h" }), Error);
  assertEquals(t.calls.length, 0);
});

Deno.test("smtpConfigFromEnv applies host/port defaults", () => {
  const env = new Map([["SMTP_USER", "u@gmail.com"], ["SMTP_PASS", "app-password"]]);
  const cfg = smtpConfigFromEnv((k) => env.get(k));
  assertEquals(cfg, { host: "smtp.gmail.com", port: 465, user: "u@gmail.com", pass: "app-password" });
});

Deno.test("smtpConfigFromEnv honors overrides", () => {
  const env = new Map([
    ["SMTP_HOST", "smtp.example.com"],
    ["SMTP_PORT", "587"],
    ["SMTP_USER", "u@example.com"],
    ["SMTP_PASS", "secret"],
  ]);
  const cfg = smtpConfigFromEnv((k) => env.get(k));
  assertEquals(cfg, { host: "smtp.example.com", port: 587, user: "u@example.com", pass: "secret" });
});

Deno.test("smtpConfigFromEnv throws a clear error when SMTP_USER or SMTP_PASS is missing", () => {
  try {
    smtpConfigFromEnv(() => undefined);
    throw new Error("expected smtpConfigFromEnv to throw");
  } catch (e) {
    assertEquals((e as Error).message, "SMTP_USER and SMTP_PASS must be set");
  }
  const onlyUser = new Map([["SMTP_USER", "u@gmail.com"]]);
  try {
    smtpConfigFromEnv((k) => onlyUser.get(k));
    throw new Error("expected smtpConfigFromEnv to throw");
  } catch (e) {
    assertEquals((e as Error).message, "SMTP_USER and SMTP_PASS must be set");
  }
});
