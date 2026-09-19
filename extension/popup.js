const btnStart    = document.getElementById("start");
const btnStop     = document.getElementById("stop");
const progressBar = document.getElementById("progress-bar");
const spinner     = document.getElementById("spinner");
const statusEl    = document.getElementById("status");

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = "status" + (kind ? " " + kind : "");
}

function setRunning(on) {
  btnStart.disabled = on;
  btnStop.disabled  = !on;
  progressBar.classList.toggle("hidden", !on);
  spinner.classList.toggle("hidden", !on);
}

async function focusedTabId() {
  let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id != null) return tab.id;
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

const modeInputs = Array.from(document.querySelectorAll('input[name="mode"]'));

const MODE_NAMES = {
  story_replies: "story replies",
  comments:      "comments",
  likes:         "likes",
  reels:         "reels",
  posts:         "posts",
};

function selectedModes() {
  return modeInputs.filter((i) => i.checked).map((i) => i.value);
}

function queueStatus(queue) {
  if (!queue?.modes?.length) return "Running — check the Instagram tab.";
  const name = MODE_NAMES[queue.modes[queue.index]] || queue.modes[queue.index];
  const step = queue.modes.length > 1 ? ` (${queue.index + 1}/${queue.modes.length})` : "";
  return `Running — deleting ${name}${step}. Check the Instagram tab.`;
}

// Remember the chosen categories between popup openings
chrome.storage.local.get("igWipeModes").then(({ igWipeModes }) => {
  if (Array.isArray(igWipeModes)) {
    for (const i of modeInputs) i.checked = igWipeModes.includes(i.value);
  }
}).catch(() => {});
for (const i of modeInputs) {
  i.addEventListener("change", () => {
    chrome.storage.local.set({ igWipeModes: selectedModes() }).catch(() => {});
  });
}

// ── Restore state when popup reopens ─────────────────────────────────────────
(async () => {
  try {
    const { igWipeRunning, igWipeQueue } = await chrome.storage.session.get(["igWipeRunning", "igWipeQueue"]);
    if (igWipeRunning) {
      setRunning(true);
      setStatus(queueStatus(igWipeQueue), "ok");
    }
  } catch { /* ignore */ }
})();

// ── Watch for the loop finishing on its own ───────────────────────────────────
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "session") return;
  if (changes.igWipeQueue?.newValue && !btnStop.disabled) {
    setStatus(queueStatus(changes.igWipeQueue.newValue), "ok");
  }
  if ("igWipeRunning" in changes && !changes.igWipeRunning.newValue) {
    setRunning(false);
    // Only update status if it currently says "Running"
    if (statusEl.classList.contains("ok") && statusEl.textContent.startsWith("Running")) {
      setStatus("Done — no more items found.", "ok");
    }
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
btnStart.addEventListener("click", async () => {
  setStatus("Starting…");
  setRunning(true);

  const tabId = await focusedTabId();
  if (tabId == null) {
    setStatus("No tab found. Focus the Instagram tab, then open this popup again.", "err");
    setRunning(false);
    return;
  }

  const modes     = selectedModes();
  if (!modes.length) {
    setStatus("Pick at least one category.", "err");
    setRunning(false);
    return;
  }
  const batchSize = Math.min(50, Math.max(1, parseInt(document.getElementById("batchSize").value, 10) || 20));

  await chrome.storage.session.set({ igWipeStop: false, igWipeRunning: true });

  try {
    const rsp = await chrome.runtime.sendMessage({ type: "START_DELETION", tabId, modes, batchSize });
    if (rsp?.ok) {
      setStatus(
        rsp.navigated
          ? "Navigating to Your Activity… deletion will start automatically."
          : queueStatus({ modes, index: 0 }),
        "ok"
      );
    } else {
      setStatus(rsp?.error || "Could not start.", "err");
      setRunning(false);
      await chrome.storage.session.set({ igWipeRunning: false });
    }
  } catch (e) {
    setStatus("Error: " + (e?.message || e), "err");
    setRunning(false);
    await chrome.storage.session.set({ igWipeRunning: false });
  }
});

// ── Stop ──────────────────────────────────────────────────────────────────────
btnStop.addEventListener("click", async () => {
  setStatus("Stopping…");
  const tabId = await focusedTabId();
  try {
    await chrome.runtime.sendMessage({ type: "STOP_DELETION", tabId });
    await chrome.storage.session.set({ igWipeRunning: false });
    setRunning(false);
    setStatus("Stopped.", "ok");
  } catch (e) {
    setStatus("Stop failed: " + (e?.message || e), "err");
    setRunning(false);
  }
});
