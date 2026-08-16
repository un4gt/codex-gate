# 二进制部署

二进制发布包用于不依赖 Docker 的 Linux 或 Windows 部署。发布包会包含：

- `little-gate` 或 `little-gate.exe`：网关服务
- `static/`：管理后台静态资源
- `.env.example`：二进制部署环境变量模板
- `run-little-gate.sh` 或 `run-little-gate.ps1`：本地启动脚本
- `little-gate.service`：Linux systemd 示例，仅 Linux 包包含

应用不会自动读取 `.env` 文件。发布包里的启动脚本会读取同目录 `.env` 并注入当前进程；如果直接运行二进制，请先自行设置环境变量。

## Linux

下载并解压发布包：

```bash
tar -xzf little-gate-vX.Y.Z-linux-x86_64.tar.gz
cd little-gate-vX.Y.Z-linux-x86_64
cp .env.example .env
```

编辑 `.env`，至少设置：

```bash
ADMIN_TOKEN=replace-with-strong-admin-token
MASTER_KEY=replace-with-strong-master-key
LISTEN_ADDR=0.0.0.0:8080
CODEX_OAUTH_CALLBACK_LISTEN_ADDR=127.0.0.1:1455
STATIC_DIR=./static
DB_DSN=sqlite://./data/little_gate.sqlite
```

前台启动：

```bash
chmod +x ./little-gate ./run-little-gate.sh
./run-little-gate.sh
```

健康检查：

```bash
curl -fsS http://127.0.0.1:8080/healthz
curl -fsS http://127.0.0.1:8080/readyz
```

### systemd 示例

```bash
sudo useradd --system --home-dir /opt/little-gate --shell /usr/sbin/nologin little-gate
sudo mkdir -p /opt/little-gate /etc/little-gate
sudo cp -R ./* /opt/little-gate/
sudo cp .env /etc/little-gate/little-gate.env
sudo chown -R little-gate:little-gate /opt/little-gate
sudo chown root:root /etc/little-gate/little-gate.env
sudo chmod 600 /etc/little-gate/little-gate.env
sudo cp little-gate.service /etc/systemd/system/little-gate.service
sudo systemctl daemon-reload
sudo systemctl enable --now little-gate
sudo systemctl status little-gate
```

服务日志：

```bash
journalctl -u little-gate -f
```

## Windows

下载并解压发布包：

```powershell
Expand-Archive .\little-gate-vX.Y.Z-windows-x86_64.zip -DestinationPath .
Set-Location .\little-gate-vX.Y.Z-windows-x86_64
Copy-Item .env.example .env
```

编辑 `.env`，至少设置：

```powershell
ADMIN_TOKEN=replace-with-strong-admin-token
MASTER_KEY=replace-with-strong-master-key
LISTEN_ADDR=0.0.0.0:8080
CODEX_OAUTH_CALLBACK_LISTEN_ADDR=127.0.0.1:1455
STATIC_DIR=./static
DB_DSN=sqlite://./data/little_gate.sqlite
```

前台启动：

```powershell
powershell -ExecutionPolicy Bypass -File .\run-little-gate.ps1
```

健康检查：

```powershell
Invoke-WebRequest http://127.0.0.1:8080/healthz
Invoke-WebRequest http://127.0.0.1:8080/readyz
```

如需作为 Windows 服务运行，建议使用 NSSM 或 WinSW 包装 `little-gate.exe`，并把工作目录设置为发布包目录，使 `STATIC_DIR=./static` 和 SQLite 相对路径稳定。

## Codex OAuth 本机回调

管理台“OAuth 登录”默认使用浏览器授权码 + PKCE。OpenAI 的 redirect URI 固定为 `http://localhost:1455/auth/callback`，所以 `CODEX_OAUTH_CALLBACK_LISTEN_ADDR` 可以修改监听 IP，但端口必须保持 `1455`。默认绑定回环地址，不需要对公网开放该端口。

浏览器和 little-gate 在同一台机器时会自动完成回调。远程管理时，OpenAI 最终跳转到的是操作者电脑的 `localhost`；此时从浏览器地址栏取得完整 callback URL，粘贴到登录对话框即可。若 `1455` 被其他程序占用，服务会记录 warning 而不会退出，手工 callback 仍然可用。

完整的登录步骤、回调 API、安全边界和故障排查见 [Codex OAuth 登录](codex-oauth.md)。

## 从源码构建二进制

前端要求 Node.js `>=22.22.0`，CI 与 Docker 使用 Node 24；`frontend/.npmrc` 会拒绝不兼容的 Node 版本。构建机还需要 Rust stable，以及 `prek 0.3.9` 或 uv/`uvx`。

Linux/macOS shell：

```bash
npm --prefix frontend ci
bash scripts/run-prek-checks.sh pre-push
cargo build --release --locked --manifest-path backend/Cargo.toml
mkdir -p dist/little-gate-local/static
cp backend/target/release/backend dist/little-gate-local/little-gate
cp -R frontend/dist/* dist/little-gate-local/static/
cp deploy/binary.env.example dist/little-gate-local/.env.example
cp deploy/linux/run-little-gate.sh dist/little-gate-local/
```

Windows PowerShell：

```powershell
npm --prefix frontend ci
uvx --from "prek==0.3.9" prek run --stage pre-push --all-files --show-diff-on-failure --fail-fast
cargo build --release --locked --manifest-path backend/Cargo.toml
New-Item -ItemType Directory -Force -Path dist\little-gate-local\static | Out-Null
Copy-Item backend\target\release\backend.exe dist\little-gate-local\little-gate.exe
Copy-Item frontend\dist\* dist\little-gate-local\static -Recurse
Copy-Item deploy\binary.env.example dist\little-gate-local\.env.example
Copy-Item deploy\windows\run-little-gate.ps1 dist\little-gate-local\
```

## 发布门禁说明

`pre-push` stage 包含前端 TypeScript/Rsbuild 生产构建、React smoke tests 和完整 Rust tests。必须显式指定该 stage；未指定 stage 的 `prek run --all-files` 默认只执行 `pre-commit`，不能用于发布验证。

本地 `pre-commit`/`pre-push` shim 可用以下命令按 prek 官方方式安装：

```bash
bash scripts/install-prek-hooks.sh
```

本地 hooks 仍可能被 `--no-verify`、手工 tag 或 CI tag 绕过，所以发布安全边界位于 GitHub Actions。`scripts/git-push-with-next-tag.sh` 只允许从 `main` 创建发布 tag；统一的 `.github/workflows/release.yml` 还会先拒绝非 `main` 的手动运行，以及提交尚未进入 `main` 的 tag，再在二进制与 Docker 发布 job 之前调用一次 `.github/workflows/quality-gate.yml`。来源校验或质量门禁失败时不会生成二进制发布资产，也不会推送镜像。Dockerfile 自身还会在构建静态资源前再次运行 React smoke tests。

`manual` stage 不会由 Git 自动触发。源码 Docker Compose 部署应使用 `bash scripts/docker-compose-up.sh -d --build` 显式运行它。
