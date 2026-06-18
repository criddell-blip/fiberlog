import { useEffect, useRef } from 'react'

// ─── BROWSER BACK-BUTTON COORDINATOR ──────────────────────────────────────────
//
// FiberLog has no router — every screen is a useState flip, so the browser /
// phone Back gesture used to EXIT the app instead of stepping back one screen.
// This module makes Back walk back in-app and only leave at the root.
//
// How it works: we keep a count of synthetic history entries (`armed`) equal to
// the total "back-able depth" currently on screen. Each step the user can back
// out of owns one entry. When the user presses Back the browser consumes one of
// our entries and fires `popstate`; we route that to the top-most registered
// layer's onBack (drill a screen up, or close an overlay). At the root, depth is
// 0, nothing is armed, and Back falls through to actually leave the app.
//
// Why depth (an integer) and not a boolean: the crew narrow flow is a multi-
// level stack (projects → phases/sites → tasks → workspace). A single boolean
// "is something open" can't represent "3 steps deep" — we'd own one entry for a
// 3-level descent and the 2nd hardware Back would eject the user. So each layer
// reports how many back-steps it currently contributes, and we keep that many
// history entries armed.
//
// Why a single module-level coordinator (not per-layer listeners): the browser
// delivers exactly one popstate per Back, and overlays nest on top of drilled-in
// screens (e.g. SignOutConfirm over the workspace). One listener dispatching to
// the top of an ordered list is the only way to hit the right layer once.

const layers = []        // [{ id, ref }]; tail = top. A layer moves to the tail
                         // when it becomes active (see useBackClose), so the
                         // MOST RECENTLY OPENED layer always wins — regardless of
                         // which component mounted first. This matters once sheets
                         // nest inside child components (a sheet opened over a
                         // drilled-in screen must be "above" it even though the
                         // shell mounted earlier).
let installed = false
let armed = 0            // # of synthetic history entries we currently own
let suppressPops = 0     // # of upcoming popstate events to ignore (from our own history.back())

function totalDepth() {
  let sum = 0
  for (const l of layers) sum += l.ref.current.depth || 0
  return sum
}

// Top-most active layer = last one in the array with depth > 0.
function topLayer() {
  for (let i = layers.length - 1; i >= 0; i--) {
    if ((layers[i].ref.current.depth || 0) > 0) return layers[i]
  }
  return null
}

function install() {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('popstate', onPop)
}

// Keep the number of armed history entries equal to the total back-able depth.
// Called from each layer's effect after React state settles, so it reflects the
// post-navigation depth. pushState uses url=null so the visible path never
// changes (keeps the GitHub Pages /fiberlog/ base intact — no 404-on-refresh).
function reconcile() {
  if (typeof window === 'undefined') return
  const target = totalDepth()
  while (armed < target) {
    armed++
    window.history.pushState({ __fiberlogBack: armed }, '')
  }
  while (armed > target) {
    armed--
    suppressPops++
    window.history.back()  // async; the resulting popstate is swallowed below
  }
}

function onPop() {
  // Swallow the popstate(s) caused by our own history.back() in reconcile().
  if (suppressPops > 0) { suppressPops--; return }

  // A genuine hardware/browser Back. The browser just consumed one of our
  // synthetic entries, so drop our count to match before doing anything.
  if (armed > 0) armed--

  const layer = topLayer()
  if (!layer) return  // nothing registered — let the next Back exit the app

  const { confirm, onBack } = layer.ref.current
  if (confirm && confirm() === false) {
    // Vetoed (e.g. unsaved input, user cancelled the discard prompt). Re-arm the
    // entry the browser consumed so the next Back can try again.
    armed++
    window.history.pushState({ __fiberlogBack: 'veto' }, '')
    return
  }

  // Step this layer back one. onBack flips React state, which lowers this
  // layer's depth; its effect re-runs and reconcile() confirms armed already
  // matches the new depth (we decremented above) — no extra history op needed.
  onBack()
}

/**
 * Register a back-closable layer.
 *
 * @param {number}   depth   How many back-steps this layer currently contributes.
 *                           0 = inactive (arms nothing). For a modal: open ? 1 : 0.
 *                           For a multi-level screen stack: the current level index.
 * @param {Function} onBack  Step this layer back one (reuse the existing
 *                           setScreen / onClose / setShowX handler).
 * @param {Object}   [opts]
 * @param {Function} [opts.confirm]  Optional () => boolean. Return false to VETO
 *                           the Back (e.g. show a "Discard changes?" prompt and
 *                           return false now); the hook re-arms so Back can retry.
 *
 * Call this unconditionally at the top level of a component (Rules of Hooks),
 * before any early return — pass depth 0 while loading/inactive.
 */
export function useBackClose(depth, onBack, opts = {}) {
  // Keep the latest handlers/depth in a ref so realtime re-renders don't re-arm
  // history. The ref is written every render (before effects run), so reconcile()
  // always reads the current depth.
  const ref = useRef({})
  ref.current.depth = depth
  ref.current.onBack = onBack
  ref.current.confirm = opts.confirm
  const layerRef = useRef(null)

  // Layer lifecycle — register on mount, unregister on unmount. Deps [] so the
  // layer is NOT torn down when depth changes mid-stack (drilling deeper). The
  // earlier single-effect-on-[depth] version tore the layer down on every level
  // change, which fired spurious history.back() calls and corrupted the count.
  useEffect(() => {
    const layer = { id: Symbol('backlayer'), ref, prevDepth: 0 }
    layerRef.current = layer
    layers.push(layer)
    install()
    return () => {
      const idx = layers.indexOf(layer)
      if (idx !== -1) layers.splice(idx, 1)
      reconcile()
    }
  }, [])

  // Keep the armed history-entry count in sync with this layer's depth. Runs on
  // mount and whenever depth changes — growing (push) on descent, shrinking
  // (suppressed history.back()) on a UI-initiated ascent. After a hardware Back,
  // onPop already decremented `armed`, so this reconcile is a no-op.
  useEffect(() => {
    const layer = layerRef.current
    if (layer) {
      // On activation (0 -> >0) move this layer to the tail so it becomes the
      // top-most — the most recently opened overlay receives Back first, even
      // if its component mounted before the layer underneath it.
      if (depth > 0 && layer.prevDepth === 0) {
        const i = layers.indexOf(layer)
        if (i !== -1 && i !== layers.length - 1) { layers.splice(i, 1); layers.push(layer) }
      }
      layer.prevDepth = depth
    }
    reconcile()
  }, [depth])
}
