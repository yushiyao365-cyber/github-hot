import { AppError } from './config.js';
import { readBounded } from './github.js';
import { Store } from './store.js';
import { resolveCCSwitchModel } from './cc-switch.js';
import type { Settings } from '../shared/types.js';

export function modelDay() { return new Date().toLocaleDateString('en-CA'); }

export class ModelError extends AppError {
  constructor(message: string, public stopBatch = true, status = 502) { super(message, status); }
}

export async function callModel(store: Store, settings: Settings, system: string, input: string, maxTokens: number, fetcher: typeof fetch = fetch, ccSwitchDirectory?: string): Promise<string> {
  const current = store.settings();
  if (!current.model.enabled || JSON.stringify(current.model) !== JSON.stringify(settings.model)) throw new ModelError('模型设置已变更，已停止本轮调用。', true, 409);
  let route: ReturnType<typeof resolveCCSwitchModel>;
  try { route = resolveCCSwitchModel(settings, ccSwitchDirectory); } catch (error) { throw new ModelError(error instanceof AppError ? error.message : '无法确认 CC Switch 当前模型。', true, 409); }
  const usageKey = `modelUsage:${modelDay()}`;
  const usage = store.get(usageKey, 0);
  if (settings.model.dailyBudget > 0 && usage >= settings.model.dailyBudget) throw new ModelError('今日模型调用预算已用完，未完成的项目保留为待分析。', true, 429);
  store.set(usageKey, usage + 1);
  const parameters = /^gpt-6-(astra|sol|luna)(?:-|$)/.test(settings.model.name)
    ? { reasoning_effort: 'low', max_completion_tokens: maxTokens + 4096 }
    : { temperature: 0.2, max_tokens: maxTokens };
  const path = new URL(settings.model.endpoint).pathname;
  const protocol = route?.protocol || (/\/responses\/?$/.test(path) ? 'responses' : /\/messages\/?$/.test(path) ? 'anthropic' : path.endsWith(':generateContent') ? 'gemini' : 'chat');
  const body = protocol === 'responses'
    ? { model: settings.model.name, stream: false, store: false, reasoning: { effort: 'low' }, max_output_tokens: maxTokens + 4096, instructions: system, input: [{ role: 'user', content: input }] }
    : protocol === 'anthropic'
      ? { model: settings.model.name, stream: false, max_tokens: maxTokens, system, messages: [{ role: 'user', content: input }] }
      : protocol === 'gemini'
        ? { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: input }] }], generationConfig: { maxOutputTokens: maxTokens + 4096 } }
        : { model: settings.model.name, stream: false, ...parameters, messages: [{ role: 'system', content: system }, { role: 'user', content: input }] };
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(protocol === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {}) };
  if (route) Object.assign(headers, route.headers);
  else if (store.secret('modelKey')) {
    if (protocol === 'anthropic') headers['x-api-key'] = store.secret('modelKey');
    else if (protocol === 'gemini') headers['x-goog-api-key'] = store.secret('modelKey');
    else headers.Authorization = `Bearer ${store.secret('modelKey')}`;
  }
  let response: Response;
  try {
    response = await fetcher(settings.model.endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000),
      headers,
      body: JSON.stringify(body),
    });
  } catch { throw new ModelError('无法连接模型服务或请求超时，请检查接口地址；已保留原始资料。'); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ModelError(`模型接口返回 ${response.status}，请检查模型名称、凭据或额度。`);
  }
  try {
    const value = JSON.parse(await readBounded(response, 150000)) as {
      status?: string;
      error?: unknown;
      type?: string;
      role?: string;
      stop_reason?: string;
      content?: { type?: string; text?: unknown }[];
      candidates?: { finishReason?: string; content?: { parts?: { text?: unknown; thought?: boolean }[] } }[];
      output?: { type?: string; role?: string; content?: { type?: string; text?: unknown }[] }[];
      choices?: { finish_reason?: string; message?: { content?: unknown } }[];
    };
    let text: unknown;
    if (value.error) throw new Error();
    const joinText = (parts: { text?: unknown }[]) => parts.map(part => {
      if (typeof part.text !== 'string') throw new Error();
      return part.text;
    }).join('');
    if (protocol === 'responses') {
      if (value.status !== 'completed' || value.error || !Array.isArray(value.output)) throw new Error();
      const parts = value.output.filter(item => item.type === 'message' && item.role === 'assistant').flatMap(item => item.content || []);
      if (parts.some(part => part.type === 'refusal')) throw new Error();
      text = joinText(parts.filter(part => part.type === 'output_text'));
    } else if (protocol === 'anthropic') {
      if (value.type !== 'message' || value.role !== 'assistant' || !['end_turn', 'stop_sequence'].includes(value.stop_reason || '') || !Array.isArray(value.content)) throw new Error();
      text = joinText(value.content.filter(part => part.type === 'text'));
    } else if (protocol === 'gemini') {
      const candidate = value.candidates?.[0];
      if (candidate?.finishReason !== 'STOP' || !Array.isArray(candidate.content?.parts)) throw new Error();
      text = joinText(candidate.content.parts.filter(part => !part.thought && part.text !== undefined));
    } else {
      const choice = value.choices?.[0];
      if (choice?.finish_reason && choice.finish_reason !== 'stop') throw new Error();
      text = choice?.message?.content;
    }
    if (typeof text !== 'string' || !text.trim()) throw new Error();
    return text.trim();
  } catch { throw new ModelError('模型没有返回有效文本，未生成或伪造分析结果。', false); }
}
