/* Route Lab · app.js
   Week 6 · Mobile Application Development · NTUNHS

   What this app does
     1. Counts your steps with the phone's accelerometer (devicemotion event).
     2. Reads your position with the Geolocation API (watchPosition).
     3. Drops a dot on the map at the latest GPS position, in two ways:
          Step Mode - every N steps          (default 5)
          Time Mode - every N seconds        (default 3)
     4. Shows the dots in three views:
          Step Mode - darker dot = moved farther since the previous dot
          Time Mode - darker dot = dots closer together (you were slow or stopped)
          Heatmap   - brighter glow = more time spent there

   Sections: 1 Settings and state - 2 Map - 3 Recording dots - 4 Step counter - 5 GPS
             6 Demo walk - 7 Buttons and screen - 8 Export - 9 Start-up
*/
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  if (typeof L === 'undefined') {
    $('status').textContent = 'The map library could not be loaded. Check your internet connection and reload the page.';
    return;
  }

  /* ---------------------------------------------------------------------- */
  /* 1. Settings and state                                                   */
  /* ---------------------------------------------------------------------- */

  var DEFAULTS = { view: 'step', stepsPerDot: 5, secPerDot: 3, sensitivity: 1.2, filter: false, maxAcc: 12, follow: true };
  var SETTINGS_KEY = 'routelab.settings.v1';
  var S = loadSettings();

  function loadSettings() {
    var s = {}, k;
    for (k in DEFAULTS) s[k] = DEFAULTS[k];
    try {
      var saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      for (k in DEFAULTS) if (typeof saved[k] === typeof DEFAULTS[k]) s[k] = saved[k];
      if (['step', 'time', 'heat'].indexOf(s.view) < 0) s.view = 'step';
    } catch (e) { /* storage can be blocked; the app works without it */ }
    return s;
  }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(S)); } catch (e) { /* ignore */ }
  }

  // Everything that changes while you walk lives in this one object.
  var run = newRun();
  function newRun() {
    return {
      state: 'idle',            // 'idle' | 'running' | 'paused'
      mode: 'live',             // 'live' (real sensors) | 'demo' (simulated walk)
      steps: 0,
      activeMs: 0,              // time spent in the 'running' state
      lastTick: 0,
      fix: null,                // latest GPS reading: { lat, lon, acc, ts }
      dots: { step: [], time: [] },
      dist: { step: 0, time: 0 },
      skipped: { step: 0, time: 0 },
      warp: 1,                  // 1 = real time. The demo walk runs faster.
      motionSamples: 0,
      demo: null,
      uiTimer: null,
      dotTimer: null,
      demoTimer: null
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Small helpers                                                           */
  /* ---------------------------------------------------------------------- */

  // Great-circle distance between two GPS points, in metres (the Haversine formula).
  function haversine(lat1, lon1, lat2, lon2) {
    var R = 6371000, rad = function (d) { return d * Math.PI / 180; };
    var dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
    var a = Math.pow(Math.sin(dLat / 2), 2) +
            Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.pow(Math.sin(dLon / 2), 2);
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  function hex(h) { return [1, 3, 5].map(function (i) { return parseInt(h.slice(i, i + 2), 16); }); }
  function ramp(stops, v) {
    v = Math.max(0, Math.min(1, v));
    var x = v * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
    var a = hex(stops[i]), b = hex(stops[i + 1]);
    return 'rgb(' + a.map(function (c, k) { return Math.round(c + (b[k] - c) * f); }).join(',') + ')';
  }
  function fmtTime(sec) {
    sec = Math.floor(sec);
    var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
  }
  function fmtDist(m) { return m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m'; }
  function setStatus(text) { $('status').textContent = text; }
  function setChip(id, text, level) {
    var el = $(id); el.textContent = text; el.setAttribute('data-level', level || '');
  }

  /* ---------------------------------------------------------------------- */
  /* 2. Map                                                                  */
  /* ---------------------------------------------------------------------- */

  var STEP_RAMP = ['#B5D0F2', '#5D93D6', '#1F5BAA', '#0B2E66'];   // light blue -> dark blue
  var TIME_RAMP = ['#F9CC95', '#EB9238', '#B4510C', '#6B2600'];   // light orange -> dark brown

  var map = L.map('map').setView([25.0478, 121.5170], 13);        // Taipei, until the first GPS reading
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

  map.createPane('you');
  map.getPane('you').style.zIndex = 620;                           // "you are here" sits above the dots

  var TRACK_STYLE = { color: '#6F7F8B', weight: 2, opacity: 0.9 };
  var groups = { step: L.layerGroup(), time: L.layerGroup() };
  var tracks = { step: L.polyline([], TRACK_STYLE), time: L.polyline([], TRACK_STYLE) };
  var heat = L.heatLayer([], {
    radius: 16, blur: 16, maxZoom: 18, max: 1, minOpacity: 0.25,
    gradient: { 0.2: '#5B1F0A', 0.5: '#D9531E', 0.75: '#FF9A3D', 1.0: '#FFF1C2' }
  });
  var youDot = null, youHalo = null;

  function dotColor(kind, d) {
    if (kind === 'step') {
      var n = S.stepsPerDot;                                       // darker = farther between dots
      return ramp(STEP_RAMP, (d - 0.5 * n) / (0.8 * n));
    }
    return ramp(TIME_RAMP, 1 - d / (S.secPerDot * 2.2));           // darker = closer together
  }
  function dotPopup(kind, dot) {
    var what = kind === 'step' ? 'Step dot' : 'Time dot';
    return what + ' ' + dot.n + '<br>' + dot.d.toFixed(1) + ' m from the previous dot<br>' +
           'GPS accuracy ±' + Math.round(dot.acc) + ' m<br>' + dot.steps + ' steps so far';
  }
  function makeMarker(kind, dot, index) {
    var first = index === 0;
    return L.circleMarker([dot.lat, dot.lon], {
      radius: 6, weight: 1.5, color: '#14202B', opacity: 0.8, fillOpacity: 1,
      fillColor: first ? '#14202B' : dotColor(kind, dot.d)
    }).bindPopup(dotPopup(kind, dot));
  }
  function heatIntensity() { return Math.min(0.5, 0.07 * S.secPerDot); }   // longer gaps = each dot stands for more seconds

  // Rebuild every layer from the recorded dots (used when a setting or the view changes).
  function rebuild() {
    ['step', 'time'].forEach(function (kind) {
      var list = run.dots[kind];
      groups[kind].clearLayers();
      tracks[kind].setLatLngs(list.map(function (d) { return [d.lat, d.lon]; }));
      groups[kind].addLayer(tracks[kind]);
      list.forEach(function (d, i) { groups[kind].addLayer(makeMarker(kind, d, i)); });
    });
    var w = heatIntensity();
    heat.setLatLngs(run.dots.time.map(function (d) { return [d.lat, d.lon, w]; }));
  }
  function drawNewDot(kind, dot) {
    var list = run.dots[kind];
    groups[kind].addLayer(makeMarker(kind, dot, list.length - 1));
    tracks[kind].addLatLng([dot.lat, dot.lon]);
    if (kind === 'time') heat.addLatLng([dot.lat, dot.lon, heatIntensity()]);
  }
  function showView() {
    [groups.step, groups.time, heat].forEach(function (l) { if (map.hasLayer(l)) map.removeLayer(l); });
    map.addLayer(S.view === 'step' ? groups.step : S.view === 'time' ? groups.time : heat);
    $('map').classList.toggle('heat-view', S.view === 'heat');
    document.querySelectorAll('#seg button').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-view') === S.view));
    });
    renderLegend();
    updateStats();
  }

  function renderLegend() {
    var you = '<span class="key"><b></b>You</span>', html;
    if (S.view === 'heat') {
      html = '<div class="ramp"><span>few dots</span><i style="background:linear-gradient(90deg,#5B1F0A,#D9531E,#FF9A3D,#FFF1C2)"></i><span>many dots</span></div>' +
             '<span>Brighter = more time spent here</span>' + you;
    } else if (S.view === 'step') {
      var n = S.stepsPerDot;
      html = '<div class="ramp"><span>short gap ' + (0.5 * n).toFixed(1) + ' m</span><i style="background:linear-gradient(90deg,' + STEP_RAMP.join(',') + ')"></i><span>long gap ' + (1.3 * n).toFixed(1) + ' m</span></div>' +
             '<span>Darker = moved farther between dots</span>' + you;
    } else {
      html = '<div class="ramp"><span>far apart ' + (S.secPerDot * 2.2).toFixed(1) + ' m</span><i style="background:linear-gradient(90deg,' + TIME_RAMP.join(',') + ')"></i><span>touching 0 m</span></div>' +
             '<span>Darker = dots closer together</span>' + you;
    }
    $('legend').innerHTML = html;
  }

  /* ---------------------------------------------------------------------- */
  /* 3. Recording dots                                                       */
  /* ---------------------------------------------------------------------- */

  // Put a dot on the map at the latest GPS reading.  kind is 'step' or 'time'.
  function addDot(kind) {
    var f = run.fix;
    if (!f || run.state !== 'running') return;
    var list = run.dots[kind], prev = list[list.length - 1];
    if (prev && prev.fixTs === f.ts) return;                       // no new GPS reading since the last dot
    if (S.filter && f.acc > S.maxAcc) {                            // GPS says it is not sure: skip this one
      run.skipped[kind]++; updateStats(); return;
    }
    var d = prev ? haversine(prev.lat, prev.lon, f.lat, f.lon) : 0;
    var when = run.demo ? run.demo.clock : Date.now();
    var dot = { n: list.length + 1, time: new Date(when).toISOString(), lat: f.lat, lon: f.lon,
                acc: f.acc, steps: run.steps, d: d, fixTs: f.ts };
    list.push(dot);
    run.dist[kind] += d;
    drawNewDot(kind, dot);
    updateStats();
  }

  function countStep() {
    if (run.state !== 'running') return;
    run.steps++;
    if (run.steps % S.stepsPerDot === 0) addDot('step');           // Step Mode: one dot every N steps
    else updateStats();
  }

  function updateStats() {
    var kind = S.view === 'step' ? 'step' : 'time', list = run.dots[kind];
    $('vSteps').textContent = run.steps;
    $('vTime').textContent = fmtTime(run.activeMs / 1000);
    $('vDots').textContent = list.length;
    $('sDots').textContent = run.skipped[kind]
      ? run.skipped[kind] + ' skipped (poor accuracy)'
      : (kind === 'step' ? 'one per ' + S.stepsPerDot + ' steps' : 'one per ' + S.secPerDot + ' s');
    $('vDist').textContent = fmtDist(run.dist[kind]);
    var stepsBetween = list.length >= 2 ? list[list.length - 1].steps - list[0].steps : 0;
    $('vStride').textContent = stepsBetween >= 5 ? (run.dist[kind] / stepsBetween).toFixed(2) + ' m' : 'n/a';
    $('vAcc').textContent = run.fix ? '±' + Math.round(run.fix.acc) + ' m' : 'n/a';
  }

  /* ---------------------------------------------------------------------- */
  /* 4. Step counter (accelerometer)                                         */
  /* ---------------------------------------------------------------------- */
  /* Idea: gravity makes the total acceleration about 9.8 m/s2 when the phone is still.
     Each footstep adds a short bump on top. We (1) estimate gravity with a slow average,
     (2) smooth the rest with a fast average to remove jitter, and (3) count a step each time
     the bump rises above the threshold. A step cannot follow another one within 0.28 s. */

  var MIN_STEP_GAP = 280;                                          // milliseconds
  var det = { base: null, smooth: 0, armed: true, lastStep: -1e9, lastT: 0 };

  function processSample(ax, ay, az, t) {                          // t = milliseconds
    var mag = Math.sqrt(ax * ax + ay * ay + az * az);
    if (det.base === null) { det.base = mag; det.lastT = t; return; }
    var dt = Math.max(0.001, Math.min(0.2, (t - det.lastT) / 1000));
    det.lastT = t;
    det.base += (1 - Math.exp(-dt / 1.5)) * (mag - det.base);      // slow average = gravity
    var bump = mag - det.base;                                     // movement on top of gravity
    det.smooth += (1 - Math.exp(-dt / 0.05)) * (bump - det.smooth);// fast average = less jitter
    if (det.armed && det.smooth > S.sensitivity && t - det.lastStep > MIN_STEP_GAP) {
      det.armed = false; det.lastStep = t;
      countStep();
    } else if (!det.armed && det.smooth < S.sensitivity * 0.4) {
      det.armed = true;                                            // bump is over, ready for the next step
    }
  }

  function onMotion(e) {
    if (run.mode !== 'live') return;
    var a = e.accelerationIncludingGravity;
    if (!a || a.x == null || a.y == null || a.z == null) return;
    if (run.motionSamples++ === 0) setChip('chipMotion', 'Motion: on', 'ok');
    processSample(a.x, a.y, a.z, e.timeStamp);
  }

  var motionOn = false;
  // On iPhone, motion data needs a permission that can only be requested from a tap.
  function enableMotion() {
    if (motionOn) return Promise.resolve(true);
    if (!('DeviceMotionEvent' in window)) {
      setChip('chipMotion', 'Motion: no sensor', 'bad');
      return Promise.resolve(false);
    }
    var attach = function () {
      window.addEventListener('devicemotion', onMotion);
      motionOn = true;
      setChip('chipMotion', 'Motion: waiting', 'warn');
      return true;
    };
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      return DeviceMotionEvent.requestPermission().then(function (r) {
        if (r === 'granted') return attach();
        setChip('chipMotion', 'Motion: blocked', 'bad');
        return false;
      }).catch(function () {
        setChip('chipMotion', 'Motion: blocked', 'bad');
        return false;
      });
    }
    return Promise.resolve(attach());
  }

  /* ---------------------------------------------------------------------- */
  /* 5. GPS (Geolocation API)                                                */
  /* ---------------------------------------------------------------------- */

  var watchId = null;

  function startGps() {
    if (watchId !== null) return;
    if (!('geolocation' in navigator)) { setChip('chipGps', 'GPS: no sensor', 'bad'); return; }
    setChip('chipGps', 'GPS: searching', 'warn');
    watchId = navigator.geolocation.watchPosition(onGpsFix, onGpsError, {
      enableHighAccuracy: true, maximumAge: 0, timeout: 20000
    });
  }
  function stopGps() {
    if (watchId !== null && 'geolocation' in navigator) navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  function onGpsFix(pos) {
    if (run.mode !== 'live') return;
    var c = pos.coords;
    setFix(c.latitude, c.longitude, c.accuracy, pos.timestamp);
  }
  function onGpsError(err) {
    if (err.code === 1) {                                          // PERMISSION_DENIED
      setChip('chipGps', 'GPS: blocked', 'bad');
      setStatus('Location is blocked. Allow location for this site in your browser settings, then reload the page.');
    } else {
      setChip('chipGps', 'GPS: searching', 'warn');                // timeout or no signal: it keeps trying
    }
  }

  // Every new position (real or from the demo) goes through here.
  function setFix(lat, lon, acc, ts) {
    var first = !run.fix;
    run.fix = { lat: lat, lon: lon, acc: acc, ts: ts };
    if (!youDot) {
      youHalo = L.circle([lat, lon], { pane: 'you', radius: acc, weight: 1, color: '#1F6FD1', fillColor: '#1F6FD1', fillOpacity: 0.14, interactive: false }).addTo(map);
      youDot = L.circleMarker([lat, lon], { pane: 'you', radius: 7, weight: 2.5, color: '#FFFFFF', fillColor: '#1F6FD1', fillOpacity: 1, interactive: false }).addTo(map);
    } else {
      youHalo.setLatLng([lat, lon]).setRadius(acc);
      youDot.setLatLng([lat, lon]);
    }
    setChip('chipGps', 'GPS: ±' + Math.round(acc) + ' m', acc <= 10 ? 'ok' : acc <= 25 ? 'warn' : 'bad');
    if (first && run.mode === 'live') map.setView([lat, lon], Math.max(map.getZoom(), 18));
    else if (S.follow && run.mode === 'live' && run.state === 'running') map.panTo([lat, lon], { animate: true, duration: 0.5 });
    $('vAcc').textContent = '±' + Math.round(acc) + ' m';
  }

  /* ---------------------------------------------------------------------- */
  /* 6. Demo walk (no sensors needed)                                        */
  /* ---------------------------------------------------------------------- */
  /* Walks a simulated 465 m loop around the middle of the map, with simulated GPS wobble.
     Slow along the bottom, brisk up the right side, a 20 s stop on top, normal down the left.
     It runs 8 times faster than real time. It uses the same functions as the real app. */

  var DEMO_PTS = [[0,0],[110,0],[125,15],[125,95],[110,110],[0,110],[-15,95],[-15,15]];
  var DEMO_DT = 0.1, DEMO_STOP_S = 290, DEMO_STOP_SEC = 20, DEMO_GPS_ERROR = 5, DEMO_WARP = 8;

  function demoSegments() {
    var segs = [], total = 0;
    for (var i = 0; i < DEMO_PTS.length; i++) {
      var a = DEMO_PTS[i], b = DEMO_PTS[(i + 1) % DEMO_PTS.length], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      segs.push({ a: a, b: b, len: len, start: total }); total += len;
    }
    return { segs: segs, total: total };
  }
  function gauss() { var u = 0; while (!u) u = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random()); }

  function demoPos(g, s) {
    s = Math.max(0, Math.min(g.total, s));
    for (var i = g.segs.length - 1; i >= 0; i--) {
      if (s >= g.segs[i].start) {
        var q = g.segs[i], f = q.len ? (s - q.start) / q.len : 0;
        return [q.a[0] + (q.b[0] - q.a[0]) * f, q.a[1] + (q.b[1] - q.a[1]) * f];
      }
    }
    return DEMO_PTS[0];
  }

  function startDemo() {
    resetAll();
    var c = map.getCenter(), g = demoSegments();
    run.mode = 'demo';
    run.warp = DEMO_WARP;
    run.demo = { geo: g, c: c, s: 0, since: 0, stopLeft: 0, stopped: false, vt: 0, nextFix: 0,
                 ex: 0, ey: 0, acc: 0, clock: Date.now(), done: false };
    map.setView(c, 18);                                            // the whole loop fits on a phone screen
    setChip('chipGps', 'GPS: demo', 'warn');
    setChip('chipMotion', 'Motion: demo', 'warn');
    setStatus('Demo walk: a simulated loop at 8x speed. Watch the dots appear, then switch views.');
    beginRun();
    demoStep(0);                                                   // first GPS reading right away
  }

  function demoTick() {
    var d = run.demo;
    if (!d || run.state !== 'running') return;
    d.acc += 0.05 * run.warp;                                      // virtual seconds to simulate this tick
    while (d.acc >= DEMO_DT && !d.done) { demoStep(DEMO_DT); d.acc -= DEMO_DT; }
    if (d.done) {
      pauseRun();
      setStatus('Demo finished: ' + run.steps + ' steps, GPS distance ' + fmtDist(run.dist.step) + ' (the real loop is 465 m). Try the other views, or press Reset.');
    }
  }

  function demoStep(dt) {
    var d = run.demo, g = d.geo, u = d.s / g.total;
    var v = u < 0.25 ? 1.0 : (u < 0.5 ? 1.9 : 1.4);                // slow, brisk, normal
    if (!d.stopped && d.s >= DEMO_STOP_S) { d.stopped = true; d.stopLeft = DEMO_STOP_SEC; }
    if (d.stopLeft > 0) { v = 0; d.stopLeft -= dt; }
    var ds = v * dt;
    d.s += ds; d.since += ds; d.vt += dt; d.clock += dt * 1000;
    var stride = 0.35 + 0.25 * v;
    if (v > 0 && d.since >= stride) { d.since -= stride; countStep(); }
    if (d.vt >= d.nextFix) {                                       // one GPS reading per virtual second
      d.nextFix += 1;
      d.ex = 0.75 * d.ex + 0.66 * gauss();
      d.ey = 0.75 * d.ey + 0.66 * gauss();
      var acc = DEMO_GPS_ERROR * (0.5 + 1.1 * Math.random()), sg = 0.65 * acc;
      var p = demoPos(g, d.s), x = p[0] + d.ex * sg - 55, y = p[1] + d.ey * sg - 55;
      var lat = d.c.lat + y / 111320, lon = d.c.lng + x / (111320 * Math.cos(d.c.lat * Math.PI / 180));
      setFix(lat, lon, acc, Math.round(d.clock));
    }
    if (d.s >= g.total) d.done = true;
  }

  /* ---------------------------------------------------------------------- */
  /* 7. Buttons and screen                                                   */
  /* ---------------------------------------------------------------------- */

  function tick() {
    var now = performance.now();
    run.activeMs += (now - run.lastTick) * run.warp;
    run.lastTick = now;
    $('vTime').textContent = fmtTime(run.activeMs / 1000);
    if (run.mode === 'live' && motionOn && run.motionSamples === 0 && run.activeMs > 4000) {
      setChip('chipMotion', 'Motion: no data', 'bad');
      setStatus('No motion data is arriving. Use "+1 test step" to count by hand, or try another phone or browser.');
    }
  }
  function startTimers() {
    stopTimers();
    run.lastTick = performance.now();
    run.uiTimer = setInterval(tick, 250);
    run.dotTimer = setInterval(function () { addDot('time'); }, S.secPerDot * 1000 / run.warp);   // Time Mode
    if (run.demo) run.demoTimer = setInterval(demoTick, 50);
  }
  function stopTimers() {
    clearInterval(run.uiTimer); clearInterval(run.dotTimer); clearInterval(run.demoTimer);
    run.uiTimer = run.dotTimer = run.demoTimer = null;
  }

  // Ask the phone to keep the screen on, because the GPS can pause when the screen turns off.
  var wakeLock = null;
  function lockScreen() {
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        navigator.wakeLock.request('screen').then(function (l) {
          wakeLock = l;
          l.addEventListener('release', function () { wakeLock = null; });
        }).catch(function () { /* not allowed right now: fine */ });
      }
    } catch (e) { /* ignore */ }
  }
  function unlockScreen() {
    try { if (wakeLock) wakeLock.release(); } catch (e) { /* ignore */ }
    wakeLock = null;
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && run.state === 'running' && run.mode === 'live') lockScreen();
  });

  function beginRun() {
    run.state = 'running';
    startTimers();
    if (run.mode === 'live') lockScreen();
    syncButtons();
  }
  function pauseRun() {
    run.state = 'paused';
    stopTimers();
    unlockScreen();
    syncButtons();
    updateStats();
  }
  function resetAll() {
    stopTimers(); unlockScreen(); stopGps();
    if (youDot) { map.removeLayer(youDot); map.removeLayer(youHalo); youDot = youHalo = null; }
    run = newRun();
    det.base = null; det.smooth = 0; det.armed = true; det.lastStep = -1e9;
    rebuild(); showView();
    setChip('chipGps', 'GPS: off', '');
    setChip('chipMotion', motionOn ? 'Motion: waiting' : 'Motion: off', motionOn ? 'warn' : '');
    setStatus('Tap Start, allow location and motion, then walk. A dot is dropped on the map as you go.');
    syncButtons();
  }

  function onMain() {
    if (run.state === 'running') {
      pauseRun();
      setStatus('Paused. Tap Resume to keep going, or Reset to start over.');
      return;
    }
    if (run.mode === 'demo') {
      if (run.demo && !run.demo.done && run.state === 'paused') { beginRun(); return; }   // resume the demo
      resetAll();
    }
    run.mode = 'live';
    // Do this first, straight from the tap: iPhone only shows the motion permission prompt here.
    var motion = enableMotion();
    startGps();
    beginRun();
    setStatus(run.fix ? 'Walking. A dot is added every ' + S.stepsPerDot + ' steps and every ' + S.secPerDot + ' seconds.'
                      : 'Looking for GPS. Go outside if you can, and wait for the accuracy chip to show 10 m or better.');
    motion.then(function (ok) {
      if (!ok) setStatus('Steps are off because motion was not allowed. GPS dots in Time Mode still work, and "+1 test step" counts by hand.');
    });
  }

  function syncButtons() {
    var demoDone = run.mode === 'demo' && run.demo && run.demo.done;
    $('btnMain').textContent = run.state === 'running' ? 'Pause' : (run.state === 'paused' && !demoDone) ? 'Resume' : 'Start walking';
    var hasData = run.steps > 0 || run.dots.step.length > 0 || run.dots.time.length > 0 || run.state !== 'idle';
    $('btnReset').disabled = !hasData;
    $('btnDemo').disabled = run.state === 'running';
    $('btnStep').disabled = !(run.state === 'running' && run.mode === 'live');
    $('btnCsv').disabled = run.dots.step.length + run.dots.time.length === 0;
  }

  /* Settings panel */
  function bindSettings() {
    var rN = $('rN'), rSec = $('rSec'), rSens = $('rSens'), rAcc = $('rAcc'), cFilter = $('cFilter'), cFollow = $('cFollow');
    function show() {
      rN.value = S.stepsPerDot;   $('oN').textContent = S.stepsPerDot + ' steps';
      rSec.value = S.secPerDot;   $('oSec').textContent = S.secPerDot + ' s';
      rSens.value = S.sensitivity; $('oSens').textContent = S.sensitivity.toFixed(1) + ' m/s²';
      rAcc.value = S.maxAcc;      $('oAcc').textContent = S.maxAcc + ' m';
      cFilter.checked = S.filter; cFollow.checked = S.follow;
    }
    function changed(rebuildMap) {
      saveSettings(); show(); renderLegend();
      if (rebuildMap) rebuild();
      if (run.state === 'running') startTimers();                  // pick up a new Time Mode interval
      updateStats();
    }
    rN.addEventListener('input', function () { S.stepsPerDot = +rN.value; changed(true); });
    rSec.addEventListener('input', function () { S.secPerDot = +rSec.value; changed(true); });
    rSens.addEventListener('input', function () { S.sensitivity = +rSens.value; changed(false); });
    rAcc.addEventListener('input', function () { S.maxAcc = +rAcc.value; changed(false); });
    cFilter.addEventListener('change', function () { S.filter = cFilter.checked; changed(false); });
    cFollow.addEventListener('change', function () { S.follow = cFollow.checked; changed(false); });
    show();
  }

  /* ---------------------------------------------------------------------- */
  /* 8. Export                                                               */
  /* ---------------------------------------------------------------------- */

  function exportCsv() {
    var rows = [['kind', 'dot', 'time_iso', 'lat', 'lon', 'accuracy_m', 'steps_total', 'gap_from_previous_m']];
    ['step', 'time'].forEach(function (kind) {
      run.dots[kind].forEach(function (d) {
        rows.push([kind, d.n, d.time, d.lat.toFixed(7), d.lon.toFixed(7), d.acc.toFixed(1), d.steps, d.d.toFixed(2)]);
      });
    });
    if (rows.length === 1) { setStatus('No dots yet. Walk a little first.'); return; }
    var csv = rows.map(function (r) { return r.join(','); }).join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a'), t = new Date();
    var pad = function (n) { return String(n).padStart(2, '0'); };
    a.href = URL.createObjectURL(blob);
    a.download = 'route-lab-' + t.getFullYear() + pad(t.getMonth() + 1) + pad(t.getDate()) + '-' + pad(t.getHours()) + pad(t.getMinutes()) + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
    setStatus('CSV saved: ' + (rows.length - 1) + ' rows (step dots and time dots).');
  }

  /* ---------------------------------------------------------------------- */
  /* 9. Start-up                                                             */
  /* ---------------------------------------------------------------------- */

  document.querySelectorAll('#seg button').forEach(function (b) {
    b.addEventListener('click', function () { S.view = b.getAttribute('data-view'); saveSettings(); showView(); });
  });
  $('btnMain').addEventListener('click', onMain);
  $('btnReset').addEventListener('click', resetAll);
  $('btnDemo').addEventListener('click', startDemo);
  $('btnStep').addEventListener('click', countStep);
  $('btnCsv').addEventListener('click', exportCsv);

  if ('ResizeObserver' in window) new ResizeObserver(function () { map.invalidateSize(); }).observe($('map'));

  bindSettings();
  rebuild();
  showView();
  syncButtons();

  // Exposed so you can experiment from the browser console, for example RouteLab.run.dots.step
  window.RouteLab = { run: function () { return run; }, settings: S, processSample: processSample, haversine: haversine };
})();
