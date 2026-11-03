# github-readme-stats 自部署（huawei-sg）

`grs.mangoqwq.com` 的全部服务端资产。Cloudflare → VPS shim → 上游 GitHub GraphQL。

## 架构

```
GitHub README/dengyie 仓库 workflow (update-stats.yml)
  │  generate-stats.py: 带 &t=<epoch> 破缓存参数
  ▼
Cloudflare 边缘缓存 (24h, respect origin; &t= 天然绕过)
  ▼
VPS huawei-sg /opt/github-readme-stats  (systemd grs.service, 用户 grs)
  │  server/server.mjs shim:
  │  - 路由白名单 index/pin/top-langs (其余 404)
  │  - 参数白名单 (未知参数 400, 查询串 >512 400)
  │  - 限流 60 req/min/IP (桶级过期 GC, 不整体清空)
  │  - 内存缓存 10min/64条 (t= 跳过读写;2026-11-04 从 30min 对齐 CF 边缘/PHP 的统一 10min 新鲜度契约)
  │  - 上游错误卡片(SVG 200)检测 → 改写 503 + no-store
  │  - token 从 /etc/grs/github_token (root:grs 0640) 读入 PAT_1
  ▼
api.github.com GraphQL (PAT_1, 5000 req/h)
```

streak 卡片来自 `streak-stats.demolab.com`（官方源，与 shim 无关）。

## 文件清单

| 文件 | 部署位置 | 说明 |
|---|---|---|
| `server/server.mjs` | `/opt/github-readme-stats/server/server.mjs` (0644) | shim 主体 |
| `systemd/grs.service` | `/etc/systemd/system/grs.service` (0644) | 合并版 unit（无 override） |
| `grs-rotate-token.sh` | `/usr/local/sbin/grs-rotate-token.sh` (0700 root) | token 轮换 + 自检 |

上游代码（`api/*.js` 等）是 [anuraghazra/github-readme-stats](https://github.com/anuraghazra/github-readme-stats) 原样克隆，不改动；只有 `server/` 是我们的 shim。

## 部署步骤（全新 VPS）

```bash
# 1. 上游代码
git clone https://github.com/anuraghazra/github-readme-stats /opt/github-readme-stats
# 2. 服务用户与密钥
useradd --system --no-create-home --shell /usr/sbin/nologin grs
mkdir -p /etc/grs /etc/grs/cert
#    github_token: 最小权限 PAT（classic、零 scope 即可读公开数据, 5000 req/h）
printf '<token>\n' > /etc/grs/github_token && chown root:grs /etc/grs/github_token && chmod 640 /etc/grs/github_token
#    grs.env: PORT=80 / HTTPS_PORT=443 / TLS_CERT=/etc/grs/cert/cert.pem / TLS_KEY=/etc/grs/cert/key.pem
#    证书: self-signed CN=grs.mangoqwq.com（CF SSL 模式 full，不校验证书链）
#    key.pem → root:grs 640；cert.pem → 644
# 3. shim + unit + 轮换脚本（本目录 → 对应部署位置），然后：
install -m 0700 grs-rotate-token.sh /usr/local/sbin/grs-rotate-token.sh
systemctl daemon-reload && systemctl enable --now grs
# 4. Cloudflare: A 记录 grs.mangoqwq.com → VPS IP（橙云）；Cache Rule 对 *.svg 24h、respect origin。
#    安全组: 80/443 仅对 Cloudflare 15 个 IP 段放行。
```

## 日常运维

```bash
systemctl status grs && journalctl -u grs -n 50        # 日志
ss -ltnp | grep -E ':80|:443'                          # 监听
ps -o user=,rss= -C node                               # 应为 grs, RSS ~60MB
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1/index?username=dengyie&show_icons=true'
```

- 改动 `server.mjs` 后：scp 上去 → `systemctl restart grs` → 本地回归（400/404/429/503、t= 破缓存）。
- 升级上游：clone 目录里 `git pull` 后重启。注意上游若新增查询参数，需要同步加进 `PARAM_ALLOWLIST`。

## Token 轮换

见 Obsidian《Github 账号.md》：生成零 scope classic PAT → `ssh huawei-sg 'sudo /usr/local/sbin/grs-rotate-token.sh <token>'`。脚本自动写文件、重启并带 `t=` 破缓存自检。

## 与 workflow 的契约

`dengyie/dengyie` 的 `scripts/generate-stats.py`：
- 自托管 URL 附加 `&t=<epoch>`：同时绕过 CF 边缘缓存与 shim 内存缓存，保证每日强制回源；
- stats 错误卡片（"Something went wrong"）与 streak 错误（"Could not find a user with that name."）都视为失败，走 fallback（公开 vercel 实例）。
