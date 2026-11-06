const listEl = document.getElementById("article-list");
const feedListEl = document.getElementById("feed-list");
const settingsEl = document.getElementById("settings");
const feedUrlEl = document.getElementById("feed-url");
const refreshBtn = document.getElementById("refresh");
const toggleFilterBtn = document.getElementById("toggle-filter");
const openAllUnreadBtn = document.getElementById("open-all-unread");
const markAllReadBtn = document.getElementById("mark-all-read");
const removeAllFeedsBtn = document.getElementById("remove-all-feeds");
const undoBarEl = document.getElementById("undo-bar");
const undoTextEl = document.getElementById("undo-text");
const undoBtnEl = document.getElementById("undo-btn");

// The background writes a progress heartbeat every 15s while a fetch is in
// flight, so this can stay short even though one feed may take up to 480s.
const PROGRESS_STALE_MS = 60 * 1000;
// A slow-feed probe may legitimately run for the full 480s timeout.
const PROBE_MAX_WAIT_MS = 510 * 1000;
const MSG_RETRY_DELAY_MS = 150;

const pendingProbes = new Set();
const probeTimers = new Map();

let renderTimer = null;
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    renderSafe();
  }, 200);
}

function renderSafe() {
  return render().catch((e) => {
    console.warn("RSS: render failed:", e);
  });
}

// ---------- Messaging ----------
// chrome.runtime.sendMessage rejects when the service worker goes away before
// answering ("message channel closed before a response was received"). That is
// not fatal: the worker is restarted on the next message, so retry once and
// never let the rejection escape as an unhandled promise.
const MSG_CHANNEL_CLOSED =
  /message channel closed|message port closed|receiving end does not exist|could not establish connection|extension context invalidated/i;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendMessageSafe(message, { retries = 1 } = {}) {
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (e) {
      lastError = e;
      const text = String(e?.message || e);
      if (attempt >= retries || !MSG_CHANNEL_CLOSED.test(text)) break;
      await sleep(MSG_RETRY_DELAY_MS * (attempt + 1));
    }
  }

  console.warn(
    `RSS: background request "${message?.action}" failed:`,
    lastError?.message || lastError
  );
  return null;
}

async function getState() {
  const s = await chrome.storage.local.get([
    "feeds",
    "articles",
    "readIds",
    "lastRefresh",
    "filterMode",
    "feedStatus",
    "skippedFeedIds",
  ]);
  return {
    feeds: s.feeds || [],
    articles: s.articles || [],
    readIds: s.readIds || [],
    lastRefresh: s.lastRefresh || 0,
    filterMode: s.filterMode || "all",
    feedStatus: s.feedStatus || {},
    skippedFeedIds: s.skippedFeedIds || [],
  };
}

function formatDate(str) {
  if (!str) return "";
  const d = new Date(str);
  return isNaN(d.getTime()) ? "" : d.toLocaleString();
}

