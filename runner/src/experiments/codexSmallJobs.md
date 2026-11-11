---
id: codexSmallJobs
name: Codex small jobs
title: Codex small jobs: Luna for ordinary jobs, Sol for strong decisions
added: 2026-11-11
on: false
reminder: 93f333b4
---

## What it does

Lets you pick a Codex pool for titles, summaries and the librarian in Settings > Models. Ordinary jobs use GPT-6-Luna at low effort. Strong jobs use GPT-6.1-Sol at high effort, including project checks, conditions for waking threads, Auto approval reviews and release notes. Calls use your existing Codex login without tools or saved conversations. If a strong call cannot answer, it keeps the feature's existing failure behaviour; it never switches to Luna. A mixed pool still prefers Claude, so pick a pool of Codex logins to use these routes.

## Lives in

`runner/src/models/codex-oneshot.ts`; the Codex routes in `runner/src/models/index.ts`; the asker built in `runner/src/main.ts`; the advertised capability in `runner/src/providers.ts`

## Taking it out

Remove the Codex asker from `main.ts`, delete `codex-oneshot.ts` and its tests, remove the Codex routes from `models/index.ts`, and set Codex's `smallJobs` capability back to false. Remove this experiment file and its runner.json switch, then run `npm run experiment-docs` in `runner/`.
