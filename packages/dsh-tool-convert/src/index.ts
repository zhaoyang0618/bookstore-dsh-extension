/**
 * dsh 扩展版 — 格式转换工具插件（设计文档 2.3）。
 *
 * 注册 `convert_markdown_to_docx(input, output)` 与 `convert_djvu_to_pdf(input, output)`。
 *
 * 转换通过外部命令完成（设计文档阶段六：Pandoc、ddjvu），本插件负责：
 * - 参数与路径校验
 * - 选择可用的转换器（pandoc / ddjvu / 内置降级方案）
 * - 以子进程执行并回报结果
 *
 * @module dsh-tool-convert
 */

import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { FsError } from '@deepseek-ai/dsh-fs';
import type { Context } from '@deepseek-ai/cordis';
import type { ToolRuntime } from '@deepseek-ai/dsh-tools';
import type { FileSystem as FsService } from '@deepseek-ai/dsh-fs';

/** apply() 收到的 agent-scoped 服务集合。 */
type PluginContext = Context & { tools: ToolRuntime; fs?: FsService };

interface PluginConfig {
  pandocCommand: string;
  ddjvuCommand: string;
  timeoutMs: number;
}

/**
 * 构造 fs.resolve 的选项：cwd 未定义时不传该键，
 * 以满足 exactOptionalPropertyTypes 对可选属性的约束。
 */
function resolveOptions(exec: { agent?: { session: { header: { cwd?: string } } }; signal: AbortSignal }): { cwd?: string; signal: AbortSignal } {
  const cwd = exec.agent?.session.header.cwd;
  return cwd === undefined ? { signal: exec.signal } : { cwd, signal: exec.signal };
}

/** 把 fs.resolve 返回的 FsTarget 归一化为字符串路径。 */
function fsTargetToString(target: unknown): string {
  if (typeof target === 'string') return target;
  if (typeof target === 'object' && target !== null && 'path' in target && typeof (target as { path: unknown }).path === 'string') {
    return (target as { path: string }).path;
  }
  return String(target);
}

/** Stable Loader identity。 */
const name = 'dsh-tool-convert';

/** 插件配置。 */
const Config = z.object({
  /** pandoc 可执行文件路径或命令名。 */
  pandocCommand: z.string().default('pandoc'),
  /** ddjvu 可执行文件路径或命令名。 */
  ddjvuCommand: z.string().default('ddjvu'),
  /** 单个转换的超时（毫秒）。 */
  timeoutMs: z.number().default(120000),
});

/** 本插件用到的服务。 */
const inject = ['tools', 'fs'];

/** 转换计划（可测试的纯函数部分）。 */
export interface ConversionPlan {
  input: string;
  output: string;
  kind: 'markdown-to-docx' | 'djvu-to-pdf';
  command: string;
  args: string[];
  /** 降级方案说明（当外部工具不可用时）。 */
  fallback: string;
}

/** 由输入/输出路径推断转换类型。 */
export function detectConversion(input: string, output: string): ConversionPlan['kind'] {
  const inExt = extOf(input);
  const outExt = extOf(output);
  if (inExt === 'md' || inExt === 'markdown') {
    if (outExt === 'docx') return 'markdown-to-docx';
    throw new Error(`不支持的 Markdown 目标格式：${outExt}（仅支持 docx）`);
  }
  if (inExt === 'djvu' || inExt === 'djv') {
    if (outExt === 'pdf') return 'djvu-to-pdf';
    throw new Error(`不支持的 DjVu 目标格式：${outExt}（仅支持 pdf）`);
  }
  throw new Error(`不支持的转换：${inExt} → ${outExt}`);
}

function extOf(path: string): string {
  return path.toLowerCase().split('.').pop() ?? '';
}

/** 构造一条转换计划。 */
export function planConversion(input: string, output: string, config: { pandocCommand: string; ddjvuCommand: string }): ConversionPlan {
  const kind = detectConversion(input, output);
  if (kind === 'markdown-to-docx') {
    return {
      input,
      output,
      kind,
      command: config.pandocCommand,
      args: [input, '-o', output],
      fallback: 'pandoc 不可用时，前端用 markdown-it 渲染后经 docx 库导出（功能受限）',
    };
  }
  return {
    input,
    output,
    kind,
    command: config.ddjvuCommand,
    args: ['-format=pdf', input, output],
    fallback: 'ddjvu 不可用时，提示用户先安装 djvulibre 或用在线转换',
  };
}

/**
 * 注册两个转换工具。
 *
 * @param ctx - agent-scoped services。
 * @param config - pandocCommand / ddjvuCommand / timeoutMs。
 */
