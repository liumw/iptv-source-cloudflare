# 从 Fork 到自己的 Cloudflare

本文按新账号、新空数据库说明。全部资源建立在**你自己的** Cloudflare 账号下。本仓库不含维护者账号 ID、数据库 ID、管理员凭据或任何直播源。

## 一键部署到 Cloudflare

[![一键部署到 Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fliumw%2Fiptv-source-cloudflare)

这是 Cloudflare 官方部署向导入口：创建自己的仓库副本、Worker、D1，并自动完成建表、管理员初始化和发布。**无需安装本机工具、执行命令或导入 SQL。** 初始频道库为空，不内置任何源。

1. 点击上方按钮，登录自己的 Cloudflare，连接 GitHub，确认仓库副本名称、Worker 名称和 D1 名称。保持 D1 绑定名称为 **DB**。
2. 无需填写 `SESSION_SECRET`，向导不再显示此输入项。构建命令使用 `pnpm build`，部署命令使用 **`pnpm run deploy`**。Node.js 使用 24、pnpm 使用 11（需要时设置构建变量 `NODE_VERSION=24`、`PNPM_VERSION=11.25.0`）。确认后部署。
3. 向导创建 D1 并更新新仓库配置；构建脚本自动应用 migrations、初始化空库，再检查 Worker 的 Secret 列表。如果没有 `SESSION_SECRET`，自动生成 48 字节随机密钥，随代码上传为运行时 Secret；已有密钥保持不变。任一步失败都会停止发布。
4. 部署成功后打开 `https://你的 Worker 域名/_admin`，用户名 **`admin`**、密码 **`admin123`**。
5. 首次登录进入修改初始密码页面。填写当前密码 `admin123` 和至少 12 位的新密码，保存后使用新密码重新登录。修改前不能进入其他后台页面或调用管理 API。
6. 进入空频道库后，手动添加频道或导入自己的播放列表。

自动初始化只写入一个管理员、基础设置、一个空内容视图，以及一个带随机 token 的自动识别订阅。每个数据库独立生成密码盐和订阅 token。后续构建仍检查初始化条件，**只要已有任意管理员，全部初始化语句均跳过**，不重置密码、不重新生成订阅、不覆盖设置，也不会恢复用户删除的内容视图或订阅。

### 使用自己的 Fork

按钮的链接是静态地址，Fork 后不会自动改成你的用户名。请将部署链接中的仓库地址替换为自己的 Fork：

```text
https://deploy.workers.cloudflare.com/?url=https://github.com/YOUR-GITHUB-USERNAME/iptv-source-cloudflare
```

官方向导会从指定仓库创建副本，若名称已存在，选择另一个名称。要让 Fork 首页的按钮使用自己的代码，请编辑 README 按钮和文字链接中的 `url` 参数。要直接绑定已有 Fork 而不创建副本，使用下方第 6B 节；同样会自动初始化无管理员的数据库。

`SESSION_SECRET` 自动保存在 Cloudflare Secret 中，不写入 D1、仓库或网页资源。临时文件仅在当前部署中使用，成功或失败后都会清理。查询现有 Secret 失败时会停止发布，不会把权限、网络错误当成没有密钥。已有部署的密钥不会自动更换，现有登录保持有效。

GitHub 和 Cloudflare 登录、App 授权由部署者在官方页面完成。本机 `pnpm run deploy` 仍使用有效的 `.dev.vars`；其手动自定义账号流程见第 1–6A 节。可选配置示例在 `docs/examples/local.dev.vars.example`，不放在仓库根目录，避免官方向导要求手动输入。云端通过官方注入的 `WORKERS_CI=1` 识别 Workers Builds 环境。

官方参考：[Deploy to Cloudflare 按钮与资源、密钥配置](https://developers.cloudflare.com/workers/platform/deploy-buttons/)、[Workers Builds 环境变量](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#default-variables)。

### 端到端实测（2026-10-21）

此前已通过官方按钮创建仓库副本、独立 Worker 和 D1，并完成公网登录及 Git 自动重部署。本次自动账号版本在该独立测试 Worker 上绑定**另一份全新空 D1**，通过 Git 推送触发真实 Workers Builds；没有手动执行管理员导入 SQL。测试在同一 Cloudflare 账号内完成，不是第二个账号或 GitHub 原生 Fork 的跨账号实测。

| 实测项目 | 结果 |
| --- | --- |
| Git 云端构建 | Node.js 24、pnpm 11，锁文件安装成功；运行 pnpm run deploy |
| 自动建表 | 新 D1 自动应用 0001_schema.sql；迁移记录 1 条 |
| 自动账号 | admin / admin123 登录成功，浏览器自动进入修改初始密码页面 |
| 初始数据 | 1 个管理员、1 个空内容视图、1 个随机 token 的自动识别订阅；源、频道、线路和固定网络环境均为 0 |
| 首次改密限制 | 其他后台页面和写操作重定向改密；管理 API 返回 403 |
| 修改密码 | 设置独立新密码成功；旧密码及旧会话失效，新密码登录后显示空后台 |
| 订阅 | 无 token 返回 403，有效 token 返回空 M3U 和自动识别响应头 |
| 再次 Git 自动部署 | 构建成功；新密码、原订阅 token、既有会话及各表计数保留，未生成重复账号或配置 |
| 本地回归 | 21 项测试全部通过，覆盖自定义账号保留、失败停止发布、初始化文件清理、频道管理与网络筛选 |

当前版本已增加会话密钥自动生成和 Cloudflare Secret 上传，不再需要手动填写。部署者只需在官方页面完成登录、GitHub App 授权，然后使用默认账号登录并修改密码。若遇到 GitHub 授权过期，按文末说明重新授权。

## 1. Fork 项目并安装工具

以下第 1–6A 节是可选的命令行部署方式，可预先生成独立随机账号密码。一键部署用户直接按上面的网页流程操作，不需要执行这些命令。

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

也可以在手动创建 D1 后，通过 Cloudflare 的 Git 集成发布；可以跳过第 4–5 节，云端构建会自动建表并初始化 admin / admin123。如果已经手动导入了自定义管理员，自动初始化会跳过。先把第 3 步的数据库配置提交到**自己的 Fork**；不要提交 `private/` 或 `.dev.vars`。

1. 在 Cloudflare 的 **Workers & Pages → Create application** 中选择导入 Git 仓库的入口，连接 GitHub 并选择自己的 Fork。
2. 使用与 `wrangler.jsonc` 中 `name` 相同的 Worker 名称，生产分支选 `main`。
3. 根目录使用仓库根目录 `/`。构建命令填写 `pnpm build`，部署命令填写 `pnpm run deploy`，自动应用 D1 迁移、初始化无管理员的数据库，然后发布。
4. 在构建配置中设置 `NODE_VERSION=24`、`PNPM_VERSION=11.25.0`；依赖安装使用 `pnpm install --frozen-lockfile`（若界面可指定安装命令）。
5. 云端部署自动生成缺失的 `SESSION_SECRET`，无需手动添加。已有 Secret 会原样保留；若之前手动初始化账号但未上传本机 `.dev.vars`，云端仍可生成独立会话密钥，不影响账号密码。
6. 在 Worker 的 Bindings 确认存在名为 `DB` 的 D1 绑定，指向自己创建的数据库。代码中的 Wrangler 配置应已经建立该绑定；若手动补充，也使用这个名称。

这里选择的是 **Workers**，不是只托管静态文件的 Pages。`.generated/public` 由构建自动生成，不需要提交它，也不要把它单独作为整个应用部署。

自动生成的 `SESSION_SECRET` 位于 Worker 的**运行时** Variables and Secrets，类型为 Secret。不要把同名值填写到 Build 变量中。也可以按需手动配置至少 32 字符的自定义运行时 Secret，后续云端部署会检测并保留它。

Cloudflare Git 构建使用平台运行时 Secret，不要求远端构建环境存在本机 `.dev.vars`。后续代码推送会先应用新增 migrations，再发布，现有运行时 Secret 会保留。默认初始化包含空库检查，不会重置已有管理员或其他配置。

官方参考：[Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)、[控制台配置运行时 Secret](https://developers.cloudflare.com/workers/configuration/secrets/#via-the-dashboard)。

## 7. 首次登录并添加自己的源

1. 打开 `https://你的域名/_admin`。
2. 一键部署或直接 Git 自动构建：使用 `admin / admin123`；手动初始化：使用 `private/bootstrap.credentials.txt` 中的账号密码。
3. 首次登录必须修改初始密码（新密码至少 12 位），保存后重新登录。以后可在系统设置再次修改密码。
4. 在频道库点击 **手动添加频道**，填写名称、台号、分组、地区、台标和可选播放地址，无需先创建源；播放地址留空时，可稍后在频道详情添加线路。也可以打开源管理，通过 URL、上传或粘贴导入有权使用的播放列表。
5. 在待确认和频道库中整理频道，检查线路的网络、运营商和地区标签。
6. 从订阅管理复制完整订阅地址到播放器。默认 `/live` 需要随机 token；直接访问 `/live` 返回 403 是正常的访问保护。

默认订阅网络环境为自动识别，参数覆盖关闭。固定环境和网段绑定可在后台按需添加。无源时带正确 token 的订阅返回只有 `#EXTM3U` 的空列表，这是预期初始状态。

频道库的单个删除、批量删除以及详情页的“永久删除频道”都会物理删除频道及其线路、别名、内容视图关联，并刷新订阅缓存。需要暂停时可在频道信息取消“启用”。删除不会修改原始播放列表，源中仍存在的频道在后续重新抓取时可能再次导入。

## 8. 验收

| 检查 | 预期 |
| --- | --- |
| `/health` | HTTP 200，数据库类型为 D1 |
| `/_admin` | 跳转登录或显示后台 |
| 初始账号登录 | 自动初始化为 admin / admin123，首次登录强制改密；手动初始化使用独立密码 |
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

把日期改成实际日期，备份文件私下保存。完整导出含表结构，恢复时应导入新空数据库；不要先重建同名表，也不要直接覆盖现有线上库。本机手动生成的 `.dev.vars` 需私下保存。自动生成的密钥由 Cloudflare Secret 保管，不在 D1 导出中；保留原 Worker 时继续保留该 Secret，重建 Worker 时可自动生成新密钥，旧登录会话会失效，账号密码保持不变。

定时任务默认每天 UTC 19:17（北京时间次日 03:17）清理过期会话、登录限流记录和 30 天前访问日志。源更新在后台手动抓取。

## 常见问题

| 现象 | 检查方法 |
| --- | --- |
| 一键部署提示 `Your GitHub authorization has expired` | 这是 Cloudflare 与 GitHub 的账号连接问题，尚未进入项目构建。先按下方说明恢复 App 授权，再重试部署 |
| `database_id` 占位提示 | 填写自己的 D1 ID，保持 binding 为 `DB` |
| `no such table` | 确认在正确的账号和远程 D1 执行了 schema；本机库与云端库不同 |
| 登录失败 | 一键部署首次使用 admin / admin123；手动初始化使用生成文件中的密码；改过密码后必须使用新密码，重新部署不会重置 |
| 初始化重复或 UNIQUE 报错 | 管理员 SQL 只导入一次；不要用重复初始化来改密码 |
| 后台 503 | 检查部署是否完整成功，以及运行时是否存在自动生成的 `SESSION_SECRET`；已有无效的自定义 Secret 需修正为至少 32 字符 |
| 无法检查 Cloudflare 会话密钥 | 检查 Workers Builds 令牌的 Worker 权限或网络；此时会停止发布并保留旧密钥，不要反复重置密钥 |
| 订阅 403 | 从后台复制包含 token 的完整地址，并检查白名单 |
| 订阅为空 | 初始不内置任何源；也检查内容规则、网络标签和实际访问条件 |
| 本地有效、线上无数据 | 确认使用 `--remote` 导入，且绑定正确数据库 |
| 网页不能播放 | 源站 CORS、HTTP 混合内容、认证或网络范围可能限制播放；可复制地址到外部播放器 |

### Cloudflare 的 GitHub 授权过期

仅重新登录 GitHub 或 Cloudflare 不一定恢复旧连接。若刷新部署页面后仍提示 `Your GitHub authorization has expired`，按 [Cloudflare 官方修复步骤](https://developers.cloudflare.com/pages/configuration/git-integration/github-integration/#reinstall-the-cloudflare-github-app)重新安装 GitHub App：

1. 打开 [GitHub 已安装应用](https://github.com/settings/installations)，找到 **Cloudflare Workers and Pages → Configure**。
2. 确认影响范围后卸载 App；这会暂停该安装下仓库的新构建，已有 Cloudflare 部署继续运行。若管理多个项目，先安排合适时间。
3. 回到一键部署页面，选择 **Git 账户 → 新建 GitHub 连接**，重新 **Install & Authorize**；按自己的需要选择仓库访问范围。
4. 刷新部署页面，重新选定 GitHub 账号，确认自己的项目名和 D1，再部署；会话密钥自动生成。

重新安装前不要反复点击部署，也不要因此修改管理员 SQL 或公开会话密钥。

视频代理默认关闭，减少流量与平台额度消耗。可显式启用 `ENABLE_PLAY_PROXY="true"`，但需自行确认源的使用授权及平台限制；代理只对已登录管理员开放，不改变订阅中原始播放地址。UDP、组播和局域网 IPTV 无法由公网 Worker 直接转发。

免费计划有 CPU、请求和 D1 额度；规模较大或频繁导入时以账号指标为准，不保证所有规模均永久免费。参阅官方 [Workers 限制](https://developers.cloudflare.com/workers/platform/limits/) 与 [D1 限制](https://developers.cloudflare.com/d1/platform/limits/)。
