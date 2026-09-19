# Privacy Policy — Instagram Wipe

**Last updated: September 19, 2026**

## Overview

Instagram Wipe is a browser extension that automates the removal of your own Instagram activity (story replies, comments, likes, reels, and posts) directly within your browser. This policy explains what data the extension does and does not handle.

## Data Collection

**Instagram Wipe collects no user data.**

The extension does not collect, store, transmit, or share any information about you or your Instagram account. Specifically:

- No personal information is collected (name, email, username, password, etc.).
- No Instagram account data or content is read, recorded, or retained.
- No browsing history, URLs, or page contents are logged.
- No analytics, telemetry, or crash reports are sent anywhere.
- No cookies are read or written by the extension.

## How the Extension Works

All processing happens entirely inside your own browser tab. The extension injects a script into the Instagram tab you have open and interacts with the page's DOM (clicks buttons, selects items) on your behalf. This is equivalent to you performing those actions manually — nothing leaves your device.

## Local Storage

The extension uses Chrome's extension storage for two narrow purposes. Neither contains any personal information or Instagram content, and neither is ever read by, or transmitted to, any external party.

**Session storage** passes transient signals between the popup, background service worker, and content script:

- Small flags and settings only: `igWipeStop`, `igWipeRunning`, `igWipePending`, and `igWipeQueue` (the categories you chose, the batch size, and the ID of the browser tab being worked on).
- Scoped to the current browser session and cleared when the browser is closed.

**Local storage** remembers your preferences between popup openings:

- A single setting, `igWipeModes`: the list of categories you last ticked (e.g. `["likes", "comments"]`).
- Stays on your device until you uninstall the extension or clear its data.

## Third-Party Sharing

No user data is shared with any third party, because no user data is collected in the first place.

## Network Requests

The extension makes no network requests of its own. The only network activity that occurs is the normal page navigation and Instagram API calls made by Instagram's own web application inside your browser tab.

## Changes to This Policy

If this policy is ever updated, the **Last updated** date above will be revised. Because no data is collected, no material changes to data handling are anticipated.

## Contact

For questions about this privacy policy, please open an issue on the project's GitHub repository.
