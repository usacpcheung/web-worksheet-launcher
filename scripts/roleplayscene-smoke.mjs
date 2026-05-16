import { chromium } from 'playwright';

const DEFAULT_URL = 'http://localhost:8765/server/roleplayscene/index.html';

function parseArgs(argv) {
  const args = new Set(argv);
  const urlArg = argv.find((arg) => !arg.startsWith('-'));
  return {
    headed: args.has('--headed'),
    keepOpen: args.has('--keep-open'),
    url: process.env.ROLEPLAYSCENE_URL || urlArg || DEFAULT_URL,
  };
}

function formatLog(entry) {
  return `[${entry.type}] ${entry.text}`;
}

const options = parseArgs(process.argv.slice(2));
const browser = await chromium.launch({ headless: !options.headed });
const page = await browser.newPage();
const consoleMessages = [];
const pageErrors = [];
const assetFailures = [];

page.on('console', (message) => {
  const entry = { type: message.type(), text: message.text() };
  consoleMessages.push(entry);
  if (entry.type === 'error' || entry.type === 'warning') {
    console.log(formatLog(entry));
  }
});

page.on('pageerror', (error) => {
  pageErrors.push(error);
  console.log(`[pageerror] ${error.message}`);
});

page.on('response', (response) => {
  const request = response.request();
  const resourceType = request.resourceType();
  if (
    response.status() >= 400
    && ['document', 'script', 'stylesheet'].includes(resourceType)
  ) {
    assetFailures.push({
      status: response.status(),
      resourceType,
      url: response.url(),
    });
  }
});

try {
  await page.goto(options.url, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForSelector('#left-pane > *', { timeout: 10_000 });
  await page.waitForSelector('#right-pane > *', { timeout: 10_000 });

  const localeOptionCount = await page.locator('#locale-select option').count();
  const activeMode = await page.locator('#mode-edit.active, #mode-play.active').count();
  const serverStatus = await page.locator('#server-status').textContent({ timeout: 5_000 });

  if (localeOptionCount < 2) {
    throw new Error(`Expected at least 2 locale options, found ${localeOptionCount}.`);
  }
  if (activeMode !== 1) {
    throw new Error(`Expected exactly one active mode button, found ${activeMode}.`);
  }

  if (assetFailures.length || pageErrors.length) {
    throw new Error([
      `RolePlayScene loaded with ${assetFailures.length} asset failure(s) and ${pageErrors.length} page error(s).`,
      ...assetFailures.map((failure) => (
        `[asset ${failure.status} ${failure.resourceType}] ${failure.url}`
      )),
      ...pageErrors.map((error) => `[pageerror] ${error.message}`),
    ].join('\n'));
  }

  console.log(`RolePlayScene smoke check passed: ${options.url}`);
  console.log(`Locale options: ${localeOptionCount}`);
  console.log(`Server status: ${String(serverStatus || '').trim()}`);
} finally {
  if (options.keepOpen) {
    console.log('Browser left open because --keep-open was provided.');
  } else {
    await browser.close();
  }
}
