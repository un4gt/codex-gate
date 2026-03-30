# codex-gate
A lightweight Codex API proxy service supporting load balancing, user management, and usage statistics.

## Docker Deploy
- 复制环境变量模板：`cp .env.example .env`
- 至少设置 `ADMIN_TOKEN`；如需独立密钥加密主密钥，再设置 `MASTER_KEY`
- 构建并启动：`docker compose up -d --build`
- 查看状态：`docker compose ps`、`docker compose logs -f codex-gate`
- 冒烟检查：`curl http://127.0.0.1:8080/healthz`、`curl http://127.0.0.1:8080/readyz`
- 数据默认落在命名卷 `codex-gate-data`；如开启归档，文件会写到容器内 `/app/data/archive/request_logs`
- 停止服务：`docker compose down`；连同 SQLite 数据卷一起清掉：`docker compose down -v`

## Local Validation
- `python3 scripts/mock_upstream.py`：本地 mock 上游，复现 `429 / 401 / 200` 场景
- `python3 scripts/bench_gateway.py ...`：基础并发 / 长压 / RSS 采样
- `python3 scripts/bench_failover.py ...`：endpoint / key failover 基线
- `python3 scripts/run_regression.py --archive-compress`：一键跑 build / 长压 / failover / archive 回归
