import { useEffect, useRef, useState } from 'react'
import { BrowserMultiFormatReader } from '@zxing/browser'
import Icon from './Icon'
import { useBackClose } from '../../lib/backStack'
import { scanFeedback, unlockAudio } from '../../lib/scanFeedback'

// Unified scan-input primitive. Handles both:
//   • USB/Bluetooth scanners (HID — they type into a focused text input and
//     send a CR at the end). We listen for Enter on the visible input.
//   • Phone camera (via @zxing/browser). Tap the camera button → fullscreen
//     viewport opens → decoded barcode fires onScan and closes the viewport.
//
// Both paths fire the same `onScan(code: string)` callback so callers don't
// have to branch on input mechanism.
//
// The input auto-focuses on mount and refocuses on blur. This keeps the
// scanner-input flow "scan and forget" — the user never has to tap the
// field to give it focus. Camera button preserves focus too (clicking it
// blurs briefly but we refocus once the overlay closes).
export default function ScanInput({
  onScan,
  placeholder = 'Scan or type a code…',
  showCameraButton = true,
  autoFocus = true,
  disabled = false,
  // Continuous mode: the camera stays open across decodes (scan-and-keep-
  // scanning) with a beep/haptic + green flash per hit, instead of the
  // default one-shot "scan once and close" behavior. Opt-in so existing
  // callers are unaffected.
  continuous = false,
  scanDedupeMs = 1200,
  // Bump this counter (e.g. from a parent "Scan" button) to open the camera
  // without rendering ScanInput's own camera button.
  cameraOpenSignal = 0,
  onCameraStateChange,
}) {
  const inputRef = useRef(null)
  const [cameraOpen, setCameraOpen] = useState(false)

  // Open the camera when the parent bumps cameraOpenSignal (the bump happens
  // inside a user-gesture click, so audio is already unlocked there).
  useEffect(() => {
    if (cameraOpenSignal > 0) setCameraOpen(true)
  }, [cameraOpenSignal])

  // Phone Back / hardware Back closes the camera instead of leaving the app.
  useBackClose(cameraOpen ? 1 : 0, () => setCameraOpen(false))

  // Let the parent react to camera open/close (e.g. pause its own scan input).
  useEffect(() => { onCameraStateChange?.(cameraOpen) }, [cameraOpen, onCameraStateChange])

  // Auto-focus + refocus on blur. Tiny setTimeout so other intentional
  // focus changes (e.g. user clicked another input) win over our refocus.
  useEffect(() => {
    if (!autoFocus || disabled) return
    const el = inputRef.current
    if (!el) return
    el.focus()
    const refocus = () => {
      setTimeout(() => {
        if (document.activeElement === document.body && !cameraOpen) {
          el.focus()
        }
      }, 50)
    }
    el.addEventListener('blur', refocus)
    return () => el.removeEventListener('blur', refocus)
  }, [autoFocus, disabled, cameraOpen])

  // Refocus the input when the camera overlay closes (otherwise focus stays
  // on the camera button after dismiss and the next scanner pulse is lost).
  useEffect(() => {
    if (!cameraOpen && inputRef.current && autoFocus && !disabled) {
      inputRef.current.focus()
    }
  }, [cameraOpen, autoFocus, disabled])

  function handleKeyDown(e) {
    if (e.key === 'Enter') {
      const val = e.target.value.trim()
      if (val) {
        onScan(val)
        e.target.value = ''
      }
      e.preventDefault()
    }
  }

  return (
    <>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          ref={inputRef}
          type="text"
          placeholder={placeholder}
          onKeyDown={handleKeyDown}
          autoComplete="off"
          name="scan-input"
          disabled={disabled}
          style={{
            flex: 1,
            padding: '12px 14px',
            border: '1.5px solid var(--border2)',
            borderRadius: 'var(--r-sm)',
            background: disabled ? 'var(--gray-lt)' : 'var(--surface2)',
            color: 'var(--text)',
            fontSize: 16,
            fontFamily: 'var(--font-mono)',
            outline: 'none',
          }}
          onFocus={e => e.target.style.borderColor = 'var(--orange)'}
          onBlurCapture={e => e.target.style.borderColor = 'var(--border2)'}
        />
        {showCameraButton && (
          <button
            type="button"
            onClick={() => { unlockAudio(); setCameraOpen(true) }}
            disabled={disabled}
            title="Scan with phone camera"
            className="btn btn-ghost"
            style={{ padding: '10px 14px', flexShrink: 0, display: 'inline-flex', alignItems: 'center' }}
          >
            <Icon name="camera" size={20} />
          </button>
        )}
      </div>
      {cameraOpen && (
        <CameraScanner
          continuous={continuous}
          scanDedupeMs={scanDedupeMs}
          onScan={code => {
            if (continuous) {
              // Camera stays open — parent handles the scan; feedback fired
              // inside CameraScanner so it's instant.
              onScan(code)
            } else {
              onScan(code)
              setCameraOpen(false)
            }
          }}
          onClose={() => setCameraOpen(false)}
        />
      )}
    </>
  )
}

