// Exercise the app builder with fake Swift/security/codesign commands. No
// build or private-key access is needed to preserve an install's signing.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-app-signing-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let number = 0;
type Call = { tool: string; args: string[] };

function setup(o: { existing?: 'adhoc' | 'developer'; staged?: boolean; identity?: string; noIdentity?: boolean; signingFails?: boolean } = {}) {
  const dir = path.join(root, String(number++));
  const app = path.join(dir, 'app');
  const tools = path.join(dir, 'tools');
  const bin = path.join(dir, 'built');
  const applications = path.join(dir, 'Applications');
  for (const folder of [app, tools, bin, applications, path.join(app, 'Resources'), path.join(dir, 'scripts')]) fs.mkdirSync(folder, { recursive: true });
  fs.copyFileSync(new URL('../../../app/build-app.sh', import.meta.url), path.join(app, 'build-app.sh'));
  fs.writeFileSync(path.join(app, 'Resources', 'Info.plist'), 'test plist');
  fs.writeFileSync(path.join(app, 'stage-update.sh'), '#!/bin/sh\nexit 0\n');
  fs.writeFileSync(path.join(dir, 'scripts', 'one-build.sh'), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'Threadbear'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const installed = path.join(applications, 'Threadbear.app');
  if (o.existing) {
    fs.mkdirSync(installed);
    fs.writeFileSync(path.join(installed, '.signature'), o.existing);
    fs.writeFileSync(path.join(installed, 'keep-on-failure'), 'original');
  }
  const final = o.staged ? path.join(applications, '.Threadbear.app.next') : installed;
  const calls = path.join(dir, 'calls.ndjson');
  const mock = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify({tool,args})+'\\n');
if (tool === 'swift' && args.includes('--show-bin-path')) console.log(process.env.FAKE_BIN_DIR);
if (tool === 'security' && process.env.FAKE_NO_IDENTITY !== '1') console.log('  1) CERT123 "Apple Development: Test Person"');
if (tool === 'git') console.log(args.includes('remote') ? 'https://github.com/example/threadbear.git' : 'abc123');
if (tool === 'codesign') {
  const target = args.at(-1);
  if (args.includes('--sign')) {
    if (process.env.FAKE_SIGN_FAIL === '1') process.exit(42);
    fs.writeFileSync(path.join(target, '.signature'), args[args.indexOf('--sign') + 1] === '-' ? 'adhoc' : 'developer');
  } else {
    const marker = path.join(target, '.signature');
    if (!fs.existsSync(marker)) process.exit(1);
    console.error(fs.readFileSync(marker, 'utf8') === 'adhoc' ? 'Signature=adhoc' : 'Authority=Apple Development: Test Person');
  }
}
`;
  for (const name of ['swift', 'security', 'codesign', 'git']) fs.writeFileSync(path.join(tools, name), mock, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = {
    PATH: `${tools}:${process.env.PATH}`,
    THREADBEAR_APP_DIR: final,
    THREADBEAR_BUILD_CONFIGURATION: 'debug',
    FAKE_BIN_DIR: bin,
    FAKE_CALLS: calls,
    FAKE_NO_IDENTITY: o.noIdentity ? '1' : '0',
    FAKE_SIGN_FAIL: o.signingFails ? '1' : '0',
    ...(o.identity ? { THREADBEAR_SIGN_IDENTITY: o.identity } : {}),
  };
  const result = spawnSync('/bin/bash', [path.join(app, 'build-app.sh')], { env, encoding: 'utf8' });
  const recorded: Call[] = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
  return { result, recorded, final, installed };
}

const signingCalls = (s: ReturnType<typeof setup>) => s.recorded.filter((c) => c.tool === 'codesign' && c.args.includes('--sign'));
function assertIdentity(s: ReturnType<typeof setup>, identity: string) {
  assert.equal(s.result.status, 0, s.result.stdout + s.result.stderr);
  const calls = signingCalls(s);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[calls[0].args.indexOf('--sign') + 1], identity);
  return calls[0].args;
}

test('app signing preserves an ad-hoc install without enumerating developer keys', () => {
  for (const staged of [false, true]) {
    const s = setup({ existing: 'adhoc', staged });
    const args = assertIdentity(s, '-');
    assert.equal(s.recorded.some((c) => c.tool === 'security'), false);
    assert.equal(args[args.indexOf('--requirements') + 1], '=designated => identifier "com.mikerosoft.threadbear"');
    if (staged) assert.equal(fs.readFileSync(path.join(s.installed, '.signature'), 'utf8'), 'adhoc');
  }
});

test('app signing respects an explicit certificate even over an ad-hoc install', () => {
  const s = setup({ existing: 'adhoc', identity: 'EXPLICIT-CERT' });
  const args = assertIdentity(s, 'EXPLICIT-CERT');
  assert.equal(s.recorded.some((c) => c.tool === 'security'), false);
  assert.equal(args.includes('--requirements'), false);
});

test('an explicit ad-hoc identity gets the stable bundle-id requirement too', () => {
  const s = setup({ identity: '-' });
  const args = assertIdentity(s, '-');
  assert.equal(args[args.indexOf('--requirements') + 1], '=designated => identifier "com.mikerosoft.threadbear"');
  assert.equal(s.recorded.some((c) => c.tool === 'security'), false);
});

test('a new install still picks the first developer identity, or ad-hoc when none exists', () => {
  assertIdentity(setup(), 'CERT123');
  const s = setup({ noIdentity: true });
  const args = assertIdentity(s, '-');
  assert.equal(args.includes('--requirements'), true);
});

test('a developer signing failure stays a failure and leaves the installed app intact', () => {
  const s = setup({ existing: 'developer', signingFails: true });
  assert.equal(s.result.status, 42);
  assert.equal(signingCalls(s).length, 1, 'no retry with an ad-hoc identity');
  assert.equal(signingCalls(s)[0].args[signingCalls(s)[0].args.indexOf('--sign') + 1], 'CERT123');
  assert.equal(fs.readFileSync(path.join(s.installed, 'keep-on-failure'), 'utf8'), 'original');
});
