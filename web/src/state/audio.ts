import { MediaSession } from '@capgo/capacitor-media-session';
import { jfAudioUrl, jfImageUrl, type TrackSummary } from '@encore/shared';
import { api } from '../api/client';
import { useSession } from './session';
import { usePlayer, currentTrack, type RepeatMode } from './player';

/** Fire-and-forget play/skip/complete reporting — feeds smart shuffle. */
function report(event: 'play' | 'complete' | 'skip', t: TrackSummary, positionSec?: number) {
  if (!useSession.getState().session) return;
  void api('/api/playback/events', {
    method: 'POST',
    body: { itemId: t.id, event, positionSec, durationSec: t.durationSec },
  }).catch(() => {});
}

export const playbackEvents = {
  onPlay: (t: TrackSummary) => report('play', t),
  onComplete: (t: TrackSummary, positionSec: number) => report('complete', t, positionSec),
  onSkip: (t: TrackSummary, positionSec: number) => report('skip', t, positionSec),
};

let active: HTMLAudioElement | null = null;
let preload: HTMLAudioElement | null = null;

if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as any).__encorePlayer = {
    getState: () => usePlayer.getState(),
    getAudio: () => ({ src: active?.src, paused: active?.paused, currentTime: active?.currentTime }),
  };
}

function makeEl(): HTMLAudioElement {
  const el = new Audio();
  el.preload = 'auto';
  el.addEventListener('timeupdate', () => {
    if (el !== active) return;
    usePlayer.setState({ positionSec: el.currentTime, durationSec: effectiveDuration(el) });
    updatePositionState(el);
  });
  el.addEventListener('loadedmetadata', () => {
    if (el !== active) return;
    usePlayer.setState({ durationSec: effectiveDuration(el) });
  });
  el.addEventListener('play', () => {
    if (el !== active) return;
    usePlayer.setState({ isPlaying: true });
    // on Android this starts/keeps the foreground service that owns the
    // media notification, so playback survives backgrounding
    void MediaSession.setPlaybackState({ playbackState: 'playing' }).catch(() => {});
  });
  el.addEventListener('pause', () => {
    if (el !== active) return;
    usePlayer.setState({ isPlaying: false });
    void MediaSession.setPlaybackState({ playbackState: 'paused' }).catch(() => {});
  });
  el.addEventListener('ended', () => {
    if (el === active) handleEnded();
  });
  el.addEventListener('error', () => {
    if (el === active) {
      console.error('audio element error', el.error);
      usePlayer.setState({ isPlaying: false });
    }
  });
  return el;
}

function effectiveDuration(el: HTMLAudioElement): number {
  if (Number.isFinite(el.duration) && el.duration > 0) return el.duration;
  return currentTrack(usePlayer.getState())?.durationSec ?? 0;
}

function urlFor(t: TrackSummary): string | null {
  const session = useSession.getState().session;
  if (!session) return null;
  return jfAudioUrl(session.jellyfin, t.id);
}

function ensureActive(): HTMLAudioElement {
  if (!active) active = makeEl();
  return active;
}

function loadTrack(t: TrackSummary, autoplay: boolean) {
  const url = urlFor(t);
  if (!url) return;
  let el = ensureActive();
  if (preload && preload.src === url) {
    // near-gapless handoff: the next track is already buffered
    el.pause();
    const old = el;
    el = preload;
    active = el;
    preload = old;
    old.removeAttribute('src');
    el.volume = usePlayer.getState().volume;
  } else {
    el.src = url;
    el.load();
  }
  usePlayer.setState({ positionSec: 0, durationSec: t.durationSec });
  if (autoplay) {
    void el.play().catch((err) => console.warn('autoplay blocked or failed', err));
  }
  setMediaSessionMetadata(t);
  playbackEvents.onPlay(t);
  queueMicrotask(preloadNext);
}

function preloadNext() {
  const s = usePlayer.getState();
  const nextIdx = nextIndex(s.index, s.queue.length, s.repeat, false);
  if (nextIdx === null) return;
  const next = s.queue[nextIdx];
  if (!next) return;
  const url = urlFor(next);
  if (!url) return;
  if (!preload) preload = makeEl();
  if (preload.src !== url) {
    preload.src = url;
    preload.load();
  }
}

function nextIndex(index: number, len: number, repeat: RepeatMode, manual: boolean): number | null {
  if (len === 0) return null;
  if (repeat === 'one' && !manual) return index;
  if (index + 1 < len) return index + 1;
  if (repeat === 'all') return 0;
  return null;
}

function handleEnded() {
  const s = usePlayer.getState();
  const t = currentTrack(s);
  if (t) playbackEvents.onComplete(t, s.positionSec);
  const idx = nextIndex(s.index, s.queue.length, s.repeat, false);
  if (idx === null) {
    usePlayer.setState({ isPlaying: false, positionSec: 0 });
    return;
  }
  usePlayer.setState({ index: idx });
  const next = usePlayer.getState().queue[idx];
  if (next) loadTrack(next, true);
}