// Date key ignoring time-of-day, for grouping. Invalid dates return null.
function dateKey(pubDate) {
  if (!pubDate) return null;
  const d = new Date(pubDate);
  if (isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// "2026-8-12" -> "Today" / "Yesterday" / "September 12".
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
  const { feeds, skippedFeedIds, feedStatus } = await getState();

  const nextStatus = { ...feedStatus };
  delete nextStatus[id];

  await chrome.storage.local.set({
    feeds: feeds.filter((f) => f.id !== id),
    skippedFeedIds: skippedFeedIds.filter((x) => x !== id),
    feedStatus: nextStatus,
  });
}

// ---------- Probe pending state ----------
function setProbePending(id, pending) {
  const existing = probeTimers.get(id);
  if (existing) {
    clearTimeout(existing);
    probeTimers.delete(id);
  }

  if (pending) {
    pendingProbes.add(id);
    // Fallback: if the worker dies and no status ever arrives, don't leave
    // the button stuck on "…".
    probeTimers.set(
      id,
      setTimeout(() => {
        probeTimers.delete(id);
        pendingProbes.delete(id);
        scheduleRender();
      }, PROBE_MAX_WAIT_MS)
    );
  } else {
    pendingProbes.delete(id);
  }
}

// ---------- Refresh state (storage-driven) ----------
function isProgressFresh(progress) {
  if (!progress?.active) return false;
  const ts = progress.updatedAt || progress.startedAt || 0;
  return Date.now() - ts < PROGRESS_STALE_MS;
}

let refreshWatchdog = null;

function armRefreshWatchdog() {
  clearTimeout(refreshWatchdog);
  refreshWatchdog = setTimeout(async () => {
    refreshWatchdog = null;

    try {
      const { refreshProgress } = await chrome.storage.local.get(
        "refreshProgress"
      );

      if (isProgressFresh(refreshProgress)) {
        armRefreshWatchdog();
        return;
      }

      if (refreshProgress?.active) {
        // The worker died mid-refresh (or stopped writing). Clear the flag so
        // the ⟳ button becomes usable immediately instead of staying disabled.
        try {
          await chrome.storage.local.set({
            refreshProgress: {
              ...refreshProgress,
              active: false,
              stale: true,
              finishedAt: Date.now(),
            },
          });
        } catch (e) {
          console.warn("RSS: could not clear stale progress:", e);
        }
      }
    } catch (e) {
      console.warn("RSS: could not check refresh progress:", e);
    }

    applyRefreshState(null);
  }, PROGRESS_STALE_MS + 1000);
}

function applyRefreshState(progress) {
  if (isProgressFresh(progress)) {
    const done = progress.done || 0;
    const total = progress.total || 0;
    const skipped = progress.skipped || 0;
    const slow = progress.slow || 0;

    refreshBtn.classList.add("refreshing");
    refreshBtn.textContent = `${done}/${total}`;
    refreshBtn.disabled = true;
    refreshBtn.title =
      `Refreshing… ${done}/${total}` +
      (slow ? ` — ${slow} slow` : "") +
      (skipped ? ` — ${skipped} skipped` : "");
    armRefreshWatchdog();
  } else {
    clearTimeout(refreshWatchdog);
    refreshWatchdog = null;
    refreshBtn.classList.remove("refreshing");
    refreshBtn.textContent = "⟳";
    refreshBtn.disabled = false;
    refreshBtn.title = "Refresh all feeds";
  }
}

let refreshRequestSeq = 0;

async function requestRefresh(reason = "manual") {
  const seq = ++refreshRequestSeq;
  refreshBtn.disabled = true;

  // If the worker dies before writing any progress at all, there would be no
  // storage event to re-enable the button. Check once after a short grace.
  setTimeout(async () => {
    if (seq !== refreshRequestSeq) return;
    try {
      const { refreshProgress } = await chrome.storage.local.get(
        "refreshProgress"
      );
      if (!isProgressFresh(refreshProgress)) applyRefreshState(null);
    } catch {
      applyRefreshState(null);
    }
  }, 5000);

  const res = await sendMessageSafe({ action: "refresh", reason });

  if (!res || res.ok !== true) {
    applyRefreshState(null);
    return false;
  }

  if (res.alreadyRunning) {
    const { refreshProgress } = await chrome.storage.local.get("refreshProgress");
    applyRefreshState(refreshProgress);
  }

  return true;
}

// ---------- Feed list ----------
function isSuspendedNow(status) {
  if (!status?.suspended) return false;
  return !status.suspendedUntil || status.suspendedUntil > Date.now();
}

function renderFeedList(feeds, feedStatus, skippedFeedIds) {
  feedListEl.innerHTML = "";

  const skippedSet = new Set(skippedFeedIds || []);
  const sorted = [...feeds].sort((a, b) => {
    const ta = (a.title || a.url || "").toLowerCase();
    const tb = (b.title || b.url || "").toLowerCase();
    return ta.localeCompare(tb);
  });

  for (const f of sorted) {
    const li = document.createElement("li");

    // ---- Row: title + action buttons ----
    const row = document.createElement("div");
    row.className = "feed-row";

    const span = document.createElement("span");
    span.textContent = f.title || f.url;
    span.title = f.url;
    row.appendChild(span);

    const status = feedStatus[f.id];
    const manualSkip = skippedSet.has(f.id);
    const suspended = isSuspendedNow(status);
    const slow = !!(status && status.ok === false && status.slow);
    const pending = pendingProbes.has(f.id);

    // ---- Probe / retry button ----
    const probe = document.createElement("button");
    probe.type = "button";
    probe.className = "probe";

    if (pending) {
      probe.textContent = "…";
      probe.title = "Testing…";
      probe.disabled = true;
    } else if (status?.ok) {
      probe.textContent = "✓";
      probe.title =
        `OK — ${status.count || 0} item${status.count === 1 ? "" : "s"}` +
        (manualSkip ? " (feed is skipped)" : "");
      probe.classList.add("ok");
    } else if (slow) {
      probe.textContent = "⏱";
      probe.title =
        `Slow feed — ${status.error || "last attempt timed out"}. ` +
        "Click to test now.";
      probe.classList.add("slow");
    } else if (status && status.ok === false) {
      probe.textContent = "✗";
      probe.title =
        (status.error || "Feed failed") +
        (suspended ? " — click to retry now" : "");
      probe.classList.add("error");
    } else {
      probe.textContent = "⚡";
      probe.title = "Test connection";
    }

    probe.addEventListener("click", async () => {
      if (pendingProbes.has(f.id)) return;
      const probeStartedAt = Date.now();
      setProbePending(f.id, true);
      scheduleRender();

      const res = await sendMessageSafe({
        action: "probeFeed",
        feedId: f.id,
        url: f.url,
      });

      if (!res) {
        const { feedStatus: current = {} } = await chrome.storage.local.get(
          "feedStatus"
        );
        const existing = current[f.id];
        // If the worker finished the probe but the reply was lost with the
        // channel, keep its result instead of overwriting it with an error.
        if (!existing || !existing.at || existing.at < probeStartedAt) {
          current[f.id] = {
            ...(current[f.id] || {}),
            ok: false,
            error: "Background did not respond. Try again.",
            at: Date.now(),
          };
          await chrome.storage.local.set({ feedStatus: current });
        }
      }

      setProbePending(f.id, false);
      scheduleRender();
    });
    row.appendChild(probe);

    // ---- Skip / resume button ----
    const skip = document.createElement("button");
    skip.type = "button";
    skip.className = "skip" + (manualSkip ? " active" : "");
    skip.textContent = manualSkip ? "▶" : "⏸";
    skip.title = manualSkip
      ? "Skipped on refresh — click to include it again"
      : "Skip this feed on refresh (keeps it subscribed)";
    skip.addEventListener("click", async () => {
      const { skippedFeedIds: current = [] } = await chrome.storage.local.get(
        "skippedFeedIds"
      );
      const set = new Set(current);
      if (set.has(f.id)) set.delete(f.id);
      else set.add(f.id);
      await chrome.storage.local.set({ skippedFeedIds: [...set] });
    });
    row.appendChild(skip);

    // ---- Copy URL button ----
    const copy = document.createElement("button");
    copy.type = "button";
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
        setTimeout(() => {
          copy.textContent = "⧉";
        }, 1200);
      }
    });
    row.appendChild(copy);

    // ---- Remove button ----
    const del = document.createElement("button");
    del.type = "button";
    del.className = "remove";
    del.textContent = "×";
    del.title = "Remove";
    del.addEventListener("click", async () => {
      await removeFeed(f.id);
      setProbePending(f.id, false);
      renderSafe();
    });
    row.appendChild(del);

    li.appendChild(row);

    // ---- Second line: why a feed is skipped / failed ----
    if (suspended) {
      const note = document.createElement("div");
      note.className = "feed-note";

      const text = document.createElement("span");
      const attempts = status.failStreak || 1;
      text.textContent =
        `Auto-skipped after ${attempts} failed refresh${attempts === 1 ? "" : "es"}` +
        (status.error ? `: ${status.error}` : "") +
        (status.suspendedUntil > Date.now()
          ? ` · retried automatically after ${new Date(
              status.suspendedUntil
            ).toLocaleString()}`
          : "");
      note.appendChild(text);

      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "retry";
      retry.textContent = "Retry now";
      retry.addEventListener("click", () => probe.click());
      note.appendChild(retry);

      li.appendChild(note);
    } else if (manualSkip) {
      const note = document.createElement("div");
      note.className = "feed-note";
      note.textContent =
        "Skipped on refresh. Click ▶ to include this feed again.";
      li.appendChild(note);
    } else if (slow) {
      const note = document.createElement("div");
      note.className = "feed-note";
      const nextSecs = status.timeoutMs
        ? Math.round(status.timeoutMs / 1000)
        : 0;
      note.textContent =
        `Slow feed — ${status.error || "last attempt timed out"}.` +
        (nextSecs ? ` Next attempt allows up to ${nextSecs}s.` : "");
      li.appendChild(note);
    } else if (status && status.ok === false && status.skipped) {
      const note = document.createElement("div");
      note.className = "feed-note";
      note.textContent = status.error || "Skipped this refresh.";
      li.appendChild(note);
    } else if (status && status.ok === false && status.error) {
      const err = document.createElement("div");
      err.className = "feed-error";
      err.textContent = status.error;
      li.appendChild(err);
    }

    feedListEl.appendChild(li);
  }
}

