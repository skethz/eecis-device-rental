import type { Mail } from "./email.ts";

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
}

// The subset of nodemailer's Transporter that sendEmail() relies on.
export interface Transport {
  sendMail(opts: any): Promise<any>;
}

// nodemailer's own entrypoint reads `process.env.ETHEREAL_API` at import time (its
// createTestAccount helper), which would require --allow-env just to import the module.
// Importing it lazily here, only when a real transport is actually created, keeps
// `deno test` permission-free: every test that only exercises sendEmail()/
// smtpConfigFromEnv() with a fake transport never touches this import at all.
export async function createTransport(cfg: SmtpConfig): Promise<Transport> {
  const nodemailer = (await import("npm:nodemailer@6")).default;
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    auth: { user: cfg.user, pass: cfg.pass },
  });
}

// Reads SMTP settings from the environment (Deno.env.get, or anything with that shape,
// so this is easy to test without touching real env vars). SMTP_USER/SMTP_PASS have no
// sane default (a Gmail app password), so their absence is a hard error.
export function smtpConfigFromEnv(env: (key: string) => string | undefined): SmtpConfig {
  const user = env("SMTP_USER");
  const pass = env("SMTP_PASS");
  if (!user || !pass) throw new Error("SMTP_USER and SMTP_PASS must be set");
  return {
    host: env("SMTP_HOST") ?? "smtp.gmail.com",
    port: Number(env("SMTP_PORT") ?? "465"),
    user,
    pass,
  };
}

export async function sendEmail(
  transport: Transport,
  from: string,
  mail: Mail,
): Promise<void> {
  // De-dup recipients case-insensitively, keeping the first-seen casing.
  const seen = new Set<string>();
  const to = mail.to.filter((addr) => {
    const key = addr.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (to.length === 0) throw new Error("sendEmail: no recipients");
  const opts: Record<string, unknown> = { from, to: to.join(", "), subject: mail.subject, html: mail.html };
  if (mail.replyTo) opts.replyTo = mail.replyTo;
  await transport.sendMail(opts);
}
