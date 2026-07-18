import { canSwitchTheme } from '../helpers/theme.js';

describe('Webextension New Tab', () => {
  it('should open the extension page when a new tab is opened', async () => {
    const extensionPath = await browser.getExtensionPath();
    // Always navigate to the Litoral new-tab page directly. (The manifest does
    // not register a `chrome_url_overrides.newtab` entry, so `chrome://newtab`
    // would show Chrome's built-in new tab page, not Litoral's. The Firefox
    // path already navigated to the extension page; this normalizes the two.)
    const newTabUrl = `${extensionPath}/new-tab/index.html`;

    await browser.url(newTabUrl);

    const appDiv = await $('.App').getElement();
    await expect(appDiv).toBeExisting();
    await canSwitchTheme();
  });
});