async function render() {
  const { feeds, articles, readIds, filterMode, feedStatus, skippedFeedIds } =
    await getState();
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

  let lastKey = "__init__"; // sentinel that cannot collide with a dateKey
  for (const a of visible) {
    const key = dateKey(a.pubDate); // null = no date

    // Insert a date header whenever the day changes.
    if (key !== lastKey) {
      const header = document.createElement("div");
      header.className = "date-header";
      header.textContent = key ? formatGroupDate(key) : "Undated";
      listEl.appendChild(header);
      lastKey = key;
    }
    const isRead = readSet.has(a.id);

    const wrap = document.createElement("div");
    wrap.className = "article" + (isRead ? " read" : "");
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

    // Mark-as-read button: does not open the link. Hidden when already read.
    if (!isRead) {
      const readBtn = document.createElement("button");
      readBtn.type = "button";
      readBtn.className = "read-btn";
      readBtn.textContent = "✓";
      readBtn.title = "Mark as read";
      readBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation(); // don't bubble to wrap and open the link
        await markRead(a.id); // storage.onChanged -> scheduleRender()
      });
      wrap.appendChild(readBtn);
    }

    wrap.addEventListener("click", async (e) => {
      if (e.target.closest(".read-btn")) return;

      const url = a.link;
      if (!/^https?:/i.test(url)) return;
      await markRead(a.id);
      chrome.tabs.create({ url });
    });

    listEl.appendChild(wrap);
  }

  renderFeedList(feeds, feedStatus, skippedFeedIds);
}

