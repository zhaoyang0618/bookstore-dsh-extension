/**
 * dsh 扩展版 — 密码管理器入口插件（设计文档 2.3 / 2.9）。
 *
 * 集成 `cube-password`（React + Fastify + SQLite + TypeScript）作为独立服务运行在本地端口。
 * 本插件**只提供入口**，不实现任何密码逻辑——密码数据完全由 cube-password 服务持有，
 * 与 MyLibrary 数据层隔离。
 *
 * @module dsh-tool-password
 */

import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Context } from '@deepseek-ai/cordis';
import type { ToolRuntime } from '@deepseek-ai/dsh-tools';
import type { FileSystem as FsService } from '@deepseek-ai/dsh-fs';

/** apply() 收到的 agent-scoped 服务集合。 */
type PluginContext = Context & { tools: ToolRuntime; fs?: FsService };

interface PluginConfig {
  vaultBaseUrl: string;
  probeTimeoutMs: number;
}

/** Stable Loader identity。 */
const name = 'dsh-tool-password';

/** 插件配置。 */
const Config = z.object({
  /** cube-password 服务地址。 */
  vaultBaseUrl: z.string().default('http://127.0.0.1:8787'),
  /** 探活超时（毫秒）。 */
  probeTimeoutMs: z.number().default(3000),
});

/** 本插件用到的服务。 */
const inject = ['tools'];

/** 探活密码库服务是否在线。 */
export async function probeVault(baseUrl: string, timeoutMs: number, fetcher: typeof fetch = fetch): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(`${baseUrl.replace(/\/+$/, '')}/healthz`, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 注册密码库入口工具。
 *
 * @param ctx - agent-scoped services。
 * @param config - vaultBaseUrl / probeTimeoutMs。
 */
function apply(ctx: PluginContext, config: PluginConfig) {
  ctx.tools.register(defineTool({
    name: 'open_password_vault',
    description: '打开密码管理器（cube-password 独立服务）。本工具只提供入口，不读取、不返回任何密码内容。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          instruction: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              action: { type: 'string', required: true, enum: ['open_url'] },
              url: { type: 'string', required: true },
            },
          },
          vault: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              baseUrl: { type: 'string', required: true },
              online: { type: 'boolean', required: true },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.vault.online
            ? `打开密码管理器：${value.instruction.url}`
            : `密码库服务未启动（${value.vault.baseUrl}）。请先启动 cube-password 服务，再打开 ${value.instruction.url}`,
        },
      ],
    },
    async execute(_args, exec) {
      exec.signal.throwIfAborted();
      const online = await probeVault(config.vaultBaseUrl, config.probeTimeoutMs);
      return {
        instruction: { action: 'open_url' as const, url: config.vaultBaseUrl },
        vault: { baseUrl: config.vaultBaseUrl, online },
      };
    },
  }));
}

export { Config, apply, inject, name };
