const listEl = document.getElementById("article-list");
const feedListEl = document.getElementById("feed-list");
const settingsEl = document.getElementById("settings");
const feedUrlEl = document.getElementById("feed-url");
const refreshBtn = document.getElementById("refresh");
const toggleFilterBtn = document.getElementById("toggle-filter");
const markAllReadBtn = document.getElementById("mark-all-read"); 
const undoBarEl = document.getElementById("undo-bar");     
const undoTextEl = document.getElementById("undo-text");   
const undoBtnEl = document.getElementById("undo-btn");     

const pendingProbes = new Set();

let renderTimer = null;
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    render();
  }, 200);
}

async function getState() {
  const s = await chrome.storage.local.get([
    "feeds",
    "articles",
    "readIds",
    "lastRefresh",
    "filterMode",
    "feedStatus",  
  ]);
  return {
    feeds: s.feeds || [],
    articles: s.articles || [],
    readIds: s.readIds || [],
    lastRefresh: s.lastRefresh || 0,
    filterMode: s.filterMode || "all",
    feedStatus: s.feedStatus || {},   
  };
}

function formatDate(str) {
  if (!str) return "";
  const d = new Date(str);
  return isNaN(d.getTime()) ? "" : d.toLocaleString();
}

// 取文章的日期键，忽略时分秒，便于分组。无效日期返回 null。
function dateKey(pubDate) {
  if (!pubDate) return null;
  const d = new Date(pubDate);
  if (isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// 把 "2026-8-12" 这样的键转成 "Today" / "Yesterday" / "September 12"。
function formatGroupDate(key) {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y, m, d);

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (date.getTime() === today.getTime()) return "Today";
  if (date.getTime() === yesterday.getTime()) return "Yesterday";

  return date.toLocaleDateString(undefined, {
    year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
    month: "long",
    day: "numeric",
  });
}

async function markRead(id) {
  const { readIds } = await getState();
  if (!readIds.includes(id)) {
    readIds.push(id);
    await chrome.storage.local.set({ readIds });
  }
}

async function removeFeed(id) {
  const { feeds } = await getState();
  await chrome.storage.local.set({ feeds: feeds.filter((f) => f.id !== id) });
}

// ★ 刷新按钮状态：进行中显示 "done/total"，否则显示 ⟳
function applyRefreshState(p) {
  const isFresh =
    p?.active &&
    (!p.startedAt || Date.now() - p.startedAt < 5 * 60 * 1000);

  if (isFresh) {
    refreshBtn.classList.add("refreshing");
    refreshBtn.textContent = `${p.done || 0}/${p.total || 0}`;
    refreshBtn.disabled = true;
    refreshBtn.title = "Refreshing…";
  } else {
    refreshBtn.classList.remove("refreshing");
    refreshBtn.textContent = "⟳";
    refreshBtn.disabled = false;
    refreshBtn.title = "Refresh all feeds";
  }
}

function renderFeedList(feeds, feedStatus) {
  feedListEl.innerHTML = "";

  const sorted = [...feeds].sort((a, b) => {
    const ta = (a.title || a.url || "").toLowerCase();
    const tb = (b.title || b.url || "").toLowerCase();
    return ta.localeCompare(tb);
  });

  for (const f of sorted) {
    const li = document.createElement("li");

    // ---- 第一行：标题 + 按钮 ----
    const row = document.createElement("div");
    row.className = "feed-row";

    const span = document.createElement("span");
    span.textContent = f.title || f.url;
    span.title = f.url;
    row.appendChild(span);

    // ---- 探测按钮 ----
    const probe = document.createElement("button");
    probe.className = "probe";

    let state = "unknown";
    let count = 0;
    let error = "";

    if (pendingProbes.has(f.id)) {
      state = "pending";
    } else if (feedStatus[f.id]) {
      const st = feedStatus[f.id];
      if (st.ok) {
        state = "ok";
        count = st.count;
      } else {
        state = "error";
        error = st.error;
      }
    }

    if (state === "pending") {
      probe.textContent = "…";
      probe.title = "Testing…";
      probe.disabled = true;
    } else if (state === "ok") {
      probe.textContent = "✓";
      probe.title = `OK — ${count} item${count === 1 ? "" : "s"}`;
      probe.classList.add("ok");
    } else if (state === "error") {
      probe.textContent = "✗";
      probe.title = error;
      probe.classList.add("error");
    } else {
      probe.textContent = "⚡";
      probe.title = "Test connection";
    }

    probe.addEventListener("click", async () => {
      pendingProbes.add(f.id);
      renderFeedList(feeds, feedStatus);
      try {
        await chrome.runtime.sendMessage({
          action: "probeFeed",
          feedId: f.id,
          url: f.url,
        });
      } catch (e) {
        const { feedStatus: current = {} } = await chrome.storage.local.get("feedStatus");
        current[f.id] = { ok: false, error: String(e?.message || e), at: Date.now() };
        await chrome.storage.local.set({ feedStatus: current });
      } finally {
        pendingProbes.delete(f.id);
      }
    });
    row.appendChild(probe);

    // ---- 复制 URL 按钮 ----
    const copy = document.createElement("button");
    copy.className = "copy";
    copy.textContent = "⧉";
    copy.title = "Copy feed URL";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(f.url);
        copy.classList.add("copied");
        copy.textContent = "✓";
        setTimeout(() => {
          copy.classList.remove("copied");
          copy.textContent = "⧉";
        }, 1200);
      } catch (e) {
        copy.textContent = "✗";
        setTimeout(() => { copy.textContent = "⧉"; }, 1200);
      }
    });
    row.appendChild(copy);

    // ---- 删除按钮 ----
    const del = document.createElement("button");
    del.className = "remove";
    del.textContent = "×";
    del.title = "Remove";
    del.addEventListener("click", async () => {
      await removeFeed(f.id);
      pendingProbes.delete(f.id);
      render();
    });
    row.appendChild(del);

    li.appendChild(row);

    // ---- 第二行：错误信息（仅失败时显示） ----
    if (state === "error" && error) {
      const err = document.createElement("div");
      err.className = "feed-error";
      err.textContent = error;
      li.appendChild(err);
    }

    feedListEl.appendChild(li);
  }
}
async function render() {
  const { feeds, articles, readIds, filterMode, feedStatus } = await getState();
  const readSet = new Set(readIds);

  const visible =
    filterMode === "unread"
      ? articles.filter((a) => !readSet.has(a.id))
      : articles;

  toggleFilterBtn.textContent = filterMode === "all" ? "☰" : "●";
  toggleFilterBtn.title =
    filterMode === "all"
      ? "Showing all — click for unread only"
      : "Showing unread — click for all";

  listEl.innerHTML = "";
  if (visible.length === 0) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent =
      articles.length === 0
        ? "No articles yet. Add a feed and click ⟳."
        : "No unread articles. 🎉";
    listEl.appendChild(p);
  }

  let lastKey = "__init__";   // 用一个不会和任何 dateKey 碰撞的哨兵值
  for (const a of visible) {
    const key = dateKey(a.pubDate);   // null 表示无日期

    // ★ 日期变化时插入分组标题
    if (key !== lastKey) {
      const header = document.createElement("div");
      header.className = "date-header";
      header.textContent = key ? formatGroupDate(key) : "Undated";
      listEl.appendChild(header);
      lastKey = key;
    }

    const wrap = document.createElement("a");
    wrap.className = "article" + (readSet.has(a.id) ? " read" : "");
    wrap.href = a.link;
    wrap.title = a.link;

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = a.title || "(no title)";
    wrap.appendChild(title);

    if (a.summary) {
      const sum = document.createElement("div");
      sum.className = "summary";
      sum.textContent = a.summary;
      wrap.appendChild(sum);
    }

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = [a.feedTitle, formatDate(a.pubDate)]
      .filter(Boolean)
      .join(" · ");
    wrap.appendChild(meta);

    wrap.addEventListener("click", async (e) => {
      e.preventDefault();
      const url = wrap.href;
      if (!/^https?:/i.test(url)) return;
      await markRead(a.id);
      chrome.tabs.create({ url });
    });
    listEl.appendChild(wrap);
  }
  renderFeedList(feeds, feedStatus);
}