refreshBtn.addEventListener("click", () => {
  requestRefresh("manual");
});

toggleFilterBtn.addEventListener("click", async () => {
  const { filterMode } = await getState();
  const next = filterMode === "all" ? "unread" : "all";
  await chrome.storage.local.set({ filterMode: next });
});

// ==================== Mark all as read (+ undo) ====================
// Track only the ids marked by this action, so undo never removes read marks
// created before/after it.
let pendingUndo = null; // { ids: string[], timeoutId: number }
const UNDO_WINDOW_MS = 8000;

function hideUndoBar() {
  if (pendingUndo) {
    clearTimeout(pendingUndo.timeoutId);
    pendingUndo = null;
  }
  undoBarEl.hidden = true;
}

function showUndoBar(count, message) {
  undoTextEl.textContent =
    message ||
    `Marked ${count} article${count === 1 ? "" : "s"} as read.`;
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
    setTimeout(() => {
      markAllReadBtn.classList.remove("marked");
      markAllReadBtn.textContent = "☑";
      markAllReadBtn.disabled = false;
    }, 900);
    return;
  }

  await chrome.storage.local.set({ readIds: [...readSet] });

  markAllReadBtn.classList.add("marked");
  markAllReadBtn.textContent = `${newlyRead.length}`;
  markAllReadBtn.disabled = true;
  setTimeout(() => {
    markAllReadBtn.classList.remove("marked");
    markAllReadBtn.textContent = "☑";
    markAllReadBtn.disabled = false;
  }, 1200);

  hideUndoBar();
  pendingUndo = {
    ids: newlyRead,
    timeoutId: setTimeout(() => {
      hideUndoBar();
    }, UNDO_WINDOW_MS),
  };
  showUndoBar(newlyRead.length);
});

