// サイドパネルの初期化
console.log("[SidePanel] Side panel loaded");

// 現在の表示データ
let currentUrl = "";
let currentBookmarks = null;
let currentSortOrder = "stars"; // 'stars' or 'date'
let expectedUrl = ""; // 現在ロード中または表示中のURL
let tabListenersRegistered = false;

// オリジン人気ページ
let currentOrigin = "";
let expectedOrigin = "";
let currentOriginPopularItems = null;

// スター取得の進捗表示（background から通知される）
let starFetchProgress = {
  url: "",
  active: false,
  text: "",
};

async function requestBookmarks(url) {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    chrome.runtime.sendMessage({
      type: "REQUEST_BOOKMARKS",
      url,
      tabId: tab?.id,
    });
  } catch {
    // tabId が取れない環境でも最低限動くようにする
    chrome.runtime.sendMessage({ type: "REQUEST_BOOKMARKS", url });
  }
}

function setStarFetchProgressForUrl(url, progress) {
  if (!url) return;

  const phase = progress?.phase;
  const doneBatches = Number(progress?.doneBatches ?? 0);
  const totalBatches = Number(progress?.totalBatches ?? 0);
  const doneUris = Number(progress?.doneUris ?? 0);
  const totalUris = Number(progress?.totalUris ?? 0);
  const percent = Number(progress?.percent ?? 0);

  if (phase === "done") {
    starFetchProgress = { url, active: false, text: "" };
    return;
  }

  starFetchProgress = {
    url,
    active: true,
    text: `スター取得中… ${percent}%`,
  };
}

function updateStarProgressUI() {
  const el = document.getElementById("star-progress");
  if (!el) return;

  const show =
    starFetchProgress.active && starFetchProgress.url === currentUrl;

  if (show) {
    el.textContent = starFetchProgress.text;
    el.classList.remove("hidden");
  } else {
    el.textContent = "";
    el.classList.add("hidden");
  }
}

function safeGetOriginFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.hostname;
  } catch {
    return "";
  }
}

function requestOriginPopularForUrl(url) {
  const origin = safeGetOriginFromUrl(url);
  currentOrigin = origin;
  expectedOrigin = origin;
  currentOriginPopularItems = null;

  if (!origin) {
    showPopularError(url, "このURLでは人気ページを取得できません");
    return;
  }

  showPopularLoading(origin);
  chrome.runtime.sendMessage({ type: "REQUEST_ORIGIN_POPULAR", url });
}

// 初期化処理
async function init() {
  console.log("[SidePanel] Initializing...");
  try {
    // 現在のアクティブタブのブックマークを表示
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    console.log("[SidePanel] Current tab:", tab);
    if (tab?.url) {
      console.log("[SidePanel] Tab URL:", tab.url);
      showLoading(tab.url);
      // バックグラウンドスクリプトに明示的にリクエスト
      requestBookmarks(tab.url);

      registerTabListeners();
    } else {
      console.log("[SidePanel] No tab URL found");
      showError("", "タブのURLを取得できませんでした");
    }
  } catch (error) {
    console.error("[SidePanel] Init error:", error);
    showError("", error.message);
  }
}

function registerTabListeners() {
  if (tabListenersRegistered) return;
  tabListenersRegistered = true;

  chrome.tabs.onActivated.addListener(async (activeInfo) => {
    try {
      const tab = await chrome.tabs.get(activeInfo.tabId);
      if (!tab?.url) return;
      showLoading(tab.url);
      chrome.runtime.sendMessage({ type: "REQUEST_BOOKMARKS", url: tab.url, tabId: tab.id });
    } catch (error) {
      console.error("[SidePanel] Error in tabs.onActivated:", error);
    }
  });

  chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status !== "complete" || !tab?.active || !tab?.url) return;
    try {
      showLoading(tab.url);
      chrome.runtime.sendMessage({ type: "REQUEST_BOOKMARKS", url: tab.url, tabId });
    } catch (error) {
      console.error("[SidePanel] Error in tabs.onUpdated:", error);
    }
  });
}

