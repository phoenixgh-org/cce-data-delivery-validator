/**
 * Dashboard layout constants shared by the two-pane body and the row above it
 * (vamh.8).
 *
 * The report shell is a two-pane body — a requirements pane beside a
 * transmissions pane — with a row of summary cards sitting directly on top of
 * it, one card per pane. The cards only read as belonging to their pane if each
 * card's edges land on the edges of the pane below it, which holds only while
 * the cards, the panes and the body agree on three numbers: the two flex bases
 * and the gutter. They used to be four independent literals held together by a
 * docblock saying "change both together"; a change to either pane silently
 * misaligned the row, and nothing observed it.
 *
 * So the values live here and every surface reads them:
 * `ComplianceCard` and `TransmissionsCard` for the panes themselves,
 * `SummaryCards` for the two cards, and `Dashboard` for the body's padding and
 * gap. Editing a basis here moves the pane and the card above it together, which
 * is the only way they can drift apart.
 *
 * PRESENTATION ONLY, and deliberately browser-safe: plain string and number
 * constants, no React and no imports, so any module in `src/web` can read them
 * without pulling a component in.
 */

/**
 * Gutter and gap, in px: the two-pane body's padding and the gap between the
 * panes, and the same two values on the summary-card row above it. Equal padding
 * and gap are what put the card edges on the pane edges.
 */
export const PANE_GUTTER = 16;

/** The requirements (compliance) pane, and the summary card above it. */
export const REQUIREMENTS_PANE_FLEX = '1 1 57%';

/** The transmissions pane, and the summary card above it. */
export const TRANSMISSIONS_PANE_FLEX = '1 1 44%';

/**
 * The docked detail region INSIDE the transmissions pane, as a share of that
 * pane's height.
 *
 * It is the same string as {@link TRANSMISSIONS_PANE_FLEX} by coincidence, not
 * by dependency: that one is a width across the body, this one is a height
 * within one card's column. Narrowing the pane must not resize the detail
 * region, so the two are named separately and must be changed separately.
 */
export const TX_DETAIL_FLEX = '1 1 44%';
