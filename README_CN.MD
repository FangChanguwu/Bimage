<h1 align="center">Bimage</h1>

<div align="center">

**一个支持自托管的 AI 图像工作台。**

[English](README.MD) · **简体中文**

![Version](https://img.shields.io/badge/version-0.1.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)

</div>

## 简介

Bimage 集图像生成、参考图编辑与提示词优化于一处。接入自己的 OpenAI 兼容服务后，可以在同一页面创建任务、查看队列、搜索历史和下载原图。

![Bimage 桌面工作台：左侧编辑提示词和生成参数，右侧展示生成历史与图像预览](docs/preview.png)

## 功能特性

- **图像创作** — 支持文生图、参考图编辑，最多可添加 16 张参考图；支持自动尺寸及 PNG、JPEG、WebP 输出。
- **提示词优化** — 从简短描述起草提示词，或在编辑框里查看逐字修改，仅在确认后应用。
- **持久化队列** — 逐张提交并保存进度；取消只影响仍在排队的图片，已经开始生成的图片继续完成。
- **历史与下载** — 支持按提示词搜索、回填任务设置、单张原图下载和批量 ZIP 下载。
- **独立工作空间** — 使用访问密钥登录，支持供应商共享、站点品牌设置、深浅主题与响应式布局。

## 技术栈

- **前端：** Vue 3 + TypeScript + Vite
- **后端：** Node.js + Express + TypeScript
- **数据库：** SQLite（`node:sqlite`）

## 快速开始

### 环境要求

- 本地开发：Node.js 24+ 与 npm。
- 容器部署：Docker 和 Docker Compose v2，无需在宿主机安装 Node.js。

### 本地开发

在终端安装依赖、编译并启动 API：

```bash
git clone https://github.com/FangChanguwu/Bimage.git
cd Bimage
npm ci
npm --prefix backend ci
npm --prefix frontend ci
npm --prefix backend run build
HOST=127.0.0.1 npm --prefix backend start
```

在另一个终端进入仓库目录，启动前端：

```bash
npm --prefix frontend run dev
```

访问 [http://127.0.0.1:5178](http://127.0.0.1:5178)。首次启动后，在本机打开 `data/admin-key.txt` 获取管理员访问密钥。

登录后，在「设置」中添加 OpenAI 兼容供应商，再为生图和提示词优化选择对应模型。只使用生图时，无需配置文本模型。

## 部署

### Docker Compose

在仓库根目录执行：

```bash
cp .env.example .env
docker compose up -d --build --wait
```

默认入口为 [http://localhost:6767](http://localhost:6767)，API 不单独对外暴露端口。首次部署同样从挂载目录 `data/admin-key.txt` 获取管理员访问密钥。

### 环境配置

- `BIMAGE_PORT`：工作台对外端口，默认 `6767`。
- `BIMAGE_COOKIE_SECURE`：通过 HTTPS 反向代理部署时设为 `true`，本机 HTTP 测试保留 `false`。

对外部署时请启用 HTTPS，并备份 `data/`；其中包含任务历史、图片和供应商凭据，不应提交到 Git。更多运行参数见[后端配置](backend/README.md)，接口说明见 [API 文档](docs/API.md)。

## 贡献者

- **ChatGPT**（AI 助手）：每次都说「再补一个测试」，结果从来不止一个。

## 许可证

本项目基于 [MIT License](LICENSE) 开源。