// ローディング表示
function showLoading(url) {
  console.log("[SidePanel] Showing loading for:", url);
  currentUrl = url;
  expectedUrl = url;
  currentOrigin = safeGetOriginFromUrl(url);
  expectedOrigin = currentOrigin;
  currentOriginPopularItems = null;
  // 次の表示に向けて進捗をリセット
  starFetchProgress = { url, active: false, text: "" };
  const container = document.getElementById("bookmarks-container");
  if (!container) {
    console.error("[SidePanel] Container element not found!");
    return;
  }
  container.innerHTML = `
    <div class="loading">
      <div class="spinner"></div>
      <p>はてなブックマークを読み込み中...</p>
      <p class="url">${escapeHtml(url)}</p>
    </div>
  `;
}

function buildTabsHtml({
  active,
  bookmarkCountText = "",
  entryUrl = null,
  showBookmarkCount = true,
  showStarProgress = true,
} = {}) {
  const bookmarkCountHtml =
    showBookmarkCount && bookmarkCountText
      ? entryUrl
        ? `<a href="${escapeHtml(
          entryUrl
        )}" target="_blank" class="bookmark-count" title="はてなブックマークで見る">${bookmarkCountText}</a>`
        : `<div class="bookmark-count">${bookmarkCountText}</div>`
      : "";

  const starProgressHtml = showStarProgress
    ? `<div id="star-progress" class="star-progress hidden"></div>`
    : "";

  return `
    <div class="header-info">
      <div class="sort-tabs">
        <button class="sort-tab ${active === "stars" ? "active" : ""}" data-sort="stars" title="スター数順">⭐</button>
        <button class="sort-tab ${active === "date" ? "active" : ""}" data-sort="date" title="新着順">🕐</button>
        <button class="sort-tab ${active === "popular" ? "active" : ""}" data-sort="popular" title="サイト人気">🔥</button>
        ${bookmarkCountHtml}
      </div>
      ${starProgressHtml}
    </div>
  `;
}

function attachTabHandlers(container) {
  const sortTabs = container.querySelectorAll(".sort-tab");
  sortTabs.forEach((tab) => {
    tab.addEventListener("click", (e) => {
      const sortOrder = e.currentTarget.dataset.sort;
      console.log("[SidePanel] Sort order changed to:", sortOrder);
      currentSortOrder = sortOrder;

      if (currentSortOrder === "popular") {
        requestOriginPopularForUrl(currentUrl);
        return;
      }

      if (currentBookmarks) {
        showBookmarks(currentUrl, currentBookmarks);
      } else {
        showLoading(currentUrl);
        requestBookmarks(currentUrl);
      }
    });
  });
}

function showPopularLoading(origin) {
  const container = document.getElementById("bookmarks-container");
  if (!container) return;

  container.innerHTML = `
    ${buildTabsHtml({ active: "popular", showBookmarkCount: false, showStarProgress: false })}
    <div class="loading">
      <div class="spinner"></div>
      <p>サイトの人気ページを読み込み中...</p>
      <p class="url">${escapeHtml(origin)}</p>
    </div>
  `;

  attachTabHandlers(container);
}

function showPopularError(url, error) {
  const container = document.getElementById("bookmarks-container");
  if (!container) return;

  const origin = safeGetOriginFromUrl(url);
  container.innerHTML = `
    ${buildTabsHtml({ active: "popular", showBookmarkCount: false, showStarProgress: false })}
    <div class="error">
      <p>エラーが発生しました</p>
      <p class="error-message">${escapeHtml(error)}</p>
      ${origin ? `<p class="url">${escapeHtml(origin)}</p>` : ""}
    </div>
  `;

  attachTabHandlers(container);
}

function showPopular(origin, items) {
  const container = document.getElementById("bookmarks-container");
  if (!container) return;

  if (!Array.isArray(items) || items.length === 0) {
    container.innerHTML = `
      ${buildTabsHtml({ active: "popular", showBookmarkCount: false, showStarProgress: false })}
      <div class="no-bookmarks">
        <div class="spinner"></div>
        <p>人気ページが見つかりませんでした</p>
        <p class="url">${escapeHtml(origin)}</p>
      </div>
    `;
    attachTabHandlers(container);
    return;
  }

  const siteUrl = `https://b.hatena.ne.jp/site/${encodeURIComponent(origin)}/`;
  let html = `
    ${buildTabsHtml({ active: "popular", showBookmarkCount: false, showStarProgress: false })}
    <div class="url-display"><a href="${escapeHtml(
    siteUrl
  )}" target="_blank" rel="noopener noreferrer">${escapeHtml(
    origin
  )}</a> の人気</div>
    <div class="bookmarks-list">
  `;

  for (const item of items) {
    const title = item?.title ? String(item.title) : item?.link ? String(item.link) : "";
    const link = item?.link ? String(item.link) : "";
    const count = Number(item?.count ?? 0);

    html += `
      <div class="bookmark-item">
        <div class="bookmark-header">
          <a href="${escapeHtml(link)}" target="_blank" class="user-link">${escapeHtml(title)}</a>
          <div class="meta"><span class="stars">${Number.isFinite(count) && count > 0 ? `★ ${count}` : ""}</span></div>
        </div>
        <div class="url">${escapeHtml(link)}</div>
      </div>
    `;
  }

  html += "</div>";
  container.innerHTML = html;
  attachTabHandlers(container);
}

