import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function loadDotenv(p: string) {
  try {
    const content = readFileSync(p, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const m = /^(\s*#.*|\s*)$/.test(line) ? null : line.match(/^([^=\s]+)\s*=\s*(.*)$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2] ?? '';
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch {}
}

(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const rootEnv = resolve(here, '../../..', '.env');
  const pkgEnv = resolve(here, '../.env');
  if (existsSync(rootEnv)) loadDotenv(rootEnv);
  else if (existsSync(pkgEnv)) loadDotenv(pkgEnv);
})();

