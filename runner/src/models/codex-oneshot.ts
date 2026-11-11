// One ephemeral small job through Codex's official app-server. The isolation
// settings follow Codex 0.163's tui/src/temporary_structured_request.rs:
// no built-in or extension tools, and each effective MCP server disabled.
// Project instructions are omitted; Codex may still supply the login's
// global AGENTS.md. Nothing reads or copies that login's credentials here.
import fs from 'node:fs';
import type { Logger } from '../log.ts';
import type { ProcessRegistry } from '../proc.ts';
import { AppServerProcess, type AppServerTimings } from '../adapters/codex/appserver.ts';
import type { Asker } from './acp-oneshot.ts';
import type { CliResponse } from './claude-pool.ts';

type ObjectValue = Record<string, unknown>;
const object = (v: unknown): v is ObjectValue => v !== null && typeof v === 'object' && !Array.isArray(v);

export type CodexAskerDeps = {
  binary: () => string;
  on: () => boolean;
  registry: ProcessRegistry;
  log: Logger;
  timings?: Partial<AppServerTimings>;
};

// This is also supplied at process startup: hooks, plugins and notify must
// be off before a thread can start, including on logins with custom config.
export function smallJobConfig(): ObjectValue {
  const features = [
    'apps', 'browser_use', 'browser_use_external', 'code_mode', 'code_mode_host', 'code_mode_only', 'computer_use',
    'context_management', 'current_time_reminder', 'deferred_executor', 'enable_fanout', 'goals', 'hooks',
    'image_generation', 'memories', 'multi_agent', 'multi_agent_v2', 'plugins', 'request_permissions_tool',
    'shell_snapshot', 'shell_tool', 'skill_search', 'sleep_tool', 'standalone_web_search', 'token_budget',
    'tool_suggest', 'unified_exec', 'view_image', 'workspace_dependencies',
  ];
  return {
    ...Object.fromEntries(features.map((name) => [`features.${name}`, false])),
    'cloud.skills.enabled': false,
    'skills.include_instructions': false,
    'tools.experimental_request_user_input.enabled': false,
    'tools.update_plan.enabled': false,
    project_doc_max_bytes: 0,
    include_environment_context: false,
    include_apps_instructions: false,
    web_search: 'disabled',
    notify: [],
  };
}

function fail(message: string, flags: { timedOut?: boolean; limit?: boolean } = {}): CliResponse {
  return { ok: false, timedOut: flags.timedOut === true, limit: flags.limit === true, message };
}

function failure(error: unknown): CliResponse {
  const e = object(error) ? error : {};
  const info = e.codexErrorInfo ?? (object(e.data) ? e.data.codexErrorInfo : undefined);
  const name = typeof info === 'string' ? info : object(info) ? Object.keys(info)[0] : '';
  const message = error instanceof Error ? error.message : typeof e.message === 'string' ? e.message : 'Codex did not complete the small job.';
  return fail(message, { limit: name === 'usageLimitExceeded' || name === 'rateLimitExceeded' });
}