// エラー表示
function showError(url, error) {
  console.log("[SidePanel] Showing error for:", url, "Error:", error);
  currentUrl = url;
  const container = document.getElementById("bookmarks-container");
  if (!container) {
    console.error("[SidePanel] Container element not found!");
    return;
  }
  container.innerHTML = `
    <div class="error">
      <p>エラーが発生しました</p>
      <p class="error-message">${escapeHtml(error)}</p>
      ${url ? `<p class="url">${escapeHtml(url)}</p>` : ""}
    </div>
  `;
}

// ブックマーク表示
function showBookmarks(url, data) {
  console.log("[SidePanel] Showing bookmarks for:", url, "Data:", data);
  currentUrl = url;
  currentBookmarks = data;
  currentOrigin = safeGetOriginFromUrl(url);
  expectedOrigin = currentOrigin;

  const container = document.getElementById("bookmarks-container");
  if (!container) {
    console.error("[SidePanel] Container element not found!");
    return;
  }

  const bookmarkCountText =
    data.bookmarkCount > 0 ? `${data.bookmarkCount} users` : "";
  const entryUrl = data.entryUrl || null;

  if (!data.comments || data.comments.length === 0) {
    container.innerHTML = `
      ${buildTabsHtml({
      active: currentSortOrder,
      bookmarkCountText,
      entryUrl,
      showBookmarkCount: true,
      showStarProgress: true,
    })}
      <div class="no-bookmarks">
        <div class="spinner"></div>
        <p>このページにはブックマークコメントがありません</p>
        <p class="url">${escapeHtml(url)}</p>
      </div>
    `;
    attachTabHandlers(container);
    updateStarProgressUI();
    return;
  }

  // ソート順に応じてコメントをソート
  const sortedComments = [...data.comments];
  if (currentSortOrder === "stars") {
    sortedComments.sort((a, b) => b.stars - a.stars);
  } else if (currentSortOrder === "date") {
    sortedComments.sort((a, b) => {
      // timestampを比較（新しい順）
      const dateA = parseTimestamp(a.timestamp);
      const dateB = parseTimestamp(b.timestamp);
      return dateB - dateA;
    });
  }

  let html = `
    ${buildTabsHtml({
    active: currentSortOrder,
    bookmarkCountText,
    entryUrl,
    showBookmarkCount: true,
    showStarProgress: true,
  })}
    <div class="bookmarks-list">
  `;

  for (const comment of sortedComments) {
    const starText = comment.stars > 0 ? `★ ${comment.stars}` : "";
    const starLink = `https://b.hatena.ne.jp/entry/${data.eid
      }/comment/${escapeHtml(comment.user)}`;
    const tagsHtml =
      comment.tags && comment.tags.length > 0
        ? comment.tags
          .map(
            (tag) =>
              `<a class="tag" target="_blank" href="https://b.hatena.ne.jp/${escapeHtml(
                comment.user
              )}/${escapeHtml(tag)}" >${escapeHtml(tag)}</a>`
          )
          .join("")
        : "";

    html += `
      <div class="bookmark-item">
        <div class="bookmark-header">
          <a href="https://b.hatena.ne.jp/${escapeHtml(comment.user)}/"
             target="_blank"
             class="user-link">
            <img src="https://cdn.profile-image.st-hatena.com/users/${escapeHtml(
      comment.user
    )}/profile.png"
                 class="user-icon"
                 alt="${escapeHtml(comment.user)}"
                 onerror="this.onerror=null; this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2224%22 height=%2224%22 viewBox=%220 0 24 24%22%3E%3Ccircle cx=%2212%22 cy=%2212%22 r=%2212%22 fill=%22%23ccc%22/%3E%3Ctext x=%2212%22 y=%2217%22 text-anchor=%22middle%22 fill=%22white%22 font-size=%2214%22%3E${escapeHtml(
      comment.user.substring(0, 1).toUpperCase()
    )}%3C/text%3E%3C/svg%3E';">
            ${escapeHtml(comment.user)}
          </a>
          <div class="meta">
            ${comment.timestamp
        ? `<span class="timestamp" title="${escapeHtml(
          comment.timestamp
        )}">${escapeHtml(formatDateOnly(comment.timestamp))}</span>`
        : ""
      }
            ${starText ? `<a href="${starLink}" target="_blank"><span class="stars">${starText}</span></a>` : ""}
          </div>
        </div>
        ${comment.comment
        ? `<div class="comment">${escapeHtml(comment.comment)}</div>`
        : ""
      }
        ${tagsHtml ? `<div class="tags">${tagsHtml}</div>` : ""}
      </div>
    `;
  }

  html += "</div>";
  container.innerHTML = html;

  // コメント内のURLらしき文字列をリンクに変換
  linkifyComments(container);

  attachTabHandlers(container);

  // 進捗表示の反映
  if (currentSortOrder !== "popular") {
    updateStarProgressUI();
  }
}

function linkifyComments(rootEl) {
  const commentEls = rootEl.querySelectorAll(".comment");
  commentEls.forEach((el) => {
    // 既存のHTMLはescape済みなので、DOM上のtextContentを元に安全に組み立て直す
    const text = el.textContent || "";
    el.replaceChildren(linkifyTextToFragment(text));
  });
}

function linkifyTextToFragment(text) {
  const fragment = document.createDocumentFragment();
  if (!text) return fragment;

  // http(s)://... または www.... をざっくり検出
  const urlRegex = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/gi;

  let lastIndex = 0;
  for (const match of text.matchAll(urlRegex)) {
    const matchedText = match[0];
    const matchIndex = match.index ?? 0;

    if (matchIndex > lastIndex) {
      fragment.appendChild(
        document.createTextNode(text.slice(lastIndex, matchIndex))
      );
    }

    // URL末尾に付きがちな句読点などを外す
    const { urlText, trailing } = splitTrailingPunctuation(matchedText);

    const href = urlText.toLowerCase().startsWith("www.")
      ? `https://${urlText}`
      : urlText;

    const safeHref = toSafeHttpUrlOrNull(href);
    if (safeHref) {
      const a = document.createElement("a");
      a.href = safeHref;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = urlText;
      fragment.appendChild(a);
    } else {
      fragment.appendChild(document.createTextNode(matchedText));
    }

    if (trailing) {
      fragment.appendChild(document.createTextNode(trailing));
    }

    lastIndex = matchIndex + matchedText.length;
  }

  if (lastIndex < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
  }

  return fragment;
}

