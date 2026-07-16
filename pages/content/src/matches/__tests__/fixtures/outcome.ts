/** Final reveal outcome after the platform's confirm button is clicked.
 *  Shared by `facebook-fixture.ts` and `instagram-fixture.ts` so the
 *  `buildXFixture({ outcome })` call sites have a single source of truth.
 *
 *  `'pending'` reveals nothing on the confirm-button click — the scheduler
 *  parks in `waitForOutcome` (its 30s poll loop) so a test can dispatch
 *  `beforeunload` mid-flight and assert the success/failure guards fire
 *  before any terminal outcome would race in. */
export type Outcome = 'success' | 'error' | 'pending';
