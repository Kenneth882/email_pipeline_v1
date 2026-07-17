export type EmailSlot = 1 | 2 | 3;

export function buildOutreachEmail(opts: {
  venueName: string;
  slot: EmailSlot;
  contactName?: string | null;
}): { subject: string; body: string } {
  const hello = opts.contactName?.trim()
    ? `Hi ${opts.contactName.trim().split(/\s+/)[0]},`
    : "Hi,";

  if (opts.slot === 1) {
    return {
      subject: `Private event inquiry — ${opts.venueName}`,
      body: `${hello}

I'm reaching out from VenueHopper about a private event in Chicago (75+ guests, fully private space, AV).

Would ${opts.venueName} be open to sharing availability and a rough budget range?

Thanks,
Kenneth
VenueHopper
`,
    };
  }

  if (opts.slot === 2) {
    return {
      subject: `Re: Private event inquiry — ${opts.venueName}`,
      body: `${hello}

Quick follow-up on my note about a private Chicago event at ${opts.venueName}. Still exploring fit — happy to share more detail if useful.

Best,
Kenneth
`,
    };
  }

  return {
    subject: `Re: Private event inquiry — ${opts.venueName}`,
    body: `${hello}

Last note from me on the private event inquiry for ${opts.venueName}. If timing is better later, no worries — happy to reconnect whenever.

Thanks,
Kenneth
`,
  };
}
