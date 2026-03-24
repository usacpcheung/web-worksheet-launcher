import { editorStorage } from './storage/index.js';

const app = document.getElementById('app');

if (app) {
  const storageReady = typeof editorStorage?.drafts?.put === 'function';
  app.textContent = storageReady ? 'Editor booted with storage layer' : 'Editor booted';
}
