if (window.__igWipeInstalled) {
  /* already loaded by declarative content script */
} else {
  window.__igWipeInstalled = true;

  (() => {
    // Labels are matched case-insensitively against the UI text (English + Danish).
    const LABELS = {
      select:  ["Select", "Vælg"],
      delete:  ["Delete", "Slet"],
      unlike:  ["Unlike", "Synes ikke godt om", "Synes ikke længere godt om", "Fjern synes godt om"],
      ok:      ["OK"],
      empty:   ["No results", "Ingen resultater"],
      emptyPrefix: ["You haven't", "Du har ikke"],
    };
    const UNCHECKED_SEL = '[style*="circle__outline"]';
    const CHECKED_SEL = '[style*="circle-check__filled"]';

    let stopRequested = false;
    let running = false;

    function sleep(ms) {
      const jittered = Math.round(ms * (0.85 + Math.random() * 0.3));
      return new Promise((r) => setTimeout(r, jittered));
    }

    function scriptClick(el) {
      if (!el || !el.isConnected) return;
      const opts = { bubbles: true, cancelable: true, composed: true, view: window };
      try {
        el.dispatchEvent(new PointerEvent("pointerdown", opts));
        el.dispatchEvent(new MouseEvent("mousedown", opts));
        el.dispatchEvent(new PointerEvent("pointerup", opts));
        el.dispatchEvent(new MouseEvent("mouseup", opts));
        el.dispatchEvent(new MouseEvent("click", opts));
      } catch { /* ignore */ }
    }

    const norm = (t) => (t || "").replace(/\s+/g, " ").trim().toLowerCase();

    // Deepest elements whose own text equals one of the labels.
    function findByText(labels, root = document.body, prefix = false) {
      const wanted = labels.map(norm);
      const out = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const t = norm(node.nodeValue);
        if (!t) continue;
        const hit = prefix ? wanted.some((w) => t.startsWith(w)) : wanted.includes(t);
        if (hit && node.parentElement) out.push(node.parentElement);
      }
      return out;
    }

    // Nearest ancestor that actually receives clicks (bloks sets pointer-events: none on most layers).
    function clickTarget(el) {
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        if (n.tagName === "BUTTON") return n;
        const pe = n.style?.pointerEvents;
        if (n.getAttribute("role") === "button" && pe !== "none") return n;
        if (pe === "auto" || n.style?.cursor === "pointer") return n;
      }
      return el;
    }

    function isEmptyState() {
      return findByText(LABELS.empty).length > 0 ||
        findByText(LABELS.emptyPrefix, document.body, true).length > 0;
    }

    function uncheckedBoxes() {
      const boxes = Array.from(
        document.querySelectorAll('[data-testid="bulk_action_checkbox"]')
      ).filter((b) => b.querySelector(UNCHECKED_SEL));
      if (boxes.length) return boxes;
      // fallback: bare outline-circle icons (older layout / other activity pages)
      return Array.from(document.querySelectorAll(UNCHECKED_SEL));
    }

    function isChecked(box) {
      return box.matches(CHECKED_SEL) || Boolean(box.querySelector(CHECKED_SEL)) ||
        (!box.matches(UNCHECKED_SEL) && !box.querySelector(UNCHECKED_SEL));
    }

    async function toggleBox(box) {
      // Try the tile (the element with pointer-events: auto), then the checkbox itself.
      const candidates = [clickTarget(box), box.querySelector('[role="button"]'), box];
      for (const c of candidates) {
        if (!c) continue;
        scriptClick(c);
        await sleep(350);
        if (!box.isConnected || isChecked(box)) return true;
      }
      return false;
    }

    async function isStopped() {
      if (stopRequested) return true;
      try {
        const { igWipeStop } = await chrome.storage.session.get("igWipeStop");
        return Boolean(igWipeStop);
      } catch {
        return false;
      }
    }

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type === "STOP_DELETION") {
        stopRequested = true;
        sendResponse({ ok: true });
        return true;
      }
      if (msg?.type === "START_DELETION") {
        stopRequested = false;
        if (running) {
          sendResponse({ ok: true, note: "already_running" });
          return true;
        }
        runDeletion(msg.mode, msg.batchSize).catch(() => {});
        sendResponse({ ok: true });
        return true;
      }
    });

    async function runDeletion(mode, batchSize) {
      running = true;
      const n = Math.min(50, Math.max(1, Number(batchSize) || 20));
      const actionLabels = mode === "likes" ? LABELS.unlike : LABELS.delete;

      try {
        while (!(await isStopped())) {

          // Step 1 — wait for and click "Select" (skip if already in select mode)
          let inSelectMode = false;
          while (!inSelectMode && !(await isStopped())) {
            await sleep(2000);
            if (isEmptyState()) {
              await chrome.storage.session.set({ igWipeStop: true });
              return;
            }
            const [selectBtn] = findByText(LABELS.select);
            if (selectBtn) {
              scriptClick(clickTarget(selectBtn));
              inSelectMode = true;
            } else if (uncheckedBoxes().length) {
              inSelectMode = true;
            }
          }

          if (await isStopped()) return;

          // Step 2 — select up to n items
          let selectedCount = 0;
          for (let attempt = 0; selectedCount === 0 && attempt < 10 && !(await isStopped()); attempt++) {
            await sleep(1000);
            for (const box of uncheckedBoxes()) {
              if (await isStopped()) return;
              if (await toggleBox(box)) selectedCount++;
              if (selectedCount >= n) break;
            }
          }

          if (await isStopped()) return;

          if (selectedCount === 0) {
            await chrome.storage.session.set({ igWipeStop: true });
            return;
          }

          // Step 3 — click Delete / Unlike
          await sleep(1000);
          const [actionBtn] = findByText(actionLabels).filter(
            (el) => !el.closest('[role="dialog"]')
          );

          if (!actionBtn) {
            // button not found — reload and retry
            await sleep(2000);
            location.reload();
            await sleep(3000);
            continue;
          }
          scriptClick(clickTarget(actionBtn));

          // Step 4 — confirm dialog
          let confirmed = false;
          for (let attempt = 0; !confirmed && attempt < 15 && !(await isStopped()); attempt++) {
            await sleep(1000);
            for (const dialog of document.querySelectorAll('[role="dialog"]')) {
              const [confirmBtn] = findByText(actionLabels, dialog);
              if (confirmBtn) {
                scriptClick(clickTarget(confirmBtn));
                confirmed = true;
                break;
              }
              const [okBtn] = findByText(LABELS.ok, dialog);
              if (okBtn) {
                // rate-limited — dismiss and reload
                scriptClick(clickTarget(okBtn));
                await sleep(2000);
                location.reload();
                await sleep(3000);
                confirmed = true;
                break;
              }
            }
          }
          if (!confirmed) {
            location.reload();
            await sleep(3000);
            continue;
          }

          if (await isStopped()) return;

          // Step 5 — brief pause before the next batch
          await sleep(3000);
        }
      } finally {
        running = false;
        try {
          await chrome.storage.session.set({ igWipeRunning: false });
        } catch { /* ignore */ }
      }
    }
  })();
}
