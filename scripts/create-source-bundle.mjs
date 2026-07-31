import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const files = [
  '.env.example',
  '.gitignore',
  'LICENSE',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'package.json',
  'package-lock.json',
  'vite.config.js',
  'index.html',
  'server.mjs',
  'server/chat-core.mjs',
  'scripts/create-source-bundle.mjs',
  'src/main.js',
  'src/history.js',
  'src/sse.js',
  'src/style.css',
  'supabase/config.toml',
  'supabase/functions/chat/index.ts',
  'tests/chat-core.test.mjs',
  'tests/history.test.mjs',
  'tests/sse.test.mjs',
];

const sections = await Promise.all(
  files.map(async (file) => {
    const contents = await readFile(resolve(root, file), 'utf8');
    return `\n${'='.repeat(80)}\nFILE: ${file}\n${'='.repeat(80)}\n\n${contents}`;
  }),
);

const header = `FLASH CHAT CORRESPONDING SOURCE\n
Generated from the exact application source at build time.\n
License: GNU Affero General Public License v3.0 or later.\n
Install with: npm ci\n
Run with: npm run dev\n`;

const sourceBundle = `${header}${sections.join('')}\n`;

await Promise.all([
  mkdir(resolve(root, 'dist'), { recursive: true }),
  mkdir(resolve(root, 'public'), { recursive: true }),
]);
await Promise.all([
  writeFile(resolve(root, 'dist/source-code.txt'), sourceBundle, 'utf8'),
  writeFile(resolve(root, 'public/source-code.txt'), sourceBundle, 'utf8'),
]);

console.log('Included corresponding source at /source-code.txt');
