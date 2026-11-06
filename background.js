// ---------- Config ----------
const ALARM_NAME = "rss-refresh";
const REFRESH_INTERVAL_MINUTES = 480;
const MAX_ARTICLES = 5000;
const SUMMARY_MAX_LENGTH = 160;

// A slow-but-working source is different from a dead one:
//   - every feed starts with a generous timeout
//   - a feed that times out gets a progressively longer timeout next time
//     (up to MAX_FEED_TIMEOUT_MS), so slow feeds eventually load
//   - timeouts are reported as "slow", not as failures, and never count
//     toward auto-suspension
//   - a global deadline still bounds the whole run
const FEED_TIMEOUT_MS = 60000;
const MAX_FEED_TIMEOUT_MS = 480000;
const FEED_MAX_ATTEMPTS = 2;
const FEED_CONCURRENCY = 4;
// Must be large enough for a full MAX_FEED_TIMEOUT_MS attempt plus overhead.
const REFRESH_DEADLINE_MS = 540000;
const AUTO_SUSPEND_AFTER = 3;
const AUTO_SUSPEND_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const MAX_FEED_BYTES = 10 * 1024 * 1024;

// While a refresh is running, write a small progress heartbeat and touch an
// extension API. This keeps the MV3 service worker alive through a long fetch
// and lets the side panel distinguish "still loading" from "worker died".
const KEEPALIVE_INTERVAL_MS = 15000;

// Progress written by a previous service-worker instance is orphaned the
// moment this one boots. Anything started after BOOT_AT belongs to this one.
const BOOT_AT = Date.now();

// ---------- Unread badge ----------
// Single source of truth: articles + readIds.
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

// Any write that changes articles or readIds recomputes the badge, no matter
// whether the write came from the service worker (refresh) or the side panel
// (opening an article, mark all read, undo, clear).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.articles || changes.readIds) updateBadge();
});

updateBadge();

// ---------- Lifecycle ----------
function ensureAlarm() {
  try {
    const p = chrome.alarms.create(ALARM_NAME, {
      periodInMinutes: REFRESH_INTERVAL_MINUTES,
    });
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch (e) {
    console.error("Could not create alarm:", e);
  }
}

// A refresh belongs to a service-worker instance. If the worker is restarted
// mid-refresh, the `active` flag left in storage would otherwise pin the UI in
// "refreshing" forever. Clear progress that predates this worker boot.
async function clearOrphanedProgress() {
  try {
    const { refreshProgress } = await chrome.storage.local.get("refreshProgress");
    if (!refreshProgress?.active) return;

    const startedAt = refreshProgress.startedAt || 0;
    if (startedAt >= BOOT_AT) return; // started by this worker: still ours

    await chrome.storage.local.set({
      refreshProgress: {
        ...refreshProgress,
        active: false,
        interrupted: true,
        stale: true,
        done: refreshProgress.done || 0,
        total: refreshProgress.total || 0,
        finishedAt: Date.now(),
        updatedAt: Date.now(),
      },
      lastRefreshError:
        "The previous refresh was interrupted (the service worker restarted).",
    });
  } catch (e) {
    console.error("Could not clear orphaned refresh progress:", e);
  }
}

clearOrphanedProgress();

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  clearOrphanedProgress();
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.error(e));
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  clearOrphanedProgress();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) startRefresh({ reason: "alarm" });
});

// ---------- Messaging ----------
// `refresh` acknowledges immediately and runs in the background. Holding the
// message channel open for a multi-minute refresh is what produced
// "A listener indicated an asynchronous response by returning true, but the
// message channel closed before a response was received". Progress is exposed
// through refreshProgress in storage instead.
function safeSendResponse(sendResponse, payload) {
  try {
    sendResponse(payload);
  } catch {
    // The sender (side panel) may have been closed while we were working.
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.action === "refresh") {
    try {
      const result = startRefresh({
        reason: msg.reason || "manual",
      });
      safeSendResponse(sendResponse, {
        ok: true,
        started: result.started,
        alreadyRunning: !result.started,
      });
    } catch (e) {
      safeSendResponse(sendResponse, {
        ok: false,
        error: String(e?.message || e),
      });
    }
    return false;
  }

  if (msg?.action === "cancelRefresh") {
    safeSendResponse(sendResponse, {
      ok: true,
      cancelled: cancelRefreshRun(),
    });
    return false;
  }

  if (msg?.action === "probeFeed" && msg.url) {
    probeFeed(msg.feedId, msg.url)
      .then((res) => safeSendResponse(sendResponse, res))
      .catch((e) =>
        safeSendResponse(sendResponse, {
          ok: false,
          error: String(e?.message || e),
        })
      );
    return true;
  }

  if (msg?.action === "openLink" && msg.url) {
    chrome.tabs.create({ url: msg.url });
    safeSendResponse(sendResponse, { ok: true });
    return false;
  }

  return false;
});

