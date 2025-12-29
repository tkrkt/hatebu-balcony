// サイドパネルの初期化
console.log("[SidePanel] Side panel loaded");

// 現在の表示データ
let currentUrl = "";
let currentBookmarks = null;
let currentSortOrder = "stars"; // 'stars' or 'date'
let expectedUrl = ""; // 現在ロード中または表示中のURL

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
      chrome.runtime.sendMessage({ type: "REQUEST_BOOKMARKS", url: tab.url });
    } else {
      console.log("[SidePanel] No tab URL found");
      showError("", "タブのURLを取得できませんでした");
    }
  } catch (error) {
    console.error("[SidePanel] Init error:", error);
    showError("", error.message);
  }
}

// ローディング表示
function showLoading(url) {
  console.log("[SidePanel] Showing loading for:", url);
  currentUrl = url;
  expectedUrl = url;
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

  const container = document.getElementById("bookmarks-container");
  if (!container) {
    console.error("[SidePanel] Container element not found!");
    return;
  }

  if (!data.comments || data.comments.length === 0) {
    container.innerHTML = `
      <div class="no-bookmarks">
        <div class="spinner"></div>
        <p>このページにはブックマークがありません</p>
        <p class="url">${escapeHtml(url)}</p>
      </div>
    `;
    return;
  }

  const bookmarkCountText =
    data.bookmarkCount > 0 ? `${data.bookmarkCount} users` : "";
  const entryUrl = data.entryUrl || null;

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
    <div class="header-info">
      <div class="sort-tabs">
        <button class="sort-tab ${
          currentSortOrder === "stars" ? "active" : ""
        }" data-sort="stars" title="スター数順">
          ⭐
        </button>
        <button class="sort-tab ${
          currentSortOrder === "date" ? "active" : ""
        }" data-sort="date" title="新着順">
          🕐
        </button>
        <button class="reload-button" title="再読込">
          🔄
        </button>
        ${
          bookmarkCountText
            ? entryUrl
              ? `<a href="${escapeHtml(entryUrl)}" target="_blank" class="bookmark-count" title="はてなブックマークで見る">${bookmarkCountText}</a>`
              : `<div class="bookmark-count">${bookmarkCountText}</div>`
            : ""
        }
      </div>
    </div>
    <div class="bookmarks-list">
  `;

  for (const comment of sortedComments) {
    const starText = comment.stars > 0 ? `★ ${comment.stars}` : "";
    const tagsHtml =
      comment.tags && comment.tags.length > 0
        ? comment.tags
            .map(
              (tag) =>
                `<a class="tag" target="_blank" href="https://b.hatena.ne.jp/${escapeHtml(
                  comment.user
                )}/${escapeHtml(tag)}" >${escapeHtml(
                  tag
                )}</a>`
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
            ${
              comment.timestamp
                ? `<span class="timestamp" title="${escapeHtml(
                    comment.timestamp
                  )}">${escapeHtml(formatDateOnly(comment.timestamp))}</span>`
                : ""
            }
            ${starText ? `<span class="stars">${starText}</span>` : ""}
          </div>
        </div>
        ${
          comment.comment
            ? `<div class="comment">${escapeHtml(comment.comment)}</div>`
            : ""
        }
        ${tagsHtml ? `<div class="tags">${tagsHtml}</div>` : ""}
      </div>
    `;
  }

  html += "</div>";
  container.innerHTML = html;

  // タブのクリックイベントを設定
  const sortTabs = container.querySelectorAll(".sort-tab");
  sortTabs.forEach((tab) => {
    tab.addEventListener("click", (e) => {
      const sortOrder = e.currentTarget.dataset.sort;
      console.log("[SidePanel] Sort order changed to:", sortOrder);
      currentSortOrder = sortOrder;
      showBookmarks(currentUrl, currentBookmarks);
    });
  });

  // リロードボタンのクリックイベントを設定
  const reloadButton = container.querySelector(".reload-button");
  if (reloadButton) {
    reloadButton.addEventListener("click", () => {
      console.log("[SidePanel] Reload button clicked for:", currentUrl);
      showLoading(currentUrl);
      chrome.runtime.sendMessage({
        type: "CLEAR_CACHE_AND_RELOAD",
        url: currentUrl,
      });
    });
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
      showLoading(message.url);
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
      showBookmarks(message.url, message.data);
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
      showError(message.url, message.error);
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