function apply(ctx: PluginContext, config: PluginConfig) {
  ctx.tools.register(defineTool({
    name: 'convert_markdown_to_docx',
    description: '把 Markdown 文件转换为 DOCX（Word）文档。使用 pandoc 执行；未安装 pandoc 时返回降级说明。',
    parameters: {
      input: { type: 'string', required: true, description: '输入 Markdown 文件路径' },
      output: { type: 'string', required: true, description: '输出 DOCX 文件路径' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          conversion: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              kind: { type: 'string', required: true },
              command: { type: 'string', required: true },
              args: { type: 'array', required: true, items: { type: 'string' } },
              executed: { type: 'boolean', required: true },
              exitCode: { type: 'integer' },
              output: { type: 'string', required: true },
              fallback: { type: 'string', required: true },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.conversion.executed
            ? `已转换 ${value.conversion.args[0]} → ${value.conversion.args[2]}（退出码 ${value.conversion.exitCode}）`
            : `未执行转换（外部工具不可用）。降级方案：${value.conversion.fallback}`,
        },
      ],
    },
    async execute(args, exec) {
      const input = args.input.trim();
      const output = args.output.trim();
      if (input.length === 0 || output.length === 0) throw new Error('convert_markdown_to_docx 需要 input 与 output');
      const inputTarget = await ctx.fs.resolve(input, resolveOptions(exec));
      const resolvedInput = fsTargetToString(inputTarget);
      const resolvedOutput = fsTargetToString(await ctx.fs.resolve(output, resolveOptions(exec)));
      const info = await ctx.fs.stat(inputTarget, exec.signal);
      if (info === undefined || info.type !== 'file') throw new FsError(`输入文件不存在：${input}`, 'FS_NOT_FOUND');
      const plan = planConversion(resolvedInput, resolvedOutput, config);
      return { conversion: await runConversion(plan, config.timeoutMs, exec.signal) };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'convert_djvu_to_pdf',
    description: '把 DjVu 文件转换为 PDF。使用 ddjvu 执行；未安装 djvulibre 时返回降级说明。',
    parameters: {
      input: { type: 'string', required: true, description: '输入 DjVu 文件路径' },
      output: { type: 'string', required: true, description: '输出 PDF 文件路径' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          conversion: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              kind: { type: 'string', required: true },
              command: { type: 'string', required: true },
              args: { type: 'array', required: true, items: { type: 'string' } },
              executed: { type: 'boolean', required: true },
              exitCode: { type: 'integer' },
              output: { type: 'string', required: true },
              fallback: { type: 'string', required: true },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.conversion.executed
            ? `已转换 ${value.conversion.args[2]} → ${value.conversion.args[3]}（退出码 ${value.conversion.exitCode}）`
            : `未执行转换（外部工具不可用）。降级方案：${value.conversion.fallback}`,
        },
      ],
    },
    async execute(args, exec) {
      const input = args.input.trim();
      const output = args.output.trim();
      if (input.length === 0 || output.length === 0) throw new Error('convert_djvu_to_pdf 需要 input 与 output');
      const inputTarget = await ctx.fs.resolve(input, resolveOptions(exec));
      const resolvedInput = fsTargetToString(inputTarget);
      const resolvedOutput = fsTargetToString(await ctx.fs.resolve(output, resolveOptions(exec)));
      const info = await ctx.fs.stat(inputTarget, exec.signal);
      if (info === undefined || info.type !== 'file') throw new FsError(`输入文件不存在：${input}`, 'FS_NOT_FOUND');
      const plan = planConversion(resolvedInput, resolvedOutput, config);
      return { conversion: await runConversion(plan, config.timeoutMs, exec.signal) };
    },
  }));
}

/** 以子进程执行一条转换计划；外部工具缺失时返回未执行的结果。 */
async function runConversion(plan: ConversionPlan, timeoutMs: number, signal: AbortSignal): Promise<{
  kind: string;
  command: string;
  args: string[];
  executed: boolean;
  exitCode?: number;
  output: string;
  fallback: string;
}> {
  const { spawn } = await import('node:child_process');
  const available = await commandExists(plan.command);
  if (!available) {
    return { kind: plan.kind, command: plan.command, args: plan.args, executed: false, output: `命令不存在：${plan.command}`, fallback: plan.fallback };
  }
  return new Promise((resolve, reject) => {
    const child = spawn(plan.command, plan.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const onAbort = (): void => {
      child.kill('SIGKILL');
    };
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve({
        kind: plan.kind,
        command: plan.command,
        args: plan.args,
        executed: true,
        exitCode: code ?? -1,
        output: `${stdout}${stderr}`.trim().slice(0, 4000),
        fallback: plan.fallback,
      });
    });
  });
}

/** 判断命令是否存在于 PATH。 */
async function commandExists(command: string): Promise<boolean> {
  if (command.includes('/')) {
    const { access } = await import('node:fs/promises');
    try {
      await access(command);
      return true;
    } catch {
      return false;
    }
  }
  const { execFile } = await import('node:child_process');
  const which = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((resolve) => {
    execFile(which, [command], (error) => {
      resolve(!error);
      return undefined;
    });
  });
}

export { Config, apply, inject, name };
