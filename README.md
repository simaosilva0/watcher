# CP Train Watcher

Keeps retrying a cp.pt booking for one or more departures and pings your phone (via [ntfy](https://ntfy.sh)) the moment a seat is held in checkout. It never fills in payment details.

## Install (once)

1. Unzip the folder somewhere permanent.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, pick the folder.

## Update

1. Replace the files in that folder with the new ones.
2. In `chrome://extensions`, press the reload button on **CP Train Watcher**.
3. Refresh the cp.pt tab and press **Start watching** again. A tab left open from before keeps running the old code.

The panel title and notifications show the version (e.g. `v5.6`), so you can tell which one is running.

## Set up

1. Install the ntfy app on your phone.
2. On cp.pt, search your route and open the results page. The watcher panel appears top-right.
3. **Use this page** - saves it as the page the watcher resets to (also fills the date).
4. **Date** / **Departs** - the train(s) you want, 24h departure times separated by commas, in order of preference (e.g. `08:15, 19:39, 21:10`). It cycles through them in that order, one attempt per wait, then starts over. It stops at the first seat it secures.
5. **ntfy topic** - press **New** for a random topic and subscribe to it in the app. Topics on ntfy.sh are public by name, so keep it hard to guess.
6. **ntfy token** - only if your topic is protected (an ntfy.sh access token, starts with `tk_`). Leave empty otherwise.
7. **Start at** - optional; waits until that time before the first attempt.
8. **Every (s)** - seconds between attempts (min 4, randomised up to x2, so 4 -> 4-8 s). Faster gets you blocked by cp.pt: it drops all connections from your address to its booking server, and results pages stop loading.
9. **Run (min)** - stop after this many minutes (max 300) and send a "stopped" notification.
10. **Test ntfy**, then **Start watching**. Leave the tab open.

Drag the panel by its title to move it; click the title to hide the settings. Settings are saved in the browser and survive restarts.

## What it does when things go wrong

Anything that isn't a checkout page means "keep trying":

- **cp.pt redirects to the home page or another page.** It goes back to the search. If that keeps happening, the wait grows, up to 5 min.
- **Empty results ("Não foram encontrados resultados").** It reloads, waiting at most ~35 s.
- **"Avançar para compra" lands on the home page.** cp.pt dropped the purchase before the sale was made, so no seat is held. It reloads the search right away, which also gets a fresh cp.pt session.
- **A sale with no clear answer.** It retries. A seat only counts as secured when cp.pt's `/sale` request succeeds, and that result is saved even if the page navigates away.
- **Terms box won't tick, or "Avançar para compra" stays disabled.** It retries.
- **cp.pt hangs on "Por favor aguarde um momento...".** After 20 s it reloads the search.
- **The loop stalls for 2 min.** It reloads the search.
- **The page dies** (Chrome error page, crashed or unloaded tab). The extension reloads the search in that tab within ~2.5 min.
- **A reload during the "Start at" wait.** It keeps waiting.

It never navigates away from a checkout page or in the middle of a sale. Hidden tabs get their timers slowed by Chrome, so keep the cp.pt tab visible, ideally in its own window.

## Notifications

| Notification | Meaning |
| --- | --- |
| CP seat secured | A seat is held in checkout. Pay now; it expires. The watcher has stopped. |
| CP watcher stopped | **Run (min)** ran out without a seat. |
| CP watcher throttled | cp.pt stopped returning results. The watcher slows down and keeps going. |
| CP watcher bounced | cp.pt keeps sending the tab away from the results. Still retrying. |
| CP watcher test | Sent by **Test ntfy**. |

Small hiccups don't send a notification; the panel's status line shows them.

## Tuning

The `CONFIG` block at the top of `content.js` holds the timings:

- `jitter` - random extra on top of **Every (s)** (default 1.0, i.e. up to x2).
- `minDelaySec` - lowest allowed **Every (s)** (default 4).
- `maxEmptyBackoffLevel` - how far the wait may grow after empty results pages.
- `loaderMaxMs` - how long cp.pt's loading screen may show before a reload (default 20 s).
- `stallMs` - how long without progress before the watchdogs reload the search (default 2 min).
- `acceptTerms` / `autoAdvanceToPayment` - set to `false` to tick the terms or press "Avançar para compra" yourself.

Reload the extension after editing.

## Share

```sh
zip -r cp-watcher.zip manifest.json background.js content.js inject.js README.md
```
