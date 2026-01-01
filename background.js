// バックグラウンドスクリプト
console.log("[Background] Background service worker loaded");

// キャッシュ（URLごとのブックマークデータ）
const bookmarkCache = new Map();
const CACHE_EXPIRY_MS = 10 * 60 * 1000; // 10分間キャッシュ

// キャッシュ（hostごとの人気ページデータ）
const originPopularCache = new Map();
const ORIGIN_POPULAR_CACHE_EXPIRY_MS = 60 * 60 * 1000; // 60分間キャッシュ

// スター数キャッシュ（URIごと）
const starCountCache = new Map();
const STAR_COUNT_CACHE_EXPIRY_MS = 60 * 60 * 1000; // 60分

// リクエストIDトラッキング（最新のリクエストのみを処理）
let currentRequestId = 0;

// オリジン人気ページ用のリクエストID（最新のリクエストのみを処理）
let currentOriginPopularRequestId = 0;

const STAR_BATCH_SIZE = 30;
const STAR_DELAY_MS = 250;
const INCLUDE_EMPTY_COMMENTS = false;

function isOutdatedRequest(requestId) {
  return requestId > 0 && requestId < currentRequestId;
}

function isOutdatedOriginPopularRequest(requestId) {
  return requestId > 0 && requestId < currentOriginPopularRequestId;
}

function getCachedStarCount(uri) {
  const v = starCountCache.get(uri);
  if (!v) return null;
  if (Date.now() - v.timestamp > STAR_COUNT_CACHE_EXPIRY_MS) {
    starCountCache.delete(uri);
    return null;
  }
  return v.count;
}

function setCachedStarCount(uri, count) {
  starCountCache.set(uri, { count, timestamp: Date.now() });
}

// 拡張機能のインストール時
chrome.runtime.onInstalled.addListener(() => {
  console.log("[Background] Extension installed");
});

// サイドパネルの動作設定
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) =>
    console.error("[Background] SidePanel behavior error:", error)
  );

// メッセージリスナー（サイドパネルからのリクエストを受信）
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[Background] Message received:", message);

  if (message.type === "REQUEST_BOOKMARKS" && message.url) {
    const requestId = ++currentRequestId;
    console.log(
      "[Background] Processing REQUEST_BOOKMARKS:",
      "url=",
      message.url,
      "tabId=",
      message.tabId,
      "requestId=",
      requestId
    );
    fetchAndSendBookmarksWithCanonical(message.url, message.tabId, requestId)
      .then(() => sendResponse({ status: "ok" }))
      .catch((error) => {
        console.error("[Background] Error in REQUEST_BOOKMARKS:", error);
        sendResponse({ status: "error", error: error.message });
      });
    return true; // 非同期レスポンスを示す
  }

  if (message.type === "REQUEST_ORIGIN_POPULAR" && (message.url || message.origin)) {
    const requestId = ++currentOriginPopularRequestId;
    const urlOrOrigin = message.origin || message.url;
    console.log(
      "[Background] Processing REQUEST_ORIGIN_POPULAR for:",
      urlOrOrigin,
      "requestId:",
      requestId
    );

    fetchAndSendOriginPopular(urlOrOrigin, requestId)
      .then(() => sendResponse({ status: "ok" }))
      .catch((error) => {
        console.error("[Background] Error in REQUEST_ORIGIN_POPULAR:", error);
        sendResponse({ status: "error", error: error.message });
      });
    return true;
  }

  sendResponse({ status: "ok" });
  return true;
});

function isHttpUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

async function tryGetCanonicalUrlFromTab(tabId) {
  if (!Number.isInteger(tabId) || tabId <= 0) {
    return { canonicalUrl: null, status: "invalid-tabId" };
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        try {
          const link = document.querySelector('link[rel="canonical" i]');
          const raw = (link && (link.getAttribute("href") || link.href)) || "";
          const href = String(raw || "").trim();
          if (!href) return null;
          return new URL(href, location.href).toString();
        } catch {
          return null;
        }
      },
    });

    const candidate = results?.[0]?.result;
    if (typeof candidate !== "string") {
      return { canonicalUrl: null, status: "not-found" };
    }
    const s = candidate.trim();
    if (!s) return { canonicalUrl: null, status: "not-found" };
    if (!isHttpUrl(s)) return { canonicalUrl: null, status: "invalid-canonical" };
    return { canonicalUrl: s, status: "found" };
  } catch (error) {
    return {
      canonicalUrl: null,
      status: "error",
      errorMessage: error?.message || String(error),
    };
  }
}

