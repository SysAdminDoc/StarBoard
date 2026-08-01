import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const CAPTURES = resolve(ROOT, 'tests', 'screenshots');

function imageData(name) {
  try {
    return `data:image/png;base64,${readFileSync(resolve(CAPTURES, name)).toString('base64')}`;
  } catch {
    throw new Error(`Missing tests/screenshots/${name}; run the full browser smoke suite first`);
  }
}

const icon = `data:image/png;base64,${readFileSync(resolve(ROOT, 'icons', 'icon128.png')).toString('base64')}`;
const frames = [
  {
    output: 'screenshot-popup.png',
    capture: '02-popup.png',
    eyebrow: 'PORTFOLIO SIGNAL',
    title: 'Your repositories, ranked at a glance.',
    detail: 'See stars, forks, visibility, and recent activity in one focused view.',
    tags: ['Local-first', 'Exact snapshots', 'Fast filters'],
  },
  {
    output: 'screenshot-deltas.png',
    capture: '05-deltas.png',
    eyebrow: 'BASELINE MOMENTUM',
    title: 'See movement, not just totals.',
    detail: 'Compare every repository against your baseline and sort by recent gains.',
    tags: ['Star deltas', 'Fork deltas', 'Custom views'],
  },
  {
    output: 'screenshot-web-mode.png',
    capture: '06-web-mode.png',
    eyebrow: 'TOKEN-OPTIONAL',
    title: 'Start with the GitHub session you already use.',
    detail: 'Website mode reads your repository list through github.com without storing a personal access token.',
    tags: ['No token required', 'Signed-in session', 'Source status'],
  },
];

function shell(content) {
  return `<!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          * { box-sizing: border-box; }
          html, body { width: 1280px; height: 800px; margin: 0; overflow: hidden; }
          body {
            color: #f7faff;
            font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            background:
              radial-gradient(circle at 77% 30%, rgba(91, 140, 255, .21), transparent 30%),
              radial-gradient(circle at 18% 85%, rgba(44, 224, 163, .09), transparent 29%),
              linear-gradient(135deg, #07101f 0%, #0b1730 54%, #091326 100%);
          }
          body::before, body::after {
            content: "";
            position: absolute;
            border: 1px solid rgba(119, 157, 255, .12);
            border-radius: 50%;
            pointer-events: none;
          }
          body::before { width: 940px; height: 300px; left: 160px; top: 245px; transform: rotate(-8deg); }
          body::after { width: 1100px; height: 410px; left: -270px; top: 425px; transform: rotate(8deg); }
          .brand { position: absolute; left: 72px; top: 58px; display: flex; align-items: center; gap: 14px; z-index: 2; }
          .brand img { width: 48px; height: 48px; }
          .brand-name { font-size: 25px; line-height: 1; font-weight: 760; letter-spacing: -.03em; }
          .brand-sub { margin-top: 7px; color: #88a0ca; font-size: 13px; letter-spacing: .08em; text-transform: uppercase; }
          .copy { position: absolute; left: 72px; top: 214px; width: 535px; z-index: 2; }
          .eyebrow { color: #78a4ff; font-size: 14px; font-weight: 750; letter-spacing: .18em; }
          h1 { margin: 18px 0 20px; max-width: 535px; font-size: 52px; line-height: 1.04; letter-spacing: -.045em; }
          p { margin: 0; max-width: 500px; color: #a9bbda; font-size: 20px; line-height: 1.55; }
          .tags { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 34px; }
          .tag { padding: 10px 14px; border: 1px solid rgba(120, 164, 255, .34); border-radius: 999px; background: rgba(13, 29, 57, .72); color: #c7d7f4; font-size: 13px; font-weight: 650; }
          .preview { position: absolute; z-index: 3; overflow: hidden; background: #07101f; }
          .preview.popup { right: 78px; top: 80px; width: 440px; height: 640px; border: 1px solid rgba(126, 166, 255, .35); border-radius: 18px; box-shadow: 0 30px 80px rgba(0, 0, 0, .48), 0 0 0 10px rgba(72, 112, 206, .06); }
          .preview.popup img { display: block; width: 440px; height: 640px; }
          .options-preview { position: absolute; inset: 0; width: 1280px; height: 800px; overflow: hidden; z-index: 3; }
          .options-preview img { display: block; width: 1280px; height: auto; }
        </style>
      </head>
      <body>${content}</body>
    </html>`;
}

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  for (const frame of frames) {
    const tags = frame.tags.map((tag) => `<span class="tag">${tag}</span>`).join('');
    await page.setContent(shell(`
      <div class="brand"><img src="${icon}" alt=""><div><div class="brand-name">StarBoard</div><div class="brand-sub">Portfolio signal</div></div></div>
      <main class="copy"><div class="eyebrow">${frame.eyebrow}</div><h1>${frame.title}</h1><p>${frame.detail}</p><div class="tags">${tags}</div></main>
      <div class="preview popup"><img src="${imageData(frame.capture)}" alt=""></div>
    `));
    await page.screenshot({ path: resolve(ROOT, 'docs', frame.output) });
  }

  await page.setContent(shell(`
    <div class="options-preview"><img src="${imageData('07-options-web.png')}" alt=""></div>
  `));
  await page.screenshot({ path: resolve(ROOT, 'docs', 'screenshot-options.png') });
} finally {
  await browser.close();
}

console.log('PASS  rendered four 1280x800 store screenshots from current smoke captures');
