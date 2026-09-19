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

// ── Queue ──────────────────────────────────────────────────────────────────────
// igWipeQueue = { modes: [...], index, batchSize, tabId } lives in session storage
// so it survives the service worker being suspended between categories.

async function finishAll() {
  await chrome.storage.session.set({
    igWipeStop: true, igWipeRunning: false, igWipePending: null, igWipeQueue: null,
  });
}

// Start (or navigate to) the category at queue.index.
async function startCurrent(queue) {
  const { tabId, batchSize } = queue;
  const mode = queue.modes[queue.index];
  await chrome.storage.session.set({ igWipeStop: false, igWipePending: null, igWipeQueue: queue });

  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch {
    await finishAll();
    return { ok: false, error: "That tab no longer exists." };
  }

  if (tabIsOnTarget(tab.url || "", mode)) {
    // Already on the right page — try to send directly
    const ok = await sendToContent(tabId, { type: "START_DELETION", mode, batchSize, tabId });
    if (!ok) {
      // Content script not ready; store pending and reload
      await chrome.storage.session.set({ igWipePending: { mode, batchSize, tabId } });
      try { await chrome.tabs.reload(tabId); } catch { /* ignore */ }
    }
    return { ok: true, navigated: false };
  }

  // Navigate to the activity page and wait for it to load (handled by onUpdated)
  await chrome.storage.session.set({ igWipePending: { mode, batchSize, tabId } });
  try {
    await chrome.tabs.update(tabId, { url: activityUrl(mode) });
  } catch (e) {
    await finishAll();
    return { ok: false, error: (e?.message) || "Could not navigate the tab." };
  }
  return { ok: true, navigated: true };
}

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendRsp) => {
  if (msg?.type === "STOP_DELETION") {
    (async () => {
      await finishAll();
      const tabId = await resolveTab(msg.tabId);
      if (tabId != null) {
        try { await chrome.tabs.sendMessage(tabId, { type: "STOP_DELETION" }); } catch { /* ignore */ }
      }
      sendRsp({ ok: true });
    })();
    return true;
  }

  // Content script finished the current category (nothing left) — move on.
  if (msg?.type === "MODE_DONE") {
    (async () => {
      const { igWipeQueue: queue, igWipeStop } = await chrome.storage.session.get(["igWipeQueue", "igWipeStop"]);
      if (!queue || igWipeStop || queue.modes[queue.index] !== msg.mode) return;
      if (sender.tab?.id != null && sender.tab.id !== queue.tabId) return;
      if (queue.index + 1 >= queue.modes.length) {
        await finishAll();
        return;
      }
      await startCurrent({ ...queue, index: queue.index + 1 });
    })();
    return;
  }

  if (msg?.type === "RUN_FAILED") {
    finishAll();
    return;
  }

  if (msg?.type !== "START_DELETION") return;

  const { batchSize, tabId: rawTabId } = msg;
  const modes = (Array.isArray(msg.modes) ? msg.modes : [msg.mode])
    .filter((m) => m in ACTIVITY_URLS);

  (async () => {
    if (!modes.length) {
      sendRsp({ ok: false, error: "Pick at least one category." });
      return;
    }
    await chrome.storage.session.set({ igWipeStop: false, igWipePending: null, igWipeRunning: true });

    const tabId = await resolveTab(rawTabId);
    if (tabId == null) {
      await finishAll();
      sendRsp({ ok: false, error: "No tab found. Focus the Instagram tab then open the popup again." });
      return;
    }

    const rsp = await startCurrent({ modes, index: 0, batchSize, tabId });
    try { await chrome.tabs.update(tabId, { active: true }); } catch { /* ignore */ }
    sendRsp(rsp);
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
