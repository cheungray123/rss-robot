# RSS 博客订阅监控

零依赖的 RSS/Atom/JSON Feed 博客监控工具，自动抓取订阅的博客，发现新文章时通过飞书和邮件推送通知。

## 目录结构

```
rss-monitor/
├── check-feeds.js            # 主脚本
├── feeds.yml                 # 本地订阅源配置（备用）
├── data/
│   ├── seen-articles.json    # 已读文章记录（自动维护）
│   └── last-check-output.json # 最近一次检查结果（JSON格式）
└── README.md                 # 本文档
```

## 支持的 Feed 格式

| 格式 | 说明 | 示例 |
|------|------|------|
| RSS 2.0 | 最常见的博客格式 | WordPress 默认输出 |
| Atom | 常见于 GitHub/GitLab 等 | 阮一峰博客 |
| JSON Feed | 现代标准 | 少数博客使用 |
| 自定义 JSON API | 任意 JSON 接口 | 需配置 `path` 和 `mapping` |

脚本会自动识别格式，也可以手动指定 `format: json`。

## 订阅源配置

### 方式一：远程 JSON（推荐）

通过环境变量 `FEEDS_URL` 指向一个 JSON 文件地址，修改订阅源无需推送代码。

**简单数组格式：**

```json
[
  "https://www.ruanyifeng.com/blog/atom.xml",
  "https://www.zhangxinxu.com/wordpress/"
]
```

**完整对象格式（推荐）：**

```json
{
  "feeds": [
    {
      "url": "https://www.ruanyifeng.com/blog/atom.xml"
    },
    {
      "url": "https://api.example.com/posts",
      "format": "json",
      "path": "data.list",
      "feedTitle": "某某博客",
      "mapping": {
        "title": "title",
        "link": "url",
        "pubDate": "publishedAt",
        "author": "author.name"
      }
    }
  ]
}
```

远程 JSON 可以放在任何可公网访问的地方：
- GitHub Gist（`https://gist.githubusercontent.com/用户ID/gistID/raw`）
- 自己的服务器
- 云存储（COS/OSS/S3）的公开链接

### 方式二：本地 feeds.yml

当 `FEEDS_URL` 未设置或不可用时，回退使用本地配置。

**简单格式：**

```yaml
feeds:
  - https://www.ruanyifeng.com/blog/atom.xml
  - https://www.zhangxinxu.com/wordpress/
```

**完整格式（自定义 JSON API）：**

```yaml
feeds:
  - url: https://api.example.com/posts
    format: json
    path: data.list
    feedTitle: 某某博客
    mapping:
      title: title
      link: url
      pubDate: publishedAt
      author: author.name
```

### 自定义 JSON API 字段说明

| 字段 | 必填 | 说明 |
|------|------|------|
| `url` | 是 | API 地址 |
| `format` | 否 | 设为 `json` 强制使用 JSON 解析，默认自动识别 |
| `path` | 否 | 文章数组在 JSON 中的路径，如 `data.list` |
| `feedTitle` | 否 | 自定义博客名称 |
| `mapping` | 否 | 字段映射，将 API 字段名映射到标准字段 |

**mapping 可配置的映射字段：**

| 标准字段 | 说明 | 默认尝试的字段名 |
|----------|------|------------------|
| `title` | 文章标题 | `title` |
| `link` | 文章链接 | `link`, `url` |
| `pubDate` | 发布时间 | `pubDate`, `publishedAt`, `created_at`, `date` |
| `author` | 作者 | `author` |
| `feedTitle` | 来源博客名 | `feedTitle`, `source` |

支持嵌套字段，如 `author.name` 会读取 `item.author.name`。

## 通知方式

### 飞书通知

在飞书群中创建自定义机器人，获取 Webhook 地址。

**创建步骤：**

1. 打开飞书群 → 设置 → 群机器人 → 添加机器人 → 自定义机器人
2. 设置机器人名称（如"博客订阅"），复制 Webhook 地址
3. Webhook 地址格式：`https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx`

配置环境变量：

```
FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx
```

### 邮件通知

支持三种邮件发送方式：

#### 方式一：SMTP（国内邮箱，推荐）

支持 QQ 邮箱、163 邮箱、126 邮箱、阿里邮箱、新浪邮箱等。

