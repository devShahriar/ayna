import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const SEVERITY_COLOR = { critical: '#ff6b6b', major: '#ffa94d', minor: '#74c0fc' };

function shotPair(iter, runDir) {
  const rel = (f) => path.relative(runDir, f);
  const viewports = iter.before.shots.map((s) => s.viewport);

  return viewports
    .map((vp) => {
      const b = iter.before.shots.find((s) => s.viewport === vp);
      const a = iter.after?.shots.find((s) => s.viewport === vp);
      return `
      <div class="pair">
        <div class="pair-label">${esc(vp)}</div>
        <div class="frames">
          <figure><figcaption>before</figcaption><img src="${esc(rel(b.file))}" loading="lazy"></figure>
          ${
            a
              ? `<figure><figcaption>after${
                  iter.reverted ? ' — rolled back, shown for comparison' : ''
                }</figcaption><img src="${esc(rel(a.file))}" loading="lazy"></figure>`
              : '<figure class="empty"><figcaption>after</figcaption><div class="none">not captured</div></figure>'
          }
        </div>
      </div>`;
    })
    .join('');
}

function iterationBlock(iter, runDir) {
  // An iteration that threw has no screenshots to show — say what broke instead.
  if (!iter.before) {
    return `
  <section class="iter reverted">
    <header><h2>Iteration ${iter.n}</h2><div class="badge">failed</div></header>
    <p class="verdict">${esc(iter.error ?? 'no data recorded')}</p>
  </section>`;
  }

  const c = iter.critique;
  const issues = (c?.issues ?? [])
    .map(
      (i) => `
      <li>
        <span class="sev" style="--sev:${SEVERITY_COLOR[i.severity] ?? '#adb5bd'}">${esc(i.severity)}</span>
        <span class="area">${esc(i.area)}</span>
        <div class="problem">${esc(i.problem)}</div>
        <div class="fix">→ ${esc(i.fix)}</div>
      </li>`,
    )
    .join('');

  const changes = (iter.changes ?? [])
    .map((ch) => `<li><code>${esc(ch.file)}</code> <span class="kind">${esc(ch.kind)}</span></li>`)
    .join('');

  return `
  <section class="iter${iter.reverted ? ' reverted' : ''}">
    <header>
      <h2>Iteration ${iter.n}</h2>
      ${c ? `<div class="score" data-score="${c.score >= 8 ? 'good' : c.score >= 5 ? 'mid' : 'bad'}">${esc(c.score)}<span>/10</span></div>` : ''}
      ${iter.reverted ? '<div class="badge">reverted</div>' : ''}
    </header>
    ${c ? `<p class="verdict">${esc(c.verdict)}</p>` : ''}
    ${shotPair(iter, runDir)}
    <div class="cols">
      <div>
        <h3>What the critic saw</h3>
        <ul class="issues">${issues || '<li class="none">no issues</li>'}</ul>
      </div>
      <div>
        <h3>What changed</h3>
        <ul class="changes">${changes || '<li class="none">no files changed</li>'}</ul>
        ${iter.summary ? `<pre class="summary">${esc(iter.summary.slice(0, 2000))}</pre>` : ''}
        ${
          iter.verdict
            ? `<h3>Verifier</h3><p class="${iter.verdict.improved ? 'good' : 'bad'}">${
                iter.verdict.improved ? 'improved' : 'not clearly improved'
              } — ${esc(iter.verdict.notes)}</p>${
                iter.verdict.regressions?.length
                  ? `<ul class="regressions">${iter.verdict.regressions.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`
                  : ''
              }`
            : ''
        }
      </div>
    </div>
  </section>`;
}

