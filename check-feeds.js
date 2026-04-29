import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createConnection as netConnect } from 'net';
import { connect as tlsConnect } from 'tls';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── 配置 ───
const FEEDS_PATH = join(__dirname, 'feeds.yml');
const DATA_DIR = join(__dirname, 'data');
const SEEN_PATH = join(DATA_DIR, 'seen-articles.json');
const OUTPUT_PATH = join(DATA_DIR, 'last-check-output.json');
const MAX_SEEN = 500;
const FEISHU_WEBHOOK = process.env.FEISHU_WEBHOOK_URL;
const FEEDS_URL = process.env.FEEDS_URL; // 远程 JSON 订阅源地址
const REQUEST_TIMEOUT = 15000;

// ─── 邮件配置 ───
const EMAIL_PROVIDER = process.env.EMAIL_PROVIDER || 'resend'; // resend | custom | smtp
const EMAIL_API_KEY = process.env.EMAIL_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM; // 发件人，如 "博客订阅 <bot@easte.cc>"
const EMAIL_TO = process.env.EMAIL_TO; // 收件人，多个用逗号分隔
const EMAIL_API_URL = process.env.EMAIL_API_URL; // 自定义邮件 API 地址（provider=custom 时使用）
// SMTP 配置（provider=smtp 时使用，支持 QQ/163/126/阿里等国内邮箱）
const SMTP_HOST = process.env.SMTP_HOST; // 如 smtp.qq.com
const SMTP_PORT = parseInt(process.env.SMTP_PORT) || 465; // SSL 默认 465，STARTTLS 用 587
const SMTP_USER = process.env.SMTP_USER; // 邮箱账号
const SMTP_PASS = process.env.SMTP_PASS; // 授权码（非登录密码）

// 确保 data 目录存在
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// ─── 解析 feeds.yml ───
// 支持两种格式：
//   简单: - https://example.com
//   完整: - url: https://api.example.com/posts
//          format: json
//          path: data.list
//          mapping: { title, link, pubDate, author }
function parseFeedsYml(content) {
	const lines = content.split('\n');
	const feeds = [];
	let current = null;

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;

		// 简单格式: - url
		const simpleMatch = trimmed.match(/^-\s*(https?:\/\/.+)/);
		if (simpleMatch && !current) {
			feeds.push({ url: simpleMatch[1] });
			continue;
		}

		// 完整格式开始: - url: xxx 或 - format: xxx
		if (trimmed.startsWith('- ')) {
			if (current) feeds.push(current);
			current = {};
			const kvMatch = trimmed.match(/^-\s*(\w+):\s*(.+)/);
			if (kvMatch) current[kvMatch[1]] = kvMatch[2].trim();
			continue;
		}

		// 完整格式续行: key: value
		const kvMatch = trimmed.match(/^(\w+):\s*(.+)/);
		if (kvMatch && current) {
			const [, key, value] = kvMatch;
			if (key === 'mapping') {
				// mapping 是对象，下一行开始
				current._parsingMapping = true;
				current.mapping = {};
			} else {
				current[key] = value.trim();
			}
			continue;
		}

		// mapping 子属性: title: xxx
		const mappingMatch = trimmed.match(/^(\w+):\s*(.+)/);
		if (mappingMatch && current?._parsingMapping) {
			current.mapping[mappingMatch[1]] = mappingMatch[2].trim();
		}
	}
	if (current) {
		delete current._parsingMapping;
		feeds.push(current);
	}

	return feeds;
}

