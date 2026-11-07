# Mute X List Members

A small Chrome extension that mutes everyone on an X (Twitter) list in one go.

Open any list, press **Start muting**, and it works through every member for you, showing who's been muted as it goes.

## Install

1. Download this repo (green **Code** button → **Download ZIP**) and unzip it, or `git clone` it.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the folder that contains `manifest.json`.

## Use

1. Log in to [x.com](https://x.com) and open the list you want to mute, for example `https://x.com/i/lists/123456789`.
2. A dialog appears in the middle of the page. Press **Start muting**.
3. Leave the tab open. The dialog shows each member with their status (Waiting, Muting, Muted, Already muted, Failed) and overall progress.

You can press **−** to shrink the dialog into a small button in the corner and keep using X, or **Stop** at any time. Running it again picks up where it left off.

## How it works

1. **Finding members.** On the list's members page, X loads the members itself. The extension watches for that request and repeats it page by page until it has every member, so it doesn't depend on what's visible on screen. If that fails, it falls back to scrolling the member list.
2. **Muting.** Each member is muted with the same request X's website sends when you click **Mute** on a profile, using your logged-in session. Members are muted as soon as they're found, one every 5 seconds, so X doesn't rate-limit you.
3. **Rate limits.** If X does say "too many requests", the extension waits until X allows more and then continues on its own.
4. **Remembering.** Members found and accounts muted are saved in your browser (x.com's local storage). The next run skips anyone already muted and doesn't need to load the list again. Press **Rescan list** if the list has changed.

## Privacy

Everything runs in your browser. The extension only talks to x.com, as you, and stores nothing anywhere else. It has no permissions beyond running on x.com and twitter.com.

## Files

| File | What it does |
| --- | --- |
| `manifest.json` | Extension setup: which pages the scripts run on |
| `capture.js` | Runs inside X's page and notes the request X uses to load list members |
| `content.js` | The dialog, finding members, and muting |

## Settings

The speed and timing values are constants at the top of `content.js`:

- `MUTE_DELAY_MS`: time between mutes (default 5000 ms)
- `SCROLL_DELAY_MS`: time between scrolls in the scrolling fallback

After changing them, click reload on the extension in `chrome://extensions` and refresh the X tab.

## Disclaimer

This is an unofficial tool and is not affiliated with X. It relies on X's private web API, so it can stop working when X changes their site. Bulk automated actions may go against X's rules. Use it on your own account at your own risk.
