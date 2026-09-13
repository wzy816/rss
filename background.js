const ALARM_NAME = "rss-refresh";
const REFRESH_INTERVAL_MINUTES = 480;
const MAX_ARTICLES = 5000;
const SUMMARY_MAX_LENGTH = 160;
const FEED_TIMEOUT_MS = 120000;              
const MAX_FEED_BYTES = 10 * 1024 * 1024;
const FEED_MAX_ATTEMPTS = 3;


// ---------- 角标：唯一数据源是 articles + readIds ----------
// ---------- Unread badge ----------
async function updateBadge() {
  try {
    const { articles = [], readIds = [] } = await chrome.storage.local.get([
      "articles",
      "readIds",
    ]);
    const readSet = new Set(readIds);
    const unread = articles.reduce(
      (n, a) => n + (readSet.has(a.id) ? 0 : 1),
      0
    );

    if (unread > 0) {
      await chrome.action.setBadgeBackgroundColor({ color: "#0366d6" });
      await chrome.action.setBadgeText({ text: String(unread) });
    } else {
      await chrome.action.setBadgeText({ text: "" });
    }
  } catch (e) {
    console.error("updateBadge failed:", e);
  }
}

// 任何改变 articles 或 readIds 的写入都会触发。
// 无论写入来自 SW（refresh）还是 side panel（点开、标全部已读、撤销、清空）。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.articles || changes.readIds) {
    updateBadge();
  }
});

// 启动时也跑一次，防止上次 SW 被 kill 时留下过期角标。
updateBadge();

// 任何改变 articles 或 readIds 的写入都会重算角标 —— 无论写入来自
// service worker（refresh）还是 side panel（点开文章、全部标已读、撤销、清空）。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.articles || changes.readIds) {
    updateBadge();
  }
});

// 让点击扩展图标时直接打开侧边栏
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.error(e));
});

// ---------- 生命周期 ----------
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: REFRESH_INTERVAL_MINUTES });
  chrome.storage.local.remove("refreshProgress");
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: REFRESH_INTERVAL_MINUTES });
  chrome.storage.local.remove("refreshProgress");
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) refreshAllFeeds();
});

