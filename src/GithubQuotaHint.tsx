import type { Dashboard } from '../shared/types.js';

export default function GithubQuotaHint({ data }: { data: Dashboard }) {
  const blocked = data.status.retryAt && Date.parse(data.status.retryAt) > Date.now();
  return <div className="github-quota-hint">
    {!data.hasGithubToken && <p>尚未绑定 Token，正在使用匿名请求。可在 <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">GitHub 创建细粒度 Token</a>，仅用于读取公开仓库，不授予写入或私有仓库权限；只填在本机设置页，不要发到聊天中。</p>}
    {data.githubRate?.map(rate => <p key={rate.resource}>{rate.resource === 'search' ? '搜索接口' : '普通接口'}：上次响应剩余 {rate.remaining} / {rate.limit > 0 ? rate.limit : '未知'} 次{rate.resetAt > 0 && `，重置时间 ${new Date(rate.resetAt).toLocaleString('zh-CN')}`}。</p>)}
    {blocked && <p>资料采集暂缓至 {new Date(data.status.retryAt!).toLocaleString('zh-CN')}；有缓存的项目仍可分析，没有资料的先等待，不阻塞其他项目。</p>}
  </div>;
}
