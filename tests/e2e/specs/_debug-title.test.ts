describe('Chrome 150 headless chrome-extension:// title diagnostic', () => {
  it('reports document.title and <title> element for the options page', async () => {
    const extensionPath = await browser.getExtensionPath();
    const optionsUrl = `${extensionPath}/options/index.html`;

    await browser.url(optionsUrl);
    await browser.pause(2000);

    const result = await browser.execute(() => {
      const titleEl = document.querySelector('title');
      return {
        documentTitle: document.title,
        titleElTextContent: titleEl?.textContent ?? null,
        titleElOuterHTML: titleEl?.outerHTML ?? null,
        readyState: document.readyState,
        appContainerPresent: !!document.getElementById('app-container'),
        appContainerChildCount: document.getElementById('app-container')?.childElementCount ?? -1,
        bodyInnerHTMLLength: document.body.innerHTML.length,
        outerHTMLLength: document.documentElement.outerHTML.length,
        locationHref: window.location.href,
      };
    });

    // eslint-disable-next-line no-console
    console.log('[DEBUG-TITLE]', JSON.stringify(result, null, 2));
  });
});
