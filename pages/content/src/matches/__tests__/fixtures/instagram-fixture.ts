/**
 * Instagram Creator Studio composer fixture for `instagram/index.ts`.
 *
 * Mirrors `facebook-fixture.ts` but reconstructs the IG scheduler, which is a
 * single-step "Create post" flow that opens the composer directly (no separate
 * media-reveal step like FB's Photo/Video button), then a "Schedule" toggle
 * reveals the date and final Schedule button.
 *
 * Selector provenance: keep in sync with `instagram/index.ts SELECTORS`.
 *
 * Quirk: IG's `successIndicator` is
 *   `[role="dialog"][aria-label*="Scheduled"], [role="dialog"]`
 * — the second comma arm matches ANY dialog, so the success fixture must
 * give the dialog an aria-label containing "Scheduled" (it does).
 */
import type { Outcome } from './outcome';

export { type Outcome } from './outcome';

export const buildInstagramFixture = ({ outcome = 'success' }: { outcome?: Outcome } = {}): void => {
  // Login gate — IG uses an aria-label="Instagram" anchor (case-insensitive `i`).
  const logo = document.createElement('a');
  logo.setAttribute('aria-label', 'Instagram');
  logo.textContent = 'Instagram';
  document.body.appendChild(logo);

  // ── Create post button ─────────────────────────────────
  const createPostButton = document.createElement('button');
  createPostButton.setAttribute('aria-label', 'Create post');
  createPostButton.textContent = 'Create post';
  document.body.appendChild(createPostButton);

  createPostButton.addEventListener('click', () => {
    // IG exposes the file input immediately (accept must carry `image` or
    // `video` for the `[accept*="image"], [accept*="video"]` selector).
    const fileInput = document.createElement('input');
    fileInput.setAttribute('type', 'file');
    fileInput.setAttribute('accept', 'image/*,video/*');
    document.body.appendChild(fileInput);

    const captionArea = document.createElement('textarea');
    captionArea.setAttribute('aria-label', 'Write a caption...');
    document.body.appendChild(captionArea);

    // Schedule toggle (role="button", aria-label*="Schedule") — distinct from
    // the final submit button (button[type="button"][aria-label*="Schedule"]).
    const scheduleToggle = document.createElement('button');
    scheduleToggle.setAttribute('role', 'button');
    scheduleToggle.setAttribute('aria-label', 'Schedule');
    scheduleToggle.textContent = 'Schedule';
    document.body.appendChild(scheduleToggle);

    scheduleToggle.addEventListener('click', () => {
      const scheduleDateInput = document.createElement('input');
      scheduleDateInput.setAttribute('type', 'datetime-local');
      document.body.appendChild(scheduleDateInput);

      const scheduleButton = document.createElement('button');
      // type="button" is what disambiguates this from the toggle above.
      scheduleButton.setAttribute('type', 'button');
      scheduleButton.setAttribute('aria-label', 'Schedule');
      scheduleButton.textContent = 'Schedule';
      document.body.appendChild(scheduleButton);

      scheduleButton.addEventListener('click', () => {
        if (outcome === 'success') {
          const dialog = document.createElement('div');
          dialog.setAttribute('role', 'dialog');
          dialog.setAttribute('aria-label', 'Scheduled');
          dialog.textContent = 'Your reels are scheduled';
          document.body.appendChild(dialog);
        } else if (outcome === 'error') {
          const alert = document.createElement('div');
          alert.setAttribute('role', 'alert');
          alert.textContent = 'We could not schedule your post.';
          document.body.appendChild(alert);
        }
        // outcome === 'pending': reveal nothing — the scheduler parks in
        // waitForOutcome so a test can fire beforeunload mid-flight.
      });
    });
  });
};
