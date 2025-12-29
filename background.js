// バックグラウンドスクリプト
console.log("[Background] Background service worker loaded");

// キャッシュ（URLごとのブックマークデータ）
const bookmarkCache = new Map();
const CACHE_EXPIRY_MS = 10 * 60 * 1000; // 10分間キャッシュ

// リクエストIDトラッキング（最新のリクエストのみを処理）
let currentRequestId = 0;

const STAR_BATCH_SIZE = 30;
const STAR_DELAY_MS = 250;
const INCLUDE_EMPTY_COMMENTS = false;

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
    console.log("[Background] Processing REQUEST_BOOKMARKS for:", message.url);
    const requestId = ++currentRequestId;
    fetchAndSendBookmarks(message.url, requestId)
      .then(() => sendResponse({ status: "ok" }))
      .catch((error) => {
        console.error("[Background] Error in REQUEST_BOOKMARKS:", error);
        sendResponse({ status: "error", error: error.message });
      });
    return true; // 非同期レスポンスを示す
  }

  sendResponse({ status: "ok" });
  return true;
});

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
      if (requestId > 0 && requestId < currentRequestId) {
        console.log("[Background] Skipping outdated request:", requestId, "current:", currentRequestId);
        return;
      }
      sendToSidePanel({ type: "BOOKMARKS_UPDATE", data: cached.data, url, requestId });
      return;
    }

    console.log("[Background] Fetching bookmarks for:", url);

    // ローディング状態を送信
    sendToSidePanel({ type: "BOOKMARKS_LOADING", url, requestId });

    const bookmarks = await fetchHatenaBookmarks(url);
    console.log("[Background] Fetched bookmarks:", bookmarks);

    // キャッシュに保存
    bookmarkCache.set(url, {
      data: bookmarks,
      timestamp: Date.now(),
    });

    // 古いリクエストの場合はスキップ（fetch完了後に再チェック）
    if (requestId > 0 && requestId < currentRequestId) {
      console.log("[Background] Skipping outdated request after fetch:", requestId, "current:", currentRequestId);
      return;
    }

    // サイドパネルに送信
    sendToSidePanel({ type: "BOOKMARKS_UPDATE", data: bookmarks, url, requestId });
  } catch (error) {
    console.error("[Background] Error fetching bookmarks:", error);
    // 古いリクエストの場合はエラーも送信しない
    if (requestId > 0 && requestId < currentRequestId) {
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

// はてなブックマークのコメントとスターを取得
async function fetchHatenaBookmarks(targetUrl) {
  console.log("[Background] fetchHatenaBookmarks for:", targetUrl);
  const entry = await fetchHatenaEntry(targetUrl);
  console.log("[Background] Hatena entry:", entry);

  if (!entry || !entry.eid || !Array.isArray(entry.bookmarks)) {
    console.log("[Background] No bookmarks found");
    return {
      targetUrl,
      eid: null,
      bookmarkCount: 0,
      comments: [],
      entryUrl: entry?.entry_url || null,
    };
  }

  const eid = entry.eid;
  const bookmarks = entry.bookmarks;
  console.log("[Background] Found", bookmarks.length, "bookmarks");

  // 各ブックマークに対してスター候補URIを作成
  const candidatesByKey = new Map();

  for (const b of bookmarks) {
    if (!b?.user) continue;
    if (!INCLUDE_EMPTY_COMMENTS && (!b.comment || b.comment.trim() === ""))
      continue;

    const key = makeKey(b);
    const candidates = buildStarTargetCandidates(eid, b);

    if (candidates.length === 0) continue;
    candidatesByKey.set(key, { bookmark: b, candidates });
  }

  // すべての候補URIをフラットにしてスターAPIへ
  const allCandidateUris = unique(
    [...candidatesByKey.values()].flatMap((x) => x.candidates)
  );

  const starCountByUri = await fetchStarCountsForUris(allCandidateUris);

  // 各ブックマークごとに最もスターが付いていたURIを採用
  const out = [];
  for (const { bookmark, candidates } of candidatesByKey.values()) {
    let bestUri = null;
    let bestCount = 0;

    for (const uri of candidates) {
      const c = starCountByUri.get(uri) ?? 0;
      if (c > bestCount) {
        bestCount = c;
        bestUri = uri;
      }
    }

    out.push({
      user: bookmark.user,
      stars: bestCount,
      comment: bookmark.comment ?? "",
      timestamp: bookmark.timestamp ?? "",
      tags: bookmark.tags ?? [],
      starTargetUri: bestUri,
    });
  }

  // スター降順にソート
  out.sort((a, b) => b.stars - a.stars);

  return {
    targetUrl,
    eid,
    bookmarkCount: entry.count ?? 0,
    comments: out,
    entryUrl: entry.entry_url || null,
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

  if (yyyymmdd) {
    uris.push(`https://b.hatena.ne.jp/${user}/${yyyymmdd}#bookmark-${eid}`);
    uris.push(`http://b.hatena.ne.jp/${user}/${yyyymmdd}#bookmark-${eid}`);
  }

  uris.push(`https://b.hatena.ne.jp/entry/${eid}/comment/${user}`);
  uris.push(`http://b.hatena.ne.jp/entry/${eid}/comment/${user}`);

  if (yyyymmdd) {
    uris.push(`https://b.hatena.ne.jp/${user}/${yyyymmdd}`);
    uris.push(`http://b.hatena.ne.jp/${user}/${yyyymmdd}`);
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
async function fetchStarCountsForUris(uris) {
  const result = new Map();
  const cache = new Map();

  for (let i = 0; i < uris.length; i += STAR_BATCH_SIZE) {
    const batch = uris.slice(i, i + STAR_BATCH_SIZE);

    const toFetch = batch.filter((u) => !cache.has(u));
    for (const u of batch) {
      if (cache.has(u)) result.set(u, cache.get(u));
    }
    if (toFetch.length === 0) continue;

    const params = toFetch.map((u) => `uri=${encodeURIComponent(u)}`).join("&");
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
      cache.set(e.uri, count);
      result.set(e.uri, count);
      returned.add(e.uri);
    }

    for (const u of toFetch) {
      if (!returned.has(u)) {
        cache.set(u, 0);
        result.set(u, 0);
      }
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