// ---------- Parsing helpers ----------
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
    const rel = (
      attrs.match(/rel=["']([^"']+)["']/i)?.[1] || "alternate"
    ).toLowerCase();
    if (rel === "alternate") {
      alternate = url;
      break;
    }
    if (!fallback) fallback = url;
  }
  return alternate || fallback || "";
}

function parseFeed(xmlText) {
  const head = xmlText.slice(0, 4000);
  const looksLikeFeed = /<(rss|feed|rdf:RDF)\b/i.test(head);
  const hasItems = /<(item|entry)\b/i.test(xmlText);

  // A 200 response that is actually an HTML error page used to look like a
  // healthy feed with zero items. Treat it as broken so it is visible.
  if (!looksLikeFeed && !hasItems) {
    throw new Error("Response is not an RSS/Atom feed");
  }

  const isAtom = /<feed\b/i.test(head) && !/<rss\b/i.test(head);
  const blockRe = isAtom
    ? /<entry\b[\s\S]*?<\/entry>/gi
    : /<item\b[\s\S]*?<\/item>/gi;

  // Feed-level title lives before the first item/entry.
  const firstBlockIdx = xmlText.search(isAtom ? /<entry\b/i : /<item\b/i);
  const feedHead = firstBlockIdx >= 0 ? xmlText.slice(0, firstBlockIdx) : xmlText;
  const feedTitle = pickTag(feedHead, "title") || "";

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

// ---------- Fetching (timeout + size cap + deadline aware) ----------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function timeoutError(budgetMs, requestedMs) {
  // If the global deadline (not the per-feed timeout) cut the attempt short,
  // the feed was never really tested and should not be called "slow".
  const deadlineLimited = budgetMs < requestedMs;
  const err = new Error(
    deadlineLimited
      ? "Refresh time limit reached"
      : `Timed out after ${Math.max(1, Math.round(budgetMs / 1000))}s`
  );
  err.code = deadlineLimited ? "DEADLINE" : "TIMEOUT";
  return err;
}

function cancelledError() {
  const err = new Error("Cancelled");
  err.code = "CANCELLED";
  return err;
}

