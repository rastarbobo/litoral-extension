describe('Webextension Popup', () => {
  it('should open the popup successfully', async () => {
    const extensionPath = await browser.getExtensionPath();
    const popupUrl = `${extensionPath}/popup/index.html`;
    await browser.url(popupUrl);

    // Litoral popup renders the brand header "Litoral Agency" inside an <h1>.
    await expect(browser).toHaveTitle('Popup', { wait: 5000, interval: 100 });
    await expect($('h1=Litoral Agency')).toBeExisting();
  });
});
