import { useEffect, useRef, useState } from 'react'
import { BrowserMultiFormatReader } from '@zxing/browser'

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
}) {
  const inputRef = useRef(null)
  const [cameraOpen, setCameraOpen] = useState(false)

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
            fontFamily: '"DM Mono", monospace',
            outline: 'none',
          }}
          onFocus={e => e.target.style.borderColor = 'var(--orange)'}
          onBlurCapture={e => e.target.style.borderColor = 'var(--border2)'}
        />
        {showCameraButton && (
          <button
            type="button"
            onClick={() => setCameraOpen(true)}
            disabled={disabled}
            title="Scan with phone camera"
            className="btn btn-ghost"
            style={{ padding: '10px 14px', fontSize: 20, flexShrink: 0 }}
          >
            📷
          </button>
        )}
      </div>
      {cameraOpen && (
        <CameraScanner
          onScan={code => { onScan(code); setCameraOpen(false) }}
          onClose={() => setCameraOpen(false)}
        />
      )}
    </>
  )
}

// Fullscreen camera viewport that runs continuous barcode detection.
// Stops + releases the camera stream on unmount (the controls.stop() from
// ZXing's API), so a "scan and close" interaction doesn't leak the camera.
function CameraScanner({ onScan, onClose }) {
  const videoRef = useRef(null)
  const controlsRef = useRef(null)
  const [error, setError] = useState(null)
  const [starting, setStarting] = useState(true)

  useEffect(() => {
    let cancelled = false
    const reader = new BrowserMultiFormatReader()

    ;(async () => {
      try {
        // undefined deviceId = let the browser pick the default camera.
        // On most phones the default is the back-facing camera, which is
        // what we want for scanning. Worker-facing camera selection can
        // be added later if needed.
        const controls = await reader.decodeFromVideoDevice(
          undefined,
          videoRef.current,
          (result, err) => {
            if (cancelled) return
            if (result) {
              // Stop the camera immediately to avoid double-fire on the
              // next decode pass — parent will unmount us anyway.
              if (controlsRef.current) controlsRef.current.stop()
              onScan(result.getText())
            }
            // err is fired per-frame when no code is detected — ignore.
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
  }, [onScan])

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
          <div style={{ fontSize: 36, marginBottom: 10 }}>📷</div>
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
              border: '2px solid var(--orange)', borderRadius: 8, pointerEvents: 'none',
              boxShadow: '0 0 0 9999px rgba(0,0,0,0.3)',
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
            Point the camera at a barcode
          </div>
          <button
            onClick={onClose}
            className="btn btn-ghost"
            style={{ marginTop: 16, background: 'white', color: 'var(--text)' }}
          >
            Cancel
          </button>
        </>
      )}
    </div>
  )
}
