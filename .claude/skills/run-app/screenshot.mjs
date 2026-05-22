// One-shot: launch app, take screenshots, quit
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SHOT_DIR = process.env.SCREENSHOT_DIR || '/tmp/shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });

const ELECTRON_BIN = path.join(
  APP_DIR,
  '.electron-runner/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
);

console.log('Launching...');
const app = await electron.launch({
  executablePath: ELECTRON_BIN,
  args: [APP_DIR],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_ENV: 'production' },
  timeout: 30_000,
});

// Wait for app to settle
await new Promise(r => setTimeout(r, 5_000));

const windows = app.windows();
console.log('Windows:', windows.length);
for (const w of windows) console.log(' url:', w.url());

const page = windows.find(w => !w.url().startsWith('devtools://')) ?? await app.firstWindow();

// Try to let the socket auto-load first; inject test data only as fallback
const testConfig = {
  version: 5, type: 'page',
  controls: {
    'bank:1-11': {
      type: 'button',
      style: { text: 'Resume', color: 0xffffff, bgcolor: 0x000000, size: 'auto' },
      options: { relativeDelay: false, stepAutoProgress: true },
      feedbacks: [],
      steps: {
        '0': {
          action_sets: {
            down: [
              { id: 'a1', action: 'go',             instance: 'qlabfb', options: {}, delay: 0 },
              { id: 'a2', action: 'stop',            instance: 'qlabfb', options: {}, delay: 500 },
              { id: 'a3', action: 'new_togglePause', instance: 'qlabfb', options: {}, delay: 1800 },
              // Action group with sequential execution
              {
                id: 'ag1', action: 'action_group', instance: 'internal',
                options: { execution_mode: 'sequential' }, delay: 3000,
                children: {
                  default: [
                    { id: 'ag1a', action: 'go',   instance: 'qlabfb', options: {}, delay: 0 },
                    { id: 'ag1b', action: 'stop',  instance: 'qlabfb', options: {}, delay: 500 },
                  ]
                }
              },
            ],
            up: [
              { id: 'a4', action: 'go', instance: 'qlabfb', options: {}, delay: 0 },
            ],
            '1000': [
              { id: 'a5', action: 'hardStop', instance: 'qlabfb', options: {}, delay: 0 },
              { id: 'a6', action: 'panic',    instance: 'qlabfb', options: {}, delay: 250 },
            ],
          },
          options: {}
        }
      }
    }
  },
  page: { 1: { name: 'Page 1' } },
  instances: {
    qlabfb: { instance_type: 'figure53-qlab-advance', label: 'qlabfb', enabled: true }
  }
};

// Wait up to 6s for satellite auto-load from Companion, then fall back to test data
let autoLoaded = false;
for (let i = 0; i < 12; i++) {
  await new Promise(r => setTimeout(r, 500));
  autoLoaded = await page.evaluate(() => !!document.querySelector('.btn-cell:not(.btn-cell--empty)'));
  if (autoLoaded) { console.log('auto-loaded from Companion'); break; }
}
// Wait for satellite, then inject test data to show wait alignment
await new Promise(r => setTimeout(r, 3000));
await page.evaluate((cfg) => { if (window.__injectConfig) window.__injectConfig(cfg); }, testConfig);
await new Promise(r => setTimeout(r, 600));

// Click a button, then double-click a track to open Add Action modal
await page.evaluate(() => {
  const btn = document.querySelector('.btn-cell:not(.btn-cell--empty)');
  if (btn) btn.click();
});
await new Promise(r => setTimeout(r, 400));

// Double-click the Press track to trigger Add Action
await page.evaluate(() => {
  const trackBody = document.querySelector('.track-body');
  if (trackBody) {
    const e = new MouseEvent('dblclick', { bubbles: true, clientX: 500, clientY: trackBody.getBoundingClientRect().top + 20 });
    trackBody.dispatchEvent(e);
  }
});
await new Promise(r => setTimeout(r, 2000));

// Screenshot the timeline
const shot1 = path.join(SHOT_DIR, 'ct-01-initial.png');
await page.screenshot({ path: shot1 });
console.log('screenshot:', shot1);

await app.close();
console.log('done');
