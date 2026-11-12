# dsh-meow-constellation · 记忆星图

把 [meow-memory](https://www.npmjs.com/package/meow-memory) 的七层 SQLite 记忆，实时画成一片可旋转、可拖拽、可点击的 3D 星图。点开任意光点，就能看到这条记忆的全文、关键词、重要性、状态、项目和时间。

深蓝星空 + 发光光点 + 层环 + 关联线，灵感来自「记忆星图」静态原型；数据是真的，来自你自己的 `memory.db`。

## 效果预览

> 以下截图使用虚构的示例数据，不含任何真实记忆内容。

**全景 · 七层记忆各占一条同心环，可拖拽旋转、滚轮缩放**

![记忆星图全景](assets/screenshot-1.png)

**点击光点 · 右侧展开全文、关键词、重要性、状态与关联记忆**

![点击查看记忆详情](assets/screenshot-2.png)

**筛选 · 分层显隐、关键词搜索、包含归档 / 已完结**

![筛选与分层过滤](assets/screenshot-3.png)

## 效果

- **七层分层**：`soul / user / rules / project / topic / fact / lesson` 各占一条同心环、一个纵深平面，颜色与图例一一对应；点击左侧图例可单独隐藏某一层。
- **拖拽**：拖空白处旋转 3D 视角；**拖住某个光点可以把它挪走**（位置记在内存里，「重置视角」还原）。
- **滚轮缩放**、自动旋转开关、层级标签、中心「此刻」核心。
- **点击看详情**：右侧玻璃面板展示层级 / 状态徽章、更新时间、重要性星级、项目、子类、目标、命中次数、关键词、全文、关联记忆、记忆 ID（可复制）。
- **实时且轻量**：每 4 秒带 mtime 轮询，库没变时只回约 100 字节的标记、不传整包；变化时才重绘，拖拽过的位置会保留。面板改用不透明深色背景，避免逐帧毛玻璃模糊拖慢 iframe 渲染。
- **筛选**：全文/关键词/项目搜索、「包含归档 / 已完结」开关；左下角可切换工作区，下拉里直接标出每个记忆库的条数，也能选「全部工作区」把多个库合并成一片星图。默认打开**有效条数最多的主库**，不再误选刚写过的空库。
- **离线演示**：不在 DSH 宿主内打开时（例如直接双击 HTML），自动切换到内置演示数据，页面照样能玩。

## 安装

需要 DSH ≥ 0.2.0-rc.1、Node ≥ 22.5（`node:sqlite`），并且已装 `meow-memory`。

```bash
# 从 npm（发布后）
dsh plugin --profile desktop add dsh-meow-constellation --config.minimumReleaseAge=0

# 本地开发目录 / tarball
dsh plugin --profile desktop add file:/path/to/dsh-meow-constellation --config.minimumReleaseAge=0
```

装完**重启 DSH 桌面端**生效。启动后右下角会出现一枚发光小圆球，点击（或 `Alt+M`）打开星图；`Esc` 关闭；面板上有「刷新 / 新窗口 / 关闭」。

也可以直接访问 `http://127.0.0.1:<DSH端口>/meow-constellation/app` 单独打开。

## 数据与安全

宿主端只做三件事：读 `<workspace>/.dsh-meow/memory.db`、列出工作区、返回静态页面。

| 路由 | 说明 |
| --- | --- |
| `GET /meow-constellation/app` | 星图页面（单文件，内联 CSS/JS） |
| `GET /meow-constellation/api/workspaces` | 已发现且确实存在 `memory.db` 的工作区 |
| `GET /meow-constellation/api/memories?dir=<绝对路径>&all=1` | 七层记忆条目 + 元数据 |

- 数据库以 **readOnly** 打开，只执行 `SELECT *`，不写、不改、不注册任何工具。
- `dir` 只接受宿主自己发现的工作区路径，拒绝任意路径读取（防目录穿越）。
- 路由只对 loopback / `localhost` 请求开放，记忆内容不会暴露给局域网。
- `all=1` 才返回 `archived` / `stale` 条目，默认只展示 active。

## 结构

```
lib/index.js            宿主：路由 + SQLite 只读查询
lib/client.js           浏览器：悬浮球 + iframe 面板（shadow DOM 隔离）
lib/constellation.html  星图页面：Canvas 2D 渲染、交互、详情面板
cordis.patch.yml        profile bundle 挂载行
```

## 开发

```bash
npm run check     # node --check
npm run smoke     # 用真实 memory.db 跑数据层与三个路由的冒烟测试
```

## 发布

### npm

```bash
npm publish --access public
```

包名 `dsh-meow-constellation`，`publishConfig` 已指向 npmjs。发布后按上面的 `dsh plugin add` 即可安装。

### GitHub

已发布到 [yuyun-git/dsh-meow-constellation](https://github.com/yuyun-git/dsh-meow-constellation)（`main` 分支 + `v0.1.0` tag）。

```bash
git clone https://github.com/yuyun-git/dsh-meow-constellation.git
```

本地开发推送：

```bash
git remote add origin git@github.com:yuyun-git/dsh-meow-constellation.git
git push -u origin main --tags
```

`package.json` 的 `repository` / `homepage` / `bugs` 已指向 `yuyun-git`。

MIT © 2026
