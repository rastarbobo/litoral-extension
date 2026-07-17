describe('Chrome 150 headless MV3 load diagnostic', () => {
  it('probes chrome://extensions/, retries extension URL nav, and reads manifest.json', async () => {
    await browser.url('chrome://extensions/');
    await browser.pause(1500);
    const result = await browser.execute(() => {
      return {
        url: window.location.href,
        title: document.title,
        bodyTextSample: document.body.innerText.slice(0, 500),
        bodyHasDropToInstall: document.body.innerText.toLowerCase().includes('drop to install'),
        bodyHasLoadedExtensionsText: document.body.innerText.toLowerCase().includes('litoral'),
        managerElement: !!document.querySelector('extensions-manager'),
        itemListElement: !!document.querySelector('extensions-item-list'),
        itemCount: document.querySelectorAll('extensions-item').length,
      } as Record<string, unknown>;
    });
    console.log('[DEBUG-A] chrome://extensions/ probe:', JSON.stringify(result, null, 2));
    await browser.pause(500);

    const extensionPath = await browser.getExtensionPath();
    const optionsUrl = `${extensionPath}/options/index.html`;
    await browser.url(optionsUrl);
    await browser.pause(2000);
    let result2 = await browser.execute(() => ({
      locationHref: window.location.href,
      documentTitle: document.title,
      appContainerPresent: !!document.getElementById('app-container'),
      readyState: document.readyState,
    } as Record<string, unknown>));
    console.log('[DEBUG-B] first nav to options:', JSON.stringify(result2, null, 2));

    // Try once more
    await browser.url(optionsUrl);
    await browser.pause(3000);
    result2 = await browser.execute(() => ({
      locationHref: window.location.href,
      documentTitle: document.title,
      appContainerPresent: !!document.getElementById('app-container'),
      readyState: document.readyState,
    } as Record<string, unknown>));
    console.log('[DEBUG-B] second nav to options (3s wait):', JSON.stringify(result2, null, 2));

    await browser.url(`${extensionPath}/manifest.json`);
    await browser.pause(1500);
    const result3 = await browser.execute(() => ({
      locationHref: window.location.href,
      bodyTextSample: document.body.innerText.slice(0, 1000),
    } as Record<string, unknown>));
    console.log('[DEBUG-C] manifest.json probe:', JSON.stringify(result3, null, 2));
  });
});
