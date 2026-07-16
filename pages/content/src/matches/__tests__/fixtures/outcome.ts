/** Final reveal outcome after the platform's confirm button is clicked.
 *  Shared by `facebook-fixture.ts` and `instagram-fixture.ts` so the
 *  `buildXFixture({ outcome })` call sites have a single source of truth. */
export type Outcome = 'success' | 'error';