undoBtnEl.addEventListener("click", async () => {
  if (!pendingUndo) {
    undoBarEl.hidden = true;
    return;
  }

  const idsToRestore = new Set(pendingUndo.ids);
  clearTimeout(pendingUndo.timeoutId);
  pendingUndo = null;
  undoBarEl.hidden = true;

  const { readIds } = await getState();
  const restored = readIds.filter((id) => !idsToRestore.has(id));
  await chrome.storage.local.set({ readIds: restored });
});

// ==================== Open all unread (+ mark read) ====================
const OPEN_ALL_ICON = "↗";
const OPEN_ALL_TITLE = "Open all unread in new tabs, then mark read";

function flashOpenAllButton(count) {
  openAllUnreadBtn.classList.add("marked");
  openAllUnreadBtn.textContent = String(count);
  openAllUnreadBtn.title =
    count === 0
      ? "No unread articles to open"
      : `Opened ${count} unread article${count === 1 ? "" : "s"}`;
  openAllUnreadBtn.disabled = true;
  setTimeout(() => {
    openAllUnreadBtn.classList.remove("marked");
    openAllUnreadBtn.textContent = OPEN_ALL_ICON;
    openAllUnreadBtn.title = OPEN_ALL_TITLE;
    openAllUnreadBtn.disabled = false;
  }, count === 0 ? 900 : 1200);
}

openAllUnreadBtn.addEventListener("click", async () => {
  if (openAllUnreadBtn.disabled) return;
  openAllUnreadBtn.disabled = true;

  const { articles, readIds } = await getState();
  const readSet = new Set(readIds);
  const unread = articles.filter((a) => !readSet.has(a.id));

  if (unread.length === 0) {
    flashOpenAllButton(0);
    return;
  }

  openAllUnreadBtn.textContent = "…";
  openAllUnreadBtn.title = "Opening…";

  const openedIds = [];
  let isFirst = true;
  for (const a of unread) {
    if (!/^https?:/i.test(a.link || "")) continue;
    try {
      await chrome.tabs.create({ url: a.link, active: isFirst });
      openedIds.push(a.id);
      isFirst = false;
    } catch {
      // Keep failed opens unread so they can be retried.
    }
  }

  if (openedIds.length > 0) {
    // Re-read to avoid overwriting read state created elsewhere meanwhile.
    const { readIds: latestReadIds = [] } = await chrome.storage.local.get(
      "readIds"
    );
    const merged = new Set(latestReadIds);
    for (const id of openedIds) merged.add(id);
    await chrome.storage.local.set({ readIds: [...merged] });

    hideUndoBar();
    pendingUndo = {
      ids: openedIds,
      timeoutId: setTimeout(() => {
        hideUndoBar();
      }, UNDO_WINDOW_MS),
    };
    showUndoBar(
      openedIds.length,
      `Opened ${openedIds.length} unread article${
        openedIds.length === 1 ? "" : "s"
      } in new tabs and marked ${
        openedIds.length === 1 ? "it" : "them"
      } as read.`
    );
  }

  flashOpenAllButton(openedIds.length);
});