// Fullscreen camera viewport that runs continuous barcode detection.
// Stops + releases the camera stream on unmount (the controls.stop() from
// ZXing's API), so a "scan and close" interaction doesn't leak the camera.
function CameraScanner({ onScan, onClose, continuous = false, scanDedupeMs = 1200 }) {
  const videoRef = useRef(null)
  const controlsRef = useRef(null)
  const [error, setError] = useState(null)
  const [starting, setStarting] = useState(true)
  const [flash, setFlash] = useState(false)

  // Latest props in refs so the decode effect can run ONCE (deps []) without
  // restarting the camera every render — critical for continuous mode where
  // the parent passes a fresh onScan closure on each scan.
  const onScanRef = useRef(onScan); onScanRef.current = onScan
  const continuousRef = useRef(continuous); continuousRef.current = continuous
  const dedupeRef = useRef(scanDedupeMs); dedupeRef.current = scanDedupeMs
  const lastCodeRef = useRef(null)
  const lastTimeRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    const reader = new BrowserMultiFormatReader()

    ;(async () => {
      try {
        // undefined deviceId = let the browser pick the default camera.
        // On most phones the default is the back-facing camera, which is
        // what we want for scanning.
        const controls = await reader.decodeFromVideoDevice(
          undefined,
          videoRef.current,
          (result, err) => {
            if (cancelled || !result) return  // err fires per no-code frame — ignore
            const text = result.getText()
            if (continuousRef.current) {
              // Dedupe: a held barcode decodes many times/sec. Ignore the
              // same code within the dedupe window so one physical scan = +1.
              const now = Date.now()
              if (text === lastCodeRef.current && now - lastTimeRef.current < dedupeRef.current) return
              lastCodeRef.current = text
              lastTimeRef.current = now
              scanFeedback('ok')
              setFlash(true)
              setTimeout(() => setFlash(false), 220)
              onScanRef.current(text)
              // Camera stays open — keep scanning.
            } else {
              // One-shot: stop immediately to avoid a double-fire, then report.
              if (controlsRef.current) controlsRef.current.stop()
              onScanRef.current(text)
            }
          }
        )
        if (cancelled) {
          controls.stop()
        } else {
          controlsRef.current = controls
          setStarting(false)
        }
      } catch (e) {
        console.error('Camera scan failed:', e)
        if (!cancelled) {
          setError(e?.message || 'Could not access camera')
          setStarting(false)
        }
      }
    })()

    return () => {
      cancelled = true
      if (controlsRef.current) {
        try { controlsRef.current.stop() } catch {}
      }
    }
  }, [])

  return (
    <div
      onClick={e => e.target === e.currentTarget && onClose()}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.92)',
        zIndex: 200, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
    >
      {error ? (
        <div style={{ color: 'white', textAlign: 'center', maxWidth: 320 }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 10 }}><Icon name="camera" size={34} /></div>
          <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 6 }}>Camera unavailable</div>
          <div style={{ fontSize: 13, color: 'var(--hint)', marginBottom: 20, lineHeight: 1.4 }}>
            {error}
          </div>
          <div style={{ fontSize: 12, color: 'var(--hint)', marginBottom: 20 }}>
            Allow camera access in your browser settings, or use a USB/Bluetooth scanner instead.
          </div>
          <button onClick={onClose} className="btn btn-primary">Close</button>
        </div>
      ) : (
        <>
          <div style={{
            width: '100%', maxWidth: 480, aspectRatio: '4/3',
            background: 'black', borderRadius: 'var(--r-sm)', overflow: 'hidden',
            position: 'relative',
          }}>
            <video
              ref={videoRef}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              playsInline
              muted
            />
            {/* Targeting reticle — visual hint for where to point the barcode */}
            <div style={{
              position: 'absolute', top: '25%', bottom: '25%', left: '10%', right: '10%',
              border: `2px solid ${flash ? '#22c55e' : 'var(--orange)'}`, borderRadius: 8, pointerEvents: 'none',
              boxShadow: '0 0 0 9999px rgba(0,0,0,0.3)',
              transition: 'border-color 0.12s',
            }} />
            {starting && (
              <div style={{
                position: 'absolute', inset: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: 'white', fontSize: 14,
              }}>
                Starting camera…
              </div>
            )}
          </div>
          <div style={{ color: 'white', marginTop: 16, fontSize: 13, textAlign: 'center' }}>
            {continuous ? 'Keep scanning parts — tap Done when finished' : 'Point the camera at a barcode'}
          </div>
          <button
            onClick={onClose}
            className="btn btn-ghost"
            style={{ marginTop: 16, background: 'white', color: 'var(--text)' }}
          >
            {continuous ? 'Done' : 'Cancel'}
          </button>
        </>
      )}
    </div>
  )
}
