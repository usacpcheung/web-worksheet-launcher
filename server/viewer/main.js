import { viewerStorage } from './storage/index.js';

const app = document.getElementById('app');

if (app) {
  const storageReady = typeof viewerStorage?.drafts?.put === 'function';
  app.textContent = storageReady ? 'Viewer booted with storage layer' : 'Viewer booted';
}
