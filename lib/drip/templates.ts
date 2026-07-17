import { EVENT_BRIEF, formatStatedBudget } from "@/lib/event-brief";

export type EmailSlot = 1 | 2 | 3;

export function buildOutreachEmail(opts: {
  venueName: string;
  slot: EmailSlot;
  contactName?: string | null;
}): { subject: string; body: string } {
  const hello = opts.contactName?.trim()
    ? `Hi ${opts.contactName.trim().split(/\s+/)[0]},`
    : "Hi there,";

  const budgetLabel = formatStatedBudget();
  const food = EVENT_BRIEF.foodBudgetUsd.toLocaleString("en-US");
  const bar = EVENT_BRIEF.barTabUsd.toLocaleString("en-US");
  const subject = `Private event inquiry | August 12th from 6–9pm`;

  if (opts.slot === 1) {
    return {
      subject,
      body: `${hello}

I'm looking to book a private event for a networking community on ${EVENT_BRIEF.primaryDateLabel} for ${EVENT_BRIEF.guestCountLabel} people, standing. We'd need the space fully private — either a full buyout or a private room.

Our budget is around a ${budgetLabel} minimum spend for light bites and a beer & wine tab. Ideally, we'd put about $${food} toward pre-selected food platters and $${bar} as an initial bar tab for beer and wine only, which we usually add to throughout the event depending on how much people drink.

Would love to hear more details about your space and menu options.
Thanks,
${EVENT_BRIEF.signerName}
`,
    };
  }

  if (opts.slot === 2) {
    return {
      subject: `Re: ${subject}`,
      body: `${hello}

Quick follow-up on my note about a private event on ${EVENT_BRIEF.primaryDateLabel} (${EVENT_BRIEF.guestCountLabel} people, standing, fully private). Still exploring fit for ${opts.venueName} — happy to share more detail if useful.

Best,
${EVENT_BRIEF.signerName}
`,
    };
  }

  return {
    subject: `Re: ${subject}`,
    body: `${hello}

Last note from me on the August 12th private event inquiry for ${opts.venueName}. If timing is better later, no worries — happy to reconnect whenever.

Thanks,
${EVENT_BRIEF.signerName}
`,
  };
}