async function fetchAndSendBookmarksWithCanonical(url, tabId, requestId = 0) {
  // http/httpsでないURLは従来通りそのまま処理（executeScriptも不可）
  if (!isHttpUrl(url)) {
    console.log(
      "[Background] REQUEST_BOOKMARKS canonical skipped (non-http(s)):",
      "url=",
      url,
      "requestId=",
      requestId
    );
    return fetchAndSendBookmarks(url, requestId);
  }

  const canonicalResult = await tryGetCanonicalUrlFromTab(tabId);
  const canonical = canonicalResult?.canonicalUrl || null;
  const status = canonicalResult?.status || "unknown";

  if (status === "invalid-tabId") {
    console.log(
      "[Background] REQUEST_BOOKMARKS canonical skipped (missing tabId):",
      "url=",
      url,
      "tabId=",
      tabId,
      "requestId=",
      requestId
    );
    return fetchAndSendBookmarks(url, requestId);
  }

  if (status === "error") {
    console.log(
      "[Background] REQUEST_BOOKMARKS canonical read failed; fallback to original:",
      "url=",
      url,
      "tabId=",
      tabId,
      "requestId=",
      requestId,
      "error=",
      canonicalResult?.errorMessage
    );
    return fetchAndSendBookmarks(url, requestId);
  }

  if (status === "found" && canonical && canonical !== url) {
    console.log(
      "[Background] REQUEST_BOOKMARKS using canonical:",
      "original=",
      url,
      "canonical=",
      canonical,
      "tabId=",
      tabId,
      "requestId=",
      requestId
    );
    return fetchAndSendBookmarks(canonical, requestId);
  }

  if (status === "invalid-canonical") {
    console.log(
      "[Background] REQUEST_BOOKMARKS canonical ignored (non-http(s) canonical):",
      "url=",
      url,
      "tabId=",
      tabId,
      "requestId=",
      requestId
    );
  }

  return fetchAndSendBookmarks(url, requestId);
}

function safeGetHost(urlOrHost) {
  if (!urlOrHost) return null;
  const s = String(urlOrHost).trim();
  if (!s) return null;
  try {
    // host文字列だけの場合もあるので、スキームが無ければ https を仮付けして解釈
    const u = s.includes("://") ? new URL(s) : new URL(`https://${s}`);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.hostname || null;
  } catch {
    return null;
  }
}

function getCachedOriginPopular(host) {
  const v = originPopularCache.get(host);
  if (!v) return null;
  if (Date.now() - v.timestamp > ORIGIN_POPULAR_CACHE_EXPIRY_MS) {
    originPopularCache.delete(host);
    return null;
  }
  return v.data;
}

function setCachedOriginPopular(host, data) {
  originPopularCache.set(host, { data, timestamp: Date.now() });
}

async function fetchAndSendOriginPopular(urlOrOrigin, requestId = 0) {
  const host = safeGetHost(urlOrOrigin);
  if (!host) {
    // 古いリクエストの場合はスキップ
    if (isOutdatedOriginPopularRequest(requestId)) return;
    sendToSidePanel({
      type: "ORIGIN_POPULAR_UPDATE",
      origin: "",
      items: [],
      requestId,
    });
    return;
  }

  const cached = getCachedOriginPopular(host);
  if (cached) {
    if (isOutdatedOriginPopularRequest(requestId)) return;
    sendToSidePanel({
      type: "ORIGIN_POPULAR_UPDATE",
      origin: host,
      items: cached,
      requestId,
    });
    return;
  }

  if (isOutdatedOriginPopularRequest(requestId)) return;
  sendToSidePanel({
    type: "ORIGIN_POPULAR_LOADING",
    origin: host,
    requestId,
  });

  try {
    const items = await fetchHatenaOriginPopular(host);
    setCachedOriginPopular(host, items);

    if (isOutdatedOriginPopularRequest(requestId)) return;
    sendToSidePanel({
      type: "ORIGIN_POPULAR_UPDATE",
      origin: host,
      items,
      requestId,
    });
  } catch (error) {
    if (isOutdatedOriginPopularRequest(requestId)) return;
    sendToSidePanel({
      type: "ORIGIN_POPULAR_ERROR",
      origin: host,
      error: error?.message || String(error),
      requestId,
    });
  }
}

