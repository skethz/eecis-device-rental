import { createClient } from "npm:@supabase/supabase-js@2";
import { overdueMail, type Mail } from "../_shared/email.ts";
import { createTransport, sendEmail, smtpConfigFromEnv } from "../_shared/mailer.ts";

export interface Deps { db: any; send: (m: Mail) => Promise<void>; labManager: string }

export async function runOverdue(d: Deps, today: string): Promise<number> {
  const { data, error } = await d.db.from("rentals").select("*, device:devices(name,maker,model,unit_no,labelled)")
    .eq("status", "approved").lt("end_date", today).or(`last_warned_on.is.null,last_warned_on.lt.${today}`);
  if (error) throw error;
  let n = 0;
  for (const r of data ?? []) {
    try {
      await d.send(overdueMail(r, d.labManager, today));
    } catch (e) {
      console.error(`warn failed for rental ${r.id}`, e);
      continue;
    }
    // If the bookkeeping write fails the borrower would be re-warned tomorrow, which is
    // fine; what must not happen is reporting it as a completed warning.
    const { error: markError } = await d.db.from("rentals").update({ last_warned_on: today }).eq("id", r.id);
    if (markError) {
      console.error(`marking rental ${r.id} as warned failed`, markError);
      continue;
    }
    n++;
  }
  return n;
}

if (import.meta.main) {
  Deno.serve(async (req) => {
    if (req.headers.get("authorization") !== `Bearer ${Deno.env.get("CRON_SECRET")}`) return new Response("forbidden", { status: 403 });
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const lab = Deno.env.get("LAB_MANAGER_EMAIL")!;
    const transport = await createTransport(smtpConfigFromEnv(Deno.env.get));
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zurich" }).format(new Date()); // YYYY-MM-DD
    try {
      const n = await runOverdue({
        db,
        labManager: lab,
        send: (m) => sendEmail(transport, Deno.env.get("MAIL_FROM")!, { ...m, replyTo: lab }),
      }, today);
      return Response.json({ warned: n });
    } catch (e) {
      console.error(e);
      return new Response("Something went wrong.", { status: 500 });
    }
  });
}
