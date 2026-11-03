# streak-stats 自部署(hw-sg)

> **速读 / 生产真相**:自部署 `github-readme-streak-stats`(DenverCoder1,PHP 8.2 + composer)跑在华为云新加坡 VPS `huawei-sg` 的 `/opt/github-readme-streak-stats`,systemd `streak-stats.service`,监听 `127.0.0.1:8080`(PHP built-in server,单线程)。**公网入口 `https://streak.mangoqwq.com`(CF 橙云 → A 111.91.24.234)**,与 `grs.mangoqwq.com` 共用同一个 443 监听,由 grs shim(`server.mjs`)按 Host 头分流到 8080——不占新端口、无需 Origin Rule、安全组无需变更(443 仅放行 CF 段)。canonical 源码:本仓库 `infrastructure/streak/` + `infrastructure/grs/server/server.mjs`(分流逻辑)。

## 为什么自部署

官方公共实例 `streak-stats.demolab.com` 反复全局 503 / 巨慢(2026-11-03 实测:连续 15-40s 挂起后 503,VPS 与 Actions runner 双双超时),单源无兜底导致 `update-stats.yml` 整个失败、README stats 卡当天冻结。与当初 vercel 官方 grs 实例 `DEPLOYMENT_PAUSED` 同款剧本,根治方式同 grs:自部署 + 公共实例降级为 fallback。

## 组件与路径(VPS)

| 项 | 值 |
|---|---|
| 应用 | `/opt/github-readme-streak-stats`(git clone `DenverCoder1/github-readme-streak-stats`,owner `streak:streak`) |
| 运行用户 | `streak`(system,nologin) |
| systemd | `/etc/systemd/system/streak-stats.service`(canonical: 本目录 `systemd/streak-stats.service`) |
| PHP 依赖 | `php-cli php-mbstring php-xml php-curl php-intl composer`(Debian 12 = PHP 8.2) |
| Token | `/etc/streak/streak.env`(**640 root:streak**,`TOKEN=<PAT>` + `WHITELIST=dengyie`),软链为应用根 `.env`;**与 grs 共用同一个 PAT**,轮换走 `grs-rotate-token.sh`(已扩展双服务) |
| 缓存 | `/opt/github-readme-streak-stats/cache/`(24h TTL,unit `ReadWritePaths` 唯一可写点) |
| 分流 | `server.mjs`:Host == `streak.mangoqwq.com` → 透明代理 `127.0.0.1:8080`;PHP 的 HTTP-200 错误卡被规范成 **503 + no-store**(与 grs 错误卡同契约) |
| TLS | `/etc/grs/cert/{cert,key}.pem` 自签证书,SAN 含 `grs.mangoqwq.com` + `streak.mangoqwq.com`(CF zone `full` 模式不校验, SAN 仅为卫生) |
| DNS | zone `mangoqwq.com`(`d2d0fb042a3ef19ae678e03fce29c5f5`),A `streak` → 111.91.24.234(Proxied) |

## 全新部署 SOP

```bash
ssh huawei-sg
apt-get install -y php-cli php-mbstring php-xml php-curl php-intl composer unzip
git clone --depth 1 https://github.com/DenverCoder1/github-readme-streak-stats /opt/github-readme-streak-stats
cd /opt/github-readme-streak-stats && COMPOSER_ALLOW_SUPERUSER=1 composer install --no-dev --no-interaction
useradd --system --no-create-home --shell /usr/sbin/nologin streak
chown -R streak:streak /opt/github-readme-streak-stats
mkdir -m 750 /etc/streak
printf 'TOKEN=%s\nWHITELIST=dengyie\n' "$(cat /etc/grs/github_token)" > /etc/streak/streak.env
chown root:streak /etc/streak/streak.env && chmod 640 /etc/streak/streak.env
ln -s /etc/streak/streak.env /opt/github-readme-streak-stats/.env
# 安装 unit(从仓库 infrastructure/streak/systemd/ 拷贝)→ daemon-reload → enable --now
```

## 验证

```bash
# 本机直连 PHP
curl -s 'http://127.0.0.1:8080/?user=dengyie&theme=tokyonight&hide_border=true' | grep -c 'Current Streak'
# 经 shim Host 分流(模拟 CF 回源)
curl -sk -H 'Host: streak.mangoqwq.com' "https://127.0.0.1/?user=dengyie&theme=tokyonight&hide_border=true&t=$(date +%s)" -o /dev/null -w '%{http_code}\n'   # 200
# grs 不受影响
curl -sk "https://127.0.0.1/index?username=dengyie&show_icons=true" -o /dev/null -w '%{http_code}\n'   # 200
```

## 变更与排障记录

- 2026-11-04: 首次部署。起因:`streak-stats.demolab.com` 全局 503/超时(30s×2 重试仍失败),手动 dispatch 两次失败,确认单点故障后按 grs 模式自部署。DNS 记录经 `pxed` 跳板用 CF Global Key 创建(本机 `api.cloudflare.com` TLS 不通)。
