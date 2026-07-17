/**
 * Strip quoted reply history (Gmail / Outlook / iPhone common patterns).
 * Keep only the new reply content for triage.
 */
export function stripQuotedHistory(text: string): string {
  if (!text) return "";

  let body = text.replace(/\r\n/g, "\n");

  // Gmail-style "On ... wrote:"
  body = body.split(/\nOn .+ wrote:\n/)[0] ?? body;

  // Outlook-style "From: ... Sent:" block
  body = body.split(/\nFrom:\s.+\nSent:\s/)[0] ?? body;

  // "-----Original Message-----"
  body = body.split(/\n-{2,}\s*Original Message\s*-{2,}/i)[0] ?? body;

  // Apple Mail / common quote lines starting with >
  const lines = body.split("\n");
  const cut: string[] = [];
  for (const line of lines) {
    if (/^>/.test(line)) break;
    if (/^-{5,}.*Forwarded message/i.test(line)) break;
    cut.push(line);
  }
  body = cut.join("\n");

  return body.trim().slice(0, 4000);
}
