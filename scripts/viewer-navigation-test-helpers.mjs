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

// Utilities remain in the header on mobile, outside the navigation drawer.
export async function openViewerAttemptMenu(page) {
  if (await page.locator('.viewer-actions-drawer').evaluate(node => node.open)) await page.locator('.viewer-drawer-close').click();
  const trigger = page.locator('[aria-controls="viewer-attempt-menu"]');
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
}
export async function confirmViewerSaveDetails(page) {
  for (let step = 0; step < 2; step++) {
    await page.waitForFunction(() => document.querySelector('.viewer-attempt-dialog[open]')
      || document.querySelector('.read-auth-prompt, .confirm-modal-overlay [role="dialog"]')
      || window.viewerSession.state.isUploadingAttemptPackage || window.viewerSession.state.isLoadingUploadRecoveryList || !window.viewerSession.state.isUploadAttemptFlowActive);
    const dialog = page.locator('.viewer-attempt-dialog[open]');
    if (!await dialog.count()) return;
    await dialog.locator('button[type="submit"]').click();
  }
}
export async function clickViewerSave(page) {
  await openViewerAttemptMenu(page);
  await page.locator('.viewer-attempt-menu button').first().click();
  await confirmViewerSaveDetails(page);
}
export async function continueViewerSaveAfterDeletion(page) {
  const label = await page.evaluate(async () => (await import('/server/app/i18n/index.js')).t('viewer.attemptMenu.continueSave'));
  const proceed = page.locator('.viewer-attempts-modal').getByRole('button', { name: label, exact: true });
  await proceed.waitFor();
  if (!await page.locator('.viewer-attempts-modal').evaluate(node => node.scrollWidth <= node.clientWidth)) throw new Error('Slot-recovery controls overflow the dialog');
  await proceed.click();
}
