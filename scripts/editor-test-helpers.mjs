// Transport/auth fixtures need a distributable worksheet to reach those flows.
// Validation tests deliberately leave the initial reading block empty instead.
export async function completeDefaultReadingBlock(page) {
  await page.waitForFunction(() => window.editorSession?.state.draft);
  await page.evaluate(() => {
    const session = window.editorSession;
    for (const block of session.state.draft.blocks) {
      if (block.kind === 'content' && !block.content.text.trim()) {
        session.updateBlockContent(block.blockId, 'Read the worksheet instructions.');
      }
    }
  });
}
