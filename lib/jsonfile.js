import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

/** Reads a JSON file; returns fallback if the file does not exist. */
export function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
}

/** Atomic write: write a temporary file, then rename it over the old one, so the file is never half-written. */
export function writeJson(path, data, { pretty = true } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, (pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data)) + '\n', 'utf8');
  renameSync(tmp, path);
}
