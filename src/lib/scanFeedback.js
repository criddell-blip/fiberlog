// Audio + haptic feedback for scanning. Used by ScanInput's continuous
// camera mode and the cycle-count scan handler so every scan gives an
// immediate, eyes-free confirmation — warehouse staff scan with the phone
// pointed at the shelf, not the screen, so a beep + buzz matters more than
// an on-screen change.
//
// Audio uses a single lazily-created WebAudio context. Browsers require the
// context to be created/resumed inside a user gesture, so callers should
// invoke unlockAudio() from a click handler (e.g. the "Scan" button) once;
// after that the beep can fire from the (non-gesture) scan callback.

let ctx = null

function getCtx() {
  if (typeof window === 'undefined') return null
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return null
    try { ctx = new AC() } catch { return null }
  }
  return ctx
}

// Call from a user-gesture handler so iOS/Safari will allow the beep to play
// later from the scan callback (which is not a gesture).
export function unlockAudio() {
  const c = getCtx()
  if (c && c.state === 'suspended') c.resume().catch(() => {})
}

function tone(freq, ms, { type = 'sine', gain = 0.06, delay = 0 } = {}) {
  const c = getCtx()
  if (!c) return
  if (c.state === 'suspended') c.resume().catch(() => {})
  const t0 = c.currentTime + delay
  const osc = c.createOscillator()
  const g = c.createGain()
  osc.type = type
  osc.frequency.value = freq
  g.gain.setValueAtTime(gain, t0)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + ms / 1000)
  osc.connect(g); g.connect(c.destination)
  osc.start(t0)
  osc.stop(t0 + ms / 1000 + 0.02)
}

// kind: 'ok' (single chirp), 'done' (rising two-tone — bin complete),
// 'error' (low buzz — unknown SKU / save failure).
export function beep(kind = 'ok') {
  if (kind === 'done') { tone(660, 80); tone(990, 120, { delay: 0.09 }) }
  else if (kind === 'error') tone(200, 160, { type: 'square', gain: 0.05 })
  else tone(880, 60)
}

export function haptic(ms = 30) {
  try { if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(ms) } catch {}
}

// Beep + buzz together. iOS ignores navigator.vibrate (no-op) — the beep
// covers it there.
export function scanFeedback(kind = 'ok') {
  beep(kind)
  haptic(kind === 'error' ? 60 : 30)
}