// ---------- 消息 ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.action === "refresh") {
    refreshAllFeeds()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg?.action === "probeFeed" && msg.url) {
    fetchFeed({ url: msg.url })
      .then(async ({ feedTitle, items }) => {  
        const { feedStatus = {} } = await chrome.storage.local.get("feedStatus");
        feedStatus[msg.feedId] = { ok: true, count: items.length, at: Date.now() };
        await chrome.storage.local.set({ feedStatus });
        await updateFeedTitle(msg.feedId, feedTitle); 
        sendResponse({ ok: true, count: items.length });
      })
      .catch(async (e) => {
        const errorMsg = String(e?.message || e);
        const { feedStatus = {} } = await chrome.storage.local.get("feedStatus");
        feedStatus[msg.feedId] = { ok: false, error: errorMsg, at: Date.now() };
        await chrome.storage.local.set({ feedStatus });
        sendResponse({ ok: false, error: errorMsg });
      });
    return true;
  }
  if (msg?.action === "openLink" && msg.url) {
    chrome.tabs.create({ url: msg.url });
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

// ---------- 解析工具 ----------
function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

function cleanText(s) {
  if (!s) return "";
  let out = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  out = out.replace(/<[^>]+>/g, "");
  return decodeEntities(out).trim();
}

function makeSummary(raw) {
  if (!raw) return "";
  let out = cleanText(raw).replace(/<[^>]+>/g, "");
  out = out.replace(/\s+/g, " ").trim();
  if (out.length > SUMMARY_MAX_LENGTH) {
    out = out.slice(0, SUMMARY_MAX_LENGTH);
    const sp = out.lastIndexOf(" ");
    if (sp > SUMMARY_MAX_LENGTH * 0.7) out = out.slice(0, sp);
    out += "…";
  }
  return out;
}

function pickTag(block, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = block.match(re);
  return m ? cleanText(m[1]) : "";
}

function pickAtomLink(block) {
  const links = [...block.matchAll(/<link\b([^>]*)\/?>/gi)];
  let alternate = null;
  let fallback = null;
  for (const m of links) {
    const attrs = m[1];
    const href = attrs.match(/href=["']([^"']+)["']/i);
    if (!href) continue;
    const url = decodeEntities(href[1]);
    const rel = (attrs.match(/rel=["']([^"']+)["']/i)?.[1] || "alternate").toLowerCase();
    if (rel === "alternate") { alternate = url; break; }
    if (!fallback) fallback = url;
  }
  return alternate || fallback || "";
}

function parseFeed(xmlText) {
  const isAtom = /<feed\b/i.test(xmlText.slice(0, 2000));
  const blockRe = isAtom
    ? /<entry\b[\s\S]*?<\/entry>/gi
    : /<item\b[\s\S]*?<\/item>/gi;

    // ★ feed 级标题在第一个 item/entry 之前，单独取
  const firstBlockIdx = xmlText.search(isAtom ? /<entry\b/i : /<item\b/i);
  const head = firstBlockIdx >= 0 ? xmlText.slice(0, firstBlockIdx) : xmlText;
  const feedTitle = pickTag(head, "title") || "";

  const blocks = xmlText.match(blockRe) || [];

  const items = [];
  for (const block of blocks) {
    const title = pickTag(block, "title") || "(no title)";
    let link = "";
    let pubDate = "";
    let summary = "";

    if (isAtom) {
      link = pickAtomLink(block);
      pubDate = pickTag(block, "updated") || pickTag(block, "published");
      summary = makeSummary(
        pickTag(block, "summary") || pickTag(block, "content")
      );
    } else {
      link = pickTag(block, "link");
      pubDate = pickTag(block, "pubDate") || pickTag(block, "dc:date");
      summary = makeSummary(
        pickTag(block, "description") || pickTag(block, "content:encoded")
      );
    }

    if (!link || !/^https?:/i.test(link)) continue;

    items.push({ id: link, title, link, pubDate, summary });
  }
  return { feedTitle, items };
}

// ---------- 抓取（带超时 + 体积上限） ----------
async function fetchFeed(feed, attempt = 1) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    ctrl.abort(new Error(`Timeout after ${FEED_TIMEOUT_MS} ms`));
  }, FEED_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(feed.url, {
      cache: "no-store",
      redirect: "follow",
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);

    if (ctrl.signal.aborted) {
      throw new Error(`Timeout after ${FEED_TIMEOUT_MS} ms`);
    }
    if (attempt < FEED_MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 400 * attempt));
      return fetchFeed(feed, attempt + 1);
    }

    let host = feed.url;
    try { host = new URL(feed.url).host; } catch {}
    throw new Error(
      `Network error — could not connect to ${host} (${FEED_MAX_ATTEMPTS} attempts)`
    );
  }

  try {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const cl = res.headers.get("content-length");
    if (cl && Number(cl) > MAX_FEED_BYTES) {
      throw new Error(
        `Feed too large (${(Number(cl) / 1024 / 1024).toFixed(1)} MB)`
      );
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let received = 0;
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_FEED_BYTES) {
        try { await reader.cancel(); } catch {}
        throw new Error(`Feed exceeded ${MAX_FEED_BYTES / 1024 / 1024} MB`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();

    return parseFeed(text);
  } catch (e) {
    if (ctrl.signal.aborted) {
      throw new Error(`Timeout after ${FEED_TIMEOUT_MS} ms`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function updateFeedTitle(feedId, newTitle) {
  if (!newTitle) return;
  const { feeds = [] } = await chrome.storage.local.get("feeds");
  const f = feeds.find((x) => x.id === feedId);
  if (!f || f.title === newTitle) return;
  f.title = newTitle;
  await chrome.storage.local.set({ feeds });
}

// ---------- 刷新（增量写盘） ----------
async function refreshAllFeeds() {
  const {
    feeds = [],
    readIds = [],
    articles: existingArticles = [],
    feedStatus: oldFeedStatus = {},
  } = await chrome.storage.local.get([
    "feeds",
    "readIds",
    "articles",
    "feedStatus",
  ]);

  const readSet = new Set(readIds);
  const total = feeds.length;
  const startedAt = Date.now();

  const map = new Map();
  for (const a of existingArticles) map.set(a.id, a);

  // ★ feedStatus 在内存里维护，每次 flush 时一起写入。
  //   这样每处理完一个 feed，侧边栏就能看到它的探测结果，
  //   而不是等到整个 refresh 结束。
  const feedStatus = { ...oldFeedStatus };
  const errors = [];
  let done = 0;

  // 一次 storage.set 写入三样东西：文章、进度、feedStatus。
  // 每处理完一个 feed 调一次。
  const flush = async () => {
    let arr = [...map.values()];
    arr.sort((a, b) => {
      const ta = a.pubDate ? Date.parse(a.pubDate) : 0;
      const tb = b.pubDate ? Date.parse(b.pubDate) : 0;
      return (tb || 0) - (ta || 0);
    });
    if (arr.length > MAX_ARTICLES) arr = arr.slice(0, MAX_ARTICLES);
    const withRead = arr.map((a) => ({ ...a, read: readSet.has(a.id) }));

    await chrome.storage.local.set({
      articles: withRead,
      feedStatus,
      refreshProgress: { active: true, done, total, startedAt },
    });
    return withRead;
  };

  // 初始写：进度从 0 开始，feedStatus 先带上一次的快照
  await flush();

  try {
    for (const feed of feeds) {
      try {
        const { feedTitle, items } = await fetchFeed(feed); 
        for (const it of items) {
          map.set(it.id, {
            ...it,
            feedId: feed.id,
            feedTitle: feed.title || feed.url,
          });
        }
        feedStatus[feed.id] = { ok: true, count: items.length, at: Date.now() };
        if (feedTitle && feedTitle !== feed.title) {
          feed.title = feedTitle;              // 本地副本同步，供后续文章使用
          await updateFeedTitle(feed.id, feedTitle);
        }
      } catch (e) {
        const msg = String(e?.message || e);
        errors.push({ feedId: feed.id, url: feed.url, error: msg });
        feedStatus[feed.id] = { ok: false, error: msg, at: Date.now() };
      }

      done++;
      await flush();
    }

    // 收尾：去掉已不在订阅列表里的旧文章和旧状态
    const liveFeedIds = new Set(feeds.map((f) => f.id));
    for (const [id, a] of map) {
      if (!liveFeedIds.has(a.feedId)) map.delete(id);
    }
    for (const id of Object.keys(feedStatus)) {
      if (!liveFeedIds.has(id)) delete feedStatus[id];
    }

    await flush();
    await chrome.storage.local.set({ lastErrors: errors });
    await updateBadge();
  } finally {
    await chrome.storage.local.set({
      refreshProgress: {
        active: false,
        done: total,
        total,
        finishedAt: Date.now(),
      },
    });
  }
}