refreshBtn.addEventListener("click", async () => {
  // 立即禁用，避免在 storage 更新前重复点击；
  // 最终状态由 refreshProgress 的 storage 变化驱动。
  refreshBtn.disabled = true;
  try {
    await chrome.runtime.sendMessage({ action: "refresh" });
  } catch {
    // 出错时手动复位
    applyRefreshState(null);
  }
});

toggleFilterBtn.addEventListener("click", async () => {
  const { filterMode } = await getState();
  const next = filterMode === "all" ? "unread" : "all";
  await chrome.storage.local.set({ filterMode: next });
});
// ==================== Mark all as read (+ undo) ====================
// 记录本次新标记的 id，撤销时只从 readIds 里移除这些 id，
// 这样不会误伤撤销之前/之后单篇阅读产生的已读记录。
let pendingUndo = null;      // { ids: string[], timeoutId: number }
const UNDO_WINDOW_MS = 8000;

function hideUndoBar() {
  if (pendingUndo) {
    clearTimeout(pendingUndo.timeoutId);
    pendingUndo = null;
  }
  undoBarEl.hidden = true;
}

function showUndoBar(count) {
  undoTextEl.textContent = `Marked ${count} article${count === 1 ? "" : "s"} as read.`;
  undoBarEl.hidden = false;
}

