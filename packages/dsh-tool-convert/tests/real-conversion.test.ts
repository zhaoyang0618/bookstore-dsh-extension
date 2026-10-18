/**
 * 真实格式转换的端到端测试（设计文档阶段六）。
 *
 * 这些测试**会真的调用 pandoc / ddjvu**：
 * - 工具已安装时验证完整链路（产出文件、内容正确）
 * - 工具缺失时自动跳过，不阻塞 CI
 *
 * 设计前提（design doc）：本软件**不负责安装**这些工具，
 * 由用户自行安装；软件只负责探测、调用、以及在缺失时给出可操作提示。
 *
 * @module dsh-tool-convert/__tests__/real-conversion
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installHint, planConversion, resolveCommand, runConversionForTest } from '../src/index.js';

const SAMPLE_MD = `# 黑暗森林法则

## 两条公理

1. 生存是文明的第一需要
2. 文明不断增长扩张，但宇宙物质总量不变

由此推出**猜疑链**与**技术爆炸**。

| 概念 | 说明 |
|---|---|
| 猜疑链 | 无法判断对方是否善意 |
| 技术爆炸 | 文明可能短期跃迁 |

> 给岁月以文明，而不是给文明以岁月。
`;

// 注意：describe.skipIf 在**模块加载时**求值，早于 beforeAll，
// 因此这里必须用顶层 await 先探测工具是否存在。
const hasPandoc = (await resolveCommand('pandoc')) !== undefined;
const hasDdjvu = (await resolveCommand('ddjvu')) !== undefined;
const hasCjb2 = (await resolveCommand('cjb2')) !== undefined;

let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'convert-e2e-'));
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('resolveCommand 探测能力', () => {
  it('能找到已安装的工具绝对路径', async () => {
    if (!hasPandoc) return;
    const path = await resolveCommand('pandoc');
    expect(path).toBeTruthy();
    // 必须是绝对路径，而不是裸命令名
    expect(path?.startsWith('/')).toBe(true);
    expect(existsSync(path as string)).toBe(true);
  });

  it('找不到不存在的工具时返回 undefined', async () => {
    expect(await resolveCommand('definitely-not-installed-xyz')).toBeUndefined();
  });

  it('支持直接传绝对路径', async () => {
    if (!hasPandoc) return;
    const path = (await resolveCommand('pandoc')) as string;
    expect(await resolveCommand(path)).toBe(path);
  });

  it('传不存在的绝对路径返回 undefined', async () => {
    expect(await resolveCommand('/nonexistent/bin/tool')).toBeUndefined();
  });
});

describe('installHint 给出可操作提示', () => {
  it('pandoc 提示包含 brew / winget', () => {
    const hint = installHint('pandoc');
    expect(hint).toContain('brew install pandoc');
    expect(hint).toContain('winget');
  });

  it('ddjvu 提示包含 djvulibre', () => {
    const hint = installHint('ddjvu');
    expect(hint).toContain('djvulibre');
  });

  it('未知命令给出通用提示', () => {
    expect(installHint('mytool')).toContain('mytool');
  });
});

// 注意：本软件不安装工具，只探测与调用
describe.skipIf(!hasPandoc)('Markdown → DOCX（真实 pandoc）', () => {
  it('转换成功且产物是合法 docx（ZIP 容器）', async () => {
    const input = join(tempDir, 'sample.md');
    const output = join(tempDir, 'sample.docx');
    writeFileSync(input, SAMPLE_MD, 'utf8');

    const plan = planConversion(input, output, { pandocCommand: 'pandoc', ddjvuCommand: 'ddjvu' });
    const result = await runConversionForTest(plan, 120_000);

    expect(result.executed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(existsSync(output)).toBe(true);
    // docx 是 ZIP：头两字节应为 PK
    const head = readFileSync(output).subarray(0, 2).toString('latin1');
    expect(head).toBe('PK');
    expect(statSync(output).size).toBeGreaterThan(1000);
  });

  it('输入不存在时 pandoc 返回非零退出码', async () => {
    const plan = planConversion(join(tempDir, 'missing.md'), join(tempDir, 'out.docx'), {
      pandocCommand: 'pandoc',
      ddjvuCommand: 'ddjvu',
    });
    const result = await runConversionForTest(plan, 60_000);
    expect(result.executed).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it('转换含中文与表格的内容不报错', async () => {
    const input = join(tempDir, 'chinese.md');
    const output = join(tempDir, 'chinese.docx');
    writeFileSync(input, SAMPLE_MD, 'utf8');
    const plan = planConversion(input, output, { pandocCommand: 'pandoc', ddjvuCommand: 'ddjvu' });
    const result = await runConversionForTest(plan, 120_000);
    expect(result.exitCode).toBe(0);
    expect(existsSync(output)).toBe(true);
  });
});

describe.skipIf(!hasDdjvu || !hasCjb2)('DjVu → PDF（真实 ddjvu）', () => {
  /** 用 cjb2 造一个最小 DjVu 文件。 */
  function makeDjvu(dir: string): string {
    const pbm = join(dir, 'page.pbm');
    const djvu = join(dir, 'page.djvu');
    // 生成 400x200 的棋盘格 PBM
    const width = 400;
    const height = 200;
    const rows: string[] = [`P1`, `${width} ${height}`];
    for (let y = 0; y < height; y += 1) {
      let row = '';
      for (let x = 0; x < width; x += 1) {
        const inside = y > 20 && y < 180 && x > 20 && x < 380;
        row += inside && (Math.floor(y / 10) + Math.floor(x / 10)) % 2 === 0 ? '1' : '0';
      }
      rows.push(row);
    }
    writeFileSync(pbm, `${rows.join('\n')}\n`, 'utf8');

    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    const cjb2 = execFileSync('which', ['cjb2'], { encoding: 'utf8' }).trim();
    execFileSync(cjb2, [pbm, djvu], { stdio: 'pipe' });
    return djvu;
  }

  it('转换成功且产物是合法 PDF', async () => {
    const djvu = makeDjvu(tempDir);
    const output = join(tempDir, 'page.pdf');
    const plan = planConversion(djvu, output, { pandocCommand: 'pandoc', ddjvuCommand: 'ddjvu' });
    const result = await runConversionForTest(plan, 120_000);

    expect(result.executed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(existsSync(output)).toBe(true);
    // PDF 头
    const head = readFileSync(output).subarray(0, 5).toString('latin1');
    expect(head).toBe('%PDF-');
  });

  it('生成的 PDF 能被解析出页数（用 pdfinfo，若可用）', async () => {
    const djvu = makeDjvu(tempDir);
    const output = join(tempDir, 'page2.pdf');
    const plan = planConversion(djvu, output, { pandocCommand: 'pandoc', ddjvuCommand: 'ddjvu' });
    await runConversionForTest(plan, 120_000);

    const pdfinfo = await resolveCommand('pdfinfo');
    if (pdfinfo === undefined) return; // 未装 poppler，跳过加强校验
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    const info = execFileSync(pdfinfo, [output], { encoding: 'utf8' });
    expect(info).toMatch(/Pages:\s*1/);
  });
});

describe('工具缺失时的降级行为', () => {
  it('命令不存在时返回 executed=false 与安装提示，而不是抛错', async () => {
    const input = join(tempDir, 'x.md');
    writeFileSync(input, '# x', 'utf8');
    const plan = planConversion(input, join(tempDir, 'x.docx'), {
      pandocCommand: 'definitely-not-installed-xyz',
      ddjvuCommand: 'ddjvu',
    });
    const result = await runConversionForTest(plan, 30_000);

    expect(result.executed).toBe(false);
    // 提示里应告诉用户去装什么
    expect(result.output).toContain('definitely-not-installed-xyz');
    expect(result.fallback.length).toBeGreaterThan(0);
  });
});
