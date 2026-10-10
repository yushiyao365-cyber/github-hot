import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { AppError } from './errors.js';

export async function pdfExcerpt(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new AppError('PDF 内容为空');
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const result = await reader.read(); if (result.done) break;
      length += result.value.length;
      if (length > 2_000_000) throw new AppError('PDF 超过 2 MB 读取上限，请改用报告的公开 HTML 页面');
      chunks.push(result.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = Buffer.concat(chunks);
  if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new AppError('来源不是有效 PDF');
  const directory = await mkdtemp(join(tmpdir(), 'radar-paper-'));
  try {
    const path = join(directory, 'paper.pdf');
    await writeFile(path, bytes, { mode: 0o600 });
    const { stdout } = await promisify(execFile)('pdftotext', ['-f', '1', '-l', '30', '-layout', '-enc', 'UTF-8', path, '-'], { timeout: 15000, maxBuffer: 1_000_000, encoding: 'utf8' });
    const text = stdout.replace(/\u0000/g, '').trim().slice(0, 24000);
    if (text.length < 160) throw new AppError('PDF 可提取文字不足；不进行 OCR，也不绕过加密');
    return text;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('PDF 文字提取失败，请确认本机已安装 pdftotext，或改用公开 HTML 页面');
  } finally { await rm(directory, { recursive: true, force: true }); }
}
