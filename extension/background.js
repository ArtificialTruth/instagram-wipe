const ACTIVITY_URLS = {
  story_replies: "https://www.instagram.com/your_activity/interactions/story_replies",
  comments:      "https://www.instagram.com/your_activity/interactions/comments",
  likes:         "https://www.instagram.com/your_activity/interactions/likes",
  reels:         "https://www.instagram.com/your_activity/photos_and_videos/reels",
  posts:         "https://www.instagram.com/your_activity/photos_and_videos/posts",
};

function activityUrl(mode) {
  return ACTIVITY_URLS[mode] || ACTIVITY_URLS.likes;
}

function stripTrailingSlash(p) {
  return p.replace(/\/+$/, "") || "/";
}

function tabIsOnTarget(tabUrl, mode) {
  try {
    const target = new URL(activityUrl(mode));
    const tab    = new URL(tabUrl);
    if (!tab.hostname.endsWith("instagram.com")) return false;
    return stripTrailingSlash(tab.pathname) === stripTrailingSlash(target.pathname);
  } catch {
    return false;
  }
}

function tabReachedTarget(tabUrl, mode) {
  try {
    const want = new URL(activityUrl(mode));
    const tab  = new URL(tabUrl);
    if (!tab.hostname.endsWith("instagram.com")) return false;
    const p = stripTrailingSlash(tab.pathname);
    const w = stripTrailingSlash(want.pathname);
    return p === w || p.startsWith(w + "/");
  } catch {
    return false;
  }
}

async function resolveTab(explicitId) {
  if (explicitId != null) {
    const n = Number(explicitId);
    if (Number.isFinite(n) && n >= 0) return n | 0;
  }
  let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id != null) return tab.id;
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

async function sendToContent(tabId, payload) {
  for (let i = 0; i < 5; i++) {
    try {
      await chrome.tabs.sendMessage(tabId, payload);
      return true;
    } catch {
      if (i === 0) {
        try {
          await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
        } catch { /* ignore */ }
      }
      await new Promise((r) => setTimeout(r, 400 + i * 300));
    }
  }
  return false;
}

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendRsp) => {
  if (msg?.type === "STOP_DELETION") {
    (async () => {
      await chrome.storage.session.set({ igWipeStop: true, igWipeRunning: false, igWipePending: null });
      const tabId = await resolveTab(msg.tabId);
      if (tabId != null) {
        try { await chrome.tabs.sendMessage(tabId, { type: "STOP_DELETION" }); } catch { /* ignore */ }
      }
      sendRsp({ ok: true });
    })();
    return true;
  }

  if (msg?.type !== "START_DELETION") return;

  const { mode, batchSize, tabId: rawTabId } = msg;

  (async () => {
    await chrome.storage.session.set({ igWipeStop: false, igWipePending: null, igWipeRunning: true });

    const tabId = await resolveTab(rawTabId);
    if (tabId == null) {
      sendRsp({ ok: false, error: "No tab found. Focus the Instagram tab then open the popup again." });
      return;
    }

    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch {
      sendRsp({ ok: false, error: "That tab no longer exists." });
      return;
    }

    const url = tab.url || "";
    if (url.startsWith("chrome://") || url.startsWith("chrome-extension://") || url.startsWith("about:")) {
      sendRsp({ ok: false, error: "Open instagram.com in a regular tab first, then click Start." });
      return;
    }

    if (tabIsOnTarget(url, mode)) {
      // Already on the right page — try to send directly
      const ok = await sendToContent(tabId, { type: "START_DELETION", mode, batchSize, tabId });
      if (!ok) {
        // Content script not ready; store pending and reload
        await chrome.storage.session.set({ igWipePending: { mode, batchSize, tabId } });
        try { await chrome.tabs.reload(tabId); } catch { /* ignore */ }
      }
      try { await chrome.tabs.update(tabId, { active: true }); } catch { /* ignore */ }
      sendRsp({ ok: true, navigated: false });
      return;
    }

    // Navigate to the activity page and wait for it to load (handled by onUpdated)
    await chrome.storage.session.set({ igWipePending: { mode, batchSize, tabId } });
    try {
      await chrome.tabs.update(tabId, { url: activityUrl(mode), active: true });
    } catch (e) {
      await chrome.storage.session.remove("igWipePending");
      sendRsp({ ok: false, error: (e?.message) || "Could not navigate the tab." });
      return;
    }
    sendRsp({ ok: true, navigated: true });
  })();

  return true;
});

// ── Pick up pending start after navigation completes ─────────────────────────

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.url) return;

  (async () => {
    const { igWipePending } = await chrome.storage.session.get("igWipePending");
    if (!igWipePending) return;

    const pendingTabId = Number(igWipePending.tabId) | 0;
    if (pendingTabId !== tabId || !tabReachedTarget(tab.url, igWipePending.mode)) return;

    await chrome.storage.session.remove("igWipePending");
    await chrome.storage.session.set({ igWipeStop: false });

    const payload = { type: "START_DELETION", mode: igWipePending.mode, batchSize: igWipePending.batchSize, tabId };
    const ok = await sendToContent(tabId, payload);
    if (!ok) {
      // Last-resort retry after a short delay
      setTimeout(async () => { await sendToContent(tabId, payload); }, 2500);
    }
  })();
});
