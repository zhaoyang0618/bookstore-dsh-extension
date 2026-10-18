/**
 * dsh 扩展版 — Wiki 工具插件（设计文档 2.3 / 2.8）。
 *
 * 两种暴露方式：
 * 1. **MCP 模式**：`llm-wiki-mcp` 作为 MCP 服务运行，通过 `dsh-mcp-client` 连接，
 *    其工具以 `mcp__wiki__*` 命名空间出现。
 * 2. **本地模式**（本插件）：直接对 MyLibrary 的 `wiki/pages/` 做读写，
 *    让模型无需启动 MCP 服务也能操作 Wiki。
 *
 * 两种模式读写同一份数据（设计文档 4.2「Wiki 互通」）。
 *
 * @module dsh-tool-wiki
 */

import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { MyLibraryStore, createWikiPage, slugify } from '@bookstore/mylibrary-core';
import type { Context } from '@deepseek-ai/cordis';
import type { ToolRuntime } from '@deepseek-ai/dsh-tools';
import type { FileSystem as FsService } from '@deepseek-ai/dsh-fs';

/** apply() 收到的 agent-scoped 服务集合。 */
type PluginContext = Context & { tools: ToolRuntime; fs?: FsService };

interface PluginConfig {
  wikiBaseUrl: string;
  libraryRoot: string;
  localMode: boolean;
}

/** Stable Loader identity。 */
const name = 'dsh-tool-wiki';

/** 插件配置。 */
const Config = z.object({
  /** Wiki 前端基地址。 */
  wikiBaseUrl: z.string().default('http://127.0.0.1:5174'),
  /** MyLibrary 根目录。 */
  libraryRoot: z.string().default(''),
  /** 是否启用本地直写模式（关闭时只返回 MCP 工具说明）。 */
  localMode: z.boolean().default(true),
});

/** 本插件用到的服务。 */
const inject = ['tools', 'fs'];

/**
 * 注册 Wiki 工具。
 *
 * @param ctx - agent-scoped services。
 * @param config - wikiBaseUrl / libraryRoot / localMode。
 */
