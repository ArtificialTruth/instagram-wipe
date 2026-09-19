if (window.__igWipeInstalled) {
  /* already loaded by declarative content script */
} else {
  window.__igWipeInstalled = true;

  (() => {
    // Everything here is language-independent: elements are identified by
    // test ids, icon URLs, colors, position and by observing what a click does.
    const CHECKBOX_SEL = '[data-testid="bulk_action_checkbox"]';
    const UNCHECKED_SEL = '[style*="circle__outline"]';
    const CHECKED_SEL = '[style*="circle-check__filled"]';
    const ICON_SEL = 'img, svg, [style*="mask-image"]';

    let stopRequested = false;
    let running = false;
    // Text of the verified "Select" button, learned at runtime (in whatever language the UI uses).
    let learnedSelectText = null;

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

    function pressEscape() {
      const opts = { key: "Escape", code: "Escape", keyCode: 27, bubbles: true };
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", opts));
      document.dispatchEvent(new KeyboardEvent("keydown", opts));
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

    // ── DOM helpers ─────────────────────────────────────────────────────────────

    const norm = (t) => (t || "").replace(/\s+/g, " ").trim();

    function isVisible(el) {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }

    function rgb(el) {
      const m = getComputedStyle(el).color.match(/\d+(\.\d+)?/g);
      return m ? m.slice(0, 3).map(Number) : [0, 0, 0];
    }
    // Instagram renders destructive actions (Delete / Unlike) in red and links (Select) in blue.
    const isRed = (el) => { const [r, g, b] = rgb(el); return r > 180 && g < 110 && b < 130; };
    const isBlue = (el) => { const [r, g, b] = rgb(el); return b > 200 && r < 90 && g > 80; };

    // Nearest ancestor that actually receives clicks (bloks sets pointer-events: none on most layers).
    function clickTarget(el) {
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        if (n.tagName === "BUTTON") return n;
        const pe = n.style?.pointerEvents;
        if (n.getAttribute("role") === "button" && pe !== "none") return n;
        if (pe === "auto" || n.style?.cursor === "pointer") return n;
      }
      return getComputedStyle(el).cursor === "pointer" ? el : null;
    }

    const inTile = (el) =>
      Boolean(el.closest('[role="button"]')?.querySelector(CHECKBOX_SEL)) ||
      Boolean(el.closest(CHECKBOX_SEL));

    // Clickable, icon-free text buttons outside dialogs, nav links and item tiles.
    // Returns [{ leaf, target, text }].
    function textButtons(root = document.body) {
      const seen = new Set();
      const out = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = norm(node.nodeValue);
        const leaf = node.parentElement;
        if (!text || !leaf || text.length > 40 || !isVisible(leaf)) continue;
        const target = clickTarget(leaf);
        if (!target || seen.has(target)) continue;
        seen.add(target);
        if (norm(target.textContent) !== text) continue; // text must be the button's only label
        if (target.querySelector(ICON_SEL)) continue;
        if (root === document.body && target.closest('[role="dialog"], a[href], nav')) continue;
        if (inTile(target)) continue;
        out.push({ leaf, target, text });
      }
      return out;
    }

    const openDialogs = () =>
      Array.from(document.querySelectorAll('[role="dialog"]')).filter(isVisible);

    function checkboxes() {
      const boxes = Array.from(document.querySelectorAll(CHECKBOX_SEL));
      if (boxes.length) return boxes;
      // fallback: bare outline-circle icons (other activity page layouts)
      return Array.from(document.querySelectorAll(UNCHECKED_SEL));
    }

    const inSelectMode = () => checkboxes().length > 0;

    const uncheckedBoxes = () =>
      checkboxes().filter((b) => b.matches(UNCHECKED_SEL) || b.querySelector(UNCHECKED_SEL));

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

    // ── Step helpers ───────────────────────────────────────────────────────────

    // "Select" candidates, best first: the previously verified text, then blue
    // text, then right-most. Only buttons above the content are considered.
    function selectCandidates() {
      const firstItem = document.querySelector('img[src*="cdninstagram"]');
      const limit = firstItem ? firstItem.getBoundingClientRect().top : Infinity;
      const score = (c) =>
        (c.text === learnedSelectText ? 1e6 : 0) +
        (isBlue(c.leaf) ? 1e5 : 0) +
        c.target.getBoundingClientRect().right;
      return textButtons()
        .filter((c) => c.target.getBoundingClientRect().bottom <= limit + 1)
        .sort((a, b) => score(b) - score(a));
    }

    // Returns "ok" when select mode is active, "empty" when nothing can be selected.
    async function enterSelectMode(startUrl) {
      const tried = new Set();
      for (let attempt = 0; attempt < 15; attempt++) {
        if (await isStopped()) return "stopped";
        await sleep(2000);
        if (inSelectMode()) return "ok";

        const cand = selectCandidates().find((c) => !tried.has(c.text));
        if (!cand) continue;
        tried.add(cand.text);

        scriptClick(cand.target);
        for (let i = 0; i < 6 && !inSelectMode(); i++) await sleep(500);

        if (location.href !== startUrl) {
          // wrong button navigated away — go back to the activity page
          await reloadAndResume(startUrl);
          return "stopped";
        }
        if (inSelectMode()) {
          learnedSelectText = cand.text;
          return "ok";
        }
        // wrong button (e.g. opened a sort sheet) — close whatever opened
        if (openDialogs().length) {
          pressEscape();
          await sleep(800);
        }
        // Select button that works but shows no checkboxes means there is nothing left
        if (cand.text === learnedSelectText) return "empty";
      }
      return "empty";
    }

    // Delete / Unlike button in the bulk action bar. Instagram renders it in red;
    // failing that, take the right-most button in the bottom-most row of buttons
    // that appeared with select mode (the destructive action sits on the right,
    // e.g. "Archive | Delete").
    function findActionButton(before) {
      const buttons = textButtons();
      const red = buttons.filter((c) => isRed(c.leaf));
      if (red.length) return red[red.length - 1].target;
      const fresh = buttons
        .filter((c) => !before.has(c.target))
        .map((c) => ({ el: c.target, r: c.target.getBoundingClientRect() }));
      if (!fresh.length) return null;
      const lowest = Math.max(...fresh.map((f) => f.r.top));
      const row = fresh.filter((f) => Math.abs(f.r.top - lowest) < 20);
      row.sort((x, y) => y.r.right - x.r.right);
      return row[0].el;
    }

    // Handles the dialog shown after the action button. Returns "confirmed",
    // "dismissed" (e.g. rate-limit notice) or null if no dialog yet.
    function handleDialog() {
      for (const dialog of openDialogs()) {
        const btns = Array.from(dialog.querySelectorAll('button, [role="button"]'))
          .filter((b) => isVisible(b) && norm(b.textContent));
        if (!btns.length) continue;
        const redBtn = btns.find((b) => {
          const leaf = Array.from(b.querySelectorAll("*")).find((e) => norm(e.textContent) && !e.children.length) || b;
          return isRed(leaf) || isRed(b);
        });
        if (redBtn) { scriptClick(redBtn); return "confirmed"; }
        if (btns.length === 1) { scriptClick(btns[0]); return "dismissed"; }
        // confirmation dialogs list the destructive action first, cancel last
        scriptClick(btns[0]);
        return "confirmed";
      }
      return null;
    }

    async function reloadAndResume(url) {
      try {
        await chrome.storage.session.set({ igWipePending: { ...currentJob, resume: true } });
      } catch { /* ignore */ }
      await sleep(1000);
      if (url && location.href !== url) location.href = url;
      else location.reload();
      await sleep(5000);
    }

    let currentJob = null;

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
        currentJob = { mode: msg.mode, batchSize: msg.batchSize, tabId: msg.tabId };
        runDeletion(msg.batchSize).catch(() => {});
        sendResponse({ ok: true });
        return true;
      }
    });

    async function runDeletion(batchSize) {
      running = true;
      const n = Math.min(50, Math.max(1, Number(batchSize) || 20));
      const startUrl = location.href;

      try {
        while (!(await isStopped())) {

          // Step 1 — enter select mode
          const before = new Set(textButtons().map((c) => c.target));
          const state = await enterSelectMode(startUrl);
          if (state === "stopped") return;
          if (state === "empty") {
            await chrome.storage.session.set({ igWipeStop: true });
            return;
          }

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
          const actionBtn = findActionButton(before);
          if (!actionBtn || location.href !== startUrl) {
            await reloadAndResume(startUrl);
            return;
          }
          scriptClick(actionBtn);

          // Step 4 — confirm dialog
          let result = null;
          for (let attempt = 0; !result && attempt < 15 && !(await isStopped()); attempt++) {
            await sleep(1000);
            result = handleDialog();
          }
          if (await isStopped()) return;
          if (result !== "confirmed") {
            // rate-limited or no dialog — reload and carry on
            await reloadAndResume(startUrl);
            return;
          }

          // Step 5 — brief pause before the next batch
          await sleep(3000);
        }
      } finally {
        running = false;
        try {
          const { igWipePending } = await chrome.storage.session.get("igWipePending");
          if (!igWipePending) await chrome.storage.session.set({ igWipeRunning: false });
        } catch { /* ignore */ }
      }
    }
  })();
}
