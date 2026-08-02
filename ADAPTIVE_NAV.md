# Adaptive Sidebar → Bottom Nav Pattern

A reusable spec for a navigation shell that is a **left sidebar on desktop** and a **hide-on-scroll bottom nav bar on mobile**, with a "More" burger for overflow items. Framework-agnostic in spirit; the reference is Next.js App Router + Tailwind.

Use this file two ways:
1. **As a design contract** — read it before wiring nav on a new project.
2. **As an LLM prompt** — paste it verbatim to Claude/Cursor/Copilot and it will produce a working implementation. A ready-to-paste prompt is at the bottom.

---

## Behavior Spec

### Breakpoint switch
- **≥ `lg` (1024px)**: fixed left sidebar, full nav visible. Sidebar can toggle collapsed (icons only) vs expanded (icons + labels). Collapsed state persists in `localStorage`.
- **< `lg`**: sidebar hidden. Bottom nav bar fixed to the viewport bottom. No hamburger drawer replacing the sidebar — the bottom bar IS the mobile nav.

### Bottom bar layout
- **6 primary items + 1 "More" burger** = 7 slots, evenly distributed with `flex-1`.
- Each slot: icon (20×20), tiny label under it (10–11px). Full slot ≥ 44×44 tap target.
- Active item: colored icon + label + a small 3px accent underline pill just below.
- Optional numeric badge on any item (unread count etc.) — red pill at top-end of the icon, "9+" cap.

### More sheet (overflow)
- Tapping the burger opens a **bottom sheet** sliding up from the bottom edge.
- Backdrop: `black/40`, tap to close.
- Sheet: rounded-top card, `pb-[calc(env(safe-area-inset-bottom)+1rem)]`, header with title + close (X) button.
- Grid layout: 3 columns of remaining nav items (same icon+label format).
- Auto-closes on route change and on `Esc`.
- Locks body scroll while open.
- Burger icon animates: Menu icon rotates/fades out → X icon rotates/fades in.

### Hide-on-scroll (Facebook-style)
- Scroll **down** → bar slides down out of view (`translate-y-full`, 300ms ease-out).
- Scroll **up** → bar slides back in.
- Always visible when `scrollY < 60` (near top).
- Deadband of ±8px prevents jitter.
- Throttled via `requestAnimationFrame` (one update per frame).
- Bar stays visible while the More sheet is open, even during scroll.
- The main content reserves bottom padding (`pb-[calc(5rem+env(safe-area-inset-bottom))]`) so nothing gets trapped under the bar.

### Extras that fit naturally in the More sheet
- Language switcher (inline pill toggle) — one row, `border-t`.
- User email + sign-out button — one row, `border-t`.

### iOS safe area
Everywhere the bar or sheet touches the bottom edge: `env(safe-area-inset-bottom)` in padding. Never let items sit under the home indicator.

### RTL
- Sidebar uses logical properties: `start-0`, `border-e`, `ms-52`, `-end-2`.
- Everything mirrors automatically when `dir="rtl"` is on `<html>`.

### Permissions / conditional items
- Filter `primaryItems` and `moreItems` by the current user's permissions BEFORE rendering. A gated item disappears from the ladder entirely; nothing else needs to change — `flex-1` re-distributes the remaining slots.

---

## Component Structure

```
components/layout/
├── AppShell.tsx          # Wraps children; switches between sidebar and bottom nav by viewport
├── Sidebar.tsx           # Desktop sidebar (collapsed/expanded)
└── MobileBottomNav.tsx   # Bottom bar + More sheet + hide-on-scroll
```

`AppShell` skeleton:
```tsx
<div className="min-h-screen bg-bg-main overflow-x-hidden">
  {/* Desktop sidebar */}
  <div className="hidden lg:block fixed start-0 top-0 h-screen w-52 border-e z-40">
    <Sidebar collapsed={collapsed} onToggle={toggle} />
  </div>

  {/* Main — reserves bottom space on mobile for the bar */}
  <div className={collapsed ? "lg:ms-16" : "lg:ms-52"}>
    <main className="p-4 md:p-6 pb-[calc(5rem+env(safe-area-inset-bottom))] lg:pb-6">
      {children}
    </main>
  </div>

  {/* Mobile bottom nav */}
  <div className="lg:hidden fixed bottom-0 inset-x-0 z-50">
    <MobileBottomNav />
  </div>
</div>
```

## Item Config Shape

```ts
interface NavItem {
  href: string;
  labelKey: string;      // i18n key (or plain label if not multilingual)
  icon: LucideIcon;      // 20×20 lucide-react icon
  requires?: Permission; // optional gate
}

const primaryItems: NavItem[] = [ /* 6 items — most-used routes */ ];
const moreItems:    NavItem[] = [ /* the rest — settings, admin, less-used routes */ ];
```

## Hide-on-scroll hook (drop-in)

