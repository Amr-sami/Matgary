# Responsive Design Rules

A reusable checklist for building responsive UIs across any web app. Style-agnostic — apply to Tailwind, CSS Modules, styled-components, plain CSS, etc.

## Core Principles

1. **Never hide content to fit small screens.** Move it, stack it, collapse it into a menu, or defer it behind a disclosure — never delete it from the DOM based on viewport width.
2. **No overlap.** Two interactive elements must never share the same pixels at any viewport size. Fixed/absolute elements must reserve their space in the flow (padding on the scroll container).
3. **No horizontal overflow.** The page never scrolls sideways unless it's an intentional carousel/table region. If the viewport is 320px wide, nothing pokes past 320px.
4. **Design mobile-first.** Author the smallest layout as the default; add complexity at larger breakpoints with min-width media queries.
5. **Touch targets ≥ 44×44 px.** Every tappable element (buttons, icons, links, nav items) meets Apple's HIG minimum. Use padding, not margin, to expand.

## Breakpoint Ladder

Use a consistent, minimal set of breakpoints. Recommended:

| Name | Min width | Typical device        |
|------|-----------|-----------------------|
| xs   | 0         | Small phones          |
| sm   | 640px     | Large phones          |
| md   | 768px     | Tablets portrait      |
| lg   | 1024px    | Tablets landscape / small laptops |
| xl   | 1280px    | Desktops              |
| 2xl  | 1536px    | Large desktops        |

Never introduce a breakpoint for a single element — bend the design, not the ladder.

## Layout

- Use CSS Grid or Flexbox. Never fixed pixel widths on containers.
- `max-width` on content containers; center with `margin-inline: auto`.
- Use `min()`, `max()`, `clamp()` for fluid sizing between breakpoints.
- Padding on the scroll container must include safe-area insets on iOS: `padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)`.
- Reserve space for fixed headers/footers with `scroll-padding` and matching `padding` on the main content area — never let them float over content.

## Typography

- Use `rem` for font sizes, not `px`. Users' browser zoom must work.
- Base body ≥ 16px (`1rem`). Never smaller than 14px anywhere.
- Line length: 45–75 characters. Enforce with `max-width: 65ch` on prose blocks.
- Line height: 1.4–1.6 for body, 1.1–1.3 for headings.
- Use `clamp()` for fluid headings: `font-size: clamp(1.5rem, 4vw, 2.5rem);`

## Navigation

### Top nav
- If nav items don't fit at a breakpoint, collapse into an overflow menu ("More" / hamburger) — do NOT drop items.
- The menu button must be visible and reachable; announce it to screen readers with `aria-label` and `aria-expanded`.
- Active item state must be visible in both the visible bar and the overflow menu.

### Bottom nav (mobile)
- Auto-hide on scroll down, reveal on scroll up. Use a small threshold (~10px) to avoid jitter.
- Never hide during momentum scroll bounce — check `scrollY > 0` and direction.
- Restore visibility when scroll reaches the top, when a modal opens, or when the user is idle for ~1s.
- Respect `env(safe-area-inset-bottom)` so items don't sit under the home indicator.
- Reserve height in the main scroll container (`padding-bottom`) so content is never trapped beneath it.

### Sidebars
- On `< md`: hidden by default, opened as a drawer (overlay + backdrop, focus trap, `Esc` to close).
- On `≥ md`: docked; page content shifts, never overlaps.

## Images & Media

- Every `<img>` gets `width` and `height` attributes (or `aspect-ratio` CSS) to prevent CLS.
- Use `srcset` + `sizes` or a framework `<Image>` component.
- `object-fit: cover` for hero/thumbnail crops; never stretch.
- Videos: `<video>` with `playsinline` on iOS; provide a poster.

## Tables

Tables are the #1 source of overflow bugs. Pick one:
- **Wrap in a horizontal scroll region** (`overflow-x: auto`) with a visible scroll cue on mobile.
- **Reflow as cards** on small screens — each row becomes a stacked card with `dt`/`dd` pairs.
- **Priority columns**: hide low-priority columns on small screens BUT expose them via row expansion — never permanently hide data.

## Forms

- Inputs `width: 100%` inside their column; use grid for multi-column layouts that collapse to 1 column on mobile.
- Font size ≥ 16px on inputs to prevent iOS zoom-on-focus.
- Labels above inputs on mobile; beside is OK on wide screens but check readability.
- Sticky action bar (Save / Cancel) at the bottom on mobile, inline on desktop.
- Never rely on `placeholder` as a label.

## Modals, Dialogs, Popovers

- Full-screen or bottom-sheet on mobile; centered card on tablet+.
- Trap focus, restore on close, close on `Esc` and backdrop click.
- Respect `prefers-reduced-motion` for open/close animations.
- Never taller than viewport — inner scroll if content overflows.

## Interactions

- Hover styles must have an equivalent focus/active style — mobile has no hover.
- Every `:hover` gets a matching `:focus-visible`.
- Pointer type: use `@media (hover: hover)` to gate hover-only affordances.
- Long-press, swipe, pinch: only if there's also a tap/click path.

## Testing Checklist

Before shipping, walk the app through each of these:

- [ ] iPhone SE (375×667) — smallest common device
- [ ] iPhone 15 (393×852)
- [ ] iPad portrait (768×1024) and landscape (1024×768)
- [ ] Desktop 1280, 1440, 1920
- [ ] Browser zoom 200% at 1280 desktop
- [ ] Landscape orientation on phone
- [ ] Slow 3G throttling — no layout shift as assets load
- [ ] Dynamic text size (iOS Accessibility → Larger Text at max)
- [ ] Dark mode + light mode
- [ ] Keyboard-only navigation (Tab, Shift+Tab, Enter, Esc)
- [ ] Screen reader (VoiceOver on iOS, TalkBack on Android, NVDA on Windows)
- [ ] `prefers-reduced-motion: reduce`
- [ ] RTL languages if the app supports them (mirror layouts, don't just translate)

## Anti-Patterns — Never Do These

- `display: none` on content just to make a layout fit. Always redesign, don't delete.
- Fixed heights on cards/rows that contain user-generated text.
- `overflow: hidden` on the body to "fix" a horizontal scrollbar — find and fix the offending element.
- Menu items or buttons that only appear on hover — inaccessible on touch.
- Layouts that require a specific device width (e.g., "designed for iPhone 14").
- Tiny tap targets in dense toolbars — pad them or space them.
- Detecting device type via user-agent string to switch layouts. Use CSS media queries.
- Popovers/tooltips that require hover with no dismiss action on touch devices.

## Debug Tips

- Add a temporary `* { outline: 1px solid red; }` to find the element causing horizontal overflow.
- Chrome DevTools → Rendering → "Emulate CSS media feature prefers-reduced-motion" to test motion preferences.
- Chrome DevTools → Device Toolbar → rotate, throttle, and try uncommon widths (280px, 320px, 360px).
- Lighthouse mobile audit: aim for ≥ 90 Performance, 100 Accessibility.

---

Treat this file as the contract. If a design or PR breaks one of these rules, either fix the design or update the rule with the reasoning — don't silently drift.
