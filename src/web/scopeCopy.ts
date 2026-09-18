/**
 * Scope readout copy (vamh.1) — the sentences that explain what a scoped count
 * is counting.
 *
 * The functions here used to live in FilterBar.tsx, which the one-line header
 * retired. They are copy, not markup, and their readers moved: the summary cards
 * carry the scoped numbers now. Keeping them in their own module means the
 * surface that renders a count can change without the sentence that qualifies it
 * moving with it.
 *
 * Pure and browser-safe: no DOM, no JSX, no backend import — so scopeCopy.test.ts
 * exercises it on the Node runner without the React shim the JSX-bearing modules
 * need.
 */

/**
 * The CCE-unit readout's tooltip (p98). The number is DISTINCT APPLIANCES THAT
 * REPORTED, and the tooltip is the only thing standing between that and being
 * read as fleet coverage — DESIGN §7 says the receiving side can only speak for
 * what arrived, so the sentence names the identifier the count is keyed on and
 * then says plainly what the number is not. Neither "coverage" nor "fleet size"
 * appears as a label anywhere.
 *
 * Naming both identifiers, in preference order, is also the disclosure that the
 * two are different kinds of name: a supplier that sends a serial for one fridge
 * and only its own appliance id for another has two units here either way, and a
 * reader who knows which field is counted can see why.
 *
 * The second sentence appears only when some report named no appliance at all:
 * those reports are in the transmission count but in no unit, and without the
 * sentence the two numbers would look inconsistent for no visible reason.
 */
export function unitsTitle(unidentifiedReports: number): string {
  const base =
    'Distinct appliances reported on in this scope — the manufacturer serial ' +
    "(ASER) where sent, otherwise the supplier's appliance id (AMID). Counts " +
    'what was received, not the fleet.';
  if (unidentifiedReports <= 0) return base;
  // Pluralized: the brief's sentence is written with a placeholder N, and a
  // readout that says "1 reports" is a defect on a surface this careful.
  const noun = unidentifiedReports === 1 ? 'report' : 'reports';
  return `${base} ${unidentifiedReports} ${noun} carried no appliance identifier.`;
}
