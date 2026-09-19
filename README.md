# Instagram Wipe

A Chrome extension that bulk-deletes your Instagram activity. Instagram makes mass-removal nearly impossible through its UI — wiping 500 liked posts one-by-one would take hours. Instagram Wipe automates the entire process, running inside your own browser using only your existing login session. No credentials are ever collected or transmitted.

## Features

- Delete **Story Replies**, **Comments**, **Likes**, **Reels**, and **Posts** in bulk
- Pick several categories at once — they are wiped one after another
- Works in any Instagram language (no hardcoded UI text)
- Configurable batch size (1–50 items per batch)
- Start / Stop controls with live status feedback
- Runs entirely client-side — no server, no API keys, no account credentials

## Installation

The extension is not on the Chrome Web Store. Load it as an unpacked extension:

1. Clone or download this repository.
2. Open Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the `extension/` folder.
5. The **Instagram Wipe** icon will appear in your toolbar.

## Usage

1. Log into [instagram.com](https://instagram.com) in a regular tab.
2. Keep that Instagram tab focused (active).
3. Click the **Instagram Wipe** toolbar icon to open the popup.
4. Tick the categories you want to delete (Story Replies, Comments, Likes, Reels, Posts) — one or several.
5. Set **Items per batch** (default 20; max 50).
6. Click **Start**.

The extension navigates the Instagram tab to the relevant *Your Activity* page and begins selecting and deleting items automatically. Click **Stop** at any time to halt the process. The extension handles rate-limit dialogs and page reloads gracefully and moves on to the next selected category when the current one is empty, stopping once all are done.

## How It Works

| File | Role |
|---|---|
| `manifest.json` | Manifest V3 config; declares permissions and the content script match pattern |
| `background.js` | Service worker; queues the selected categories, navigates to each activity URL and relays start/stop messages |
| `content.js` | Injected into `instagram.com/your_activity/*`; performs the actual DOM interaction loop |
| `popup.html/js/css` | Extension popup UI |

The deletion loop in `content.js` follows five steps per batch:

1. Wait for and click the **Select** button.
2. Click up to *batchSize* item checkboxes.
3. Click the **Delete** / **Unlike** action button.
4. Confirm the dialog (or dismiss a rate-limit notice and reload).
5. Pause briefly, then repeat until the page shows its empty state, then continue with the next category.

## Permissions

| Permission | Why it's needed |
|---|---|
| `tabs` | Navigate the Instagram tab to the correct activity page |
| `scripting` | Inject `content.js` when the declarative content script hasn't loaded yet |
| `storage` | Pass stop/start signals between the popup, background, and content script via `session` storage |
| `host_permissions` → `instagram.com` | Required to run content scripts and send messages to Instagram tabs |

## Notes

- The extension only works on `https://www.instagram.com/your_activity/*` pages.
- Instagram may change its DOM structure at any time, which can break selector-based automation. If the extension stops working, check for Instagram UI updates.
- Use responsibly. Aggressive batch sizes may trigger temporary rate-limits.

## Privacy

Instagram Wipe collects **no user data**. All processing happens locally inside your browser tab. See the full [Privacy Policy](PRIVACY.md) for details.

## License

See [LICENSE](LICENSE).