export function codexAsker(deps: CodexAskerDeps): Asker {
  return async (req) => {
    if (!deps.on()) return fail('Codex small jobs are off in this runner.');
    if (!req.model || !req.effort) return fail('Codex small jobs need an explicit model and effort.');
    const config = smallJobConfig();
    const proc = new AppServerProcess({
      binary: deps.binary(),
      // Do not inherit normal threads' codexArgs: --enable is applied after
      // all -c values, regardless of argument order, and could restore hooks.
      args: Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]),
      account: req.account,
      cwd: req.cwd,
      registry: deps.registry,
      log: deps.log,
      label: `small-job:${req.account.id}`,
      timings: deps.timings,
      maxLineBytes: 1_000_000,
    });
    let threadId: string | undefined;
    let text: string | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let finish!: (r: CliResponse) => void;
    const completed = new Promise<CliResponse>((resolve) => { finish = resolve; });
    proc.onRequest = (id) => {
      proc.respondError(id, -32601, 'Small jobs cannot use tools or ask for input.');
      finish(fail('Codex tried to use a tool or ask for input during a small job.'));
    };
    proc.onExit = (error) => finish(fail(error?.message ?? 'Codex stopped before answering the small job.'));
    proc.onOversize = () => finish(fail('Codex returned too much data for a small job.'));
    proc.onNotification = (method, params) => {
      if (!object(params)) return;
      if (typeof params.threadId === 'string' && threadId && params.threadId !== threadId) return;
      if (method === 'model/rerouted') return finish(fail('Codex tried to change the small job model.'));
      if (method === 'thread/tokenUsage/updated' && object(params.tokenUsage) && object(params.tokenUsage.total)) {
        const usage = params.tokenUsage.total;
        if (typeof usage.inputTokens === 'number') inputTokens = usage.inputTokens;
        if (typeof usage.outputTokens === 'number') outputTokens = usage.outputTokens;
      }
      if ((method === 'item/started' || method === 'item/completed') && object(params.item)) {
        const item = params.item;
        if (!['agentMessage', 'userMessage', 'reasoning'].includes(String(item.type))) return finish(fail('Codex tried to use a tool during a small job.'));
        if (method === 'item/completed' && item.type === 'agentMessage' && typeof item.text === 'string') text = item.text;
      }
      if (method === 'error' && params.willRetry !== true) return finish(failure(params.error));
      if (method === 'turn/completed' && object(params.turn)) {
        if (params.turn.status !== 'completed') return finish(failure(params.turn.error));
        finish(text === undefined ? fail('Codex completed the small job without an answer.') : {
          ok: true, text,
          ...(inputTokens === undefined ? {} : { inputTokens }),
          ...(outputTokens === undefined ? {} : { outputTokens }),
        });
      }
    };
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<CliResponse>((resolve) => {
      timer = setTimeout(() => {
        proc.kill();
        resolve(fail(`Codex did not answer within ${Math.round(req.timeoutMs / 1000)} s.`, { timedOut: true }));
      }, req.timeoutMs);
      timer.unref();
    });
    const work = async (): Promise<CliResponse> => {
      fs.mkdirSync(req.cwd, { recursive: true });
      await proc.start();
      const effective = await proc.request<{ config?: unknown }>('config/read', { cwd: req.cwd, includeLayers: false });
      if (!object(effective?.config)) return fail('Codex could not read its small job configuration.');
      // MCP config merges by name. An empty object would leave the login's
      // existing servers enabled, so disable each one before thread/start.
      const servers = effective.config.mcp_servers;
      if (servers !== undefined && !object(servers)) return fail('Codex returned unreadable MCP settings.');
      const started = await proc.request<ObjectValue>('thread/start', {
        cwd: req.cwd, model: req.model, modelProvider: 'openai',
        approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'read-only',
        ephemeral: true, environments: [], dynamicTools: [], runtimeWorkspaceRoots: [], selectedCapabilityRoots: [],
        baseInstructions: req.system?.trim() || 'Answer the message. Plain text, no preamble.',
        developerInstructions: '',
        config: { ...config, mcp_servers: Object.fromEntries(Object.keys(servers ?? {}).map((name) => [name, { enabled: false }])) },
      });
      if (!object(started?.thread) || typeof started.thread.id !== 'string') return fail('Codex started a small job without an id.');
      threadId = started.thread.id;
      if (started.thread.ephemeral !== true || started.thread.path != null) return fail('Codex did not start an ephemeral small job.');
      if (!object(started.sandbox) || started.sandbox.type !== 'readOnly') return fail('Codex did not start the small job with read-only permissions.');
      if (started.model !== req.model) return fail('Codex did not use the requested small job model.');
      if (started.modelProvider !== 'openai') return fail('Codex did not use the OpenAI provider for the small job.');
      await proc.request('turn/start', {
        threadId, input: [{ type: 'text', text: req.user, text_elements: [] }], model: req.model, effort: req.effort,
        ...(req.jsonSchema ? { outputSchema: req.jsonSchema } : {}),
      });
      return completed;
    };
    try {
      return await Promise.race([work(), completed, timeout]);
    } catch (error) {
      return failure(error);
    } finally {
      clearTimeout(timer);
      await proc.close().catch(() => undefined);
    }
  };
}