export async function writeReport({ cfg, runId, runDir, iterations, stopReason, totalCost }) {
  const first = iterations[0]?.critique?.score;
  const last = [...iterations].reverse().find((i) => i.critique)?.critique?.score;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ayna · ${esc(cfg.target.name)} · ${esc(runId)}</title>
<style>
  :root { color-scheme: dark; --bg:#0c0d10; --panel:#14161b; --line:#242832; --ink:#e8eaf0; --mute:#8b93a7; --accent:#7c9cff; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
    font:15px/1.6 ui-sans-serif,-apple-system,"SF Pro Text",Inter,system-ui,sans-serif; }
  .wrap { max-width:1180px; margin:0 auto; padding:48px 24px 96px; }
  h1 { font-size:28px; letter-spacing:-.02em; margin:0 0 4px; }
  .meta { color:var(--mute); font-size:13px; margin-bottom:32px; }
  .meta b { color:var(--ink); font-weight:600; }
  .delta { display:flex; gap:24px; padding:20px 24px; background:var(--panel);
    border:1px solid var(--line); border-radius:14px; margin-bottom:40px; align-items:center; }
  .delta .n { font-size:32px; font-weight:650; letter-spacing:-.03em; }
  .delta .arrow { color:var(--mute); font-size:20px; }
  .delta .lbl { color:var(--mute); font-size:12px; text-transform:uppercase; letter-spacing:.08em; }
  section.iter { background:var(--panel); border:1px solid var(--line); border-radius:16px;
    padding:28px; margin-bottom:28px; }
  section.iter.reverted { border-color:#5c2b2b; }
  section.iter header { display:flex; align-items:center; gap:14px; margin-bottom:6px; }
  h2 { font-size:19px; margin:0; letter-spacing:-.01em; }
  .score { font-size:22px; font-weight:650; letter-spacing:-.02em; }
  .score span { font-size:13px; color:var(--mute); font-weight:400; }
  .score[data-score=good] { color:#69db7c; } .score[data-score=mid] { color:#ffd43b; } .score[data-score=bad] { color:#ff8787; }
  .badge { font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:#ff8787;
    border:1px solid #5c2b2b; border-radius:99px; padding:2px 10px; }
  .verdict { color:var(--mute); margin:0 0 22px; }
  .pair { margin-bottom:22px; }
  .pair-label { font-size:11px; text-transform:uppercase; letter-spacing:.1em; color:var(--mute); margin-bottom:8px; }
  .frames { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
  figure { margin:0; }
  figcaption { font-size:11px; color:var(--mute); margin-bottom:6px; }
  figure img { width:100%; border:1px solid var(--line); border-radius:10px; display:block;
    max-height:520px; object-fit:cover; object-position:top; background:#fff; }
  figure .none { border:1px dashed var(--line); border-radius:10px; padding:40px; text-align:center; color:var(--mute); }
  .cols { display:grid; grid-template-columns:1fr 1fr; gap:28px; margin-top:24px; }
  h3 { font-size:12px; text-transform:uppercase; letter-spacing:.1em; color:var(--mute); margin:0 0 12px; }
  ul { list-style:none; padding:0; margin:0; }
  .issues li { padding:12px 0; border-bottom:1px solid var(--line); }
  .issues li:last-child { border-bottom:0; }
  .sev { font-size:10px; text-transform:uppercase; letter-spacing:.08em; color:var(--sev);
    border:1px solid var(--sev); border-radius:99px; padding:1px 8px; margin-right:8px; }
  .area { font-size:12px; color:var(--mute); }
  .problem { margin-top:6px; }
  .fix { margin-top:4px; color:var(--mute); font-size:14px; }
  .changes li { padding:6px 0; }
  .changes code { background:#1c1f27; padding:2px 7px; border-radius:6px; font-size:13px; }
  .kind { color:var(--mute); font-size:12px; margin-left:6px; }
  .summary { background:#1c1f27; border-radius:10px; padding:14px; font-size:12.5px;
    white-space:pre-wrap; color:var(--mute); margin-top:14px; overflow-x:auto; }
  .regressions li { color:#ff8787; font-size:13px; padding:3px 0; }
  .good { color:#69db7c; } .bad { color:#ffa94d; }
  .none { color:var(--mute); }
  @media (max-width:820px) { .cols,.frames { grid-template-columns:1fr; } }
</style></head>
<body><div class="wrap">
  <h1>ayna · ${esc(cfg.target.name)}</h1>
  <div class="meta">run <b>${esc(runId)}</b> · ${iterations.length} iteration(s) · ${esc(stopReason)}${
    totalCost ? ` · <b>$${totalCost.toFixed(4)}</b>` : ''
  }</div>
  ${
    first !== undefined && last !== undefined
      ? `<div class="delta">
      <div><div class="lbl">start</div><div class="n">${esc(first)}</div></div>
      <div class="arrow">→</div>
      <div><div class="lbl">end</div><div class="n">${esc(last)}</div></div>
      <div style="margin-left:auto;color:var(--mute);font-size:13px">critic score, out of 10</div>
    </div>`
      : ''
  }
  ${iterations.map((i) => iterationBlock(i, runDir)).join('')}
</div></body></html>`;

  const file = path.join(runDir, 'report.html');
  await writeFile(file, html);
  return file;
}
