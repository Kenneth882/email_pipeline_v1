/** True when draft body uses the escalate-don't-invent marker. */
export function draftHasEscalation(body: string): boolean {
  return /\[ESCALATION/i.test(body);
}
