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

## 从源码构建二进制

Linux/macOS shell：

```bash
npm --prefix frontend ci
npm --prefix frontend run build
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
npm --prefix frontend run build
cargo build --release --locked --manifest-path backend/Cargo.toml
New-Item -ItemType Directory -Force -Path dist\little-gate-local\static | Out-Null
Copy-Item backend\target\release\backend.exe dist\little-gate-local\little-gate.exe
Copy-Item frontend\dist\* dist\little-gate-local\static -Recurse
Copy-Item deploy\binary.env.example dist\little-gate-local\.env.example
Copy-Item deploy\windows\run-little-gate.ps1 dist\little-gate-local\
```
