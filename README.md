# 微博实时热点监控网站

手机优先的微博热搜监控网站，基于 Cloudflare Workers 免费部署。

## 功能

- 展示微博实时热点排行榜
- 显示排名、标题、热度、标签、最后更新时间
- 每 5 分钟定时刷新，访问页面时也会按需刷新
- 对新进入榜单的热点显示“新”标记
- 点击热点跳转微博搜索页
- 微博接口失败时自动重试，并展示最近一次成功缓存

## 命令

```bash
npm test
npm run dev
npm run deploy
```

## 部署

项目配置在 `wrangler.toml` 中，部署到 Cloudflare Workers 后会获得一个 `workers.dev` 公网地址。
