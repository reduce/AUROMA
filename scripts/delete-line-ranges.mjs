#!/usr/bin/env node
/**
 * One-off: delete inclusive 1-based line ranges from a file.
 * Ranges are deleted high-to-low so earlier line numbers stay valid.
 * Usage: node scripts/delete-line-ranges.mjs <file> <start-end> [<start-end> ...] [--write]
 */
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const write = args.includes('--write');
const file = args[0];
const ranges = args.slice(1).filter(a => a !== '--write').map(r => {
  const [s, e] = r.split('-').map(Number);
  return [s, e];
});
if (!file || ranges.length === 0) {
  console.error('usage: delete-line-ranges.mjs <file> <start-end> [...] [--write]');
  process.exit(1);
}

const lines = readFileSync(file, 'utf8').split('\n');
// sort descending by start so deletions don't shift later ranges
ranges.sort((a, b) => b[0] - a[0]);
for (const [s, e] of ranges) {
  lines.splice(s - 1, e - s + 1);
}
const out = lines.join('\n');
console.error(`deleted ${ranges.length} range(s) from ${file}`);
if (write) { writeFileSync(file, out, 'utf8'); console.error('wrote'); }
else process.stdout.write(out);
