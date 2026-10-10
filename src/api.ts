export async function api<Type>(path: string, body?: unknown, method = 'POST'): Promise<Type> {
  const response = await fetch(`/api${path}`, body === undefined ? undefined : {
    method, headers: { 'Content-Type': 'application/json', 'X-Radar-Client': '1' }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求未完成，请重试');
  return data as Type;
}
