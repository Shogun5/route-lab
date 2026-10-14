# Route Lab

A phone web app for Week 6 of *Mobile Application Development* (NTUNHS, Department of Exercise and Health Sciences).
Walk, and Route Lab draws your route from the phone's **GPS** and **step counter** in three views:

| View | What a dot means |
|---|---|
| **Step Mode** | A dot every N steps (default 5). Darker = you moved farther since the previous dot. |
| **Time Mode** | A dot every N seconds (default 3). Darker = dots closer together (you were slow or stopped). |
| **Heatmap** | Brighter glow = more time spent in that place. |

Plain HTML, CSS and JavaScript. No build step, no install, no account, no data leaves the phone.

## Files

```
route-lab/
├─ index.html      page structure
├─ style.css       look and layout
├─ app.js          GPS, step counter, dots, views, demo walk, CSV export
├─ manifest.json   lets you "Add to Home Screen"
├─ icons/          icon-192.png, icon-512.png
└─ docs/
   └─ prompt-log.md   your weekly AI prompt log
```

All paths are relative, so the app works from any GitHub Pages address.

## Publish with GitHub Pages

1. Create a **public** repository, for example `route-lab`.
2. **Add file → Upload files.** Drag in the *contents* of this folder (`index.html`, `style.css`, `app.js`, `manifest.json`, `icons`, `docs`, `README.md`), not the folder itself. `index.html` must sit at the top level of the repository. Click **Commit changes**.
3. **Settings → Pages → Build and deployment.** Source: *Deploy from a branch*. Branch: `main`, folder `/ (root)`. Save.
4. Wait one to two minutes. Your app is at `https://YOUR-USERNAME.github.io/route-lab/`.
5. Open that link on your phone. Pages uses HTTPS, which the browser requires for GPS and motion sensors.

To update the app later, edit a file on GitHub (or upload it again) and commit. The site refreshes in a minute or two. If you still see the old version, reload the page.

## Try it

- **No phone handy?** Press **Demo walk**. It runs a simulated 465 m loop at 8× speed, so you can compare the three views.
- **On a phone, outside:** press **Start walking**, allow Location and Motion, put the phone in your hand or pocket, and walk. Wait until the GPS chip shows 10 m or better before you set off.
- Tap any dot to see its distance from the previous dot and the GPS accuracy at that moment.
- **Export CSV** saves every dot (time, latitude, longitude, accuracy, steps, gap) for your own analysis.

## Things to notice

- GPS wobbles 5–20 m. Add up dot-to-dot distances and your total is **longer** than the real walk. Turn on *Skip GPS readings with accuracy worse than…* and compare.
- Step length = GPS distance ÷ steps. Is it believable (about 0.6–0.8 m)? What if you hold the phone differently?
- iPhone pauses GPS when the screen is off. Route Lab asks the phone to stay awake, but keep the app in front.

## Ideas to extend with Antigravity (vibe coding)

Ask for one small change at a time, test on your phone, then commit.

1. "Add a *Save route* button that stores the walk in the browser and a list to load old walks."
2. "Show a 5-minute countdown and a *Finish* summary card: distance, steps, average speed."
3. "Colour each Time Mode dot by speed in km/h and add a legend."
4. "Add a service worker so the app opens offline." (the map tiles still need internet)
5. "Let me mark a *landmark* by tapping the map, and show the distance from my walk to it."

Log every prompt in `docs/prompt-log.md`.

## Credits and limits

- Map: [Leaflet](https://leafletjs.com) (BSD-2) with tiles from [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors. The public OSM tile server is for light use such as a class. For a real product, use a tile provider with an agreement.
- Heatmap: [leaflet.heat](https://github.com/Leaflet/Leaflet.heat) (BSD-2).
- Do not put other people's health data or photos in a public repository.
