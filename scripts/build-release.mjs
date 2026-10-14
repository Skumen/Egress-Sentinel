// Builds the release: dist/egress-sentinel/ and dist/egress-sentinel.zip.
// Copies an explicit list of paths (never data/, .env, config.json or sensor/config.json),
// converts text files to LF line endings and zips with forward-slash paths.
//   node scripts/build-release.mjs
import { cpSync, rmSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const OUT = join(DIST, 'egress-sentinel');

const INCLUDE = [
  'index.js', 'package.json', 'config.example.json', '.env.example', '.gitignore', 'LICENSE',
  'README.md', 'README.ru.md', 'lib', 'webapp', 'deploy', 'docs', 'test', 'scripts', 'sensor',
];
const EXCLUDE = new Set([join('sensor', 'config.json')]);
const TEXT = new Set(['.js', '.mjs', '.json', '.md', '.html', '.service', '.conf', '.example']);

rmSync(DIST, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const files = [];
function walk(rel) {
  const abs = join(ROOT, rel);
  if (EXCLUDE.has(rel)) return;
  if (statSync(abs).isDirectory()) {
    for (const name of readdirSync(abs)) walk(join(rel, name));
  } else {
    files.push(rel);
  }
}
for (const p of INCLUDE) {
  if (!existsSync(join(ROOT, p))) throw new Error(`missing: ${p}`);
  walk(p);
}

for (const rel of files) {
  const src = join(ROOT, rel);
  const dst = join(OUT, rel);
  mkdirSync(dirname(dst), { recursive: true });
  if (TEXT.has(extname(rel)) || basename(rel) === 'Caddyfile' || basename(rel).startsWith('.')) {
    writeFileSync(dst, readFileSync(src, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n'));
  } else {
    cpSync(src, dst);
  }
}

// bsdtar (Windows 10+, macOS) and GNU tar with zip support write forward-slash entries.
execFileSync('tar', ['-a', '-cf', 'egress-sentinel.zip', 'egress-sentinel'], { cwd: DIST, stdio: 'inherit' });
console.log(`${files.length} files → dist/egress-sentinel/ and dist/egress-sentinel.zip`);