```tsx
const [hidden, setHidden] = useState(false);
const lastY = useRef(0);
const ticking = useRef(false);

useEffect(() => {
  lastY.current = window.scrollY;
  const onScroll = () => {
    if (ticking.current) return;
    ticking.current = true;
    requestAnimationFrame(() => {
      const y = window.scrollY;
      const delta = y - lastY.current;
      if (y < 60) setHidden(false);
      else if (delta > 8) setHidden(true);
      else if (delta < -8) setHidden(false);
      lastY.current = y;
      ticking.current = false;
    });
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  return () => window.removeEventListener("scroll", onScroll);
}, []);
```

Apply: `className={cn("transition-transform duration-300 ease-out", hidden && !moreOpen ? "translate-y-full" : "translate-y-0")}`.

## Body scroll lock while sheet is open

```tsx
useEffect(() => {
  if (!moreOpen) return;
  const prev = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  return () => { document.body.style.overflow = prev; };
}, [moreOpen]);
```

## Accessibility

- Bottom bar: `<nav aria-label="Primary">`.
- More button: `aria-label="More"`, `aria-expanded={moreOpen}`, `aria-controls="more-sheet-id"`.
- Sheet: `role="dialog"`, `aria-modal="true"`, `aria-hidden={!moreOpen}`.
- Focus trap the sheet while open; return focus to the More button on close.
- `Esc` closes the sheet.
- Each nav item is a real `<a>` / `<Link>` — routing works with the keyboard.
- Every icon-only interactive has a text label (visible or `sr-only`).

## Testing Checklist

- [ ] iPhone SE (375×667) — all 6 icons + burger fit without wrapping.
- [ ] Scroll down 200px → bar hides. Scroll up 20px → bar reappears.
- [ ] Scroll to top → bar is visible even if last direction was down.
- [ ] Open More sheet → backdrop closes it, `Esc` closes it, route change closes it.
- [ ] While sheet is open, page behind does not scroll.
- [ ] Bar stays visible while sheet is open.
- [ ] Home indicator: bar labels are above it, not under it.
- [ ] Landscape phone: layout stays usable, tap targets remain ≥ 44px.
- [ ] Resize desktop from 1440 → 1023px — sidebar hides, bottom bar appears exactly at `lg`.
- [ ] Sidebar collapsed state survives a reload.
- [ ] RTL: sidebar on the right, badges on the correct corner.
- [ ] Keyboard-only: Tab through the bar, activate items, open/close sheet.

---

## Ready-to-paste LLM prompt

> Copy everything between the fences into any coding assistant.

```
Build an adaptive navigation shell with this exact behavior:

DESKTOP (≥ 1024px):
- Fixed left sidebar, 208px wide (52 in Tailwind), collapsible to 64px (icons only).
- Collapsed state persists in localStorage under key "sidebar:collapsed".
- Main content shifts right by the sidebar width (ms-52 / ms-16).

MOBILE (< 1024px):
- No sidebar. A fixed bottom navigation bar instead.
- Bar contains 6 primary nav items + a 7th "More" burger button, evenly spaced with flex-1.
- Each slot is ≥ 44×44px, icon 20×20, label 10–11px under the icon.
- Active item: colored icon+label plus a 3px accent underline pill just below the item.
- Optional red badge on any item's icon for unread counts, "9+" cap.

MORE SHEET:
- Tapping the burger slides a bottom sheet up from the bottom edge (300ms ease-out).
- Backdrop is black/40, tapping it closes the sheet.
- Sheet has rounded top corners, a header row (title + X close button), then a 3-column grid of the overflow nav items using the same icon+label format.
- Sheet auto-closes on route change and on Esc.
- Body scroll is locked while the sheet is open.
- Burger icon crossfades to X when open.

HIDE-ON-SCROLL:
- Scroll down → bar slides out of view (translate-y-full).
- Scroll up → bar slides back in.
- Always visible when scrollY < 60.
- Use an 8px deadband to prevent jitter.
- Throttle scroll updates with requestAnimationFrame.
- Bar stays visible while the More sheet is open, regardless of scroll.

CONTENT SPACING:
- Main content has bottom padding = 5rem + env(safe-area-inset-bottom) on mobile so nothing is trapped under the bar.
- Bar itself uses pb-[calc(env(safe-area-inset-bottom)+0.375rem)].

RTL / i18n:
- Use logical properties: start-0, end-0, border-e, ms-*, me-*.

ACCESSIBILITY:
- nav aria-label="Primary" on the bar.
- More button has aria-label, aria-expanded, aria-controls.
- Sheet has role="dialog", aria-modal="true".
- Focus trap while open, return focus to the More button on close, Esc closes.

CONFIG:
- Nav items are declared as { href, label, icon, requires? } arrays: primaryItems (6) and moreItems (rest).
- Filter both arrays by the current user's permissions before rendering; the layout re-flows automatically.

STACK: Next.js App Router (client component), Tailwind CSS, lucide-react icons. Provide three files: AppShell.tsx, Sidebar.tsx, MobileBottomNav.tsx. Wire AppShell so it renders children with the correct offset and reserves bottom space on mobile.
```

---

If the target project uses a different stack (SvelteKit, Vue, React Native web), keep the behavior spec — only swap the framework glue (routing hook, className mechanism, icon package).