// ---------- public controls ----------

export function playQueue(tracks: TrackSummary[], startIndex = 0) {
  if (!tracks.length) return;
  usePlayer.setState({ queue: tracks, index: startIndex });
  const t = tracks[startIndex];
  if (t) loadTrack(t, true);
}

export function playTrackAt(index: number) {
  const s = usePlayer.getState();
  const t = s.queue[index];
  if (!t) return;
  usePlayer.setState({ index });
  loadTrack(t, true);
}

export function togglePlay() {
  const el = active;
  if (!el || !el.src) return;
  if (el.paused) void el.play().catch(() => {});
  else el.pause();
}

export function next(manual = true) {
  const s = usePlayer.getState();
  const t = currentTrack(s);
  if (manual && t) playbackEvents.onSkip(t, s.positionSec);
  const idx = nextIndex(s.index, s.queue.length, s.repeat, manual);
  if (idx === null) return;
  usePlayer.setState({ index: idx });
  const nextTrack = usePlayer.getState().queue[idx];
  if (nextTrack) loadTrack(nextTrack, true);
}

export function prev() {
  const s = usePlayer.getState();
  if ((active?.currentTime ?? 0) > 3 || s.index <= 0) {
    seek(0);
    return;
  }
  const t = currentTrack(s);
  if (t) playbackEvents.onSkip(t, s.positionSec);
  usePlayer.setState({ index: s.index - 1 });
  const prevTrack = usePlayer.getState().queue[s.index - 1];
  if (prevTrack) loadTrack(prevTrack, true);
}

export function seek(sec: number) {
  if (active) {
    active.currentTime = sec;
    usePlayer.setState({ positionSec: sec });
  }
}

export function setVolume(v: number) {
  usePlayer.setState({ volume: v });
  if (active) active.volume = v;
}

export function setRepeat(r: RepeatMode) {
  usePlayer.setState({ repeat: r });
  preloadNext();
}

export function addToQueue(tracks: TrackSummary[]) {
  const s = usePlayer.getState();
  usePlayer.setState({ queue: [...s.queue, ...tracks] });
  if (s.index === -1) playTrackAt(0);
}

export function playNext(tracks: TrackSummary[]) {
  const s = usePlayer.getState();
  const q = [...s.queue];
  q.splice(s.index + 1, 0, ...tracks);
  usePlayer.setState({ queue: q });
  if (s.index === -1) playTrackAt(0);
  else preloadNext();
}

export function removeFromQueue(index: number) {
  const s = usePlayer.getState();
  if (index === s.index) return;
  const q = s.queue.filter((_, i) => i !== index);
  usePlayer.setState({ queue: q, index: index < s.index ? s.index - 1 : s.index });
}

// ---------- media session ----------
// @capgo/capacitor-media-session delegates to navigator.mediaSession on the
// web and to a foreground service + media notification on Android, so the
// same calls cover browser tabs, PWA installs, and the native app.

let handlersRegistered = false;
function registerMediaHandlers() {
  if (handlersRegistered) return;
  handlersRegistered = true;
  const on = (action: Parameters<typeof MediaSession.setActionHandler>[0]['action'], fn: (d: { seekTime?: number | null }) => void) =>
    void MediaSession.setActionHandler({ action }, fn).catch(() => {});
  on('play', () => togglePlay());
  on('pause', () => togglePlay());
  on('previoustrack', () => prev());
  on('nexttrack', () => next());
  on('seekto', (d) => {
    if (d.seekTime != null) seek(d.seekTime);
  });
  on('stop', () => {
    active?.pause();
  });
}

function setMediaSessionMetadata(t: TrackSummary) {
  registerMediaHandlers();
  const session = useSession.getState().session;
  const artwork =
    session && t.imageItemId
      ? [96, 256, 512].map((size) => ({
          src: jfImageUrl(session.jellyfin, t.imageItemId!, { tag: t.imageTag, size }),
          sizes: `${size}x${size}`,
          type: 'image/jpeg',
        }))
      : [];
  void MediaSession.setMetadata({
    title: t.name,
    artist: t.artists.join(', '),
    album: t.album ?? undefined,
    artwork,
  }).catch(() => {});
}

let lastPos = 0;
function updatePositionState(el: HTMLAudioElement) {
  if (Math.abs(el.currentTime - lastPos) < 1) return;
  lastPos = el.currentTime;
  const duration = effectiveDuration(el);
  void MediaSession.setPositionState({
    duration,
    position: Math.min(el.currentTime, duration),
    playbackRate: el.playbackRate,
  }).catch(() => {});
}
