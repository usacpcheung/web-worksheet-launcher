// Exercise the actual responsive controls; never bypass section navigation via state edits.
export async function openViewerActions(page) {
  const launcher = page.locator('.viewer-actions-launcher');
  if (await launcher.isVisible() && !await page.locator('.viewer-actions-drawer').evaluate(node => node.open)) await launcher.click();
}
export async function clickViewerAction(page, name) {
  await openViewerActions(page);
  await page.getByRole('button', { name, exact: true }).click();
}
export async function chooseViewerSection(page, index) {
  await openViewerActions(page);
  await page.locator('.viewer-browse').click();
  const target = page.locator(`.viewer-chooser__item[data-section-index="${index}"]`);
  for (let count = 0; !await target.isVisible() && count < 500; count++) {
    const visible = await page.locator('.viewer-chooser__item:visible').first().getAttribute('data-section-index');
    await page.locator(Number(visible) > index ? '.viewer-chooser__previous' : '.viewer-chooser__next').click();
  }
  await target.click();
}