function parseHatenaWrappedJsonArray(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return [];

  // 例: ([{...}, {...}]);
  let s = trimmed;
  if (s.startsWith("(") && s.endsWith(");")) {
    s = s.slice(1, -2).trim();
  } else if (s.startsWith("(") && s.endsWith(")")) {
    s = s.slice(1, -1).trim();
  }

  if (s.endsWith(";")) s = s.slice(0, -1).trim();

  const parsed = JSON.parse(s);
  if (!Array.isArray(parsed)) return [];
  return parsed;
}

async function fetchHatenaOriginPopular(host) {
  const apiUrl =
    "https://b.hatena.ne.jp/entrylist/json?sort=count&url=" +
    encodeURIComponent(host);
  console.log("[Background] Fetching Hatena host popular:", apiUrl);

  const res = await fetch(apiUrl, {
    headers: { "User-Agent": "hatena-sidepanel-extension/1.0" },
  });

  if (!res.ok) {
    throw new Error(
      `Hatena entrylist API error: ${res.status} ${res.statusText}`
    );
  }

  const text = await res.text();
  const arr = parseHatenaWrappedJsonArray(text);

  return arr
    .map((x) => {
      const link = typeof x?.link === "string" ? x.link : "";
      const title = typeof x?.title === "string" ? x.title : "";
      const countRaw = x?.count;
      const count = Number.isFinite(Number(countRaw)) ? Number(countRaw) : 0;
      return { link, title, count };
    })
    .filter((x) => x.link);
}

// はてなブックマークを取得してサイドパネルに送信
async function fetchAndSendBookmarks(url, requestId = 0) {
  console.log("[Background] fetchAndSendBookmarks called for:", url, "requestId:", requestId);
  try {
    // http/httpsでないURLはスキップ
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      console.log("[Background] Skipping non-http(s) URL:", url);
      // 空のデータを送信して、サイドパネルをクリアする
      sendToSidePanel({
        type: "BOOKMARKS_UPDATE",
        data: {
          targetUrl: url,
          eid: null,
          bookmarkCount: 0,
          comments: []
        },
        url,
        requestId
      });
      return;
    }

    // キャッシュチェック
    const cached = bookmarkCache.get(url);
    if (cached && Date.now() - cached.timestamp < CACHE_EXPIRY_MS) {
      console.log("[Background] Using cached data for:", url);
      // 古いリクエストの場合はスキップ
      if (isOutdatedRequest(requestId)) {
        console.log("[Background] Skipping outdated request:", requestId, "current:", currentRequestId);
        return;
      }
      sendToSidePanel({ type: "BOOKMARKS_UPDATE", data: cached.data, url, requestId });
      return;
    }

    console.log("[Background] Fetching bookmarks for:", url);

    // ローディング状態を送信
    sendToSidePanel({ type: "BOOKMARKS_LOADING", url, requestId });

    // まずはコメント一覧（スター0）を即送信して、表示を早める
    const {
      baseData,
      candidatesByIndex,
      allCandidateUris,
    } = await fetchHatenaBookmarksBase(url);

    console.log("[Background] Fetched base bookmarks (no stars yet):", baseData);

    // キャッシュに保存（スターは後で上書きする）
    bookmarkCache.set(url, {
      data: baseData,
      timestamp: Date.now(),
    });

    if (isOutdatedRequest(requestId)) {
      console.log(
        "[Background] Skipping outdated request after base fetch:",
        requestId,
        "current:",
        currentRequestId
      );
      return;
    }

    sendToSidePanel({ type: "BOOKMARKS_UPDATE", data: baseData, url, requestId });

    // スター数はバックグラウンドで取得し、取れたら差分を送る
    if (allCandidateUris.length > 0) {
      const starCountByUri = await fetchStarCountsForUris(
        allCandidateUris,
        () => isOutdatedRequest(requestId),
        (progress) => {
          if (isOutdatedRequest(requestId)) return;
          sendToSidePanel({
            type: "BOOKMARKS_STAR_PROGRESS",
            url,
            requestId,
            progress,
          });
        }
      );

      if (isOutdatedRequest(requestId)) {
        console.log(
          "[Background] Skipping outdated request after star fetch:",
          requestId,
          "current:",
          currentRequestId
        );
        return;
      }

      const withStars = applyStarCounts(baseData, candidatesByIndex, starCountByUri);
      console.log("[Background] Updated bookmarks with stars:", withStars);

      // キャッシュをスター込みで上書き
      bookmarkCache.set(url, {
        data: withStars,
        timestamp: Date.now(),
      });

      sendToSidePanel({ type: "BOOKMARKS_UPDATE", data: withStars, url, requestId });
    }
  } catch (error) {
    console.error("[Background] Error fetching bookmarks:", error);
    // 古いリクエストの場合はエラーも送信しない
    if (isOutdatedRequest(requestId)) {
      console.log("[Background] Skipping outdated error:", requestId, "current:", currentRequestId);
      return;
    }
    sendToSidePanel({ type: "BOOKMARKS_ERROR", error: error.message, url, requestId });
  }
}

