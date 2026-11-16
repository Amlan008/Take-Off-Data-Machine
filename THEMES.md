# Shared theme behaviour

Midnight, Daylight, Mist, Forest and Sandstone use semantic colour roles in `site-themes.css`. Buttons, inputs, secondary controls, active tabs, selected rows, hover/focus states, disabled controls, notices, map UI, legends, dialogs, developer notes and Weather Journal panels resolve their colours from those roles. The METAR screen now also provides a theme selector.

Weather artwork keeps its own lighting. White text over the desktop illustration has a fixed local contrast gradient; on mobile the text below the scene uses the selected theme. The forecast veil, controls and hourly/day details follow the theme at every size. Active captions use the stronger foreground so they remain legible over tinted selection surfaces.

Hazard categories retain their yellow/orange/red identity. Category-button fills and text badges use contrasting variants; map glyphs, analytical colour scales, storm intensity colours and official graphics are not reassigned by theme. Aerodrome graph canvases remain white, and the Skew-T plot keeps its embedded scientific drawing surface.

Validation: `node scripts/test_site_theme.mjs` verifies preference persistence and unavailable-storage behaviour. `node scripts/test_site_theme_colors.mjs` measures normal text, secondary text, primary actions, notices and disabled states across all five palettes, as well as active category labels. Browser checks cover seven main pages in five themes, populated report results, selected journal days/hours, colour contrast and responsive layouts. An initial transient map-load timeout was resolved after the observation chart finished rendering.
