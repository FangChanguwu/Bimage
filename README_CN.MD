<p align="center">
  <img src="frontend/public/Bimage.png" width="144" height="144" alt="Bimage logo" />
</p>

<h1 align="center">Bimage</h1>

<div align="center">

**一个支持自托管的 AI 图像工作台。**

[English](README.MD) · **简体中文**

![Version](https://img.shields.io/badge/version-0.3.7-blue)
![License](https://img.shields.io/badge/license-MIT-green)

</div>

接入自己的 OpenAI 兼容服务，在同一页面完成图像生成、参考图编辑、提示词优化与历史任务管理。

![Bimage 中文工作台](docs/preview-zh.png)

## 功能特性

- **图像创作与参考复用** — 支持文生图、参考图编辑（最多 16 张），并可在历史任务、大图灯箱或收藏详情中一键「作为参考图」直接复用已有资产（无需重复上传），支持自动/自定义尺寸与 PNG / JPEG / WebP 导出。
- **局部修复与像素蒙版重绘** — 内置双模式修复编辑器：支持原生透明通道 PNG 像素蒙版重绘（`/images/edits` `mask` 参数，含画笔、橡皮擦、矩形/圆形选区、反选与撤销/重做），同时保留涂鸦标注提示模式。
- **提示词优化** — 由简短描述生成提示词，或在编辑框内逐字对比修改并按需应用。
- **收藏夹与完整任务详情** — 支持一键星标收藏图片，在侧边栏以纯图网格集中浏览；点击任意作品即可查看并复制完整提示词、生成参数、参考图与像素蒙版，删除原历史任务时自动保护已收藏图片及关联资产。
- **持久化队列** — 逐张请求并持久化进度；取消仅影响排队任务，不中断生成中的图片。
- **历史管理与缓存加速** — 全量提示词搜索、分页加载、一键回填参数、原图单张及 ZIP 批量下载，配合服务端缩略图与账号隔离的浏览器持久缓存。
- **多用户与管理** — 账号登录、供应商共享、站点品牌自定义、账号并发上限，以及仅管理员可用的 GitHub 版本检测、一键更新到最新版与历史版本回退。
- **中英文切换** — 随时切换简体中文 / English，切换时保留当前草稿。

### 提示词优化

根据简短想法扩写或润色提示词，支持逐字 Diff 预览并一键应用。

![中文版提示词优化对比](docs/prompt-refinement-zh.png)

### 局部修复与像素蒙版重绘

使用画笔、橡皮擦、矩形/圆形选区与反选工具涂抹重绘区域，自动导出带 Alpha 通道的 PNG 像素蒙版并回填至草稿，也可切换为涂鸦标注提示模式。

![中文版局部修复与像素蒙版重绘](docs/inpainting-zh.png)

### 收藏夹与任务详情

侧边栏提供纯图片网格视图集中管理精选作品；点击图片即可查看完整提示词、生成参数、参考图与像素蒙版，并支持一键下载、复制、作为参考图或恢复参数。

![中文版收藏夹纯图网格](docs/favorites-zh.png)

![中文版收藏夹任务详情弹窗](docs/favorites-detail-zh.png)

## Docker Compose 部署

需要 Docker 与 Docker Compose v2+（支持 `--wait`），镜像由本仓库源码本地构建。

```bash
git clone https://github.com/FangChanguwu/Bimage.git
cd Bimage
test -f .env || cp .env.example .env
# 按需修改 .env
docker compose build
docker compose up -d --wait
```

- **首次初始化**：私下执行 `docker compose logs api` 获取一次性初始化链接，打开后创建首个管理员账号。
- **数据持久化**：`./data` 保存 SQLite、图片与配置，更新前请备份，切勿执行 `docker compose down -v`。
- **公网 HTTPS**：对外开放请使用同源 HTTPS 反向代理，将 `BIMAGE_PUBLIC_URL` 设为实际访问地址、`BIMAGE_COOKIE_SECURE=true`、`BIMAGE_BIND_HOST=127.0.0.1`；代理头配置见 [backend/README.md](backend/README.md)。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BIMAGE_PORT` | `6767` | 对外 Web 端口（API 仅内部监听 `6768`）。 |
| `BIMAGE_PUBLIC_URL` | `http://localhost:6767` | 用于生成初始化链接的可信 HTTP(S) 源地址（不含路径）。 |
| `BIMAGE_BIND_HOST` | `0.0.0.0` | 与反向代理同机部署时建议设为 `127.0.0.1`。 |
| `BIMAGE_COOKIE_SECURE` | `false` | 使用 HTTPS 访问时设为 `true`。 |
| `BIMAGE_CONCURRENCY` | `8` | 全站生图并发上限（1–8）。 |

### 更新与回滚

等待运行中／排队中的任务完成并备份 `./data` 和 `.env`，随后执行：

```bash
git pull --ff-only
docker compose build
docker compose up -d --force-recreate --wait
```

如需回滚，先停止容器，恢复对应的 `./data` 备份，切换到目标版本（`git checkout <tag>`），再按上述命令重建启动即可。

## 本地开发

需要 Node.js 24+ 与 npm。

```bash
# 终端 1：启动后端 API
git clone https://github.com/FangChanguwu/Bimage.git
cd Bimage
npm ci && npm --prefix backend ci && npm --prefix frontend ci
npm --prefix backend run build
BIMAGE_PUBLIC_URL=http://127.0.0.1:5178 HOST=127.0.0.1 npm --prefix backend start
```

```bash
# 终端 2：启动前端
npm --prefix frontend run dev
```

打开 API 终端打印的初始化链接创建首个管理员，之后访问 [http://127.0.0.1:5178](http://127.0.0.1:5178) 登录，并在「系统设置」中添加 OpenAI 兼容供应商。在根目录执行 `npm run build` 可一次编译前后端。

## 技术栈与文档

- **技术栈**：Vue 3 · TypeScript · Vite · Node.js · Express · SQLite (`node:sqlite`)
- **相关文档**：[API 文档](docs/API.md) · [后端配置](backend/README.md) · [更新日志](CHANGELOG.md)

## 许可证

[MIT](LICENSE)
