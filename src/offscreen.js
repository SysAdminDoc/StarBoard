/**
 * StarBoard — offscreen DOM host for web (no-token) mode.
 *
 * All it does is hand a real DOMParser to `scrapeAccount`, which the service
 * worker cannot do itself: MV3 workers have no DOMParser.
 *
 * Requests carry `credentials: 'include'` so the browser's existing github.com
 * session applies — this reads the same pages the user is already signed in to
 * see, one at a time, identifying itself as the extension it is.
 */

import { scrapeAccount } from './lib/scrape.js';

const parser = new DOMParser();
const parseHTML = (html) => parser.parseFromString(html, 'text/html');

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;

  (async () => {
    try {
      if (msg.type === 'scrape-account') {
        sendResponse({ ok: true, result: await scrapeAccount(msg.username, parseHTML) });
      } else {
        sendResponse({ ok: false, error: { message: `Unknown offscreen job: ${msg.type}` } });
      }
    } catch (err) {
      sendResponse({ ok: false, error: { message: err.message } });
    }
  })();

  return true;
});
