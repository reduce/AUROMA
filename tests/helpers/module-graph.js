import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from '@swc/core';

const MODULES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../public/modules');

function moduleFiles() {
  return readdirSync(MODULES_DIR).filter((f) => f.endsWith('.js'));
}

/**
 * Returns the names of modules that do NOT parse as valid ES modules.
 * Empty array means every module is valid ESM.
 */
export function findInvalidModules() {
  const invalid = [];
  for (const file of moduleFiles()) {
    const code = readFileSync(join(MODULES_DIR, file), 'utf8');
    try {
      parseSync(code, { syntax: 'ecmascript', isModule: true });
    } catch (err) {
      invalid.push({ file, error: String(err.message).split('\n')[0] });
    }
  }
  return invalid;
}

function exportedNames(code) {
  const names = new Set();
  for (const m of code.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  for (const m of code.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  return names;
}

/**
 * Returns every named import from a sibling Module that does NOT resolve to a
 * real export in that sibling. Empty array means every cross-module import is wired.
 * Imports from non-sibling specifiers (bare packages, etc.) are ignored.
 */
export function findUnresolvedImports() {
  const files = moduleFiles();
  const exportsByModule = {};
  for (const file of files) {
    exportsByModule['./' + file] = exportedNames(readFileSync(join(MODULES_DIR, file), 'utf8'));
  }

  const unresolved = [];
  for (const file of files) {
    const code = readFileSync(join(MODULES_DIR, file), 'utf8');
    for (const m of code.matchAll(/import\s*\{([^}]+)\}\s*from\s*["'](\.\/[A-Za-z0-9_$.]+)["']/g)) {
      const spec = m[2].endsWith('.js') ? m[2] : m[2] + '.js';
      const exp = exportsByModule[spec];
      if (!exp) continue; // not a sibling module we track
      for (let part of m[1].split(',')) {
        part = part.trim();
        if (!part) continue;
        const orig = part.split(/\s+as\s+/)[0].trim();
        if (!exp.has(orig)) {
          unresolved.push({ file, name: orig, from: m[2] });
        }
      }
    }
  }
  return unresolved;
}
