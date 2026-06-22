// ─── Console line-icon set ────────────────────────────────────────────────────
// One consistent stroked line-icon family (24×24 viewBox, round caps/joins)
// that replaces every emoji in the redesigned UI. Path data is ported verbatim
// from the design handoff mockups (docs/design_handoff_console_redesign) — the
// fl-* / m-* / t-* symbol blocks, with the prefixes dropped for clean names.
//
// Usage: <Icon name="box" size={19} />  — inherits `currentColor`, so set the
// color on the parent (or pass `color`). `fill`-style glyphs (dots) are flagged.

const STROKE = { fill: 'none', stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round' }

// name → { p: inner SVG markup, sw?: stroke width (default 1.6), solid?: filled glyph }
const ICONS = {
  // Inventory nav + actions
  search:    { sw: 1.7, p: '<circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/>' },
  plus:      { sw: 1.9, p: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>' },
  box:       { p: '<path d="M3 8l9-5 9 5v8l-9 5-9-5V8z"/><path d="M3 8l9 5 9-5"/><path d="M12 13v8"/>' },
  warehouse: { p: '<path d="M3 21V9l9-5 9 5v12"/><path d="M3 21h18"/><rect x="9" y="13" width="6" height="8"/>' },
  nut:       { p: '<path d="M7 4h10l5 8-5 8H7l-5-8z"/><circle cx="12" cy="12" r="3.2"/>' },
  activity:  { sw: 1.7, p: '<path d="M3 12h4l3 8 4-16 3 8h4"/>' },
  clipboard: { p: '<rect x="6" y="4" width="12" height="17" rx="2"/><rect x="9" y="2.5" width="6" height="4" rx="1"/><line x1="9" y1="11" x2="15" y2="11"/><line x1="9" y1="15" x2="13" y2="15"/>' },
  scan:      { p: '<path d="M4 8V5a1 1 0 0 1 1-1h3"/><path d="M16 4h3a1 1 0 0 1 1 1v3"/><path d="M20 16v3a1 1 0 0 1-1 1h-3"/><path d="M8 20H5a1 1 0 0 1-1-1v-3"/><line x1="4" y1="12" x2="20" y2="12"/>' },
  grid:      { p: '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>' },
  download:  { p: '<path d="M12 4v11"/><path d="M7 11l5 5 5-5"/><path d="M4 20h16"/>' },
  upload:    { p: '<path d="M12 20V9"/><path d="M7 13l5-5 5 5"/><path d="M4 4h16"/>' },
  refresh:   { p: '<path d="M3.5 12a8.5 8.5 0 0 1 14.5-6"/><path d="M18 2.5V7h-4.5"/><path d="M20.5 12a8.5 8.5 0 0 1-14.5 6"/><path d="M6 21.5V17h4.5"/>' },
  zap:       { p: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>' },
  layers:    { p: '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>' },
  receipt:   { p: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="9" y1="12" x2="15" y2="12"/>' },
  filter:    { sw: 1.7, p: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>' },
  tag:       { p: '<path d="M4 4h7l9 9-7 7-9-9z"/><circle cx="8.5" cy="8.5" r="1.4"/>' },
  truck:     { p: '<rect x="2" y="7" width="12" height="9" rx="1"/><path d="M14 10h4l3 3v3h-7z"/><circle cx="7" cy="18.5" r="1.7"/><circle cx="18" cy="18.5" r="1.7"/>' },
  move:      { sw: 1.7, p: '<path d="M7.5 8l-3.5 4 3.5 4"/><path d="M16.5 8l3.5 4-3.5 4"/><line x1="4.5" y1="12" x2="19.5" y2="12"/>' },
  pin:       { p: '<path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.4"/>' },
  dots:      { solid: true, p: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>' },

  // Disclosure / chrome
  'chevron-down':  { sw: 1.8, p: '<path d="M6 9l6 6 6-6"/>' },
  'chevron-right': { sw: 1.8, p: '<path d="M9 6l6 6-6 6"/>' },
  menu:      { sw: 1.9, p: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>' },
  x:         { sw: 2, p: '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>' },
  check:     { sw: 2.4, p: '<path d="M5 12l5 5 9-11"/>' },
  arrow:     { sw: 2, p: '<line x1="4" y1="12" x2="19" y2="12"/><path d="M13 6l6 6-6 6"/>' },

  // Manager nav + secondary surfaces
  folder:    { sw: 1.7, p: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>' },
  chart:     { sw: 1.7, p: '<line x1="4" y1="20" x2="20" y2="20"/><rect x="6" y="11" width="3" height="6"/><rect x="11" y="6" width="3" height="11"/><rect x="16" y="13" width="3" height="4"/>' },
  gear:      { sw: 1.7, p: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>' },
  sliders:   { sw: 1.7, p: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>' },
  layout:    { sw: 1.7, p: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/>' },
  sparkle:   { sw: 1.7, p: '<path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/>' },
  rotate:    { sw: 1.8, p: '<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 3.5V8h-4.5"/>' },
  users:     { sw: 1.6, p: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/><path d="M16 5.2a3.2 3.2 0 0 1 0 5.6"/><path d="M17.5 14.2A5.5 5.5 0 0 1 20.5 19"/>' },
  alert:     { sw: 1.7, p: '<path d="M12 3.5L21 19H3z"/><line x1="12" y1="9" x2="12" y2="14"/><circle cx="12" cy="16.8" r="0.4" fill="currentColor"/>' },
  trash:     { sw: 1.7, p: '<path d="M4 7h16"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>' },
  printer:   { sw: 1.7, p: '<path d="M6 9V3h12v6"/><path d="M6 18H4a1 1 0 0 1-1-1v-6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6a1 1 0 0 1-1 1h-2"/><rect x="6" y="15" width="12" height="6"/>' },
  mail:      { sw: 1.7, p: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 6.5l8.5 6 8.5-6"/>' },
  edit:      { sw: 1.7, p: '<path d="M4 20h4l10-10-4-4L4 16z"/><line x1="13.5" y1="6.5" x2="17.5" y2="10.5"/>' },
}

export default function Icon({ name, size = 19, color, style, className, title }) {
  const def = ICONS[name]
  if (!def) {
    if (typeof console !== 'undefined') console.warn('Icon: unknown name', name)
    return null
  }
  const attrs = def.solid
    ? { fill: 'currentColor', stroke: 'none' }
    : { ...STROKE, strokeWidth: def.sw || 1.6 }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      className={className}
      style={{ flexShrink: 0, display: 'block', color, ...style }}
      {...attrs}
      dangerouslySetInnerHTML={{ __html: (title ? `<title>${title}</title>` : '') + def.p }}
    />
  )
}

// Named export for callers that want to check availability / enumerate.
export const ICON_NAMES = Object.keys(ICONS)