| 环境变量 | 说明 |
|----------|------|
| `EMAIL_PROVIDER` | 设为 `smtp` |
| `SMTP_HOST` | SMTP 服务器地址 |
| `SMTP_PORT` | 端口，默认 `465`（SSL） |
| `SMTP_USER` | 邮箱账号 |
| `SMTP_PASS` | 授权码（非登录密码） |
| `EMAIL_FROM` | 发件人，如 `博客订阅 <xxx@qq.com>` |
| `EMAIL_TO` | 收件人，多个用逗号分隔 |

**国内邮箱 SMTP 配置参考：**

| 邮箱 | SMTP_HOST | 端口 | 获取授权码 |
|------|-----------|------|------------|
| QQ 邮箱 | `smtp.qq.com` | 465 | 设置 → 账户 → POP3/SMTP → 生成授权码 |
| 163 邮箱 | `smtp.163.com` | 465 | 设置 → POP3/SMTP/IMAP → 新增授权密码 |
| 126 邮箱 | `smtp.126.com` | 465 | 设置 → POP3/SMTP/IMAP → 新增授权密码 |
| 阿里邮箱 | `smtp.aliyun.com` | 465 | 设置 → 账户 → 开启 SMTP |
| 新浪邮箱 | `smtp.sina.com` | 465 | 设置 → 开启 SMTP |
| Outlook | `smtp.office365.com` | 587 | 登录密码（需 STARTTLS） |

**QQ 邮箱授权码获取：**

1. 登录 QQ 邮箱 → 设置 → 账户
2. 找到「POP3/IMAP/SMTP/Exchange/CardDAV/CalDAV服务」
3. 开启 POP3/SMTP 服务
4. 点击「生成授权码」，按提示发送短信后获取 16 位授权码

#### 方式二：Resend API

