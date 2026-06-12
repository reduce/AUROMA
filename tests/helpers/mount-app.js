import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_HTML = resolve(dirname(fileURLToPath(import.meta.url)), '../../public/app.html');

/**
 * Mount the real app.html body markup into the current jsdom document, so boot
 * tests exercise the actual DOM ids the code depends on (not a hand-written
 * fixture). The module <script> tags are intentionally NOT executed — tests
 * drive boot by importing main.js themselves.
 */
export function mountAppHtml() {
  const html = readFileSync(APP_HTML, 'utf8');
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1] : html;
  // strip <script> tags so jsdom doesn't try to fetch/run them
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/gi, '');
}
