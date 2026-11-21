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

/*
  Test files are never what a review is looking at.

  The window treats any edit in the project as the round's work, and a test
  written while a round was out was taken as the answer to it: the round was
  announced as applied with nothing but the test in it, and the user's change
  had not been made. A test is also never where a UI is edited, so it is no use
  as a source location either.

  Folders by name anywhere in the path, files by the conventions the common
  runners use (foo.test.js, foo.spec.ts, foo_test.go, test_foo.py).
*/
const TEST_DIRS = new Set(['test', 'tests', '__tests__', '__mocks__', 'spec', 'e2e', 'cypress', 'playwright-report', 'test-results']);
const TEST_FILE = /[._-](test|spec)s?\.[^/\\]+$|^test_[^/\\]+\.py$|_test\.[^/\\]+$/i;

/** True for a project-relative path that belongs to the tests. */
export function isTestPath(rel) {
  const parts = String(rel).split(/[\\/]/).filter(Boolean);
  if (!parts.length) return false;
  if (parts.slice(0, -1).some((p) => TEST_DIRS.has(p.toLowerCase()))) return true;
  return TEST_FILE.test(parts[parts.length - 1]);
}