function splitTrailingPunctuation(urlCandidate) {
  // 末尾の記号はリンクに含めない（日本語の句読点も含める）
  const trailingChars = new Set([
    ".",
    ",",
    "!",
    "?",
    ";",
    ":",
    ")",
    "]",
    "}",
    "、",
    "。",
    "！",
    "？",
    "」",
    "』",
    "）",
    "］",
    "｝",
  ]);

  let end = urlCandidate.length;
  while (end > 0 && trailingChars.has(urlCandidate[end - 1])) {
    end -= 1;
  }

  return {
    urlText: urlCandidate.slice(0, end),
    trailing: urlCandidate.slice(end),
  };
}

function toSafeHttpUrlOrNull(href) {
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

// タイムスタンプをパースしてDate型に変換（"2021/07/19 23:36" 形式）
function parseTimestamp(timestamp) {
  if (!timestamp) return new Date(0);
  const match = timestamp.match(
    /(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{1,2})/
  );
  if (!match) return new Date(0);
  return new Date(
    parseInt(match[1]), // year
    parseInt(match[2]) - 1, // month (0-indexed)
    parseInt(match[3]), // day
    parseInt(match[4]), // hour
    parseInt(match[5]) // minute
  );
}

// 日付のみを抽出 ("2021/07/19 23:36" → "2021/07/19")
function formatDateOnly(timestamp) {
  if (!timestamp) return "";
  const match = timestamp.match(/(\d{4}\/\d{1,2}\/\d{1,2})/);
  return match ? match[1] : timestamp;
}

// HTMLエスケープ
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// メッセージリスナー（background scriptからのメッセージを受信）
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[SidePanel] Message received:", message);

  try {
    if (message.type === "BOOKMARKS_LOADING") {
      console.log("[SidePanel] Processing BOOKMARKS_LOADING");
      if (currentSortOrder === "popular") {
        currentUrl = message.url;
        expectedUrl = message.url;
        requestOriginPopularForUrl(message.url);
      } else {
        showLoading(message.url);
        // ローディング表示には進捗UIがないため、ここでは何もしない
      }
    } else if (message.type === "BOOKMARKS_UPDATE") {
      console.log("[SidePanel] Processing BOOKMARKS_UPDATE");
      // URLが変わった場合は、expectedUrlを更新
      // （キャッシュがある場合はLOADINGメッセージが来ないため）
      if (message.url !== expectedUrl) {
        console.log(
          "[SidePanel] URL changed from:",
          expectedUrl,
          "to:",
          message.url
        );
        expectedUrl = message.url;
      }
      currentUrl = message.url;
      currentBookmarks = message.data;
      if (currentSortOrder === "popular") {
        requestOriginPopularForUrl(message.url);
      } else {
        showBookmarks(message.url, message.data);
      }
    } else if (message.type === "BOOKMARKS_ERROR") {
      console.log("[SidePanel] Processing BOOKMARKS_ERROR");
      // URLが変わった場合は、expectedUrlを更新
      if (message.url !== expectedUrl) {
        console.log(
          "[SidePanel] URL changed from:",
          expectedUrl,
          "to:",
          message.url
        );
        expectedUrl = message.url;
      }
      if (currentSortOrder === "popular") {
        showPopularError(message.url, message.error);
      } else {
        showError(message.url, message.error);
      }
    } else if (message.type === "BOOKMARKS_STAR_PROGRESS") {
      // 表示中/ロード中URLと異なるものは無視（タブ切替の取りこぼし対策）
      if (message.url !== expectedUrl) {
        console.log(
          "[SidePanel] Ignoring STAR_PROGRESS for non-current URL:",
          message.url,
          "expected:",
          expectedUrl
        );
      } else {
        if (currentSortOrder !== "popular") {
          setStarFetchProgressForUrl(message.url, message.progress);
          updateStarProgressUI();
        }
      }
    } else if (message.type === "ORIGIN_POPULAR_LOADING") {
      const origin = message.origin || "";
      if (!origin || origin !== expectedOrigin) {
        console.log(
          "[SidePanel] Ignoring ORIGIN_POPULAR_LOADING for non-current origin:",
          origin,
          "expected:",
          expectedOrigin
        );
      } else if (currentSortOrder === "popular") {
        showPopularLoading(origin);
      }
    } else if (message.type === "ORIGIN_POPULAR_UPDATE") {
      const origin = message.origin || "";
      if (!origin || origin !== expectedOrigin) {
        console.log(
          "[SidePanel] Ignoring ORIGIN_POPULAR_UPDATE for non-current origin:",
          origin,
          "expected:",
          expectedOrigin
        );
      } else {
        currentOriginPopularItems = Array.isArray(message.items)
          ? message.items
          : [];
        if (currentSortOrder === "popular") {
          showPopular(origin, currentOriginPopularItems);
        }
      }
    } else if (message.type === "ORIGIN_POPULAR_ERROR") {
      const origin = message.origin || "";
      if (!origin || origin !== expectedOrigin) {
        console.log(
          "[SidePanel] Ignoring ORIGIN_POPULAR_ERROR for non-current origin:",
          origin,
          "expected:",
          expectedOrigin
        );
      } else if (currentSortOrder === "popular") {
        showPopularError(currentUrl, message.error);
      }
    } else {
      console.log("[SidePanel] Unknown message type:", message.type);
    }
    sendResponse({ status: "ok" });
  } catch (error) {
    console.error("[SidePanel] Error processing message:", error);
    sendResponse({ status: "error", error: error.message });
  }
  return true;
});

// ページ読み込み時に初期化
console.log("[SidePanel] Starting initialization...");
try {
  init();
} catch (error) {
  console.error("[SidePanel] Failed to initialize:", error);
}
