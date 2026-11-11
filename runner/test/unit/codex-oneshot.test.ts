// Isolated small jobs through the real app-server framing and a fake CLI.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexAsker, smallJobConfig } from '../../src/models/codex-oneshot.ts';
import type { AskRequest } from '../../src/models/acp-oneshot.ts';
import { ProcessRegistry } from '../../src/proc.ts';
import { nullLogger } from '../../src/log.ts';
import { FakeCodex } from '../helpers/fake-app-server.ts';
import { PATIENCE_MS } from '../helpers/patience.ts';

const dirs: string[] = [];
let shared: Promise<FakeCodex> | undefined;
const fake = () => shared ??= FakeCodex.create();
after(async () => {
  if (shared) await (await shared).close();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

async function setup(params: Partial<AskRequest> = {}, on = true) {
  const f = await fake();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-small-codex-'));
  dirs.push(root);
  const registry = new ProcessRegistry(root, nullLogger);
  const ask = codexAsker({ binary: () => f.bin, on: () => on, registry, log: nullLogger, timings: { closeWaitMs: 200, spawnRetryForMs: 0 } });
  const request: AskRequest = {
    account: { id: 'codex-main', provider: 'codex', title: 'Codex', configDir: path.join(root, 'login') },
    model: 'gpt-6-luna', effort: 'low', system: 'SECRET-SYSTEM', user: 'SECRET-TEXT', cwd: path.join(root, 'empty'), timeoutMs: PATIENCE_MS,
    ...params,
  };
  const result = ask(request);
  return { f, request, result, registry };
}

async function started(s: Awaited<ReturnType<typeof setup>>, overrides: Record<string, unknown> = {}) {
  const conn = await s.f.next();
  await conn.init();
  const read = await conn.request('config/read');
  conn.respond(read.id, { config: { ...smallJobConfig(), mcp_servers: { private: { command: 'never-start-me' }, second: { enabled: true } } } });
  const start = await conn.request('thread/start');
  conn.respond(start.id, { thread: { id: 'small-1', path: null, ephemeral: true }, model: s.request.model, modelProvider: 'openai', sandbox: { type: 'readOnly' }, ...overrides });
  return { conn, start };
}

test('Codex small jobs: ephemeral, no tools or project instructions, the chosen model/effort/schema, and usage', async () => {
  const schema = { type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false };
  const s = await setup({ model: 'gpt-6.1-sol', effort: 'high', jsonSchema: schema });
  const { conn, start } = await started(s);
  assert.equal(conn.hello.env.CODEX_HOME, s.request.account.configDir);
  assert.doesNotMatch(JSON.stringify({ argv: conn.hello.argv, env: conn.hello.env }), /SECRET/);
  assert.equal(fs.realpathSync(conn.hello.cwd), fs.realpathSync(s.request.cwd));
  assert.equal(start.params.model, 'gpt-6.1-sol');
  assert.equal(start.params.ephemeral, true);
  assert.equal(start.params.baseInstructions, 'SECRET-SYSTEM');
  assert.equal(start.params.developerInstructions, '');
  assert.deepEqual(start.params.dynamicTools, []);
  assert.deepEqual(start.params.environments, []);
  const config = start.params.config as Record<string, unknown>;
  for (const feature of ['shell_tool', 'unified_exec', 'plugins', 'apps', 'hooks', 'multi_agent', 'multi_agent_v2', 'memories', 'image_generation', 'view_image', 'goals']) assert.equal(config[`features.${feature}`], false, feature);
  assert.equal(config.project_doc_max_bytes, 0);
  assert.equal(config['skills.include_instructions'], false);
  assert.equal(config['tools.update_plan.enabled'], false);
  assert.equal(config.web_search, 'disabled');
  assert.deepEqual(config.mcp_servers, { private: { enabled: false }, second: { enabled: false } });
  const turn = await conn.request('turn/start');
  assert.equal(turn.params.model, 'gpt-6.1-sol');
  assert.equal(turn.params.effort, 'high');
  assert.deepEqual(turn.params.outputSchema, schema);
  assert.deepEqual(turn.params.input, [{ type: 'text', text: 'SECRET-TEXT', text_elements: [] }]);
  conn.respond(turn.id, { turn: { id: 't1' } });
  conn.notify('item/completed', { threadId: 'small-1', turnId: 't1', item: { type: 'agentMessage', text: '{"label":"bug"}' } });
  conn.notify('thread/tokenUsage/updated', { threadId: 'small-1', tokenUsage: { total: { inputTokens: 200, outputTokens: 12 } } });
  conn.notify('turn/completed', { threadId: 'small-1', turn: { id: 't1', status: 'completed' } });
  assert.deepEqual(await s.result, { ok: true, text: '{"label":"bug"}', inputTokens: 200, outputTokens: 12 });
  await conn.closed;
  assert.deepEqual(s.registry.pids(), []);
});

test('Codex small jobs: off sends nothing and starts no process', async () => {
  const s = await setup({}, false);
  assert.match((await s.result as { message: string }).message, /off/);
  assert.deepEqual(s.registry.pids(), []);
});

test('Codex small jobs: unreadable effective configuration never reaches a thread or model', async () => {
  const s = await setup();
  const conn = await s.f.next();
  await conn.init();
  const read = await conn.request('config/read');
  conn.respond(read.id, {});
  assert.equal((await s.result).ok, false);
  assert.equal(conn.sent('thread/start').length, 0);
  assert.equal(conn.sent('turn/start').length, 0);
});

test('Codex small jobs: unexpected sandbox or model fails before sending text', async () => {
  for (const overrides of [{ sandbox: { type: 'dangerFullAccess' } }, { model: 'gpt-6-luna' }]) {
    const s = await setup({ model: 'gpt-6.1-sol', effort: 'high' });
    const { conn } = await started(s, overrides);
    assert.equal((await s.result).ok, false);
    assert.equal(conn.sent('turn/start').length, 0);
  }
});

test('Codex small jobs: persistence or a different provider fails before sending text', async () => {
  for (const overrides of [
    { thread: { id: 'small-1', ephemeral: false, path: null } },
    { thread: { id: 'small-1', ephemeral: true, path: '/saved/session.jsonl' } },
    { thread: { id: 'small-1', path: null } },
    { modelProvider: 'other' },
  ]) {
    const s = await setup();
    const { conn } = await started(s, overrides);
    // Complete the unexpected turn if sent, so the pre-fix test fails
    // immediately instead of waiting for its deadline.
    conn.auto.set('turn/start', () => {
      setImmediate(() => {
        conn.notify('item/completed', { threadId: 'small-1', item: { type: 'agentMessage', text: 'unsafe' } });
        conn.notify('turn/completed', { threadId: 'small-1', turn: { id: 't1', status: 'completed' } });
      });
      return { turn: { id: 't1' } };
    });
    assert.equal((await s.result).ok, false);
    assert.equal(conn.sent('turn/start').length, 0);
  }
});

test('Codex small jobs: limits remain failures and never change the model', async () => {
  const s = await setup({ model: 'gpt-6.1-sol', effort: 'high' });
  const { conn } = await started(s);
  const turn = await conn.request('turn/start');
  conn.respond(turn.id, { turn: { id: 't1' } });
  conn.notify('turn/completed', { threadId: 'small-1', turn: { id: 't1', status: 'failed', error: { message: 'No quota left', codexErrorInfo: 'usageLimitExceeded' } } });
  const res = await s.result;
  assert.ok(!res.ok && res.limit);
  assert.equal(conn.sent('turn/start').length, 1);
  assert.equal(turn.params.model, 'gpt-6.1-sol');
});

test('Codex small jobs: an RPC quota rejection is a limit failure too', async () => {
  const s = await setup({ model: 'gpt-6.1-sol', effort: 'high' });
  const { conn } = await started(s);
  const turn = await conn.request('turn/start');
  conn.write({ id: turn.id, error: { code: -32000, message: 'No quota left', data: { codexErrorInfo: 'usageLimitExceeded' } } });
  const res = await s.result;
  assert.ok(!res.ok && res.limit);
});

test('Codex small jobs: unexpected interaction is refused and cannot become a success', async () => {
  const s = await setup();
  const { conn } = await started(s);
  const turn = await conn.request('turn/start');
  conn.respond(turn.id, { turn: { id: 't1' } });
  const answer = await conn.serverRequest('item/commandExecution/requestApproval', { threadId: 'small-1', command: 'read secret' });
  assert.ok(answer.error);
  const res = await s.result;
  assert.ok(!res.ok && !res.limit);
});

test('Codex small jobs: model rerouting is refused', async () => {
  const s = await setup();
  const { conn } = await started(s);
  const turn = await conn.request('turn/start');
  conn.respond(turn.id, { turn: { id: 't1' } });
  conn.notify('model/rerouted', { threadId: 'small-1', fromModel: 'gpt-6-luna', toModel: 'gpt-6.1-sol' });
  assert.equal((await s.result).ok, false);
});

test('Codex small jobs: a hung process times out and is removed from the registry', async () => {
  const s = await setup({ timeoutMs: 500 });
  const conn = await s.f.next();
  await conn.init();
  const res = await s.result;
  assert.ok(!res.ok && res.timedOut);
  await conn.closed;
  assert.deepEqual(s.registry.pids(), []);
});
