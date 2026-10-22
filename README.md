# CP Train Watcher

Keeps retrying a cp.pt booking for one or more departures and pings your phone (via [ntfy](https://ntfy.sh)) the moment a seat is held in checkout. It never fills in payment details.

## Install (once)

1. Unzip the folder somewhere permanent.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, pick the folder.

## Set up

1. Install the ntfy app on your phone.
2. On cp.pt, search your route and open the results page. The watcher panel appears top-right.
3. **Use this page** - saves it as the page the watcher resets to (also fills the date).
4. **Date** / **Departs** - the train(s) you want, 24h departure times separated by commas, in order of preference (e.g. `08:15, 19:39, 21:10`). Each round it tries them in that order. When one is full it moves to the next after about a second, with no new search. The full wait only comes after every time has been tried. It stops at the first seat it secures.
5. **ntfy topic** - press **New** for a random topic and subscribe to it in the app. Topics on ntfy.sh are public by name, so keep it hard to guess.
6. **ntfy token** - only if your topic is protected (an ntfy.sh access token, starts with `tk_`). Leave empty otherwise.
7. **Start at** - optional; waits until that time before the first attempt.
8. **Every (s)** - seconds between rounds (min 5, randomised up to x1.8). Faster risks getting throttled by cp.pt.
9. **Run (min)** - stop after this many minutes (max 300) and send a "stopped" notification.
10. **Test ntfy**, then **Start watching**. Leave the tab open.

## What it does when things go wrong

Anything that isn't a checkout page means "keep trying":

- **cp.pt redirects to the home page or another page.** It goes back to the search. If that keeps happening, the wait grows, up to 5 min.
- **Empty results ("Não foram encontrados resultados").** It reloads, waiting at most ~35 s.
- **A sale with no clear answer.** It retries. A seat only counts as secured when cp.pt's `/sale` request succeeds, and that result is saved even if the page navigates away.
- **The loop stalls for 2 min.** It reloads the search.
- **The page dies** (Chrome error page, crashed or unloaded tab). The extension reloads the search in that tab within ~2.5 min.
- **A reload during the "Start at" wait.** It keeps waiting.

It never navigates away from a checkout page or in the middle of a sale. Hidden tabs get their timers slowed by Chrome, so keep the cp.pt tab visible, ideally in its own window.

Drag the panel by its title to move it; click the title to hide the settings. Settings are saved in the browser and survive restarts.

## Share

```sh
zip -r cp-watcher.zip manifest.json background.js content.js inject.js README.md
```
