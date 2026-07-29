import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** A scratch directory that cleans itself up when the returned dispose() runs. */
export async function tempDir(prefix = 'ayna-test-') {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  return { dir, dispose: () => rm(dir, { recursive: true, force: true }) };
}

/** Writes a tiny site into `dir` so browser tests have something real to render. */
export async function fixtureSite(dir, { overflow = false, tinyText = false, blank = false } = {}) {
  await mkdir(dir, { recursive: true });
  const body = blank
    ? ''
    : `
      <header id="nav"><a id="logo">Fixture</a></header>
      <main class="container">
        <h1 class="title">A headline that is long enough to matter</h1>
        <p class="lede">Body copy for the fixture page.</p>
        ${overflow ? '<div style="width:3000px">wide</div>' : ''}
        ${tinyText ? '<span style="font-size:9px">tiny legal text</span>' : ''}
        <ul class="list"><li>one</li><li>two</li><li>three</li></ul>
      </main>`;

  await writeFile(
    path.join(dir, 'index.html'),
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Fixture</title><link rel="icon" href="data:,">
<link rel="stylesheet" href="styles.css"></head><body>${body}</body></html>`,
  );
  await writeFile(path.join(dir, 'styles.css'), 'body{font-family:system-ui;margin:0}\n.title{font-size:32px}\n');
  return dir;
}

export const hasBrowser = !process.env.AYNA_SKIP_BROWSER;