markAllReadBtn.addEventListener("click", async () => {
  const { articles, readIds } = await getState();
  const readSet = new Set(readIds);

  const newlyRead = [];
  for (const a of articles) {
    if (!readSet.has(a.id)) {
      readSet.add(a.id);
      newlyRead.push(a.id);
    }
  }

  if (newlyRead.length === 0) {
    markAllReadBtn.classList.add("marked");
    markAllReadBtn.textContent = "0";
    markAllReadBtn.disabled = true;
    setTimeout(() => { markAllReadBtn.classList.remove("marked");markAllReadBtn.textContent = "☑";markAllReadBtn.disabled = false; }, 900);
    return;
  }

  await chrome.storage.local.set({ readIds: [...readSet] });

  // 用数字短暂反馈，然后还原图标
  markAllReadBtn.classList.add("marked");
  markAllReadBtn.textContent = `${newlyRead.length}`;
  markAllReadBtn.disabled = true;
  setTimeout(() => { markAllReadBtn.classList.remove("marked");markAllReadBtn.textContent = "☑";markAllReadBtn.disabled = false; }, 1200);

  // 撤销窗口：如果之前还有未过期的撤销，先清掉再开新的
  hideUndoBar();
  pendingUndo = {
    ids: newlyRead,
    timeoutId: setTimeout(() => { hideUndoBar(); }, UNDO_WINDOW_MS),
  };
  showUndoBar(newlyRead.length);
});

undoBtnEl.addEventListener("click", async () => {
  if (!pendingUndo) { undoBarEl.hidden = true; return; }

  const idsToRestore = new Set(pendingUndo.ids);
  clearTimeout(pendingUndo.timeoutId);
  pendingUndo = null;
  undoBarEl.hidden = true;

  const { readIds } = await getState();
  const restored = readIds.filter((id) => !idsToRestore.has(id));
  await chrome.storage.local.set({ readIds: restored });
  // storage.onChanged 会触发 render()，未读列表会立即恢复
});
document.getElementById("toggle-settings").addEventListener("click", () => {
  settingsEl.hidden = !settingsEl.hidden;
});

document.getElementById("add-feed").addEventListener("click", async () => {
  const url = feedUrlEl.value.trim();
  if (!/^https?:/i.test(url)) return;

  let title = "";
  try { title = new URL(url).hostname; } catch {}

  const { feeds } = await getState();
  feeds.push({ id: "feed_" + Date.now(), url, title });
  await chrome.storage.local.set({ feeds });

  feedUrlEl.value = "";
  render();
  chrome.runtime.sendMessage({ action: "refresh" }).then(render);
});

