import { useEffect, useState } from 'react'

// Tracks whether the viewport is wide enough for the desktop two-pane
// layout (sidebar + main panel) vs the narrow phone stack. The 768px
// breakpoint is the same for both crew and manager surfaces — keep it
// here as the single source of truth.
export function useIsWide() {
  const [wide, setWide] = useState(() => window.innerWidth >= 768)
  useEffect(() => {
    const fn = () => setWide(window.innerWidth >= 768)
    window.addEventListener('resize', fn)
    return () => window.removeEventListener('resize', fn)
  }, [])
  return wide
}