// サイドパネルにメッセージを送信
function sendToSidePanel(message) {
  console.log("[Background] Sending message to side panel:", message);
  chrome.runtime.sendMessage(message).then(
    (response) =>
      console.log("[Background] Message sent successfully:", response),
    (error) =>
      console.log(
        "[Background] Message send failed (side panel may not be open):",
        error?.message
      )
  );
}

// はてなブックマークのコメント一覧（スター0）を取得し、スター取得に必要な情報も返す
async function fetchHatenaBookmarksBase(targetUrl) {
  console.log("[Background] fetchHatenaBookmarksBase for:", targetUrl);
  const entry = await fetchHatenaEntry(targetUrl);
  console.log("[Background] Hatena entry:", entry);

  if (!entry || !entry.eid || !Array.isArray(entry.bookmarks)) {
    console.log("[Background] No bookmarks found");
    return {
      baseData: {
        targetUrl,
        eid: null,
        bookmarkCount: 0,
        comments: [],
        entryUrl: entry?.entry_url || null,
      },
      candidatesByIndex: new Map(),
      allCandidateUris: [],
    };
  }

  const eid = entry.eid;
  const bookmarks = entry.bookmarks;
  console.log("[Background] Found", bookmarks.length, "bookmarks");

  const comments = [];
  const candidatesByIndex = new Map();

  for (const b of bookmarks) {
    if (!b?.user) continue;
    if (!INCLUDE_EMPTY_COMMENTS && (!b.comment || b.comment.trim() === ""))
      continue;

    const candidates = buildStarTargetCandidates(eid, b);
    const initialUri = candidates[0] ?? null;

    const index = comments.length;
    comments.push({
      user: b.user,
      stars: 0,
      comment: b.comment ?? "",
      timestamp: b.timestamp ?? "",
      tags: b.tags ?? [],
      starTargetUri: initialUri,
    });

    if (candidates.length > 0) {
      candidatesByIndex.set(index, candidates);
    }
  }

  const allCandidateUris = unique(
    [...candidatesByIndex.values()].flatMap((x) => x)
  );

  return {
    baseData: {
      targetUrl,
      eid,
      bookmarkCount: entry.count ?? 0,
      comments,
      entryUrl: entry.entry_url || null,
    },
    candidatesByIndex,
    allCandidateUris,
  };
}

function applyStarCounts(baseData, candidatesByIndex, starCountByUri) {
  const comments = baseData.comments.map((c) => ({ ...c }));

  for (const [index, candidates] of candidatesByIndex.entries()) {
    let bestUri = comments[index]?.starTargetUri ?? null;
    let bestCount = comments[index]?.stars ?? 0;

    for (const uri of candidates) {
      const c = starCountByUri.get(uri);
      if (typeof c === "number" && c > bestCount) {
        bestCount = c;
        bestUri = uri;
      }
    }

    if (comments[index]) {
      comments[index].stars = bestCount;
      comments[index].starTargetUri = bestUri;
    }
  }

  return {
    ...baseData,
    comments,
  };
}

