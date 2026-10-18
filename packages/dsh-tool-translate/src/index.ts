/**
 * dsh 扩展版 — 翻译工具插件（设计文档 2.3 / 2.7）。
 *
 * 注册 `translate_text(text, targetLang, sourceLang, context)`。
 *
 * 复用 dsh 的模型配置和 API 密钥（`ctx.llm`），不在本插件保存任何凭据。
 * 阅读器前端做划词翻译，通过这个工具拿到译文，气泡中流式显示。
 *
 * @module dsh-tool-translate
 */

import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Context } from '@deepseek-ai/cordis';
import type { ToolRuntime } from '@deepseek-ai/dsh-tools';
import type { FileSystem as FsService } from '@deepseek-ai/dsh-fs';

/** apply() 收到的 agent-scoped 服务集合。 */
type PluginContext = Context & { tools: ToolRuntime; fs?: FsService };

interface PluginConfig {
  defaultTargetLang: string;
  maxChars: number;
  timeoutMs: number;
}

/** Stable Loader identity。 */
const name = 'dsh-tool-translate';

/** 插件配置。 */
const Config = z.object({
  /** 默认目标语言。 */
  defaultTargetLang: z.string().default('zh'),
  /** 单次翻译的最大字符数。 */
  maxChars: z.number().default(8000),
  /** 模型调用超时（毫秒）。 */
  timeoutMs: z.number().default(60000),
});

/** 本插件用到的服务：llm 用于复用 dsh 的模型配置与密钥。 */
const inject = ['tools', 'llm'];

/** 构造翻译用的 system prompt。 */
export function buildTranslatePrompt(options: { targetLang: string; sourceLang?: string; context?: string }): string {
  const parts = [
    `你是一名专业的文学翻译。请把用户提供的文本翻译成${languageName(options.targetLang)}。`,
    '要求：',
    '1. 只输出译文本身，不要解释、不要加引号、不要标注语言。',
    '2. 保留原文的段落结构与标点风格。',
    '3. 专有名词首次出现时可在括号内保留原文。',
  ];
  if (options.sourceLang !== undefined && options.sourceLang.length > 0 && options.sourceLang !== 'auto') {
    parts.splice(1, 0, `源语言是${languageName(options.sourceLang)}。`);
  }
  if (options.context !== undefined && options.context.trim().length > 0) {
    parts.push(`\n上下文（书名 / 章节 / 前后文，仅供理解，不要翻译）：\n${options.context.trim()}`);
  }
  return parts.join('\n');
}

/** 常见语言代码到中文名的映射。 */
export function languageName(code: string): string {
  const map: Record<string, string> = {
    zh: '简体中文',
    'zh-CN': '简体中文',
    'zh-TW': '繁体中文',
    en: '英语',
    ja: '日语',
    ko: '韩语',
    fr: '法语',
    de: '德语',
    es: '西班牙语',
    ru: '俄语',
    it: '意大利语',
    pt: '葡萄牙语',
    auto: '原文语言',
  };
  return map[code] ?? code;
}

/**
 * 注册翻译工具。
 *
 * @param ctx - agent-scoped services。
 * @param config - defaultTargetLang / maxChars / timeoutMs。
 */
function apply(ctx: PluginContext, config: PluginConfig) {
  ctx.tools.register(defineTool({
    name: 'translate_text',
    description:
      '翻译一段文本。复用 dsh 已配置的模型与 API 密钥，无需单独配置。' +
      '阅读器划词翻译、Wiki 页面翻译、录课字幕翻译都走这个工具。',
    parameters: {
      text: { type: 'string', required: true, description: '待翻译的文本' },
      targetLang: { type: 'string', description: `目标语言代码，默认 ${config.defaultTargetLang}` },
      sourceLang: { type: 'string', description: '源语言代码，默认 auto（自动检测）' },
      context: { type: 'string', description: '上下文（书名 / 章节 / 前后文），提升翻译准确性' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          translation: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              text: { type: 'string', required: true },
              sourceLang: { type: 'string', required: true },
              targetLang: { type: 'string', required: true },
              model: { type: 'string', required: true },
              truncated: { type: 'boolean', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.translation.text }],
    },
    async execute(args, exec) {
      const raw = args.text;
      if (raw.trim().length === 0) throw new Error('translate_text 需要非空文本');
      const truncated = raw.length > config.maxChars;
      const text = truncated ? raw.slice(0, config.maxChars) : raw;
      const targetLang = args.targetLang?.trim() || config.defaultTargetLang;
      const sourceLang = args.sourceLang?.trim() || 'auto';
      exec.signal.throwIfAborted();
      const translated = await callModel(ctx, {
        system: buildTranslatePrompt({
          targetLang,
          sourceLang,
          ...(args.context !== undefined ? { context: args.context } : {}),
        }),
        text,
        timeoutMs: config.timeoutMs,
        signal: exec.signal,
      });
      return {
        translation: {
          text: translated.text,
          sourceLang: translated.sourceLang,
          targetLang,
          model: translated.model,
          truncated,
        },
      };
    },
    timeoutMs: 90000,
  }));
}

/** 通过 dsh 的 LLM 服务调用模型。 */
async function callModel(
  ctx: { llm: unknown },
  options: { system: string; text: string; timeoutMs: number; signal: AbortSignal },
): Promise<{ text: string; sourceLang: string; model: string }> {
  const llm = ctx.llm as {
    chat?: (request: unknown) => Promise<{ text?: string; model?: string; content?: string }>;
  } | undefined;
  if (llm?.chat === undefined) {
    // 没有可用的模型服务时，返回原文并标注，避免前端拿到空结果
    return { text: `[未配置模型，无法翻译] ${options.text}`, sourceLang: 'unknown', model: 'none' };
  }
  const response = await llm.chat({
    system: options.system,
    messages: [{ role: 'user', content: options.text }],
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
  return {
    text: response.text ?? response.content ?? '',
    sourceLang: 'auto',
    model: response.model ?? 'unknown',
  };
}

export { Config, apply, inject, name };