function apply(ctx: PluginContext, config: PluginConfig) {
  const baseUrl = config.wikiBaseUrl.replace(/\/+$/, '');

  const openStore = (): MyLibraryStore => {
    if (config.libraryRoot.trim().length === 0) throw new Error('未配置 libraryRoot：请在插件配置中指定 MyLibrary 目录');
    return new MyLibraryStore(config.libraryRoot, { clientId: 'dsh-tool-wiki' });
  };

  if (config.localMode) {
    ctx.tools.register(defineTool({
      name: 'wiki_create_page',
      description: '在 MyLibrary 的 wiki/pages/ 下创建一个新的 Markdown 页面（含 frontmatter），与 Obsidian / Logseq 兼容。',
      parameters: {
        title: { type: 'string', required: true, description: '页面标题' },
        body: { type: 'string', description: 'Markdown 正文，支持 [[双向链接]]' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签' },
        sourceBooks: { type: 'array', items: { type: 'string' }, description: '关联的书籍 id' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            page: {
              type: 'object',
              additionalProperties: false,
              required: true,
              properties: {
                slug: { type: 'string', required: true },
                title: { type: 'string', required: true },
                path: { type: 'string', required: true },
                links: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `已创建 Wiki 页面：${value.page.title}（${value.page.path}）` }],
      },
      async execute(args, exec) {
        exec.signal.throwIfAborted();
        const store = openStore();
        const now = new Date().toISOString();
        const page = createWikiPage({
          id: `wiki-${Date.now().toString(36)}`,
          title: args.title.trim(),
          ...(args.body !== undefined ? { body: args.body } : {}),
          tags: (args.tags ?? []) as string[],
          sourceBooks: (args.sourceBooks ?? []) as string[],
          now,
        });
        store.writeWikiPage(page);
        const saved = store.readWikiPage(page.frontmatter.slug);
        store.rebuildWikiIndex();
        return {
          page: {
            slug: page.frontmatter.slug,
            title: page.frontmatter.title,
            path: `wiki/pages/${page.relativePath}`,
            links: saved?.frontmatter.links ?? [],
          },
        };
      },
    }));

    ctx.tools.register(defineTool({
      name: 'wiki_search',
      description: '在 Wiki 页面中搜索关键词，返回匹配页面的标题、slug 与摘要片段。',
      parameters: {
        query: { type: 'string', required: true, description: '搜索关键词' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            matches: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  slug: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                  excerpt: { type: 'string', required: true },
                },
              },
            },
            total: { type: 'integer', required: true },
          },
        },
        render: (_args, value) => [
          { type: 'text', text: value.total === 0 ? '没有匹配的 Wiki 页面' : `匹配 ${value.total} 个页面：\n${value.matches.map((m) => `- ${m.title}`).join('\n')}` },
        ],
      },
      async execute(args, exec) {
        exec.signal.throwIfAborted();
        const store = openStore();
        const needle = args.query.trim().toLowerCase();
        const matches = needle.length === 0
          ? []
          : store.listWikiPages()
              .filter((page) => {
                const haystack = `${page.frontmatter.title}\n${page.frontmatter.tags.join(' ')}\n${page.body}`.toLowerCase();
                return haystack.includes(needle);
              })
              .slice(0, 20)
              .map((page) => {
                const index = page.body.toLowerCase().indexOf(needle);
                const start = Math.max(0, index - 60);
                const excerpt = index < 0 ? page.body.slice(0, 120) : `…${page.body.slice(start, start + 160).replace(/\n/g, ' ')}…`;
                return { slug: page.frontmatter.slug, title: page.frontmatter.title, excerpt };
              });
        return { matches, total: matches.length };
      },
    }));

    ctx.tools.register(defineTool({
      name: 'wiki_graph',
      description: '构建 Wiki 双向链接图谱（节点 + 出链 + 反链），用于图谱可视化。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            graph: {
              type: 'object',
              additionalProperties: false,
              required: true,
              properties: {
                nodes: { type: 'array', required: true, items: { type: 'json' } },
                backlinks: { type: 'json', required: true },
              },
            },
            nodeCount: { type: 'integer', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `Wiki 图谱：${value.nodeCount} 个节点` }],
      },
      async execute(_args, exec) {
        exec.signal.throwIfAborted();
        const store = openStore();
        const graph = store.buildWikiGraph();
        return { graph: { nodes: graph.nodes as unknown as [], backlinks: graph.backlinks }, nodeCount: graph.nodes.length };
      },
    }));

    ctx.tools.register(defineTool({
      name: 'open_wiki',
      description: '打开独立的 Wiki 界面（浏览、编辑、图谱可视化）。',
      parameters: {
        slug: { type: 'string', description: '要定位到的页面 slug' },
      },
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
          },
        },
        render: (_args, value) => [{ type: 'text', text: `打开 Wiki：${value.instruction.url}` }],
      },
      async execute(args, exec) {
        exec.signal.throwIfAborted();
        const store = openStore();
        const url = new URL(`${baseUrl}/`);
        url.searchParams.set('library', store.root);
        if (args.slug !== undefined && args.slug.trim().length > 0) url.hash = slugify(args.slug.trim());
        return { instruction: { action: 'open_url' as const, url: url.toString() } };
      },
    }));
  }

  // MCP 模式的接入说明作为工具描述的一部分暴露给模型
  ctx.tools.register(defineTool({
    name: 'wiki_mcp_status',
    description: '查看 llm-wiki-mcp MCP 服务的接入状态与可用工具清单（MCP 模式）。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              localMode: { type: 'boolean', required: true },
              mcpServerName: { type: 'string', required: true },
              hint: { type: 'string', required: true },
            },
          },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `${value.status.mcpServerName}：${value.status.hint}` },
      ],
    },
    async execute(_args, exec) {
      exec.signal.throwIfAborted();
      return {
        status: {
          localMode: config.localMode,
          mcpServerName: 'llm-wiki-mcp',
          hint: config.localMode
            ? '本地直写模式已启用，模型可直接调用 wiki_create_page / wiki_search / wiki_graph。'
            : '本地模式已关闭，请通过 dsh-mcp-client 连接 llm-wiki-mcp 服务（工具名为 mcp__wiki__*）。',
        },
      };
    },
  }));
}

export { Config, apply, inject, name };