[Resend](https://resend.com) 是海外邮件服务，需要域名验证。

| 环境变量 | 说明 |
|----------|------|
| `EMAIL_PROVIDER` | 设为 `resend`（默认） |
| `EMAIL_API_KEY` | Resend API Key |
| `EMAIL_FROM` | 发件人，如 `博客订阅 <bot@yourdomain.com>` |
| `EMAIL_TO` | 收件人 |

#### 方式三：自定义 HTTP API

| 环境变量 | 说明 |
|----------|------|
| `EMAIL_PROVIDER` | 设为 `custom` |
| `EMAIL_API_URL` | 自定义邮件 API 地址 |
| `EMAIL_API_KEY` | API 密钥 |
| `EMAIL_FROM` | 发件人 |
| `EMAIL_TO` | 收件人 |

自定义 API 需要接受以下 JSON 格式的 POST 请求：

```json
{
  "from": "发件人",
  "to": ["收件人1", "收件人2"],
  "subject": "邮件主题",
  "text": "纯文本内容",
  "html": "HTML 内容"
}
```

## 环境变量汇总

| 环境变量 | 必填 | 默认值 | 说明 |
|----------|------|--------|------|
| `FEISHU_WEBHOOK_URL` | 否 | - | 飞书机器人 Webhook 地址 |
| `FEEDS_URL` | 否 | - | 远程 JSON 订阅源地址 |
| `EMAIL_PROVIDER` | 否 | `resend` | 邮件发送方式：`resend` / `smtp` / `custom` |
| `EMAIL_API_KEY` | 否 | - | Resend/自定义 API 密钥 |
| `EMAIL_FROM` | 否 | - | 发件人地址 |
| `EMAIL_TO` | 否 | - | 收件人地址（逗号分隔） |
| `EMAIL_API_URL` | 否 | - | 自定义邮件 API 地址 |
| `SMTP_HOST` | 否 | - | SMTP 服务器地址（provider=smtp 时） |
| `SMTP_PORT` | 否 | `465` | SMTP 端口 |
| `SMTP_USER` | 否 | - | SMTP 账号 |
| `SMTP_PASS` | 否 | - | SMTP 授权码 |

## 使用方式

### 本地运行

```bash
# 仅飞书通知
set FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxx && node rss-monitor/check-feeds.js

# 飞书 + QQ 邮箱
set FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxx && set EMAIL_PROVIDER=smtp && set SMTP_HOST=smtp.qq.com && set SMTP_PORT=465 && set SMTP_USER=xxx@qq.com && set SMTP_PASS=xxxxxxxxxxxxxxxx && set EMAIL_FROM=博客订阅 ^<xxx@qq.com^> && set EMAIL_TO=target@163.com && node rss-monitor/check-feeds.js

# 飞书 + Resend
set FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxx && set EMAIL_PROVIDER=resend && set EMAIL_API_KEY=re_xxxx && set EMAIL_FROM=博客订阅 ^<bot@yourdomain.com^> && set EMAIL_TO=target@163.com && node rss-monitor/check-feeds.js
```

> **注意**：Windows CMD 中 `<` 和 `>` 需要用 `^` 转义，即 `^<xxx@qq.com^>`。PowerShell 中使用 `$env:VAR="value"` 语法。

### GitHub Actions 定时运行

项目已内置 GitHub Actions 工作流（`.github/workflows/check-feeds.yml`），每小时自动执行一次。

**配置步骤：**

1. 在 GitHub 仓库 → Settings → Secrets and variables → Actions 中添加以下 Secrets：

| Secret 名称 | 值 |
|-------------|-----|
| `FEISHU_WEBHOOK_URL` | 飞书 Webhook 地址 |
| `FEEDS_URL` | 远程 JSON 订阅源地址 |
| `EMAIL_PROVIDER` | `smtp` / `resend` / `custom` |
| `EMAIL_API_KEY` | Resend/自定义 API 密钥 |
| `EMAIL_FROM` | 发件人 |
| `EMAIL_TO` | 收件人 |
| `EMAIL_API_URL` | 自定义 API 地址 |
| `SMTP_HOST` | SMTP 服务器 |
| `SMTP_PORT` | SMTP 端口 |
| `SMTP_USER` | SMTP 账号 |
| `SMTP_PASS` | SMTP 授权码 |

2. 也可在 Actions 页面点击「Run workflow」手动触发。

## 工作原理

1. **加载订阅源**：优先从 `FEEDS_URL` 远程加载，失败则回退本地 `feeds.yml`
2. **抓取 Feed**：逐个请求订阅源，自动识别 RSS/Atom/JSON Feed 格式
3. **自动发现**：如果填入的是网站首页地址而非 Feed 地址，脚本会：
   - 解析 HTML 中的 `<link rel="alternate">` 标签发现 Feed
   - 尝试常见路径（`/feed/`、`/rss/`、`/atom.xml` 等）
4. **去重判断**：与 `data/seen-articles.json` 中的已读记录对比
5. **推送通知**：仅推送 24 小时内发布的新文章
6. **更新记录**：保存已读记录到 `data/seen-articles.json`，自动清理超过 500 条的旧记录

**首次运行**：记录所有文章但不发送通知（避免首次批量推送）。后续运行只推送新增文章。

## 已读记录维护

`data/seen-articles.json` 自动维护，格式如下：

```json
{
  "lastCheck": "2026-04-28T07:53:55.286Z",
  "articles": {
    "文章链接1": "发布时间1",
    "文章链接2": "发布时间2"
  }
}
```

- 最多保留 500 条记录，超出后自动清理最旧的
- GitHub Actions 运行后会自动 commit 更新到仓库
- 如需重置，删除此文件即可（下次运行会重新初始化）

## 检查结果 JSON

每次检查后，结果会保存到 `data/last-check-output.json`，内容格式如下：

```json
{
  "timestamp": "2026-04-29T12:00:00.000Z",
  "totalNewArticles": 3,
  "articles24h": 2,
  "articlesOlder": 1,
  "articles": [
    {
      "title": "文章标题",
      "link": "https://example.com/article",
      "pubDate": "2026-04-29T08:00:00.000Z",
      "author": "作者名",
      "feedTitle": "博客名称"
    }
  ]
}
```

### 字段说明

| 字段 | 说明 |
|------|------|
| `timestamp` | 检查时间（ISO 8601 格式） |
| `totalNewArticles` | 本次发现的新文章总数 |
| `articles24h` | 24小时内发布的新文章数量（会发送通知） |
| `articlesOlder` | 超过24小时的新文章数量（不发送通知） |
| `articles` | 新文章详情数组 |

### 外链调用

通过 GitHub Raw URL 直接获取最新结果：

```
https://raw.githubusercontent.com/cheungray123/rss-robot/master/data/last-check-output.json
```

**要求：仓库必须为公开(public)属性。**

> 注意：GitHub Raw URL 有 60次/小时 的访问频率限制，高频调用可能受限。
