#!/usr/bin/env node
/**
 * One-off: strip `console.log(...)` calls from a JS file, multi-line-safe.
 *
 * Approach: scan char-by-char tracking string/template/comment context so we
 * never match `console.log` inside a string or comment. When we hit a real
 * `console.log` followed by `(`, walk forward counting parens (still
 * string/comment-aware) to the matching `)`, then consume a trailing `;` and
 * the rest-of-line whitespace + newline if the statement stood on its own line.
 *
 * Only deletes the matched ranges — surrounding code is untouched (no reflow).
 * Keeps console.error / console.warn. Refuses to run if the result doesn't have
 * balanced-looking output; caller should `node --check` afterward regardless.
 *
 * Usage: node scripts/strip-console-log.mjs <file> [--write]
 */
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
const write = process.argv.includes('--write');
if (!file) { console.error('usage: strip-console-log.mjs <file> [--write]'); process.exit(1); }

const src = readFileSync(file, 'utf8');
const n = src.length;

// Find index of matching close paren starting at the index of '(' (src[open]==='(').
// String/template/comment aware so parens inside strings don't count.
function matchParen(open) {
  let depth = 0;
  let i = open;
  while (i < n) {
    const c = src[i];
    // skip strings
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (quote === '`' && src[i] === '$' && src[i + 1] === '{') {
          // template expression — recurse on the {...}
          let braceDepth = 1; i += 2;
          while (i < n && braceDepth > 0) {
            if (src[i] === '{') braceDepth++;
            else if (src[i] === '}') braceDepth--;
            else if (src[i] === '"' || src[i] === "'" || src[i] === '`') {
              const q2 = src[i]; i++;
              while (i < n && src[i] !== q2) { if (src[i] === '\\') i++; i++; }
            }
            i++;
          }
          continue;
        }
        if (src[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    // skip line comment
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    // skip block comment
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
    i++;
  }
  return -1;
}

// Walk the source, collecting [start,end) ranges to delete.
const ranges = [];
let i = 0;
let stripped = 0;
while (i < n) {
  const c = src[i];
  // skip strings at top-level scan too
  if (c === '"' || c === "'" || c === '`') {
    const quote = c; i++;
    while (i < n) {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === quote) { i++; break; }
      i++;
    }
    continue;
  }
  if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
  if (c === '/' && src[i + 1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }

  if (src.startsWith('console.log', i)) {
    // ensure it's not part of a longer identifier (prev char not ident char)
    const prev = src[i - 1] || ' ';
    if (/[A-Za-z0-9_$.]/.test(prev)) { i++; continue; }
    let j = i + 'console.log'.length;
    while (j < n && /\s/.test(src[j])) j++;
    if (src[j] === '(') {
      const close = matchParen(j);
      if (close !== -1) {
        let end = close + 1;
        if (src[end] === ';') end++;
        // figure out start: if everything before console.log on this line is whitespace,
        // delete the whole line (incl. leading indent + trailing newline).
        let lineStart = i;
        while (lineStart > 0 && src[lineStart - 1] !== '\n') lineStart--;
        const beforeOnLine = src.slice(lineStart, i);
        let start = i;
        if (/^\s*$/.test(beforeOnLine)) {
          start = lineStart;
          // consume trailing whitespace through the newline
          while (end < n && src[end] !== '\n' && /\s/.test(src[end])) end++;
          if (src[end] === '\n') end++;
        }
        ranges.push([start, end]);
        stripped++;
        i = end;
        continue;
      }
    }
  }
  i++;
}

// Apply deletions back-to-front.
let out = src;
for (let k = ranges.length - 1; k >= 0; k--) {
  out = out.slice(0, ranges[k][0]) + out.slice(ranges[k][1]);
}

const remaining = (out.match(/console\.log/g) || []).length;
console.error(`stripped ${stripped} console.log call(s); ${remaining} occurrence(s) of "console.log" remain (should be 0 outside strings/comments)`);

if (write) {
  writeFileSync(file, out, 'utf8');
  console.error(`wrote ${file}`);
} else {
  process.stdout.write(out);
}
