/**
 * Injected into the MUSIC POD only, beside the notification hook and for the
 * same reason: the thing worth knowing lives in the page, and the standard API
 * the page already fills in is the way to reach it.
 *
 * That API is `navigator.mediaSession` - what feeds the keyboard's media keys
 * and the Windows volume flyout. Every music service fills it in, so nothing
 * here knows or cares which service is loaded.
 *
 * Reading is done by POLLING rather than by intercepting. `metadata` and
 * `playbackState` are plain attributes, so reading them works no matter when
 * this hook ran relative to the page's own scripts - which matters, because
 * `dom-ready` is not guaranteed to beat a page that sets itself up early. One
 * read a second is nothing next to what a music page is already doing.
 *
 * Controlling has no such luxury: `setActionHandler` registrations cannot be
 * read back, so they are captured by wrapping the method. A page that
 * registered its handlers before this hook ran therefore hands over nothing -
 * hence the fallback onto the page's own `<audio>`/`<video>` element, which
 * still answers play and pause. Next/previous have no such fallback, and the
 * mini player disables those buttons rather than pretending.
 */
export const MEDIA_HOOK = `(() => {
  const ms = navigator.mediaSession;
  if (!ms) return;
  // A second run on the same document would wrap twice and poll twice. Flagged
  // at wrap time rather than when reporting starts, because those are no longer
  // the same moment: see the wait for __deskpods at the bottom.
  if (window.__deskpodsMediaHook) {
    if (window.__deskpodsMedia) window.__deskpodsMedia();
    return;
  }
  window.__deskpodsMediaHook = true;

  const handlers = Object.create(null);
  const original = ms.setActionHandler ? ms.setActionHandler.bind(ms) : null;
  if (original) {
    ms.setActionHandler = function (action, handler) {
      if (handler) { handlers[action] = handler; } else { delete handlers[action]; }
      return original(action, handler);
    };
  }

  /** Whatever the page is actually playing, preferred over a stalled sibling. */
  const element = () => {
    const all = document.querySelectorAll('video, audio');
    for (let i = 0; i < all.length; i++) { if (!all[i].paused) return all[i]; }
    return all[0] || null;
  };

  /** The largest artwork offered: the mini player would rather scale down. */
  const artworkOf = (meta) => {
    const art = (meta && meta.artwork) || [];
    let best = '', bestArea = -1;
    for (let i = 0; i < art.length; i++) {
      // Split rather than match: a backslash class inside this template
      // literal is eaten before it ever reaches the page, so the regex that
      // reads naturally here is not the regex that would run there.
      const first = String(art[i].sizes || '').split(' ')[0].split('x');
      const area = (Number(first[0]) || 0) * (Number(first[1]) || 0);
      if (area >= bestArea) { bestArea = area; best = art[i].src || ''; }
    }
    return best;
  };

  // setPositionState cannot be read back either, so it is captured on the way
  // past - the fallback for a page that drives audio without a media element
  // this hook can see (Web Audio, or a cross-origin frame).
  let position = null;
  const setPosition = ms.setPositionState ? ms.setPositionState.bind(ms) : null;
  if (setPosition) {
    ms.setPositionState = function (state) {
      if (state) { position = { at: Date.now(), state: state }; }
      else { position = null; }
      return setPosition(state);
    };
  }

  /** Seconds elapsed and total, preferring the element (it stays live). */
  const timeOf = (el) => {
    if (el && isFinite(el.duration) && el.duration > 0) {
      return { position: el.currentTime || 0, duration: el.duration };
    }
    if (position) {
      const state = position.state;
      const rate = state.playbackRate || 1;
      const elapsed = ms.playbackState === 'playing' ? (Date.now() - position.at) / 1000 : 0;
      const total = state.duration || 0;
      const at = (state.position || 0) + elapsed * rate;
      return { position: total ? Math.min(at, total) : at, duration: total };
    }
    return { position: 0, duration: 0 };
  };

  /**
   * Whether this page can be asked about its own state at all.
   *
   * Some pages answer neither question: no media element this side can see
   * (SoundCloud drives audio without one) and playbackState left at 'none'.
   * There is then nothing to read, and the only thing play/pause can go on is
   * what WE last asked for. Tracked here for that, and for nothing else - it is
   * a guess, and it is never shown as if it were knowledge.
   */
  const unknowable = () =>
    !element() && ms.playbackState !== 'playing' && ms.playbackState !== 'paused';

  let assumed = false;
  let lastMeta = '';

  let last = '';
  const report = () => {
    const meta = ms.metadata;
    const el = element();
    const time = timeOf(el);
    const blind = unknowable();
    // A new track means something started it, whoever pressed play. The only
    // use for this is the guess below.
    const metaKey = meta ? (meta.title || '') + '|' + (meta.artist || '') : '';
    if (blind && metaKey && metaKey !== lastMeta) assumed = true;
    lastMeta = metaKey;
    // Some pages never set playbackState; the element is then the only truth,
    // and when there is neither, our own last command is all there is.
    const playing = blind
      ? assumed
      : ms.playbackState === 'playing' ||
        (ms.playbackState !== 'paused' && !!el && !el.paused);
    const info = {
      title: (meta && meta.title) || '',
      artist: (meta && meta.artist) || '',
      album: (meta && meta.album) || '',
      artwork: artworkOf(meta),
      playing: playing,
      canNext: !!handlers.nexttrack,
      canPrevious: !!handlers.previoustrack,
      // Reported for the same reason as canNext: so the control can be greyed
      // out rather than sit there looking usable and doing nothing. A page that
      // drives audio without an element this side can see (SoundCloud) offers
      // neither a level to set nor a position to scrub.
      canSeek: !!handlers.seekto || (!!el && isFinite(el.duration) && el.duration > 0),
      canVolume: !!el && typeof el.volume === 'number',
      // Rounded: a seek bar does not need milliseconds, and reporting them
      // would push a change through on every single poll. A remote's clock is
      // already whole seconds.
      position: Math.round(time.position),
      duration: Math.round(time.duration),
      volume: el && typeof el.volume === 'number' ? el.volume : 1
    };
    const key = JSON.stringify(info);
    if (key === last) return;
    last = key;
    try { window.__deskpods.media(info); } catch (e) {}
  };
  const onCommand = (action) => {
    action = action || {};
    const command = action.command;
    const value = action.value;
    const fire = (name, fallback) => {
      const handler = handlers[name];
      if (handler) { try { handler(); return; } catch (e) {} }
      if (fallback) fallback();
    };
    if (command === 'next') {
      if (unknowable()) assumed = true;
      fire('nexttrack');
    } else if (command === 'previous') {
      if (unknowable()) assumed = true;
      fire('previoustrack');
    } else if (command === 'seek') {
      const el = element();
      // The site's own seekto handler knows about ads and chapter skips; the
      // element is only the fallback.
      if (handlers.seekto) {
        try { handlers.seekto({ seekTime: value }); } catch (e) {}
      } else if (el) {
        try { el.currentTime = value; } catch (e) {}
      }
    } else if (command === 'volume') {
      const all = document.querySelectorAll('video, audio');
      for (let i = 0; i < all.length; i++) {
        try { all[i].volume = value; } catch (e) {}
      }
    } else if (unknowable()) {
      // Nothing to read, so alternate on our own record. Deriving "paused"
      // from playbackState here is what made every press fire 'play' and
      // Pause never get sent at all.
      assumed = !assumed;
      fire(assumed ? 'play' : 'pause');
    } else {
      const el = element();
      const paused = el ? el.paused : ms.playbackState !== 'playing';
      if (paused) { fire('play', () => { if (el) el.play(); }); }
      else { fire('pause', () => { if (el) el.pause(); }); }
    }
    // Beat the poller so the button flips under the cursor, not a beat later.
    setTimeout(report, 200);
  };

  /**
   * Reporting starts as soon as there is a bridge to report THROUGH, which is
   * not necessarily now.
   *
   * Wrapping setActionHandler is the one thing that has to happen before the
   * page's own scripts run: registrations made before the wrapper is in place
   * cannot be read back, and that is why next/previous were dead on services
   * that register early (measured on Apple Music: nothing captured at all,
   * while its media keys plainly worked). So the hook is injected at document
   * start, and at that point the preload may not have exposed __deskpods yet.
   *
   * Bailing out then, which is what the guard at the top of this file used to
   * do, would trade one missing feature for all of them. Everything below the
   * wrapper can wait instead.
   */
  const begin = () => {
    window.__deskpodsMedia = report;
    try {
      window.__deskpods.onMediaCommand(onCommand);
    } catch (e) {}
    setInterval(report, 1000);
    report();
  };

  if (window.__deskpods) {
    begin();
  } else {
    const waiting = setInterval(() => {
      if (!window.__deskpods) return;
      clearInterval(waiting);
      begin();
    }, 50);
  }
})();`