async function fetchFeed(
  feed,
  {
    deadlineAt = Infinity,
    timeoutMs = FEED_TIMEOUT_MS,
    attempt = 1,
    signal: outerSignal = null,
  } = {}
) {
  if (outerSignal?.aborted) throw cancelledError();
  const budget = Math.min(timeoutMs, deadlineAt - Date.now());
  if (budget <= 0) throw timeoutError(0, timeoutMs);

  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, budget);

  const onOuterAbort = () => ctrl.abort();
  outerSignal?.addEventListener("abort", onOuterAbort, { once: true });

  let res;
  try {
    res = await fetch(feed.url, {
      cache: "no-store",
      redirect: "follow",
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    outerSignal?.removeEventListener("abort", onOuterAbort);

    if (outerSignal?.aborted && !timedOut) {
      throw cancelledError();
    }
    if (timedOut || ctrl.signal.aborted) {
      throw timeoutError(budget, timeoutMs);
    }

    // Only retry fast failures (DNS/connection resets). Never retry a
    // timeout: relying on a longer timeout instead is what helps slow feeds.
    if (attempt < FEED_MAX_ATTEMPTS && Date.now() + 1000 < deadlineAt) {
      await sleep(300 * attempt);
      return fetchFeed(feed, {
        deadlineAt,
        timeoutMs,
        attempt: attempt + 1,
        signal: outerSignal,
      });
    }

    let host = feed.url;
    try {
      host = new URL(feed.url).host;
    } catch {}
    throw new Error(
      `Could not connect to ${host} (${attempt} attempt${
        attempt === 1 ? "" : "s"
      })`
    );
  }

  try {
    if (!res.ok) {
      throw new Error(
        `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`
      );
    }

    const cl = res.headers.get("content-length");
    if (cl !== null && Number(cl) > MAX_FEED_BYTES) {
      throw new Error(
        `Feed too large (${(Number(cl) / 1024 / 1024).toFixed(1)} MB)`
      );
    }

    if (!res.body) throw new Error("Empty response body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let received = 0;
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_FEED_BYTES) {
        try {
          await reader.cancel();
        } catch {}
        throw new Error(`Feed exceeded ${MAX_FEED_BYTES / 1024 / 1024} MB`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();

    if (!text.trim()) throw new Error("Empty feed response");
    return parseFeed(text);
  } catch (e) {
    if (outerSignal?.aborted && !timedOut) throw cancelledError();
    if (timedOut || ctrl.signal.aborted) {
      throw timeoutError(budget, timeoutMs);
    }
    throw e;
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener("abort", onOuterAbort);
  }
}

// ---------- Feed health helpers ----------
function clampTimeout(ms) {
  return Math.min(
    MAX_FEED_TIMEOUT_MS,
    Math.max(FEED_TIMEOUT_MS, Math.round(ms))
  );
}

function timeoutFor(status) {
  return clampTimeout(status?.timeoutMs || FEED_TIMEOUT_MS);
}

function okStatus(prev, count, durationMs = 0) {
  const next = {
    ...(prev || {}),
    ok: true,
    count,
    at: Date.now(),
    failStreak: 0,
    suspended: false,
    suspendedUntil: 0,
    skipped: false,
    slow: false,
    slowTimeouts: 0,
    // Remember how long a working fetch took, so a genuinely large/slow feed
    // gets enough time on the next run instead of timing out repeatedly.
    timeoutMs: clampTimeout(Math.max(FEED_TIMEOUT_MS, durationMs * 4)),
  };
  if (durationMs > 0) next.lastDurationMs = durationMs;
  delete next.error;
  return next;
}

// A timeout is not a failure: keep the feed eligible, remember that it is
// slow, and double its timeout for next time (capped).
function slowStatus(prev, error) {
  return {
    ...(prev || {}),
    ok: false,
    slow: true,
    error,
    at: Date.now(),
    slowTimeouts: ((prev && prev.slowTimeouts) || 0) + 1,
    timeoutMs: clampTimeout(((prev && prev.timeoutMs) || FEED_TIMEOUT_MS) * 2),
    skipped: false,
    // failStreak / suspended are intentionally left alone.
  };
}

// Counts a hard failure (HTTP error, invalid feed, connection failure) and
// auto-suspends after AUTO_SUSPEND_AFTER consecutive ones. Slow timeouts use
// slowStatus() instead and never reach this function.
function failedStatus(prev, error) {
  const failStreak = ((prev && prev.failStreak) || 0) + 1;
  const suspended = failStreak >= AUTO_SUSPEND_AFTER;
  return {
    ...(prev || {}),
    ok: false,
    slow: false,
    error,
    at: Date.now(),
    failStreak,
    suspended,
    suspendedUntil: suspended ? Date.now() + AUTO_SUSPEND_COOLDOWN_MS : 0,
    skipped: false,
  };
}

function isSuspendedNow(status, now = Date.now()) {
  if (!status?.suspended) return false;
  return !status.suspendedUntil || status.suspendedUntil > now;
}

async function updateFeedTitle(feedId, newTitle) {
  if (!newTitle) return;
  const { feeds = [] } = await chrome.storage.local.get("feeds");
  const f = feeds.find((x) => x.id === feedId);
  if (!f || f.title === newTitle) return;
  f.title = newTitle;
  await chrome.storage.local.set({ feeds });
}

async function probeFeed(feedId, url) {
  const { feedStatus = {} } = await chrome.storage.local.get("feedStatus");
  const prev = feedStatus[feedId] || {};
  const startedAt = Date.now();
  // A slow feed's probe can take up to MAX_FEED_TIMEOUT_MS; keep the service
  // worker alive for the duration.
  const keepAlive = startKeepAlive();

  try {
    const { feedTitle, items } = await fetchFeed(
      { id: feedId, url },
      { timeoutMs: timeoutFor(prev) }
    );
    feedStatus[feedId] = okStatus(prev, items.length, Date.now() - startedAt);
    await chrome.storage.local.set({ feedStatus });
    await updateFeedTitle(feedId, feedTitle);
    // A successful manual probe always makes a feed eligible again.
    return { ok: true, count: items.length, revived: !!prev.suspended };
  } catch (e) {
    const error = String(e?.message || e);
    const isSlow = e?.code === "TIMEOUT";

    // Probe failures are diagnostic only: they must not increase the
    // auto-suspend streak. A timeout still raises the feed's next timeout.
    feedStatus[feedId] = isSlow
      ? slowStatus(prev, error)
      : {
          ...prev,
          ok: false,
          error,
          at: Date.now(),
          skipped: false,
        };
    await chrome.storage.local.set({ feedStatus });
    return { ok: false, error, slow: isSlow };
  } finally {
    stopKeepAlive(keepAlive);
  }
}

// ---------- Refresh (single-flight, bounded, incremental writes) ----------
let refreshPromise = null;
let activeToken = null;
// A refresh requested while another is running (e.g. a feed was just added)
// is coalesced into one follow-up run instead of being dropped.
let queuedRefresh = null;

function startRefresh(opts = {}) {
  if (refreshPromise) {
    // Re-running the scheduled refresh immediately is pointless, but a manual
    // add/import request must not be lost.
    if (opts.reason !== "alarm") {
      queuedRefresh = {
        reason: opts.reason || queuedRefresh?.reason || "manual",
      };
    }
    return { started: false, alreadyRunning: true, promise: refreshPromise };
  }

  const token = { cancelled: false, controller: new AbortController() };
  activeToken = token;

  const promise = doRefreshAllFeeds(opts, token)
    .catch(async (e) => {
      console.error("RSS: refresh failed:", e);
      // Never leave the UI waiting on a run that died before it could write
      // its own final progress record.
      try {
        const now = Date.now();
        await chrome.storage.local.set({
          refreshProgress: {
            active: false,
            done: 0,
            total: 0,
            skipped: 0,
            failed: 0,
            slow: 0,
            startedAt: now,
            updatedAt: now,
            finishedAt: now,
            error: String(e?.message || e),
          },
          lastRefreshError: String(e?.message || e),
        });
      } catch (writeErr) {
        console.error("RSS: could not record refresh failure:", writeErr);
      }
      return null;
    })
    .finally(() => {
      if (refreshPromise === promise) refreshPromise = null;
      if (activeToken === token) activeToken = null;

      const next = queuedRefresh;
      queuedRefresh = null;
      if (next) {
        try {
          startRefresh(next);
        } catch (e) {
          console.error("RSS: queued refresh failed to start:", e);
        }
      }
    });

  refreshPromise = promise;
  return { started: true, alreadyRunning: false, promise };
}

function cancelRefreshRun() {
  queuedRefresh = null;
  if (!activeToken) return false;
  activeToken.cancelled = true;
  try {
    activeToken.controller.abort();
  } catch {}
  return true;
}

function startKeepAlive(onTick) {
  try {
    return setInterval(() => {
      try {
        const p = chrome.runtime.getPlatformInfo?.();
        if (p && typeof p.catch === "function") p.catch(() => {});
      } catch {}
      if (typeof onTick === "function") {
        try {
          onTick();
        } catch (e) {
          console.error("RSS: keepalive tick failed:", e);
        }
      }
    }, KEEPALIVE_INTERVAL_MS);
  } catch {
    return null;
  }
}

function stopKeepAlive(id) {
  if (id !== null && id !== undefined) clearInterval(id);
}

function buildArticleList(map, readSet) {
  let arr = [...map.values()];
  arr.sort((a, b) => {
    const ta = a.pubDate ? Date.parse(a.pubDate) : 0;
    const tb = b.pubDate ? Date.parse(b.pubDate) : 0;
    return (tb || 0) - (ta || 0);
  });
  if (arr.length > MAX_ARTICLES) arr = arr.slice(0, MAX_ARTICLES);
  return arr.map((a) => ({ ...a, read: readSet.has(a.id) }));
}

async function doRefreshAllFeeds({ reason = "manual" } = {}, token) {
  const runId = `run_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 7)}`;
  const startedAt = Date.now();
  const deadlineAt = startedAt + REFRESH_DEADLINE_MS;
  let keepAlive = null;
  let heartbeatStopped = false;

  let feeds = [];
  let candidates = [];
  let preSkipped = 0;
  let done = 0;
  let failed = 0;
  let slowFeeds = 0;
  let skippedByDeadline = 0;
  let newItems = 0;
  let dirtyArticles = false;
  let writeError = null;
  let fatalError = null;
  const errors = [];

  let map = new Map();
  let feedStatus = {};
  let readSet = new Set();
  let discoveredTitles = new Map();
  let manualSkipSet = new Set();

  let flushQueue = Promise.resolve();

  const buildProgress = () => ({
    active: true,
    runId,
    reason,
    done,
    total: candidates.length,
    skipped: preSkipped + skippedByDeadline,
    failed,
    slow: slowFeeds,
    startedAt,
    updatedAt: Date.now(),
    deadlineAt,
  });

  const flush = (opts = {}) => {
    const withArticles = opts.forceArticles || dirtyArticles;
    if (withArticles) dirtyArticles = false;

    const p = flushQueue
      .then(async () => {
        const payload = { feedStatus, refreshProgress: buildProgress() };
        if (withArticles) {
          payload.articles = buildArticleList(map, readSet);
        }
        await chrome.storage.local.set(payload);
      })
      .catch((e) => {
        // A failed write must not break the queue or leave the run stuck.
        writeError = e;
        console.error("RSS: storage write failed:", e);
      });

    flushQueue = p;
    return p;
  };

  // Heartbeat: refresh progress.updatedAt while a fetch is in flight. The
  // side panel can then use a short staleness window even though one feed may
  // legitimately take MAX_FEED_TIMEOUT_MS (480s).
  keepAlive = startKeepAlive(() => {
    if (!heartbeatStopped) flush();
  });

  const processFeed = async (feed) => {
    if (token.cancelled) return;

    if (Date.now() >= deadlineAt - 1000) {
      feedStatus[feed.id] = {
        ...(feedStatus[feed.id] || {}),
        ok: false,
        skipped: true,
        error: "Skipped — refresh time limit reached (will retry next refresh)",
        at: Date.now(),
      };
      skippedByDeadline++;
      return;
    }

    const fetchStartedAt = Date.now();
    const prev = feedStatus[feed.id] || {};

    try {
      const { feedTitle, items } = await fetchFeed(feed, {
        deadlineAt,
        timeoutMs: timeoutFor(prev),
        signal: token.controller.signal,
      });

      let added = 0;
      for (const it of items) {
        if (!map.has(it.id)) added++;
        map.set(it.id, {
          ...it,
          feedId: feed.id,
          feedTitle: feedTitle || feed.title || feed.url,
        });
      }

      if (added > 0) {
        newItems += added;
        dirtyArticles = true;
      }

      // Use the latest status as the base in case a manual probe finished
      // while this fetch was in flight.
      feedStatus[feed.id] = okStatus(
        feedStatus[feed.id] || prev,
        items.length,
        Date.now() - fetchStartedAt
      );

      if (feedTitle && feedTitle !== feed.title) {
        discoveredTitles.set(feed.id, feedTitle);
        feed.title = feedTitle;
      }
    } catch (e) {
      if (token.cancelled || e?.code === "CANCELLED") return;
      const error = String(e?.message || e);
      const latest = feedStatus[feed.id] || prev;

      // The global time limit cut this attempt short; the feed was not
      // actually tested, so don't call it slow or broken.
      if (e?.code === "DEADLINE") {
        feedStatus[feed.id] = {
          ...latest,
          ok: false,
          skipped: true,
          error: "Skipped — refresh time limit reached (will retry next refresh)",
          at: Date.now(),
        };
        skippedByDeadline++;
        return;
      }

      // A slow feed keeps its old articles and stays eligible. Its next
      // attempt gets double the timeout (capped at MAX_FEED_TIMEOUT_MS).
      if (e?.code === "TIMEOUT") {
        feedStatus[feed.id] = slowStatus(latest, error);
        slowFeeds++;
        return;
      }

      const next = failedStatus(latest, error);
      feedStatus[feed.id] = next;
      errors.push({
        feedId: feed.id,
        url: feed.url,
        error,
        failStreak: next.failStreak,
        suspended: next.suspended,
      });
      failed++;
    }
  };

  try {
    const stored = await chrome.storage.local.get([
      "feeds",
      "readIds",
      "articles",
      "feedStatus",
      "skippedFeedIds",
    ]);

    feeds = stored.feeds || [];
    readSet = new Set(stored.readIds || []);
    manualSkipSet = new Set(stored.skippedFeedIds || []);
    feedStatus = { ...(stored.feedStatus || {}) };
    map = new Map((stored.articles || []).map((a) => [a.id, a]));
    discoveredTitles = new Map();

    const now = Date.now();
    for (const feed of feeds) {
      if (manualSkipSet.has(feed.id)) {
        preSkipped++;
        continue;
      }
      // Auto-suspended feeds are passed over so a dead source cannot consume
      // the time budget every time. They return on their own after the
      // cooldown, or immediately when a manual probe succeeds.
      if (isSuspendedNow(feedStatus[feed.id], now)) {
        preSkipped++;
        continue;
      }
      candidates.push(feed);
    }

    // Healthy feeds first (so useful articles appear early). Slow and
    // deadline-skipped feeds come next, hard-failed ones last. Within a
    // group, the least recently attempted feed goes first to avoid starving
    // slow feeds when the global deadline is hit.
    const priority = (f) => {
      const st = feedStatus[f.id];
      if (!st) return 1;
      if (st.slow || st.skipped) return 1;
      if (st.ok === false) return 2;
      return 0;
    };
    candidates.sort((a, b) => {
      const d = priority(a) - priority(b);
      if (d !== 0) return d;
      return (feedStatus[a.id]?.at || 0) - (feedStatus[b.id]?.at || 0);
    });

    await flush();

    let cursor = 0;
    const worker = async () => {
      while (!token.cancelled) {
        const index = cursor++;
        if (index >= candidates.length) return;

        try {
          await processFeed(candidates[index]);
        } catch (e) {
          console.error("RSS: unexpected feed error:", e);
          failed++;
        }

        done++;
        await flush();
      }
    };

    const workerCount = Math.min(FEED_CONCURRENCY, candidates.length);
    await Promise.all(
      Array.from({ length: workerCount }, () => worker())
    );

    // Re-read the live subscription list: the user may have removed feeds
    // while this refresh was running.
    const { feeds: latestFeeds = [] } = await chrome.storage.local.get("feeds");
    const liveFeedIds = new Set(latestFeeds.map((f) => f.id));

    for (const [id, article] of map) {
      if (!liveFeedIds.has(article.feedId)) {
        map.delete(id);
        dirtyArticles = true;
      }
    }
    for (const id of Object.keys(feedStatus)) {
      if (!liveFeedIds.has(id)) delete feedStatus[id];
    }

    // Persist newly discovered titles in one read-modify-write, preserving
    // feeds added by the side panel while we were running.
    if (discoveredTitles.size > 0) {
      let changed = false;
      for (const f of latestFeeds) {
        const title = discoveredTitles.get(f.id);
        if (title && f.title !== title) {
          f.title = title;
          changed = true;
        }
      }
      if (changed) await chrome.storage.local.set({ feeds: latestFeeds });
    }

    dirtyArticles = true;
    await flush({ forceArticles: true });
    await chrome.storage.local.set({
      lastErrors: errors,
      lastRefresh: Date.now(),
    });
  } catch (e) {
    fatalError = String(e?.message || e);
    console.error("RSS: refresh aborted:", e);
  } finally {
    heartbeatStopped = true;
    stopKeepAlive(keepAlive);
    await flushQueue.catch(() => {});

    const finishedAt = Date.now();
    const summary = {
      active: false,
      runId,
      reason,
      done,
      total: candidates.length,
      skipped: preSkipped + skippedByDeadline,
      failed,
      slow: slowFeeds,
      newItems,
      startedAt,
      updatedAt: finishedAt,
      finishedAt,
      interrupted: false,
      cancelled: token.cancelled,
    };
    if (writeError) {
      summary.writeError = String(writeError?.message || writeError);
    }
    if (fatalError) summary.error = fatalError;

    try {
      await chrome.storage.local.set({
        refreshProgress: summary,
        lastRefresh: finishedAt,
      });
    } catch (e) {
      console.error("RSS: could not finalize refresh progress:", e);
    }

    await updateBadge();
  }
}