// ==================== Remove all subscriptions ====================
document.getElementById("remove-all-feeds").addEventListener("click", async () => {
  const { feeds, articles } = await getState();
  if (feeds.length === 0) {
    removeAllFeedsBtn.textContent = "0";
    setTimeout(() => { removeAllFeedsBtn.textContent = "Remove all"; }, 900);
    return;
  }

  const ok = confirm(
    `Remove all ${feeds.length} subscription${feeds.length === 1 ? "" : "s"} ` +
    `and ${articles.length} stored article${articles.length === 1 ? "" : "s"}?\n\n` +
    `This cannot be undone.`
  );
  if (!ok) return;

  // 清空所有与订阅/文章相关的状态；filterMode 等 UI 偏好保留。
  await chrome.storage.local.set({
    feeds: [],
    articles: [],
    readIds: [],
    lastErrors: [],
    lastRefresh: 0,
  });

  await chrome.action.setBadgeText({ text: "" });
  // storage.onChanged 会触发 render()，列表和 feed 列表会立即清空
});
// ==================== OPML ====================

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildOpml(feeds) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head>',
    '    <title>RSS Subscriptions</title>',
    `    <dateCreated>${new Date().toUTCString()}</dateCreated>`,
    '  </head>',
    '  <body>',
  ];
  for (const f of feeds) {
    const title = escapeXml(f.title || f.url);
    const xmlUrl = escapeXml(f.url);
    lines.push(
      `    <outline type="rss" text="${title}" title="${title}" xmlUrl="${xmlUrl}" />`
    );
  }
  lines.push('  </body>', '</opml>');
  return lines.join("\n");
}

async function exportOpml() {
  const { feeds } = await getState();
  if (feeds.length === 0) {
    alert("No feeds to export.");
    return;
  }

  const opml = buildOpml(feeds);
  const blob = new Blob([opml], { type: "application/xml" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  const date = new Date().toISOString().slice(0, 10);
  a.download = `rss-subscriptions-${date}.opml`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importOpml(file) {
  const text = await file.text();
  const doc = new DOMParser().parseFromString(text, "text/xml");

  if (doc.querySelector("parsererror")) {
    throw new Error("Invalid OPML / XML file");
  }

  const outlines = doc.querySelectorAll("outline");
  const imported = [];
  const seen = new Set();

  for (const o of outlines) {
    const xmlUrl = (o.getAttribute("xmlUrl") || "").trim();
    if (!xmlUrl || !/^https?:/i.test(xmlUrl)) continue;
    if (seen.has(xmlUrl)) continue;
    seen.add(xmlUrl);

    let title =
      o.getAttribute("title") ||
      o.getAttribute("text") ||
      "";
    if (!title) {
      try { title = new URL(xmlUrl).hostname; } catch { title = xmlUrl; }
    }

    imported.push({ url: xmlUrl, title });
  }

  if (imported.length === 0) {
    return { added: 0, total: 0 };
  }

  const { feeds } = await getState();
  const existing = new Set(feeds.map((f) => f.url));
  let added = 0;
  let ts = Date.now();
  for (const item of imported) {
    if (existing.has(item.url)) continue;
    feeds.push({ id: `feed_${ts++}`, url: item.url, title: item.title });
    existing.add(item.url);
    added++;
  }

  await chrome.storage.local.set({ feeds });
  return { added, total: imported.length };
}

document.getElementById("export-opml").addEventListener("click", exportOpml);

document.getElementById("import-opml").addEventListener("click", () => {
  document.getElementById("opml-file").click();
});

document.getElementById("opml-file").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;

  try {
    const result = await importOpml(file);
    if (result.total === 0) {
      alert("No feeds found in this file.");
      return;
    }
    render();
    if (result.added > 0) {
      chrome.runtime.sendMessage({ action: "refresh" }).then(render);
    }
    alert(`Imported ${result.added} new feed(s). (${result.total} total in file, ${
      result.total - result.added
    } already subscribed.)`);
  } catch (err) {
    alert("Import failed: " + (err?.message || err));
  }
});

// ==================== Storage 驱动刷新按钮 ====================

async function initRefreshState() {
  const { refreshProgress } = await chrome.storage.local.get("refreshProgress");
  applyRefreshState(refreshProgress);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;

  if (changes.refreshProgress) {
    applyRefreshState(changes.refreshProgress.newValue);
  }

  if (
    changes.articles ||
    changes.feeds ||
    changes.readIds ||
    changes.filterMode ||
    changes.feedStatus 
  ) {
    scheduleRender();
  }
});

initRefreshState();
render();

