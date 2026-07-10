# 多平台热点舆情雷达

手机优先的多平台热点与舆情筛选网站。当前架构已迁移为免费方案：

- GitHub Actions 每 5 分钟定时采集热点数据。
- 采集结果写入 `data/hot-data.json`。
- GitHub Pages 直接展示静态网页。
- 前端不再依赖腾讯云 API。

## 功能

- 展示微博、新华网/新华社、今日头条、抖音、人民日报、知乎、其他新闻等来源的热点。
- 保留实时热点首页、平台筛选、搜索、自动刷新和手机端 UI。
- 保留舆情筛选池，记录今天和昨天具有社会舆情价值的热点。
- 舆情池支持当前在榜/已下榜、分类、舆情价值评分、多平台热点识别。
- 娱乐明星、饭圈营销和纯国外弱关联事件只在舆情池中过滤，实时热点首页仍展示原始热点。
- 任一平台抓取失败不会影响其他平台，失败时保留上一次数据。

## 常用命令

```bash
npm test
npm run collect
```

## 免费部署

部署由 GitHub 完成：

- `.github/workflows/update-hot-data.yml`：定时抓取并提交 `data/hot-data.json`。
- `index.html`：GitHub Pages 页面。
- `data/hot-data.json`：前端读取的数据源。

GitHub Pages 地址：

```text
https://jdaohc.github.io/
```

舆情池入口：

```text
https://jdaohc.github.io/?panel=opinion
```