// ─── HTTP 请求 ───
async function fetchUrl(url, timeout = REQUEST_TIMEOUT) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeout);
	try {
		const res = await fetch(url, {
			signal: controller.signal,
			headers: {
				'User-Agent': 'Mozilla/5.0 (compatible; RSSBot/1.0)',
				'Accept': 'text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8'
			},
			redirect: 'follow'
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const contentType = (res.headers.get('content-type') || '').toLowerCase();
		const text = await res.text();
		return { text, contentType };
	} finally {
		clearTimeout(timer);
	}
}

// ─── 从 HTML 页面自动发现 Feed ───
function discoverFeedUrl(html, baseUrl) {
	const patterns = [
		// RSS
		/<link[^>]+type=["']application\/rss\+xml["'][^>]+href=["']([^"']+)["']/i,
		/<link[^>]+href=["']([^"']+)["'][^>]+type=["']application\/rss\+xml["']/i,
		// Atom
		/<link[^>]+type=["']application\/atom\+xml["'][^>]+href=["']([^"']+)["']/i,
		/<link[^>]+href=["']([^"']+)["'][^>]+type=["']application\/atom\+xml["']/i,
		// JSON Feed
		/<link[^>]+type=["']application\/feed\+json["'][^>]+href=["']([^"']+)["']/i,
		/<link[^>]+href=["']([^"']+)["'][^>]+type=["']application\/feed\+json["']/i,
		/<link[^>]+type=["']application\/json["'][^>]+title=["'][^"']*feed[^"']*["'][^>]+href=["']([^"']+)["']/i
	];
	for (const pattern of patterns) {
		const match = html.match(pattern);
		if (match) {
			let href = match[1];
			if (href.startsWith('/')) {
				const urlObj = new URL(baseUrl);
				href = `${urlObj.protocol}//${urlObj.host}${href}`;
			} else if (!href.startsWith('http')) {
				const urlObj = new URL(baseUrl);
				href = `${urlObj.protocol}//${urlObj.host}/${href}`;
			}
			return href;
		}
	}
	return null;
}

// ─── 常见 Feed 路径尝试 ───
async function tryCommonFeedPaths(baseUrl) {
	const urlObj = new URL(baseUrl);
	// 包含 JSON Feed 常见路径
	const paths = ['/feed.json', '/feed/', '/rss/', '/feed.xml', '/rss.xml', '/atom.xml', '/index.xml', '/json/feed', '/wp-json/wp/v2/posts'];
	for (const path of paths) {
		const candidate = `${urlObj.protocol}//${urlObj.host}${path}`;
		try {
			const res = await fetch(candidate, {
				method: 'HEAD',
				headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RSSBot/1.0)' }
			});
			if (res.ok) {
				const ct = (res.headers.get('content-type') || '').toLowerCase();
				if (ct.includes('xml') || ct.includes('rss') || ct.includes('atom') || ct.includes('json')) {
					return candidate;
				}
			}
		} catch {
			// 忽略，继续尝试
		}
	}
	return null;
}

// ─── 解析 RSS/Atom XML ───
function parseFeedXml(xml, feedUrl) {
	const articles = [];
	let feedTitle = '';

	const titleMatch = xml.match(/<title[^>]*>([\s\S]*?)<\/title>/);
	if (titleMatch) feedTitle = decodeXml(titleMatch[1]).trim();

	const itemRegex = /<item[\s>]?>([\s\S]*?)<\/item>/gi;
	const entryRegex = /<entry[\s>]?>([\s\S]*?)<\/entry>/gi;

	const parseItem = (itemXml) => {
		const title = extractTag(itemXml, 'title');
		let link = '';

		const rssLink = extractTag(itemXml, 'link');
		if (rssLink) link = rssLink;

		const atomLinkMatch = itemXml.match(/<link[^>]+href=["']([^"']+)["'][^>]*>/i);
		if (atomLinkMatch && !link) link = atomLinkMatch[1];
		if (atomLinkMatch && atomLinkMatch[1]) link = atomLinkMatch[1];

		const altLinkMatch = itemXml.match(/<link[^>]+rel=["']alternate["'][^>]+href=["']([^"']+)["']/i);
		if (altLinkMatch) link = altLinkMatch[1];

		const pubDate = extractTag(itemXml, 'pubDate') || extractTag(itemXml, 'published') || extractTag(itemXml, 'updated') || extractTag(itemXml, 'dc:date');
		const author = extractTag(itemXml, 'dc:creator') || extractTag(itemXml, 'author') || '';
		const authorName = author.replace(/<name>([\s\S]*?)<\/name>/gi, '$1').trim();

		if (title && link) {
			articles.push({
				title: decodeXml(title).trim(),
				link: link.trim(),
				pubDate: pubDate ? new Date(pubDate.trim()).toISOString() : new Date().toISOString(),
				author: decodeXml(authorName).trim(),
				feedTitle: feedTitle || feedUrl
			});
		}
	};

	let match;
	while ((match = itemRegex.exec(xml)) !== null) parseItem(match[1]);
	while ((match = entryRegex.exec(xml)) !== null) parseItem(match[1]);

	return { feedTitle, articles };
}

function extractTag(xml, tag) {
	const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
	const match = xml.match(regex);
	return match ? match[1] : '';
}

function decodeXml(str) {
	return str
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

// ─── 解析 JSON Feed (https://jsonfeed.org/version/1.1) ───
function parseJsonFeed(json, feedUrl) {
	const articles = [];
	const feedTitle = json.title || feedUrl;
	const items = json.items || [];

	for (const item of items) {
		const title = item.title || '';
		const link = item.url || item.id || '';
		const pubDate = item.date_published || item.date_modified || new Date().toISOString();
		const author = Array.isArray(item.authors) ? item.authors.map((a) => a.name).join(', ') : (item.author?.name || item.author || '');

		if (title && link) {
			articles.push({
				title: title.trim(),
				link: link.trim(),
				pubDate: new Date(pubDate).toISOString(),
				author: typeof author === 'string' ? author.trim() : '',
				feedTitle
			});
		}
	}

	return { feedTitle, articles };
}

// ─── 解析自定义 JSON API ───
function parseCustomJson(json, config) {
	const articles = [];
	const mapping = config.mapping || {};
	const path = config.path || '';

	// 按 path 深入获取文章数组
	let data = json;
	if (path) {
		for (const key of path.split('.')) {
			if (data && typeof data === 'object') {
				data = data[key];
			}
		}
	}

	// 确保是数组
	const items = Array.isArray(data) ? data : [];

	// 从 mapping 获取字段名，默认值兼容常见结构
	const titleKey = mapping.title || 'title';
	const linkKey = mapping.link || 'link';
	const pubDateKey = mapping.pubDate || 'pubDate';
	const authorKey = mapping.author || 'author';
	const feedTitleKey = mapping.feedTitle || 'feedTitle';

	for (const item of items) {
		const title = getNestedValue(item, titleKey) || '';
		const link = getNestedValue(item, linkKey) || getNestedValue(item, 'url') || '';
		const pubDate = getNestedValue(item, pubDateKey) || getNestedValue(item, 'publishedAt') || getNestedValue(item, 'created_at') || new Date().toISOString();
		const author = getNestedValue(item, authorKey) || '';
		const feedTitle = getNestedValue(item, feedTitleKey) || config.feedTitle || config.url || '';

		if (title && link) {
			articles.push({
				title: String(title).trim(),
				link: String(link).trim(),
				pubDate: new Date(pubDate).toISOString(),
				author: String(typeof author === 'object' ? '' : author).trim(),
				feedTitle
			});
		}
	}

	return { feedTitle: config.feedTitle || config.url || '', articles };
}

// 获取嵌套属性值，如 "author.name" → item.author.name
function getNestedValue(obj, path) {
	if (!obj || !path) return undefined;
	return path.split('.').reduce((o, key) => o?.[key], obj);
}

// ─── 判断是否为 JSON ───
function isJsonResponse(text, contentType) {
	if (contentType?.includes('json')) return true;
	try {
		const parsed = JSON.parse(text);
		return typeof parsed === 'object' && parsed !== null;
	} catch {
		return false;
	}
}

// ─── 获取 Feed ───
async function resolveFeed(feedConfig) {
	const url = typeof feedConfig === 'string' ? feedConfig : feedConfig.url;
	const format = feedConfig.format || 'auto';

	// 第一步：抓取内容
	let response;
	try {
		response = await fetchUrl(url);
	} catch (err) {
		// 请求失败，尝试当作网页发现 Feed
		try {
			const htmlResp = await fetchUrl(url);
			const feedUrl = discoverFeedUrl(htmlResp.text, url);
			if (feedUrl) {
				console.log(`  发现 Feed: ${feedUrl}`);
				response = await fetchUrl(feedUrl);
			}
		} catch {
			// 尝试常见路径
			const guessedUrl = await tryCommonFeedPaths(url);
			if (guessedUrl) {
				console.log(`  猜测 Feed: ${guessedUrl}`);
				response = await fetchUrl(guessedUrl);
			}
		}
		if (!response) return null;
	}

	const { text, contentType } = response;
	const isJson = isJsonResponse(text, contentType);

	// 第二步：按格式解析
	if (format === 'json' || (format === 'auto' && isJson)) {
		try {
			const json = JSON.parse(text);

			// 标准 JSON Feed
			if (json.version?.includes('jsonfeed.org') || (json.items && Array.isArray(json.items) && !feedConfig.path)) {
				console.log(`  格式: JSON Feed`);
				return parseJsonFeed(json, url);
			}

			// 自定义 JSON API
			console.log(`  格式: 自定义 JSON${feedConfig.path ? ` (path: ${feedConfig.path})` : ''}`);
			return parseCustomJson(json, feedConfig);
		} catch (err) {
			console.error(`  ❌ JSON 解析失败: ${err.message}`);
			return null;
		}
	}

	// XML (RSS/Atom)
	if (text.includes('<rss') || text.includes('<feed') || text.includes('<channel') || text.includes('<entry')) {
		return parseFeedXml(text, url);
	}

	// 自动判断失败，尝试 HTML 发现
	const feedUrl = discoverFeedUrl(text, url);
	if (feedUrl) {
		console.log(`  发现 Feed: ${feedUrl}`);
		const feedResp = await fetchUrl(feedUrl);
		if (feedResp) {
			if (isJsonResponse(feedResp.text, feedResp.contentType)) {
				try {
					const json = JSON.parse(feedResp.text);
					if (json.version?.includes('jsonfeed.org') || json.items) {
						console.log(`  格式: JSON Feed`);
						return parseJsonFeed(json, feedUrl);
					}
					return parseCustomJson(json, { url: feedUrl });
				} catch {
					return null;
				}
			}
			return parseFeedXml(feedResp.text, feedUrl);
		}
	}

	// 尝试常见路径
	const guessedUrl = await tryCommonFeedPaths(url);
	if (guessedUrl) {
		console.log(`  猜测 Feed: ${guessedUrl}`);
		const guessResp = await fetchUrl(guessedUrl);
		if (guessResp) {
			if (isJsonResponse(guessResp.text, guessResp.contentType)) {
				try {
					const json = JSON.parse(guessResp.text);
					if (json.version?.includes('jsonfeed.org') || json.items) {
						console.log(`  格式: JSON Feed`);
						return parseJsonFeed(json, guessedUrl);
					}
					return parseCustomJson(json, { url: guessedUrl });
				} catch {
					return null;
				}
			}
			return parseFeedXml(guessResp.text, guessedUrl);
		}
	}

	return null;
}

// ─── 发送飞书通知 ───
async function sendFeishuNotification(newArticles) {
	if (!FEISHU_WEBHOOK) {
		console.log('⚠️ 未配置 FEISHU_WEBHOOK_URL，跳过飞书通知');
		return;
	}

	// 按博客分组
	const grouped = {};
	for (const article of newArticles) {
		const key = article.feedTitle || '未知博客';
		if (!grouped[key]) grouped[key] = [];
		grouped[key].push(article);
	}

	// 构建消息卡片
	const elements = [];

	for (const [feedName, articles] of Object.entries(grouped)) {
		elements.push({
			tag: 'markdown',
			content: `**📰 ${feedName}**`
		});

		const articleLines = articles.map((a) => {
			const time = formatRelativeTime(a.pubDate);
			return `- [${a.title}](${a.link})  <font color="grey">${time}</font>`;
		});
		elements.push({
			tag: 'markdown',
			content: articleLines.join('\n')
		});
	}

	const card = {
		msg_type: 'interactive',
		card: {
			header: {
				title: {
					tag: 'plain_text',
					content: `🔔 博客更新 · ${newArticles.length} 篇新文章`
				},
				template: 'blue'
			},
			elements
		}
	};

	try {
		const res = await fetch(FEISHU_WEBHOOK, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(card)
		});
		const result = await res.json();
		if (result.code === 0) {
			console.log(`✅ 飞书通知发送成功 (${newArticles.length} 篇新文章)`);
		} else {
			console.error('❌ 飞书通知发送失败:', result);
		}
	} catch (err) {
		console.error('❌ 飞书通知发送异常:', err.message);
	}
}

// ─── SMTP 客户端（零依赖，支持国内邮箱） ───
// 常见国内邮箱 SMTP 配置：
//   QQ邮箱:    smtp.qq.com:465(SSL) / 587(STARTTLS)  授权码
//   163邮箱:   smtp.163.com:465(SSL)                  授权码
//   126邮箱:   smtp.126.com:465(SSL)                  授权码
//   阿里邮箱:  smtp.aliyun.com:465(SSL)               授权码
//   新浪邮箱:  smtp.sina.com:465(SSL)                 登录密码
//   Outlook:   smtp.office365.com:587(STARTTLS)       登录密码

function smtpDialog(socket, expectedCode) {
	return new Promise((resolve, reject) => {
		let buffer = '';
		const onData = (chunk) => {
			buffer += chunk.toString();
			const lines = buffer.split('\r\n');
			for (const line of lines) {
				if (/^\d{3}\s/.test(line)) {
					socket.removeListener('data', onData);
					const code = parseInt(line.substring(0, 3));
					if (expectedCode && !expectedCode.includes(code)) {
						reject(new Error(`SMTP 错误: ${buffer.trim()}`));
					} else {
						resolve({ code, text: buffer.trim() });
					}
					return;
				}
			}
		};
		socket.on('data', onData);
		socket.once('error', reject);
	});
}

function smtpSend(socket, command) {
	return new Promise((resolve, reject) => {
		socket.write(command + '\r\n', 'utf-8', (err) => {
			if (err) reject(err);
			else resolve();
		});
	});
}

async function sendSmtpEmail(emailData) {
	const { from, to, subject, text, html } = emailData;
	const useSSL = SMTP_PORT === 465;

	// 1. 建立连接
	let socket;
	const connectPromise = new Promise((resolve, reject) => {
		if (useSSL) {
			socket = tlsConnect({
				host: SMTP_HOST,
				port: SMTP_PORT,
				rejectUnauthorized: false
			}, resolve);
		} else {
			socket = netConnect(SMTP_PORT, SMTP_HOST, resolve);
		}
		socket.once('error', reject);
	});

	await connectPromise;
	console.log(`  📤 SMTP 已连接 ${SMTP_HOST}:${SMTP_PORT} (${useSSL ? 'SSL' : 'STARTTLS'})`);

	try {
		// 2. 等待服务器欢迎信息
		await smtpDialog(socket, [220]);

		// 3. EHLO
		await smtpSend(socket, `EHLO rss-bot`);
		await smtpDialog(socket, [250]);

		// 4. STARTTLS（非 SSL 端口时尝试升级）
		if (!useSSL && SMTP_PORT === 587) {
			await smtpSend(socket, 'STARTTLS');
			await smtpDialog(socket, [220]);
			const tlsSocket = tlsConnect({
				socket,
				rejectUnauthorized: false
			});
			await new Promise((resolve, reject) => {
				tlsSocket.once('secureConnect', resolve);
				tlsSocket.once('error', reject);
			});
			socket = tlsSocket;
			await smtpSend(socket, `EHLO rss-bot`);
			await smtpDialog(socket, [250]);
		}

		// 5. AUTH LOGIN
		await smtpSend(socket, 'AUTH LOGIN');
		await smtpDialog(socket, [334]);

		// 6. 用户名（Base64）
		await smtpSend(socket, Buffer.from(SMTP_USER).toString('base64'));
		await smtpDialog(socket, [334]);

		// 7. 密码/授权码（Base64）
		await smtpSend(socket, Buffer.from(SMTP_PASS).toString('base64'));
		await smtpDialog(socket, [235]);
		console.log('  📤 SMTP 认证成功');

		// 8. MAIL FROM
		const fromAddr = from.includes('<') ? from.match(/<(.+)>/)[1] : from;
		await smtpSend(socket, `MAIL FROM:<${fromAddr}>`);
		await smtpDialog(socket, [250]);

		// 9. RCPT TO
		for (const recipient of to) {
			const toAddr = recipient.includes('<') ? recipient.match(/<(.+)>/)[1] : recipient;
			await smtpSend(socket, `RCPT TO:<${toAddr}>`);
			await smtpDialog(socket, [250, 251]);
		}

		// 10. DATA
		await smtpSend(socket, 'DATA');
		await smtpDialog(socket, [354]);

		// 11. 构建邮件内容（MIME multipart/alternative）
		const boundary = '----=_Part_' + Date.now();
		const mailLines = [];
		mailLines.push(`From: ${from}`);
		mailLines.push(`To: ${to.join(', ')}`);
		mailLines.push(`Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`);
		mailLines.push(`MIME-Version: 1.0`);
		mailLines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
		mailLines.push(`Date: ${new Date().toUTCString()}`);
		mailLines.push('');

		// 纯文本部分
		mailLines.push(`--${boundary}`);
		mailLines.push('Content-Type: text/plain; charset=UTF-8');
		mailLines.push('Content-Transfer-Encoding: base64');
		mailLines.push('');
		mailLines.push(Buffer.from(text).toString('base64'));

		// HTML 部分
		mailLines.push(`--${boundary}`);
		mailLines.push('Content-Type: text/html; charset=UTF-8');
		mailLines.push('Content-Transfer-Encoding: base64');
		mailLines.push('');
		mailLines.push(Buffer.from(html).toString('base64'));

		mailLines.push(`--${boundary}--`);
		mailLines.push('.');

		const mailContent = mailLines.join('\r\n');
		await smtpSend(socket, mailContent);
		await smtpDialog(socket, [250]);
		console.log('  📤 SMTP 邮件已发送');

		// 12. QUIT
		await smtpSend(socket, 'QUIT');
		await smtpDialog(socket, [221]);

	} finally {
		socket.destroy();
	}
}

// ─── 发送邮件通知 ───
async function sendEmailNotification(newArticles) {
	if (EMAIL_PROVIDER === 'smtp') {
		if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !EMAIL_FROM || !EMAIL_TO) {
			console.log('⚠️ SMTP 邮件配置不完整，跳过（需设置 SMTP_HOST, SMTP_USER, SMTP_PASS, EMAIL_FROM, EMAIL_TO）');
			return;
		}
	} else {
		if (!EMAIL_API_KEY || !EMAIL_FROM || !EMAIL_TO) {
			console.log('⚠️ 邮件配置不完整，跳过邮件通知（需设置 EMAIL_API_KEY, EMAIL_FROM, EMAIL_TO）');
			return;
		}
	}

	// 按博客分组
	const grouped = {};
	for (const article of newArticles) {
		const key = article.feedTitle || '未知博客';
		if (!grouped[key]) grouped[key] = [];
		grouped[key].push(article);
	}

	// 构建 HTML 邮件内容
	const htmlParts = [];
	htmlParts.push(`<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">`);
	htmlParts.push(`<h2 style="color: #1a1a1a; font-size: 18px; margin-bottom: 20px; padding-bottom: 12px; border-bottom: 2px solid #4f46e5;">🔔 博客更新 · ${newArticles.length} 篇新文章</h2>`);

	for (const [feedName, articles] of Object.entries(grouped)) {
		htmlParts.push(`<h3 style="color: #374151; font-size: 15px; margin-top: 20px; margin-bottom: 8px;">📰 ${escapeHtml(feedName)}</h3>`);
		htmlParts.push(`<ul style="padding-left: 20px; margin: 0;">`);
		for (const a of articles) {
			const time = formatRelativeTime(a.pubDate);
			const author = a.author ? ` - ${escapeHtml(a.author)}` : '';
			htmlParts.push(`<li style="margin-bottom: 8px; line-height: 1.5;">
				<a href="${escapeHtml(a.link)}" style="color: #4f46e5; text-decoration: none; font-weight: 500;">${escapeHtml(a.title)}</a>
				<span style="color: #9ca3af; font-size: 13px;">${time}${author}</span>
			</li>`);
		}
		htmlParts.push(`</ul>`);
	}

	htmlParts.push(`<div style="margin-top: 24px; padding-top: 12px; border-top: 1px solid #e5e7eb; color: #9ca3af; font-size: 12px; text-align: center;">
		由 RSS 博客订阅机器人自动发送
	</div>`);
	htmlParts.push(`</div>`);

	// 纯文本版本
	const textParts = [];
	textParts.push(`🔔 博客更新 · ${newArticles.length} 篇新文章\n`);
	for (const [feedName, articles] of Object.entries(grouped)) {
		textParts.push(`📰 ${feedName}`);
		for (const a of articles) {
			textParts.push(`  - ${a.title} (${formatRelativeTime(a.pubDate)})\n    ${a.link}`);
		}
		textParts.push('');
	}

	const emailData = {
		from: EMAIL_FROM,
		to: EMAIL_TO.split(',').map((s) => s.trim()),
		subject: `🔔 博客更新 · ${newArticles.length} 篇新文章`,
		text: textParts.join('\n'),
		html: htmlParts.join('\n')
	};

	try {
		if (EMAIL_PROVIDER === 'smtp') {
			await sendSmtpEmail(emailData);
			console.log(`✅ SMTP 邮件通知发送成功 (${newArticles.length} 篇新文章)`);
		} else if (EMAIL_PROVIDER === 'custom' && EMAIL_API_URL) {
			const res = await fetch(EMAIL_API_URL, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${EMAIL_API_KEY}`
				},
				body: JSON.stringify(emailData)
			});
			if (res.ok) {
				console.log(`✅ 邮件通知发送成功 (${newArticles.length} 篇新文章)`);
			} else {
				const errText = await res.text();
				console.error(`❌ 邮件通知发送失败: HTTP ${res.status} ${errText}`);
			}
		} else {
			const res = await fetch('https://api.resend.com/emails', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${EMAIL_API_KEY}`
				},
				body: JSON.stringify(emailData)
			});
			const result = await res.json();
			if (res.ok && result.id) {
				console.log(`✅ 邮件通知发送成功 (${newArticles.length} 篇新文章, id: ${result.id})`);
			} else {
				console.error('❌ 邮件通知发送失败:', result);
			}
		}
	} catch (err) {
		console.error('❌ 邮件通知发送异常:', err.message);
	}
}

function escapeHtml(str) {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function formatRelativeTime(isoDate) {
	const now = Date.now();
	const then = new Date(isoDate).getTime();
	const diff = now - then;
	const minutes = Math.floor(diff / 60000);
	const hours = Math.floor(diff / 3600000);
	const days = Math.floor(diff / 86400000);

	if (minutes < 1) return '刚刚';
	if (minutes < 60) return `${minutes}分钟前`;
	if (hours < 24) return `${hours}小时前`;
	if (days < 7) return `${days}天前`;
	return new Date(isoDate).toLocaleDateString('zh-CN');
}

// ─── 保存检查结果到 JSON ───
function saveOutputToJson(newArticles, allNewArticles) {
	const output = {
		timestamp: new Date().toISOString(),
		totalNewArticles: newArticles.length,
		articles24h: newArticles.length,
		articlesOlder: allNewArticles.length - newArticles.length,
		articles: newArticles.map((a) => ({
			title: a.title,
			link: a.link,
			pubDate: a.pubDate,
			author: a.author,
			feedTitle: a.feedTitle
		}))
	};

	try {
		writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, '\t') + '\n');
		console.log(`📄 已保存检查结果到 data/last-check-output.json`);
	} catch (err) {
		console.error(`❌ 保存检查结果失败: ${err.message}`);
	}
}

// ─── 从远程 JSON 加载订阅源 ───
async function loadFeedsFromRemote(url) {
	console.log(`🌐 从远程加载订阅源: ${url}`);
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
		const res = await fetch(url, {
			signal: controller.signal,
			headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RSSBot/1.0)' }
		});
		clearTimeout(timer);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const text = await res.text();
		const json = JSON.parse(text);

		// 简单数组格式
		if (Array.isArray(json)) {
			return json.map((item) =>
				typeof item === 'string' ? { url: item } : item
			);
		}

		// 对象格式
		if (json.feeds && Array.isArray(json.feeds)) {
			return json.feeds.map((item) =>
				typeof item === 'string' ? { url: item } : item
			);
		}

		console.log('⚠️ 远程 JSON 格式不识别，期望数组或 { feeds: [...] }');
		return [];
	} catch (err) {
		console.error(`❌ 远程加载失败: ${err.message}`);
		return null;
	}
}

// ─── 主流程 ───
async function main() {
	console.log('🔍 开始检查 RSS Feed...\n');

	// 1. 加载订阅源：优先远程 JSON，回退本地 feeds.yml
	let feeds = [];

	if (FEEDS_URL) {
		const remoteFeeds = await loadFeedsFromRemote(FEEDS_URL);
		if (remoteFeeds && remoteFeeds.length > 0) {
			feeds = remoteFeeds;
			console.log(`📋 远程加载 ${feeds.length} 个订阅源\n`);
		} else if (remoteFeeds !== null) {
			console.log('⚠️ 远程订阅源为空，尝试本地配置');
		}
	}

	if (feeds.length === 0 && existsSync(FEEDS_PATH)) {
		const feedsYml = readFileSync(FEEDS_PATH, 'utf-8');
		feeds = parseFeedsYml(feedsYml);
		if (feeds.length > 0) {
			console.log(`📋 本地加载 ${feeds.length} 个订阅源\n`);
		}
	}

	if (feeds.length === 0) {
		console.log('⚠️ 没有可用的订阅源（设置 FEEDS_URL 环境变量或编辑 feeds.yml）');
		return;
	}

	// 2. 读取已读记录
	let seenData = { lastCheck: null, articles: {} };
	if (existsSync(SEEN_PATH)) {
		try {
			seenData = JSON.parse(readFileSync(SEEN_PATH, 'utf-8'));
		} catch {
			console.log('⚠️ seen-articles.json 格式错误，将重建');
		}
	}

	// 3. 逐个抓取
	const allNewArticles = [];

	for (const feedConfig of feeds) {
		const url = typeof feedConfig === 'string' ? feedConfig : feedConfig.url;
		console.log(`🔍 检查: ${url}`);
		try {
			const result = await resolveFeed(feedConfig);
			if (!result) {
				console.log(`  ❌ 未找到 Feed\n`);
				continue;
			}

			const { feedTitle, articles } = result;
			console.log(`  📰 ${feedTitle || '未知'} - 共 ${articles.length} 篇文章`);

			// 筛选新文章（最多取最新 10 篇检查）
			const recentArticles = articles.slice(0, 10);
			const newOnes = recentArticles.filter((a) => !seenData.articles[a.link]);

			if (newOnes.length > 0) {
				console.log(`  🆕 发现 ${newOnes.length} 篇新文章`);
				for (const a of newOnes) {
					console.log(`     - ${a.title}`);
				}
				allNewArticles.push(...newOnes);
			} else {
				console.log(`  ✅ 无新文章`);
			}
			console.log();

			// 更新已读记录
			for (const a of recentArticles) {
				seenData.articles[a.link] = a.pubDate;
			}
		} catch (err) {
			console.error(`  ❌ 抓取失败: ${err.message}\n`);
		}
	}

	// 4. 发送通知（仅推送最近 24 小时内的文章）
	const oneDayAgo = Date.now() - 86400000;
	const recentNew = allNewArticles.filter(
		(a) => new Date(a.pubDate).getTime() > oneDayAgo || !seenData.lastCheck
	);

	if (recentNew.length > 0) {
		await sendFeishuNotification(recentNew);
		await sendEmailNotification(recentNew);
	} else if (allNewArticles.length > 0) {
		console.log(`ℹ️ 发现 ${allNewArticles.length} 篇新文章，但发布时间超过 24 小时，不推送通知`);
	} else {
		console.log('✅ 所有博客均无新文章');
	}

	// 保存结果到 JSON 文件
	saveOutputToJson(recentNew, allNewArticles);

	// 5. 清理旧记录
	const entries = Object.entries(seenData.articles);
	if (entries.length > MAX_SEEN) {
		entries.sort((a, b) => new Date(b[1]).getTime() - new Date(a[1]).getTime());
		seenData.articles = Object.fromEntries(entries.slice(0, MAX_SEEN));
	}

	// 6. 保存已读记录
	seenData.lastCheck = new Date().toISOString();
	writeFileSync(SEEN_PATH, JSON.stringify(seenData, null, '\t') + '\n');
	console.log(`\n📝 已更新 seen-articles.json (${Object.keys(seenData.articles).length} 条记录)`);
}

main().catch((err) => {
	console.error('❌ 脚本执行失败:', err);
	process.exit(1);
});