// ==================== Settings ====================
document.getElementById("toggle-settings").addEventListener("click", () => {
  settingsEl.hidden = !settingsEl.hidden;
});

document.getElementById("add-feed").addEventListener("click", async () => {
  const url = feedUrlEl.value.trim();
  if (!/^https?:/i.test(url)) return;

  const { feeds } = await getState();
  if (feeds.some((f) => f.url === url)) {
    feedUrlEl.value = "";
    renderSafe();
    return;
  }

  let title = "";
  try {
    title = new URL(url).hostname;
  } catch {}

  feeds.push({ id: "feed_" + Date.now(), url, title });
  await chrome.storage.local.set({ feeds });

  feedUrlEl.value = "";
  await requestRefresh("add-feed");
  renderSafe();
});

// ==================== Remove all subscriptions ====================
removeAllFeedsBtn.addEventListener("click", async () => {
  const { feeds, articles } = await getState();

  if (feeds.length === 0) {
    removeAllFeedsBtn.textContent = "0";
    setTimeout(() => {
      removeAllFeedsBtn.textContent = "Remove all";
    }, 900);
    return;
  }

  const ok = confirm(
    `Remove all ${feeds.length} subscription${
      feeds.length === 1 ? "" : "s"
    } and ${articles.length} stored article${
      articles.length === 1 ? "" : "s"
    }?\n\nThis cannot be undone.`
  );
  if (!ok) return;

  // Stop a running refresh first, otherwise it could write articles back
  // while we are clearing storage.
  await sendMessageSafe({ action: "cancelRefresh" });

  await chrome.storage.local.set({
    feeds: [],
    articles: [],
    readIds: [],
    feedStatus: {},
    skippedFeedIds: [],
    lastErrors: [],
    lastRefresh: 0,
    refreshProgress: {
      active: false,
      done: 0,
      total: 0,
      finishedAt: Date.now(),
    },
  });

  await chrome.action.setBadgeText({ text: "" });
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
    "  <head>",
    "    <title>RSS Subscriptions</title>",
    `    <dateCreated>${new Date().toUTCString()}</dateCreated>`,
    "  </head>",
    "  <body>",
  ];
  for (const f of feeds) {
    const title = escapeXml(f.title || f.url);
    const xmlUrl = escapeXml(f.url);
    lines.push(
      `    <outline type="rss" text="${title}" title="${title}" xmlUrl="${xmlUrl}" />`
    );
  }
  lines.push("  </body>", "</opml>");
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

    let title = o.getAttribute("title") || o.getAttribute("text") || "";
    if (!title) {
      try {
        title = new URL(xmlUrl).hostname;
      } catch {
        title = xmlUrl;
      }
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
    renderSafe();
    if (result.added > 0) {
      await requestRefresh("import");
    }
    alert(
      `Imported ${result.added} new feed(s). (${result.total} total in file, ${
        result.total - result.added
      } already subscribed.)`
    );
  } catch (err) {
    alert("Import failed: " + (err?.message || err));
  }
});

// ==================== Storage-driven updates ====================
async function initRefreshState() {
  try {
    const { refreshProgress } = await chrome.storage.local.get(
      "refreshProgress"
    );

    if (refreshProgress?.active && !isProgressFresh(refreshProgress)) {
      // Orphaned "active" left by a killed service worker.
      try {
        await chrome.storage.local.set({
          refreshProgress: {
            ...refreshProgress,
            active: false,
            stale: true,
            finishedAt: Date.now(),
          },
        });
      } catch (e) {
        console.warn("RSS: could not clear stale progress:", e);
      }
      applyRefreshState(null);
      return;
    }

    applyRefreshState(refreshProgress);
  } catch (e) {
    // Even if storage is unavailable, don't leave the ⟳ button stuck.
    console.warn("RSS: could not read refresh progress:", e);
    applyRefreshState(null);
  }
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
    changes.feedStatus ||
    changes.skippedFeedIds
  ) {
    scheduleRender();
  }
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) initRefreshState();
});

initRefreshState();
renderSafe();
