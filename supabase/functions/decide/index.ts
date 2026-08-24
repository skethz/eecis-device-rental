import { createClient } from "npm:@supabase/supabase-js@2";
import { decisionMail, type Mail } from "../_shared/email.ts";
import { createTransport, sendEmail, smtpConfigFromEnv } from "../_shared/mailer.ts";

export interface Deps { db: any; send: (m: Mail) => Promise<void> }

export interface Params { token: string | null; action: string | null }

// Supabase rewrites text/html responses from edge functions on *.supabase.co to
// text/plain, so this function is a plain JSON API; the confirmation UI lives on the
// static site (site/decide.html), which fetches this endpoint with CORS.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization",
};

const json = (ok: boolean, title: string, message: string, status = 200, extra: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({ ok, title, message, ...extra }),
    { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS_HEADERS } },
  );

const SEL = "*, device:devices(name,maker,model,unit_no,labelled)";

function badParams(p: Params): Response | null {
  if (!p.token || !p.action) return json(false, "Bad request", "Missing token or action.", 400);
  if (p.action !== "approve" && p.action !== "deny") return json(false, "Bad request", "Unknown action.", 400);
  return null;
}

// Read-only: validates the link and describes it as JSON. No writes. Mail scanners and
// link previewers fetch every URL in an email, so a GET must never mutate anything.
// `action` is optional here (the site's early "is this link still valid" check only
// sends the token); POST below still requires it, since that's what decides the outcome.
export async function handleDecideGet(url: URL, d: Deps): Promise<Response> {
  const token = url.searchParams.get("token");
  const action = url.searchParams.get("action");
  if (!token) return json(false, "Bad request", "Missing token.", 400);
  if (action !== null && action !== "approve" && action !== "deny") return json(false, "Bad request", "Unknown action.", 400);
  const { data: t } = await d.db.from("action_tokens").select("*").eq("token", token).is("used_at", null).maybeSingle();
  if (!t) return json(false, "Link expired", "This link was already used or is invalid.", 410);
  return json(true, "Valid", "Token is valid.", 200, { kind: t.kind, target_id: t.target_id, action });
}

export async function handleDecidePost(p: Params, d: Deps): Promise<Response> {
  const bad = badParams(p);
  if (bad) return bad;
  const token = p.token!, action = p.action!;
  const { data: t } = await d.db.from("action_tokens").select("*").eq("token", token).is("used_at", null).maybeSingle();
  if (!t) return json(false, "Link expired", "This link was already used or is invalid.", 410);
  const approved = action === "approve", now = new Date().toISOString();
  let rental: any, newEnd: string | undefined;
  if (t.kind === "rental") {
    const { data, error } = await d.db.from("rentals").update({ status: approved ? "approved" : "denied", decided_at: now })
      .eq("id", t.target_id).eq("status", "pending").select(SEL).single();
    if (error?.code === "23P01") return json(false, "Conflict", "This device is already approved for an overlapping period; the request stays pending.", 409);
    if (error || !data) return json(false, "Not found", "Request no longer pending.", 410);
    rental = data;
  } else {
    const { data: ext } = await d.db.from("extension_requests").select("*").eq("id", t.target_id).eq("status", "pending").single();
    if (!ext) return json(false, "Not found", "Extension request no longer pending.", 410);
    newEnd = ext.new_end_date;
    if (approved) {
      // The rental must still be active before we extend it.
      const { data: activeRental } = await d.db.from("rentals").select(SEL).eq("id", ext.rental_id).eq("status", "approved").maybeSingle();
      if (!activeRental) return json(false, "Not found", "The rental is no longer active.", 410);
      // ...and must still be active when we write, so a return in between is not undone.
      const { data, error } = await d.db.from("rentals").update({ end_date: newEnd })
        .eq("id", ext.rental_id).eq("status", "approved").select(SEL).maybeSingle();
      if (error?.code === "23P01") return json(false, "Conflict", "The extension conflicts with another approved rental; it stays pending.", 409);
      if (error) throw error;
      if (!data) return json(false, "Not found", "The rental is no longer active.", 410);
      rental = data;
    } else {
      const { data } = await d.db.from("rentals").select(SEL).eq("id", ext.rental_id).single();
      rental = data;
    }
    // Only transition pending -> approved/denied; a concurrent click that already
    // decided this request loses the race and gets told so, instead of also mailing.
    const { data: extDecided } = await d.db.from("extension_requests")
      .update({ status: approved ? "approved" : "denied", decided_at: now })
      .eq("id", ext.id).eq("status", "pending")
      .select().maybeSingle();
    if (!extDecided) return json(false, "Already handled", "This extension request was already decided.", 410);
  }
  await d.db.from("action_tokens").update({ used_at: now }).eq("token", token);
  try {
    await d.send(decisionMail(rental, t.kind, approved, newEnd));
    return json(true, approved ? "Approved" : "Denied", `Request #${rental.id} ${approved ? "approved" : "denied"}; the borrower has been notified.`);
  } catch (e) {
    console.error(e);
    return json(
      true,
      approved ? "Approved" : "Denied",
      `Request #${rental.id} ${approved ? "approved" : "denied"}. (The borrower could not be notified automatically — please inform them yourself.)`,
    );
  }
}

const field = (v: FormDataEntryValue | null): string | null => (typeof v === "string" ? v : null);

export async function handleDecide(req: Request, d: Deps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method === "POST") {
    const ct = req.headers.get("content-type") ?? "";
    let p: Params;
    if (ct.includes("application/json")) {
      const body = await req.json().catch(() => ({}));
      p = { token: typeof body.token === "string" ? body.token : null, action: typeof body.action === "string" ? body.action : null };
    } else {
      const form = await req.formData();
      p = { token: field(form.get("token")), action: field(form.get("action")) };
    }
    return await handleDecidePost(p, d);
  }
  return await handleDecideGet(new URL(req.url), d);
}

if (import.meta.main) {
  Deno.serve(async (req) => {
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const lab = Deno.env.get("LAB_MANAGER_EMAIL")!;
    const transport = await createTransport(smtpConfigFromEnv(Deno.env.get));
    try {
      return await handleDecide(req, {
        db,
        send: (m) => sendEmail(transport, Deno.env.get("MAIL_FROM")!, { ...m, replyTo: lab }),
      });
    } catch (e) {
      console.error(e);
      return json(false, "Error", "Something went wrong; please contact the lab manager.", 500);
    }
  });
}
