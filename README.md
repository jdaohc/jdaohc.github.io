# 微博实时热点监控网站

手机优先的多来源舆情热点监控网站，支持 Cloudflare Workers 备用部署和腾讯云 SCF 大陆优先部署。

## 功能

- 展示微博和新华网/新华社公开内容热点
- 显示排名、标题、热度、标签、最后更新时间
- 每 5 分钟定时刷新，访问页面时也会按需刷新
- 对新进入榜单的热点显示“新”标记
- 点击热点跳转对应来源页面
- 微博接口失败时自动重试，并展示最近一次成功缓存
- 默认进入综合舆情筛选视图，可切换微博、新华网、全部热搜

## 命令

```bash
npm test
npm run dev
npm run deploy
```

## 部署

项目配置在 `wrangler.toml` 中，部署到 Cloudflare Workers 后会获得一个 `workers.dev` 公网地址。

腾讯云 SCF 入口为 `src/tencent-scf.cjs`，部署配置为 `serverless.yml`。HTTP 触发器提供网页和 API，定时触发器每 5 分钟刷新缓存。