// Hatena Bookmark Entry API
async function fetchHatenaEntry(targetUrl) {
  const apiUrl =
    "https://b.hatena.ne.jp/entry/jsonlite/?url=" + encodeURIComponent(targetUrl);
  console.log("[Background] Fetching Hatena entry API:", apiUrl);

  const res = await fetch(apiUrl, {
    headers: { "User-Agent": "hatena-sidepanel-extension/1.0" },
  });

  console.log("[Background] Hatena API response status:", res.status);
  if (!res.ok) {
    throw new Error(
      `Hatena Bookmark API error: ${res.status} ${res.statusText}`
    );
  }

  const data = await res.json();
  console.log("[Background] Hatena API response data:", data);
  return data;
}

// スター候補URIを構築
function buildStarTargetCandidates(eid, bookmark) {
  const user = bookmark.user;
  const ts = bookmark.timestamp || "";
  const yyyymmdd = toYYYYMMDD(ts);

  const uris = [];

  // リクエスト数抑制のため、候補URIは必要最小限にする
  // 基本は comment ページ（HTTPS）を使い、日付が取れる場合のみアンカー付きも試す
  uris.push(`https://b.hatena.ne.jp/entry/${eid}/comment/${user}`);
  if (yyyymmdd) {
    uris.push(`https://b.hatena.ne.jp/${user}/${yyyymmdd}#bookmark-${eid}`);
  }

  return unique(uris);
}

// タイムスタンプをYYYYMMDDに変換
function toYYYYMMDD(timestamp) {
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})/.exec(timestamp || "");
  if (!m) return null;
  const yyyy = m[1];
  const mm = m[2].padStart(2, "0");
  const dd = m[3].padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

function makeKey(b) {
  return `${b.user}|${b.timestamp || ""}`;
}

// Hatena Star API から複数URIのスター数を取得
async function fetchStarCountsForUris(uris, shouldCancel, onProgress) {
  const result = new Map();

  // グローバルキャッシュから即復元
  const pending = [];
  for (const u of uris) {
    const cachedCount = getCachedStarCount(u);
    if (typeof cachedCount === "number") {
      result.set(u, cachedCount);
    } else {
      pending.push(u);
    }
  }

  const totalUris = uris.length;
  const cachedUris = totalUris - pending.length;
  const totalBatches = pending.length > 0 ? Math.ceil(pending.length / STAR_BATCH_SIZE) : 0;

  if (typeof onProgress === "function") {
    onProgress({
      phase: pending.length > 0 ? "start" : "done",
      doneBatches: pending.length > 0 ? 0 : totalBatches,
      totalBatches,
      doneUris: cachedUris,
      totalUris,
      percent: totalUris > 0 ? Math.floor((cachedUris / totalUris) * 100) : 100,
    });
  }

  let doneBatches = 0;
  let fetchedUris = 0;

  for (let i = 0; i < pending.length; i += STAR_BATCH_SIZE) {
    if (typeof shouldCancel === "function" && shouldCancel()) {
      console.log("[Background] Star fetch canceled");
      return result;
    }

    const batch = pending.slice(i, i + STAR_BATCH_SIZE);
    if (batch.length === 0) continue;

    const params = batch.map((u) => `uri=${encodeURIComponent(u)}`).join("&");
    const apiUrl = `https://s.hatena.com/entry.json?${params}`;

    const res = await fetch(apiUrl, {
      headers: { "User-Agent": "hatena-sidepanel-extension/1.0" },
    });

    if (!res.ok) {
      throw new Error(`Hatena Star API error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    const entries = Array.isArray(data.entries) ? data.entries : [];

    const returned = new Set();

    for (const e of entries) {
      if (!e || typeof e.uri !== "string") continue;
      const count = Array.isArray(e.stars) ? e.stars.length : 0;
      setCachedStarCount(e.uri, count);
      result.set(e.uri, count);
      returned.add(e.uri);
    }

    for (const u of batch) {
      if (!returned.has(u)) {
        setCachedStarCount(u, 0);
        result.set(u, 0);
      }
    }

    doneBatches += 1;
    fetchedUris += batch.length;

    if (typeof onProgress === "function") {
      const doneUris = Math.min(totalUris, cachedUris + fetchedUris);
      onProgress({
        phase: doneBatches >= totalBatches ? "done" : "progress",
        doneBatches,
        totalBatches,
        doneUris,
        totalUris,
        percent: totalUris > 0 ? Math.floor((doneUris / totalUris) * 100) : 100,
      });
    }

    await sleep(STAR_DELAY_MS);
  }

  return result;
}

function unique(arr) {
  return [...new Set(arr)];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
