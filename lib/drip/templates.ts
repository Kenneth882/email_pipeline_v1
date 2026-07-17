export type EmailSlot = 1 | 2 | 3;

export function buildOutreachEmail(opts: {
  venueName: string;
  slot: EmailSlot;
  contactName?: string | null;
}): { subject: string; body: string } {
  const hello = opts.contactName?.trim()
    ? `Hi ${opts.contactName.trim().split(/\s+/)[0]},`
    : "Hi there,";

  if (opts.slot === 1) {
    return {
      subject: "Private event inquiry | August 12th from 6–9pm",
      body: `${hello}

I'm looking to book a private event for a networking community on Wednesday, August 12th from 6–9pm for 70–80 people, standing. We'd need the space fully private — either a full buyout or a private room.

Our budget is around a $1.5k minimum spend for light bites and a beer & wine tab. Ideally, we'd put about $1,000 toward pre-selected food platters and $500 as an initial bar tab for beer and wine only, which we usually add to throughout the event depending on how much people drink.

Would love to hear more details about your space and menu options.
Thanks,
Kenneth
`,
    };
  }

  if (opts.slot === 2) {
    return {
      subject: "Re: Private event inquiry | August 12th from 6–9pm",
      body: `${hello}

Quick follow-up on my note about a private event on Wednesday, August 12th from 6–9pm (70–80 people, standing, fully private). Still exploring fit for ${opts.venueName} — happy to share more detail if useful.

Best,
Kenneth
`,
    };
  }

  return {
    subject: "Re: Private event inquiry | August 12th from 6–9pm",
    body: `${hello}

Last note from me on the August 12th private event inquiry for ${opts.venueName}. If timing is better later, no worries — happy to reconnect whenever.

Thanks,
Kenneth
`,
  };
}
