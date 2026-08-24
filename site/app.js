import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

export { deviceLabel, isEthz, overlaps, normaliseBusy, compareDevices, sortDevices, statusLine, sortStatusRows, todayLocal, addDays, $ } from "./helpers.js";

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export async function requireUser() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    location.href = "./index.html";
    throw new Error("not signed in");
  }
  return session.user;
}

// "Am I an admin?" gates the Manage devices link and the whole devices.html page.
// Cached per page load (keyed by user, so signing in as someone else re-asks) —
// it is only a hint for the UI; the real enforcement is the RLS policy on devices.
let adminCacheUserId;
let adminCacheValue = null;

export async function isAdmin(user) {
  const id = user?.id ?? null;
  if (adminCacheUserId === id && adminCacheValue !== null) return adminCacheValue;
  const { data, error } = await sb.rpc("is_admin");
  adminCacheUserId = id;
  adminCacheValue = !error && data === true;
  return adminCacheValue;
}
