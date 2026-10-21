# 从 Fork 到自己的 Cloudflare

本文按新账号、新空数据库说明。全部资源建立在**你自己的** Cloudflare 账号下。本仓库不含维护者账号 ID、数据库 ID、管理员凭据或任何直播源。

## 一键部署到 Cloudflare

[![一键部署到 Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fliumw%2Fiptv-source-cloudflare)

这是 Cloudflare 官方部署向导入口：创建自己的仓库副本、Worker、D1，并完成构建发布。首次管理员需另外生成和导入；部署后的频道库为空。希望手动创建 D1 或使用已有数据库时，可直接从下方第 1 步开始。

1. 先按下方第 1 步安装工具并克隆项目，再执行 `pnpm init:admin`，生成自己的管理员 SQL、随机密码和会话密钥。
2. 点击按钮，登录自己的 Cloudflare，连接 GitHub，确认仓库副本名称、Worker 名称和 D1 名称。若已经 Fork，使用下面的链接，将 `YOUR-GITHUB-USERNAME` 和仓库名换成自己的实际值；官方向导会从指定仓库创建副本，若名称已存在，选择另一个名称。若要直接绑定已有 Fork 而不创建副本，使用第 6B 节。

   ```text
   https://deploy.workers.cloudflare.com/?url=https://github.com/YOUR-GITHUB-USERNAME/iptv-source-cloudflare
   ```

   Markdown 按钮的链接是静态地址，Fork 后不会自动改成你的用户名。要让自己 Fork 的首页按钮使用自己的代码，请编辑 README 按钮和文字链接中的 `url` 参数。

3. 在向导的 `SESSION_SECRET` 中填入本机 `.dev.vars` 内生成的密钥值，不含引号，至少 32 字符。它是运行时 Secret，不是管理员密码。不要提交该文件。
4. 构建命令使用 `pnpm build`，部署命令使用 `pnpm run deploy`；Node.js 使用 24、pnpm 使用 11（需要时在构建变量中设置 `NODE_VERSION=24`、`PNPM_VERSION=11.25.0`）。保留 D1 绑定名称 **DB**。确认后部署。
5. 向导会创建你自己的 D1 并更新新仓库的 `wrangler.jsonc`。部署脚本在 Workers Builds 中先运行 `wrangler d1 migrations apply DB --remote`，再发布 Worker；只创建空表，不导入账号或源。若这一步失败，后续发布会停止。
6. 将向导最终创建的仓库克隆到本机（或拉取其最新配置），确认 `wrangler.jsonc` 的真实 D1 ID 与 Worker 的 `DB` 绑定一致。把第 1 步生成的 `private/bootstrap.sql` 私下放到这个仓库副本的 `private/` 下；若使用同一本机目录，保留已有文件即可。不要再次生成一套凭据。

   ```sh
   pnpm install --frozen-lockfile
   pnpm exec wrangler login
   pnpm db:init:remote
   ```

   确认 Wrangler 登录的是同一个 Cloudflare 账号。也可以在此 D1 的 Console 执行 `private/bootstrap.sql` 的 INSERT 语句。表结构已自动建立，不再手动执行 `0001_schema.sql`。管理员 SQL 只导入一次。

7. 打开自己的 Worker 地址加 `/_admin`，用 `private/bootstrap.credentials.txt` 的账号密码登录，再添加自己的源。若后台返回 503，在 Worker 的 **Settings → Variables and Secrets** 检查 `SESSION_SECRET` 是否为至少 32 字符的运行时 Secret。

后续推送使用 `pnpm run deploy` 的 Workers Builds 会先应用新增的 schema 迁移，保留运行时 Secret 和已有管理员，不重复导入初始化 SQL。本机 `pnpm run deploy` 仍要求有效的 `.dev.vars`；云端通过官方注入的 `WORKERS_CI=1` 识别构建环境。

官方参考：[Deploy to Cloudflare 按钮与资源、密钥配置](https://developers.cloudflare.com/workers/platform/deploy-buttons/)、[Workers Builds 环境变量](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#default-variables)。

## 1. Fork 项目并安装工具

在 [仓库首页](https://github.com/liumw/iptv-source-cloudflare) 点击 **Fork → Create fork**。仅 Star / Follow 不会创建应用。

安装 [Node.js 24](https://nodejs.org/)、Git 和 pnpm 11，然后执行：

```sh
npm install -g pnpm@11
git clone https://github.com/YOUR-GITHUB-USERNAME/iptv-source-cloudflare.git
cd iptv-source-cloudflare
pnpm install --frozen-lockfile
```

将 `YOUR-GITHUB-USERNAME` 换成你的 GitHub 用户名。整个项目独立构建，不需要 Python 或维护者的旧项目。

## 2. 在 Cloudflare 控制台手动创建 D1

1. 登录 [Cloudflare 控制台](https://dash.cloudflare.com/)，选择自己的账号。
2. 打开 **D1 SQL Database**（可从 Storage & databases 进入）。
3. 点击 **Create Database**，名称填 `iptv-source-db`。
4. 可按需要选择区域提示，再点击 **Create**。
5. 在新数据库的概览中复制 **Database ID**。

这是手动建库步骤，不需要购买 VPS。官方参考：[D1 创建和绑定数据库](https://developers.cloudflare.com/d1/get-started/)。

## 3. 配置自己的数据库绑定

编辑项目根目录 `wrangler.jsonc`：

```jsonc
{
  // 其他配置保留，只修改下面对应的值。
  "name": "iptv-source-cloudflare",
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "iptv-source-db",
      "database_id": "粘贴你刚创建的真实 Database ID",
      "migrations_dir": "migrations"
    }
  ]
}
```

请修改现有字段，不要用上述片段替换整个配置文件。`binding` 必须为 **DB**，与代码中的 `env.DB` 对应。

`db:*` 命令通过绑定名 **DB** 选择数据库，因此数据库可自行命名，无需修改命令。Worker 的 `name` 可自行命名，但须与 Cloudflare 中的 Worker 名称一致。

数据库 ID 是资源标识，可保存到自己的 Fork；密码、会话密钥和初始化 SQL 只能私下保存。

## 4. 生成自己的初始管理员和密码

在项目根目录执行：

```sh
pnpm init:admin
```

默认用户名为 `admin`，密码为每次独立生成的随机值。脚本只在本机生成文件，不连接 Cloudflare、不创建源、不导入测试数据。

| 文件 | 如何使用 |
| --- | --- |
| `private/bootstrap.credentials.txt` | 用文本编辑器打开，查看你的初始用户名和密码 |
| `private/bootstrap.sql` | 导入你自己的新空 D1；其中只保存密码哈希，不保存明文密码 |
| `.dev.vars` | 独立会话密钥；`pnpm run deploy` 将它作为 Cloudflare Secret 上传 |

如需自定义用户名：

```sh
pnpm init:admin --username myadmin
```

如需自定义密码，可先在终端设置你自己的临时环境变量，再使用 `--password-env MY_INITIAL_PASSWORD`。不要把明文密码写进命令行参数、仓库或 Issue；密码至少 12 位。通常直接使用随机生成值即可。

初始化脚本拒绝覆盖已存在的文件。若已经导入数据库，不要为了修改密码重新初始化；请登录系统设置修改。

## 5. 建立表结构并导入管理员

### 推荐：数据库手动建好后，用 Wrangler 导入 SQL

```sh
pnpm exec wrangler login
pnpm db:remote
pnpm db:init:remote
```

- `wrangler login` 打开官方账号授权页，确认登录的是你创建 D1 的同一个账号。
- `db:remote` 把 `migrations/0001_schema.sql` 中的空表结构应用到自己的 D1。
- `db:init:remote` 把你生成的 `private/bootstrap.sql` 导入该 D1，创建初始管理员。

`--remote` 表示云端；`--local` 表示本机模拟库，两者互相独立。不要遗漏后缀或误把本机初始化当作云端初始化。

### 可选：在 D1 Console 手动执行

1. 打开你创建的 D1 数据库，进入 **Console**。
2. 复制 `migrations/0001_schema.sql` 中的建表 SQL，依次执行完整 SQL 语句；如果界面只接受单条语句，就按分号分隔逐条执行。
3. 表结构完成后，复制本机生成的 `private/bootstrap.sql` 中的 INSERT 语句，依次执行。
4. 这份初始化 SQL 仅用于新空数据库。重复执行会报重复约束，不会重置现有管理员。

如果选择 Console 手动建表，后续首次执行 `pnpm db:remote` 会尝试重建同名表。推荐从一开始使用上面的 Wrangler migrations 路径；若已在 Console 建表，先在 Console 执行以下记录，标记已应用的 `0001_schema.sql`，再管理后续升级：

```sql
CREATE TABLE IF NOT EXISTS d1_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
INSERT OR IGNORE INTO d1_migrations(name) VALUES ('0001_schema.sql');
```

此记录只标记已经完成的建表，不代替实际执行表结构。可用下面的查询确认结果：

```sql
SELECT username, must_change_password FROM admin_users;
SELECT count(*) AS sources FROM sources;
SELECT count(*) AS channels FROM channels;
SELECT count(*) AS streams FROM streams;
```

应有一个管理员，三个计数均为 **0**。另有一个空内容视图和一个带随机 token、自动识别网络的 `/live` 订阅；没有固定网络环境或播放地址。

## 6A. 推荐：从本机发布 Worker

```sh
pnpm check
pnpm test
pnpm deploy:check
pnpm run deploy
```

`pnpm run deploy` 会检查真实 D1 ID 和至少 32 字符的会话密钥，再发布代码，并通过 `--secrets-file .dev.vars` 将密钥上传为 Worker Secret `SESSION_SECRET`。不需要把 `.dev.vars` 提交到 GitHub。官方参考：[随代码上传 Secret](https://developers.cloudflare.com/workers/configuration/secrets/#upload-secrets-alongside-code)。

Wrangler 会输出属于你的访问地址，例如：

```text
https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev
```

## 6B. 可选：连接 Fork，使用 Cloudflare 自动构建

也可以在完成 D1 初始化后，通过 Cloudflare 的 Git 集成发布。先把第 3 步的数据库配置提交到**自己的 Fork**；不要提交 `private/` 或 `.dev.vars`。

1. 在 Cloudflare 的 **Workers & Pages → Create application** 中选择导入 Git 仓库的入口，连接 GitHub 并选择自己的 Fork。
2. 使用与 `wrangler.jsonc` 中 `name` 相同的 Worker 名称，生产分支选 `main`。
3. 根目录使用仓库根目录 `/`。构建命令填写 `pnpm build`，部署命令填写 `pnpm run deploy`，自动先应用 D1 迁移再发布。
4. 在构建配置中设置 `NODE_VERSION=24`、`PNPM_VERSION=11.25.0`；依赖安装使用 `pnpm install --frozen-lockfile`（若界面可指定安装命令）。
5. 部署完成后，进入 Worker 的 **Settings → Variables and Secrets → Add**，选择 **Secret**，名称填 `SESSION_SECRET`，值填本机 `.dev.vars` 中生成的密钥值，**不包括引号**；点击 **Deploy**。
6. 在 Worker 的 Bindings 确认存在名为 `DB` 的 D1 绑定，指向自己创建的数据库。代码中的 Wrangler 配置应已经建立该绑定；若手动补充，也使用这个名称。

这里选择的是 **Workers**，不是只托管静态文件的 Pages。`.generated/public` 由构建自动生成，不需要提交它，也不要把它单独作为整个应用部署。

`SESSION_SECRET` 必须存在于 Worker 的**运行时** Variables and Secrets；仅在 Build 变量里填写同名字段不会自动成为运行时密钥。密钥添加前，后台会返回 503，这是配置尚未完成的提示。

Cloudflare Git 构建使用平台运行时 Secret，不要求远端构建环境存在本机 `.dev.vars`。后续代码推送会先应用新增 migrations，再发布，现有运行时 Secret 会保留。不要在每次构建中重导管理员。

官方参考：[Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)、[控制台配置运行时 Secret](https://developers.cloudflare.com/workers/configuration/secrets/#via-the-dashboard)。

## 7. 首次登录并添加自己的源

1. 打开 `https://你的域名/_admin`。
2. 使用 `private/bootstrap.credentials.txt` 中的账号密码登录。
3. 可在系统设置修改初始密码，修改后重新登录。
4. 打开源管理，选择 URL、上传或粘贴，添加你有权使用的播放列表，并抓取/导入。
5. 在待确认和频道库中整理频道，检查线路的网络、运营商和地区标签。
6. 从订阅管理复制完整订阅地址到播放器。默认 `/live` 需要随机 token；直接访问 `/live` 返回 403 是正常的访问保护。

默认订阅网络环境为自动识别，参数覆盖关闭。固定环境和网段绑定可在后台按需添加。无源时带正确 token 的订阅返回只有 `#EXTM3U` 的空列表，这是预期初始状态。

## 8. 验收

| 检查 | 预期 |
| --- | --- |
| `/health` | HTTP 200，数据库类型为 D1 |
| `/_admin` | 跳转登录或显示后台 |
| 初始账号登录 | 成功；初始化密码每位部署者独立 |
| 后台统计 | 初始 0 个源、0 个频道、0 条线路 |
| `/live` 无 token | 403 |
| 后台复制的完整订阅 | 初始为空；添加自己的源后输出符合规则的条目 |
| 自动模式响应头 | `X-Viewer-Source: auto`；可查看运营商、地区及 IPv4/IPv6 标记 |

内网本地开发无法模拟真实运营商。单次请求只能确认本次连接的 IPv4 或 IPv6，不能据此推断双栈或 IPTV 专网权限。通过代理连接时，地区和运营商对应代理出口。

## 9. 更新与备份

更新自己的 Fork 并拉取代码后，执行：

```sh
pnpm install --frozen-lockfile
pnpm db:remote
pnpm check
pnpm test
pnpm run deploy
```

只应用新增的 schema 迁移，不再执行 `db:init:remote`。如果使用 `pnpm run deploy` 的 Cloudflare Git 自动构建，推送代码时会自动应用新增 migrations。

导出云端完整数据库：

```sh
pnpm exec wrangler d1 export DB --remote --output private/backup-YYYYMMDD.sql
```

把日期改成实际日期，备份文件私下保存。完整导出含表结构，恢复时应导入新空数据库；不要先重建同名表，也不要直接覆盖现有线上库。会话密钥也需私下保管；更换它后原登录会话失效，重新登录即可。

定时任务默认每天 UTC 19:17（北京时间次日 03:17）清理过期会话、登录限流记录和 30 天前访问日志。源更新在后台手动抓取。

## 常见问题

| 现象 | 检查方法 |
| --- | --- |
| 一键部署提示 `Your GitHub authorization has expired` | 这是 Cloudflare 与 GitHub 的账号连接问题，尚未进入项目构建。先按下方说明恢复 App 授权，再重试部署 |
| `database_id` 占位提示 | 填写自己的 D1 ID，保持 binding 为 `DB` |
| `no such table` | 确认在正确的账号和远程 D1 执行了 schema；本机库与云端库不同 |
| 登录失败 | 确认导入了自己的 `private/bootstrap.sql`；用生成文件中的密码；改过密码后使用新密码 |
| 初始化重复或 UNIQUE 报错 | 管理员 SQL 只导入一次；不要用重复初始化来改密码 |
| 后台 503 | 在 Worker 运行时设置至少 32 字符的 `SESSION_SECRET` 并部署 |
| 订阅 403 | 从后台复制包含 token 的完整地址，并检查白名单 |
| 订阅为空 | 初始不内置任何源；也检查内容规则、网络标签和实际访问条件 |
| 本地有效、线上无数据 | 确认使用 `--remote` 导入，且绑定正确数据库 |
| 网页不能播放 | 源站 CORS、HTTP 混合内容、认证或网络范围可能限制播放；可复制地址到外部播放器 |

### Cloudflare 的 GitHub 授权过期

仅重新登录 GitHub 或 Cloudflare 不一定恢复旧连接。若刷新部署页面后仍提示 `Your GitHub authorization has expired`，按 [Cloudflare 官方修复步骤](https://developers.cloudflare.com/pages/configuration/git-integration/github-integration/#reinstall-the-cloudflare-github-app)重新安装 GitHub App：

1. 打开 [GitHub 已安装应用](https://github.com/settings/installations)，找到 **Cloudflare Workers and Pages → Configure**。
2. 确认影响范围后卸载 App；这会暂停该安装下仓库的新构建，已有 Cloudflare 部署继续运行。若管理多个项目，先安排合适时间。
3. 回到一键部署页面，选择 **Git 账户 → 新建 GitHub 连接**，重新 **Install & Authorize**；按自己的需要选择仓库访问范围。
4. 刷新部署页面，重新选定 GitHub 账号，填入自己的项目名、D1 和会话密钥，再部署。

重新安装前不要反复点击部署，也不要因此修改管理员 SQL 或公开会话密钥。

视频代理默认关闭，减少流量与平台额度消耗。可显式启用 `ENABLE_PLAY_PROXY="true"`，但需自行确认源的使用授权及平台限制；代理只对已登录管理员开放，不改变订阅中原始播放地址。UDP、组播和局域网 IPTV 无法由公网 Worker 直接转发。

免费计划有 CPU、请求和 D1 额度；规模较大或频繁导入时以账号指标为准，不保证所有规模均永久免费。参阅官方 [Workers 限制](https://developers.cloudflare.com/workers/platform/limits/) 与 [D1 限制](https://developers.cloudflare.com/d1/platform/limits/)。
