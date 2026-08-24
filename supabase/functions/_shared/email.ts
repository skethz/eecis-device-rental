export interface Rental {
  id: number;
  borrower_name: string;
  borrower_email: string;
  manager_name: string;
  manager_email: string;
  professor_name: string;
  professor_email: string;
  start_date: string;
  end_date: string;
  status: string;
  device: { name: string; maker: string | null; model: string | null; unit_no: number; labelled?: boolean };
}

export interface Mail {
  to: string[];
  subject: string;
  html: string;
  replyTo?: string;
}

export function esc(s: unknown): string {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Header injection guard: a subject line must never contain CR/LF, or an attacker-supplied
// name could smuggle extra SMTP headers (Bcc:, ...) into the message. Also caps the length.
export const subj = (s: unknown): string => String(s).replace(/[\r\n]+/g, " ").slice(0, 200);

// A device with `labelled === false` exists but carries no physical "Nr.x" sticker,
// so naming a unit number for it would be misleading.
export function deviceLabel(d: Rental["device"]): string {
  const parts = [d.name, d.maker, d.model].filter((p): p is string => !!p);
  const base = parts.join(" ");
  return d.labelled === false ? base : `${base} Nr.${d.unit_no}`;
}

function details(r: Rental): string {
  const rows: [string, string][] = [
    ["Device", esc(deviceLabel(r.device))],
    ["Borrower", esc(r.borrower_name)],
    ["Borrower email", esc(r.borrower_email)],
    ["Lab manager", esc(r.manager_name)],
    ["Professor", esc(r.professor_name)],
    ["Period", `${esc(r.start_date)} &ndash; ${esc(r.end_date)}`],
    ["Request #", esc(r.id)],
  ];
  const trs = rows.map(([k, v]) => `<tr><td style="padding:2px 8px;color:#555">${k}</td><td style="padding:2px 8px"><strong>${v}</strong></td></tr>`).join("");
  return `<table cellspacing="0" cellpadding="0">${trs}</table>`;
}

export function requestMail(r: Rental, decideUrl: string, to: string): Mail {
  const label = deviceLabel(r.device);
  const subject = `[EECIS rental] Request #${subj(r.id)}: ${subj(label)} by ${subj(r.borrower_name)}`;
  const html = `
    <p>A new device rental request needs your decision.</p>
    ${details(r)}
    <p>
      <a href="${decideUrl}&action=approve">Approve</a>
      &nbsp;|&nbsp;
      <a href="${decideUrl}&action=deny">Deny</a>
    </p>`;
  return { to: [to], subject, html };
}

export function extensionMail(r: Rental, newEnd: string, decideUrl: string, to: string): Mail {
  const label = deviceLabel(r.device);
  const subject = `[EECIS rental] Extension request #${subj(r.id)}: ${subj(label)} by ${subj(r.borrower_name)}`;
  const html = `
    <p>An extension request needs your decision.</p>
    ${details(r)}
    <p>Current end date: <strong>${esc(r.end_date)}</strong><br>
       Requested end date: <strong>${esc(newEnd)}</strong></p>
    <p>
      <a href="${decideUrl}&action=approve">Approve</a>
      &nbsp;|&nbsp;
      <a href="${decideUrl}&action=deny">Deny</a>
    </p>`;
  return { to: [to], subject, html };
}

// Sent to the borrower right after their request/extension request lands, so they know
// it went through even before the lab manager acts on it.
export function receiptMail(r: Rental, kind: "rental" | "extension", newEnd?: string): Mail {
  const label = deviceLabel(r.device);
  const noun = kind === "extension" ? "Extension request" : "Request";
  const subject = `[EECIS rental] ${subj(noun)} #${subj(r.id)} received: ${subj(label)}`;
  const period = kind === "extension"
    ? `<p>Current end date: <strong>${esc(r.end_date)}</strong><br>
       Requested end date: <strong>${esc(newEnd)}</strong></p>`
    : `<p>Requested period: <strong>${esc(r.start_date)} &ndash; ${esc(r.end_date)}</strong></p>`;
  const html = `
    <p>Your ${kind === "extension" ? "extension request" : "request"} for <strong>${esc(label)}</strong> was received.</p>
    ${period}
    ${details(r)}
    <p>The lab manager will review it; you will get another email when it is approved or denied.</p>`;
  return { to: [r.borrower_email], subject, html };
}

export function decisionMail(r: Rental, kind: "rental" | "extension", approved: boolean, newEnd?: string): Mail {
  const label = deviceLabel(r.device);
  const noun = kind === "extension" ? "extension request" : "request";
  const verdict = approved ? "approved" : "denied";
  const subject = `[EECIS rental] Your ${subj(noun)} #${subj(r.id)} was ${subj(verdict)}`;
  const extra = kind === "extension" && approved && newEnd ? `<p>New end date: <strong>${esc(newEnd)}</strong></p>` : "";
  const html = `
    <p>Your ${noun} for <strong>${esc(label)}</strong> was <strong>${verdict}</strong>.</p>
    ${extra}
    ${details(r)}`;
  return { to: [r.borrower_email], subject, html };
}

export function returnMail(r: Rental, to: string): Mail {
  const label = deviceLabel(r.device);
  const subject = `[EECIS rental] Returned: ${subj(label)} by ${subj(r.borrower_name)}`;
  const html = `
    <p>The following device has been marked as returned.</p>
    ${details(r)}`;
  return { to: [to], subject, html };
}

export function overdueMail(r: Rental, labManager: string, today: string): Mail {
  const label = deviceLabel(r.device);
  const days = Math.round((Date.parse(today) - Date.parse(r.end_date)) / 86400000);
  const subject = `[EECIS rental] OVERDUE: ${subj(label)} due ${subj(r.end_date)}`;
  const html = `
    <p>This rental is <strong>${days} day${days === 1 ? "" : "s"} overdue</strong>.</p>
    ${details(r)}
    <p>Please return the device as soon as possible and mark it as returned on the site.</p>`;
  return { to: [r.borrower_email, r.manager_email, r.professor_email, labManager], subject, html };
}
