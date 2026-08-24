import { createClient } from "npm:@supabase/supabase-js@2";
import { requestMail, extensionMail, returnMail, receiptMail, deviceRequestMail, deviceReceiptMail,
  type DeviceRequest, type Mail, type Rental } from "../_shared/email.ts";
import { createTransport, sendEmail, smtpConfigFromEnv } from "../_shared/mailer.ts";

export interface Deps { db: any; send: (m: Mail) => Promise<void>; labManager: string; siteUrl: string }

const RENTAL_SEL = "*, device:devices(name,maker,model,unit_no,labelled)";

async function loadRental(db: any, id: number): Promise<Rental> {
  const { data, error } = await db.from("rentals").select(RENTAL_SEL).eq("id", id).single();
  if (error) throw error;
  return data;
}

async function newToken(db: any, kind: string, targetId: number): Promise<string> {
  const { data, error } = await db.from("action_tokens").insert({ kind, target_id: targetId }).select("token").single();
  if (error) throw error;
  return data.token;
}

export async function handleNotify(p: any, d: Deps): Promise<Response> {
  if (p.table === "rentals" && p.type === "INSERT") {
    const r = await loadRental(d.db, p.record.id);
    const t = await newToken(d.db, "rental", r.id);
    await d.send(requestMail(r, `${d.siteUrl}/decide.html?token=${t}`, d.labManager));
    try {
      await d.send(receiptMail(r, "rental"));
    } catch (e) {
      console.error(e);
    }
  } else if (p.table === "extension_requests" && p.type === "INSERT") {
    const r = await loadRental(d.db, p.record.rental_id);
    const t = await newToken(d.db, "extension", p.record.id);
    await d.send(extensionMail(r, p.record.new_end_date, `${d.siteUrl}/decide.html?token=${t}`, d.labManager));
    try {
      await d.send(receiptMail(r, "extension", p.record.new_end_date));
    } catch (e) {
      console.error(e);
    }
  } else if (p.table === "device_requests" && p.type === "INSERT") {
    // Unlike a rental there is nothing to join in: the webhook payload is the whole row.
    const q = p.record as DeviceRequest;
    const t = await newToken(d.db, "device", q.id);
    await d.send(deviceRequestMail(q, `${d.siteUrl}/decide.html?token=${t}`, d.labManager));
    try {
      await d.send(deviceReceiptMail(q));
    } catch (e) {
      console.error(e);
    }
  } else if (p.table === "rentals" && p.type === "UPDATE" && p.old_record?.status !== "returned" && p.record.status === "returned") {
    await d.send(returnMail(await loadRental(d.db, p.record.id), d.labManager));
  } else if (p.table === "rentals" && p.type === "UPDATE") {
    return new Response("ignored", { status: 200 });
  } else return new Response("unknown event", { status: 400 });
  return new Response("ok");
}

if (import.meta.main) {
  Deno.serve(async (req) => {
    if (req.headers.get("x-webhook-secret") !== Deno.env.get("WEBHOOK_SECRET")) return new Response("forbidden", { status: 403 });
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const from = Deno.env.get("MAIL_FROM")!, lab = Deno.env.get("LAB_MANAGER_EMAIL")!;
    const transport = await createTransport(smtpConfigFromEnv(Deno.env.get));
    // Strip a trailing slash so `${siteUrl}/decide.html` never ends up with a double slash.
    const siteUrl = (Deno.env.get("SITE_URL") ?? "").replace(/\/$/, "");
    try {
      return await handleNotify(await req.json(), {
        db,
        labManager: lab,
        siteUrl,
        send: (m) => sendEmail(transport, from, { ...m, replyTo: lab }),
      });
    } catch (e) {
      console.error(e);
      return new Response(String(e), { status: 500 });
    }
  });
}
