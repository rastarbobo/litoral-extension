/**
 * Meta Business Suite composer fixture for `facebook/index.ts`.
 *
 * Reconstructs the smallest DOM that satisfies the script's `SELECTORS` and
 * simulates React's progressive reveal: clicking the current step's button
 * inserts the next step's elements. The fixture is "live" (built from DOM
 * nodes with `click` handlers wired up), which makes the race-against-error
 * (F5) and missing-element (F4) negative paths trivial — they just omit or
 * alter reveal steps.
 *
 * Selector provenance: keep in sync with `facebook/index.ts SELECTORS`.
 */
import type { Outcome } from './outcome';

export { type Outcome } from './outcome';

/**
 * Build the Meta Business Suite composer in the logged-in state.
 *
 * @param outcome.controls the final reveal after the "Schedule post" button
 *   is clicked: `'success'` reveals the `[role="dialog"][aria-label*="Post scheduled"]`
 *   confirmation; `'error'` reveals a `[role="alert"]` *instead* so it wins
 *   the `waitForOutcome` race.
 */
export const buildFacebookFixture = ({ outcome = 'success' }: { outcome?: Outcome } = {}): void => {
  // Login gate — absent in F3 (logged-out). Present here by default.
  const nav = document.createElement('nav');
  nav.setAttribute('role', 'navigation');
  nav.setAttribute('aria-label', 'Facebook top navigation');
  document.body.appendChild(nav);

  // ── Composer entry point ─────────────────────────────────
  const createPostButton = document.createElement('button');
  createPostButton.setAttribute('aria-label', 'Create post');
  createPostButton.setAttribute('role', 'button');
  createPostButton.textContent = 'Create post';
  document.body.appendChild(createPostButton);

  createPostButton.addEventListener('click', () => {
    // Photo/Video button that reveals the file input + caption + publish button
    const mediaUploadButton = document.createElement('button');
    mediaUploadButton.setAttribute('aria-label', 'Photo/Video');
    mediaUploadButton.setAttribute('role', 'button');
    mediaUploadButton.textContent = 'Photo/Video';
    document.body.appendChild(mediaUploadButton);

    mediaUploadButton.addEventListener('click', () => {
      const fileInput = document.createElement('input');
      fileInput.setAttribute('type', 'file');
      document.body.appendChild(fileInput);

      const captionArea = document.createElement('textarea');
      captionArea.setAttribute('aria-label', "What's on your mind?");
      document.body.appendChild(captionArea);

      const publishButton = document.createElement('button');
      publishButton.setAttribute('role', 'button');
      publishButton.setAttribute('aria-label', 'Publish');
      publishButton.textContent = 'Publish';
      document.body.appendChild(publishButton);

      publishButton.addEventListener('click', () => {
        // Dropdown menu containing the "Schedule" menu item
        const scheduleOption = document.createElement('div');
        scheduleOption.setAttribute('role', 'menuitem');
        scheduleOption.setAttribute('aria-label', 'Schedule post');
        scheduleOption.textContent = 'Schedule';
        document.body.appendChild(scheduleOption);

        scheduleOption.addEventListener('click', () => {
          const scheduleDateInput = document.createElement('input');
          scheduleDateInput.setAttribute('type', 'datetime-local');
          document.body.appendChild(scheduleDateInput);

          const scheduleButton = document.createElement('button');
          scheduleButton.setAttribute('role', 'button');
          scheduleButton.setAttribute('aria-label', 'Schedule post');
          scheduleButton.textContent = 'Schedule post';
          document.body.appendChild(scheduleButton);

          scheduleButton.addEventListener('click', () => {
            if (outcome === 'success') {
              const dialog = document.createElement('div');
              dialog.setAttribute('role', 'dialog');
              dialog.setAttribute('aria-label', 'Post scheduled');
              dialog.textContent = 'Your post is scheduled';
              document.body.appendChild(dialog);
            } else if (outcome === 'error') {
              // Error path: ship a role="alert" so it wins the waitForOutcome race
              const alert = document.createElement('div');
              alert.setAttribute('role', 'alert');
              alert.textContent = 'Something went wrong while scheduling.';
              document.body.appendChild(alert);
            }
            // outcome === 'pending': reveal nothing — the scheduler parks in
            // waitForOutcome so a test can fire beforeunload mid-flight.
          });
        });
      });
    });
  });
};
