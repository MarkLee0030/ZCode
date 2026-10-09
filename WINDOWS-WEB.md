# ZCode Web 端：Windows 构建与部署指南

本 fork 补齐了 `build:zcode` 在 Windows 上的三个阻断问题，并验证了从源码到
`zcode --web` 发行包的完整链路（Windows 11 + Node 24 + Git Bash）。

## 修复内容（`scripts/build-zcode.mjs`）

1. **pnpm 调用**：`run()` 改走 `scripts/spawn-command.mjs`。Windows 上裸
   `spawnSync("pnpm")` 无法解析 cmd shim（`pnpm.cmd`），需要 shell 解析并对
   含空格参数加引号——仓库已有正确实现但构建脚本未使用。
2. **tar 选择**：Windows 优先使用系统自带 bsdtar（`System32\tar.exe`）。
   Git Bash 的 GNU tar 会把 `D:\...` 路径中的冒号解释为远程主机标识导致
   打包失败；bsdtar（Win10 1809+ 自带）无此问题且参数兼容。
3. **`--no-tui` 开关**：跳过终端 TUI 运行时资产组装。`--web` 模式
   （server + agent app-server）不加载 TUI 资产；且 `@zcode/shared` 是纯源码
   workspace 包（无 build script、无 dist），SEA 资产收集器在干净 checkout
   上必然失败。web 发行包同时借此显著减重（约 -30MB 压缩体积）。

## 构建（开发机，Windows）

前置：Node 24.x、pnpm 10.33.2（`packageManager` 字段会触发 pnpm 自动切换）。

```bash
# 1. 安装依赖（约 3 分钟；Electron 二进制走 npmmirror 镜像加速）
ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" pnpm install

# 2. 构建 agent CLI（server 在无此产物时会回退 tsx 路径，Windows 上不可用）
pnpm --filter @zcode/cli... run build

# 3. 构建 @zcode/shared 闭包（server/web 构建的依赖）
pnpm --filter @zcode/shared... run build

# 4. 组装发行包（含 server + web 构建，产物在 dist/zcode/）
node scripts/build-zcode.mjs --no-tui --base-url "https://downloads.example.com/zcode/"
```

产物：

- `dist/zcode/releases/<version>/zcode-<version>.tar.gz` — 运行包（v3.14.3 实测 64.7MB）
- `dist/zcode/releases/<version>/sha256.txt` — 校验摘要

复用已有构建产物重新组包：追加 `--skip-build`。

## 部署（目标机，如公司电脑）

目标机只需要 **Node.js 24+**，不需要 pnpm、不需要源码仓库。

1. 拷贝并解压 `zcode-<version>.tar.gz`；
2. 启动：

```bash
node zcode/bin/zcode.mjs --web --workspace <项目目录> --port 3030
```

或使用随包的 `start-web.bat`（放在解压出的 `zcode` 目录同级，双击即起，
工作区默认取 `<bat所在目录>\workspace`，端口 3030，可在 `start-web.bat`
同目录放 `port.txt` 自定义端口）。

3. 浏览器访问终端输出的地址（默认 `http://127.0.0.1:3030`）。

验证：`curl http://127.0.0.1:3030/api/server-info` 应返回版本与 workspace
信息。局域网访问加 `--host 0.0.0.0`（会自动生成访问令牌，用终端输出的带
`?token=` 链接首次访问）。

## 已知限制

- `--no-tui` 构建的发行包不含终端 TUI 模式（`zcode` 无参数进 TUI 会缺资产）；
  仅影响终端 UI，不影响 `--web` 与 Agent CLI 参数模式。
- 模型 Provider 配置读取用户目录 `~/.zcode/v2/provider_config.json`（可在
  Web 设置页配置，1 秒轮询热加载）。
