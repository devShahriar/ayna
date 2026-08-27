import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

import { startTarget } from './target.mjs';
import { openBrowser, captureRoutes } from './browser.mjs';
import { runAgent, ensureAgent, resolveAgent } from './brain.mjs';
import { snapshot, restore, changedFiles } from './snapshot.mjs';
import { CRITIQUE_SCHEMA, VERIFY_SCHEMA, critiquePrompt, improvePrompt, verifyPrompt } from './prompts.mjs';
import { writeReport } from './report.mjs';
import { banner, step, ok, warn, fail, info, dim, bold, green, yellow, red, ms, openInDesktop } from './log.mjs';

const READ_TOOLS = ['Read', 'Glob', 'Grep'];
const EDIT_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'MultiEdit'];

function scoreColor(score) {
  if (score >= 8) return green;
  if (score >= 5) return yellow;
  return red;
}

export async function runLoop(cfg, { iterations, model, headless, open, agent } = {}) {
  const maxIterations = iterations ?? cfg.loop.iterations;
  const model_ = model ?? cfg.loop.model;
  const headless_ = headless ?? cfg.loop.headless;

  /*
    Pick the agent once, up front, and fail loudly if the CLI is not on PATH.
    Picking it in a tighter scope would mean the run starts and then dies on
    the first prompt — worse than the explicit gate.
  */
  const agentName = resolveAgent(agent, cfg);
  const probe = await ensureAgent(agentName);
  if (!probe.ok) {
    throw new Error(`the \`${probe.binary}\` CLI was not found on PATH — set AYNA_${agentName === 'puku' ? 'PUKU' : 'CLAUDE'}_BIN or install it`);
  }

  const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runDir = path.join(cfg.runsDir, runId);
  await mkdir(runDir, { recursive: true });

  banner(`ayna · ${cfg.target.name} · run ${runId}`);
  info(`brain: ${agentName} ${probe.version ?? ''} (model: ${model_})`);

  const target = await startTarget(cfg);
  info(`serving: ${target.url}`);

  const browser = await openBrowser({ headless: headless_ });
  info(`chrome: ${headless_ ? 'headless' : 'headed — watch it work'}`);

  const iterationsLog = [];
  let totalCost = 0;
  let stopReason = `completed ${maxIterations} iteration(s)`;

  try {
    for (let i = 1; i <= maxIterations; i++) {
      const started = Date.now();
      const iterDir = path.join(runDir, `iter-${String(i).padStart(2, '0')}`);
      await mkdir(iterDir, { recursive: true });

      banner(`iteration ${i}/${maxIterations}`);

      try {
        // 1. Look at the page as it stands.
        step('look', 'rendering and screenshotting the live page');
        await target.ensureUp();
        const before = await captureRoutes({
          browser,
          baseUrl: target.url,
          routes: cfg.target.routes?.length ? cfg.target.routes : ['/'],
          viewports: cfg.viewports,
          outDir: iterDir,
          label: 'before',
        });
        for (const s of before.shots) {
          ok(`${s.route ?? '/'} ${s.viewport} → ${path.relative(cfg.rootDir, s.file)}`);
        }
        if (before.blank) warn('page renders almost no text — check the target');

        // 2. Critique what the screenshots show.
        step('critique', 'asking the design critic what is wrong');
        const critiqueRun = await runAgent({
          agent: agentName,
          prompt: critiquePrompt({ cfg, capture: before, iteration: i }),
          cwd: cfg.rootDir,
          tools: READ_TOOLS,
          model: model_,
          schema: CRITIQUE_SCHEMA,
        });
        totalCost += critiqueRun.costUsd ?? 0;

        const critique = critiqueRun.json;
        if (!critique?.issues) {
          fail('critic returned nothing usable — stopping');
          stopReason = 'critic returned no structured critique';
          iterationsLog.push({ n: i, before, critique: null, error: critiqueRun.text?.slice(0, 500) });
          break;
        }

        const col = scoreColor(critique.score);
        ok(`score ${col(bold(`${critique.score}/10`))} — ${critique.verdict}`);
        for (const issue of critique.issues) {
          info(`[${issue.severity}] ${issue.area}: ${issue.problem}`);
        }

        if (critique.score >= cfg.loop.targetScore) {
          ok(`score is at or above the target of ${cfg.loop.targetScore} — done`);
          stopReason = `reached target score (${critique.score} >= ${cfg.loop.targetScore})`;
          iterationsLog.push({ n: i, before, critique, changes: [], durationMs: Date.now() - started });
          break;
        }
        if (critique.issues.length === 0) {
          stopReason = 'critic found no remaining issues';
          iterationsLog.push({ n: i, before, critique, changes: [], durationMs: Date.now() - started });
          break;
        }

        // 3. Back the files up, then let the implementer edit them.
        const snapDir = path.join(iterDir, 'snapshot');
        await snapshot(cfg.targetDir, snapDir);

        step('improve', `applying ${critique.issues.length} fix(es)`);
        const improveRun = await runAgent({
          agent: agentName,
          prompt: improvePrompt({ cfg, capture: before, critique, iteration: i }),
          cwd: cfg.rootDir,
          tools: EDIT_TOOLS,
          model: model_,
        });
        totalCost += improveRun.costUsd ?? 0;

        const changes = await changedFiles(snapDir, cfg.targetDir);
        if (changes.length === 0) {
          warn('no files changed — stopping');
          stopReason = 'implementer made no edits';
          iterationsLog.push({ n: i, before, critique, changes, durationMs: Date.now() - started });
          break;
        }
        for (const c of changes) ok(`${c.kind}: ${c.file}`);
        info(improveRun.text.split('\n').slice(0, 8).join('\n  · '));

        // 4. Look again.
        step('recheck', 're-rendering after the edits');
        await target.ensureUp();
        let after = await captureRoutes({
          browser,
          baseUrl: target.url,
          routes: cfg.target.routes?.length ? cfg.target.routes : ['/'],
          viewports: cfg.viewports,
          outDir: iterDir,
          label: 'after',
        });

        // If the server dropped out mid-run, every shot is a Chrome error page.
        // Restart it and look again before judging anything.
        if (after.shots.some((s) => s.transportError)) {
          warn('could not reach the page — restarting the server and retrying');
          await target.ensureUp();
          after = await captureRoutes({
            browser,
            baseUrl: target.url,
            routes: cfg.target.routes?.length ? cfg.target.routes : ['/'],
            viewports: cfg.viewports,
            outDir: iterDir,
            label: 'after',
          });
        }

        // 5. Guard against an iteration that broke the page.
        let reverted = false;
        const stillUnreachable = after.shots.some((s) => s.transportError);
        const newErrors = after.consoleErrors.length > before.consoleErrors.length;
        const brokeRender = after.blank && !before.blank;
        // Only a real load failure counts — an unreachable server is our fault.
        const loadFailed = after.shots.some((s) => s.loadError && !s.transportError);

        if (stillUnreachable) {
          fail('page is unreachable — leaving this iteration\'s edits in place and stopping');
          stopReason = 'target server unreachable during recheck (edits kept, not judged)';
          iterationsLog.push({
            n: i,
            before,
            after,
            critique,
            changes,
            summary: improveRun.text,
            verdict: null,
            reverted: false,
            inconclusive: true,
            durationMs: Date.now() - started,
          });
          break;
        }

        if (cfg.loop.autoRevert && (brokeRender || loadFailed || newErrors)) {
          fail(
            `regression detected (${[
              brokeRender && 'page went blank',
              loadFailed && 'page failed to load',
              newErrors && 'new console errors',
            ]
              .filter(Boolean)
              .join(', ')}) — reverting this iteration`,
          );
          await restore(snapDir, cfg.targetDir);
          reverted = true;
        }

        // 6. Ask the verifier whether it actually looks better.
        let verdict = null;
        if (cfg.loop.verify && !reverted) {
          step('verify', 'comparing before and after');
          const verifyRun = await runAgent({
            agent: agentName,
            prompt: verifyPrompt({ before, after, critique }),
            cwd: cfg.rootDir,
            tools: READ_TOOLS,
            model: model_,
            schema: VERIFY_SCHEMA,
          });
          totalCost += verifyRun.costUsd ?? 0;
          verdict = verifyRun.json;

          if (verdict?.improved) ok(`improved — ${verdict.notes}`);
          else warn(`not clearly improved — ${verdict?.notes ?? 'no verdict'}`);
          for (const r of verdict?.regressions ?? []) warn(`regression: ${r}`);

          if (cfg.loop.autoRevert && verdict && !verdict.improved && verdict.regressions.length > 0) {
            fail('verifier found regressions with no improvement — reverting');
            await restore(snapDir, cfg.targetDir);
            reverted = true;
          }
        }

        iterationsLog.push({
          n: i,
          before,
          // Recorded even when reverted — otherwise the run discards the very
          // evidence you need to tell a real regression from a false alarm.
          after,
          critique,
          changes,
          summary: improveRun.text,
          verdict,
          reverted,
          durationMs: Date.now() - started,
        });

        info(`iteration took ${ms(Date.now() - started)}`);
      } catch (err) {
        // One bad iteration must not cost us the report for the good ones.
        fail(`iteration ${i} failed: ${err.message}`);
        iterationsLog.push({ n: i, error: err.message, durationMs: Date.now() - started });
        stopReason = `iteration ${i} failed: ${err.message}`;
        break;
      }
    }
  } finally {
    await browser.close().catch(() => {});
    await target.close().catch(() => {});
  }

  const reportPath = await writeReport({ cfg, runId, runDir, iterations: iterationsLog, stopReason, totalCost });
  await writeFile(
    path.join(runDir, 'run.json'),
    `${JSON.stringify({ runId, stopReason, totalCost, iterations: iterationsLog }, null, 2)}\n`,
  );

  banner('done');
  info(stopReason);
  if (totalCost) info(`cost: $${totalCost.toFixed(4)}`);
  ok(`report: ${reportPath}`);
  if (open) {
    openInDesktop(reportPath);
  }
  console.log(dim(`\n  open it with:  open ${path.relative(process.cwd(), reportPath)}\n`));

  return { runId, runDir, reportPath, iterations: iterationsLog, stopReason };
}
