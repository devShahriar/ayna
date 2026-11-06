/*
  Folders that are never a UI's source.

  Build output is not source. A Next.js project answers a grep for a class name
  from .next/server/... and .next/static/chunks/... long before it reaches the
  component that produced it — so the file:line handed to Claude pointed at
  generated code that is rewritten on every build. Same for dist, build, .nuxt
  and friends; and a virtualenv or a package manager's store is large and never
  what anyone is reviewing.

  One list, because the window's grep and watcher and the watch daemon had two
  copies of it, and they had already drifted apart.
*/
export const SKIP_DIRS = [
  'node_modules', '.git', '.ayna', '.next', '.nuxt', '.svelte-kit', '.output',
  '.turbo', '.cache', '.parcel-cache', 'dist', 'build', 'out', 'coverage',
  'vendor', '__pycache__', '.venv', 'venv', '.yarn', '.pnpm-store',
];
