import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpDir } from '../helpers/fakes.ts';
import { FakeClock } from '../../src/clock.ts';
import { nullLogger } from '../../src/log.ts';
import { Models } from '../../src/models/index.ts';
import { ledgerPath } from '../../src/models/ledger.ts';
import type { AskRequest } from '../../src/models/acp-oneshot.ts';
import type { CliResponse } from '../../src/models/claude-pool.ts';
import type { Account, Pool } from '../../src/protocol.ts';

function setup(replies: CliResponse[] = []) {
  const home = tmpDir();
  const accounts: Account[] = ['codex-main', 'codex-1'].map((id) => ({ id, provider: 'codex', title: id, configDir: '/unused' }));
  const pool: Pool = { id: 'codex', title: 'Codex', accountIds: accounts.map((a) => a.id) };
  const seen: AskRequest[] = [];
  const dry: string[] = [];
  const settings = { pool: 'codex', privateFolders: [] as string[] };
  const models = new Models({
    home, clock: new FakeClock(), log: nullLogger, settings: () => settings,
    poolHost: {
      pool: () => ({ pool, accounts: accounts.map((a) => dry.includes(a.id) ? { ...a, usage: { windows: [], source: 'live' as const, readAt: '', blocked: true } } : a) }),
      ranDry: (id) => { dry.push(id); },
    },
    askers: { codex: async (req) => { seen.push(req); return replies.shift() ?? { ok: true, text: 'answer', inputTokens: 5, outputTokens: 2 }; } },
  });
  const ledger = () => fs.readFileSync(ledgerPath(home), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { models, seen, dry, settings, ledger };
}

test('Codex ordinary jobs use Luna low, including structured classify and extract', async () => {
  const h = setup([{ ok: true, text: '{"label":"bug"}' }, { ok: true, text: '{"name":"Threadbear"}' }]);
  assert.equal(h.models.unavailable(), undefined);
  assert.deepEqual(await h.models.classify({ feature: 'test', text: 'private words', labels: ['bug'] }), { ok: true, value: 'bug', model: 'gpt-6-luna on codex-main' });
  assert.ok((await h.models.extract({ feature: 'test', text: 'text', fields: { name: 'name' } })).ok);
  assert.ok((await h.models.summarize({ feature: 'test', text: 'text' })).ok);
  assert.ok((await h.models.generate({ feature: 'test', prompt: 'text' })).ok);
  assert.deepEqual(h.seen.map((r) => [r.model, (r as AskRequest & { effort?: string }).effort]), Array(4).fill(['gpt-6-luna', 'low']));
  assert.ok(h.seen[0].jsonSchema);
  assert.ok(h.seen[1].jsonSchema);
  assert.ok(h.ledger().every((l) => l.model === 'gpt-6-luna' && l.effort === 'low'));
  assert.doesNotMatch(JSON.stringify(h.ledger()), /private words/);
});

test('all strong callers use Sol high and the actual route is recorded', async () => {
  const h = setup();
  for (const feature of ['projects', 'wake-when', 'cardReviewer', 'release-notes']) {
    const r = await h.models.generate({ feature, prompt: 'text', strong: true });
    assert.ok(r.ok);
    assert.equal(r.model, 'gpt-6.1-sol on codex-main');
  }
  assert.deepEqual(h.seen.map((r) => [r.model, (r as AskRequest & { effort?: string }).effort]), Array(4).fill(['gpt-6.1-sol', 'high']));
  assert.ok(h.ledger().every((l) => l.job === 'decide' && l.model === 'gpt-6.1-sol' && l.effort === 'high'));
});

test('a strong limit retries the same Sol high route on another account, never Luna', async () => {
  const h = setup([{ ok: false, timedOut: false, limit: true, message: 'usage_limit_reached' }, { ok: true, text: 'ok' }]);
  assert.ok((await h.models.generate({ feature: 'cardReviewer', prompt: 'text', strong: true })).ok);
  assert.deepEqual(h.dry, ['codex-main']);
  assert.deepEqual(h.seen.map((r) => [r.account.id, r.model, (r as AskRequest & { effort?: string }).effort]), [
    ['codex-main', 'gpt-6.1-sol', 'high'], ['codex-1', 'gpt-6.1-sol', 'high'],
  ]);
});

test('strong errors and exhausted accounts do not downgrade or claim success', async () => {
  for (const reply of [
    { ok: false, timedOut: false, limit: false, message: 'model unavailable' },
    { ok: false, timedOut: true, limit: false, message: 'timeout' },
    { ok: true, text: '' },
  ] as CliResponse[]) {
    const h = setup([reply]);
    const r = await h.models.generate({ feature: 'cardReviewer', prompt: 'text', strong: true });
    assert.equal(r.ok, false);
    assert.equal(h.seen.length, 1);
    assert.equal(h.seen[0].model, 'gpt-6.1-sol');
  }
  const h = setup(Array(2).fill({ ok: false, timedOut: false, limit: true, message: 'limit' }));
  const r = await h.models.generate({ feature: 'cardReviewer', prompt: 'text', strong: true });
  assert.equal(r.ok ? 'sent' : r.reason, 'no-room');
  assert.equal(h.seen.length, 2);
  assert.ok(h.seen.every((r) => r.model === 'gpt-6.1-sol'));
});

test('Codex private folders never reach the model, including strong jobs', async () => {
  const h = setup();
  h.settings.privateFolders = ['/private/client'];
  const r = await h.models.generate({ feature: 'cardReviewer', cwd: '/private/client/app', prompt: 'text', strong: true });
  assert.equal(r.ok ? 'sent' : r.reason, 'private');
  assert.equal(h.seen.length, 0);
});
