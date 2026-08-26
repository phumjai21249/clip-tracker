---
name: Clip Tracker
description: ระบบติดตามงานคลิปสำหรับทีมผลิตวิดีโอ JS SPORT / Me SPORT — real-time collaboration
colors:
  bg: "#f4f6fa"
  surface: "#ffffff"
  surface-2: "#f1f4f8"
  surface-3: "#e9edf3"
  border: "#e3e8ef"
  border-strong: "#d3dae4"
  text: "#1a2233"
  text-2: "#5b6678"
  text-3: "#98a2b3"
  brand: "#6d4de0"
  brand-strong: "#5b3bd6"
  brand-soft: "#efeafd"
  brand-text: "#5b3bd6"
  status-idle: "#64748b"
  status-filming: "#e79009"
  status-editing: "#2f74e0"
  status-done: "#0e9f6e"
  status-uploaded: "#8b5cf6"
  danger: "#e02f44"
  danger-bg: "#fdeaec"
  success: "#0e9f6e"
  warning: "#e79009"
  info: "#2f74e0"
  cyan: "#0e8fa3"
  rose: "#d63369"
  avatar-amber: "#f59e0b"
  avatar-red: "#ef4444"
  avatar-blue: "#3b82f6"
  avatar-teal: "#06b6d4"
  avatar-green: "#10b981"
  avatar-mint: "#14b8a6"
  avatar-violet: "#8b5cf6"
  avatar-pink: "#ec4899"
  logo-gradient-start: "#7c5cf0"
  logo-gradient-end: "#a855f7"
typography:
  page-title:
    fontFamily: "'Noto Sans Thai', 'Manrope', -apple-system, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 800
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  section-title:
    fontFamily: "'Noto Sans Thai', 'Manrope', -apple-system, sans-serif"
    fontSize: "1.05rem"
    fontWeight: 800
    letterSpacing: "-0.01em"
  stat-number:
    fontFamily: "'Manrope', 'Noto Sans Thai', sans-serif"
    fontSize: "1.45rem"
    fontWeight: 800
  body:
    fontFamily: "'Noto Sans Thai', 'Manrope', -apple-system, sans-serif"
    fontSize: "0.86rem"
    fontWeight: 500
    lineHeight: 1.5
  label:
    fontFamily: "'Noto Sans Thai', 'Manrope', -apple-system, sans-serif"
    fontSize: "0.72rem"
    fontWeight: 700
  icon:
    fontFamily: "'Material Icons Round'"
    fontSize: "16px"
    fontWeight: 400
rounded:
  sm: "8px"
  md: "12px"
  lg: "16px"
  full: "9999px"
components:
  button-primary:
    backgroundColor: "{colors.brand}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: "10px 18px"
  button-primary-hover:
    backgroundColor: "{colors.brand-strong}"
  button-ghost:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "10px 18px"
  status-badge-done:
    backgroundColor: "{colors.status-done}"
    textColor: "{colors.status-done}"
    rounded: "{rounded.full}"
    padding: "6px 13px"
  channel-tag:
    backgroundColor: "{colors.surface-2}"
    rounded: "{rounded.full}"
    padding: "4px 11px"
---

# Design System: Clip Tracker

## Overview

**Creative North Star: "The Ops Whiteboard"**

Clip Tracker is the shared production board a small TikTok content team keeps open all day — one tab, real-time, everyone watching the same numbers move. The system reads as a clean SaaS ops dashboard, not a marketing surface: dense information (stat cards, calendar, a sortable table), generous but not decorative surfaces, and color that is functional first — status and channel meaning before brand expression. It ships light and dark, both first-class (`[data-theme]` on `<html>`), because the team checks this board at a desk in the morning and on a phone at night.

The rejected world is the glassmorphism/blur dashboard and the flat monochrome ops tool (à la [[invest-hub-app|Invest Hub]], a sibling project in this workspace with a black, zero-radius, mono-numeral aesthetic) — Clip Tracker is warmer and rounder than that on purpose: it's a team-facing collaboration tool, not a solo trading terminal.

**Key Characteristics:**
- Soft, rounded surfaces (8–16px radius) on a light neutral canvas, or a near-black canvas in dark mode
- One brand accent (violet, `#6d4de0`), used sparingly — status and channel colors carry most of the meaning
- Thai-first typography: Noto Sans Thai leads every stack, Manrope is the numeral/Latin partner
- Real-time sync indicator and online badge are always visible — this is built to be watched, not just visited

## Colors

The palette is neutral-and-functional: a light gray-blue canvas, one violet brand accent used at low frequency, and two closed color systems — clip **status** and content **channel** — that must stay visually distinct from each other and from the brand accent.

### Primary
- **Brand Violet** (`#6d4de0`, hover `#5b3bd6`): primary buttons, active tab underline, focus rings, links, the KPI score number. Used on well under 10% of any screen — its rarity keeps it meaningful when a primary action needs to stand out.

### Neutral
- **Canvas** (`#f4f6fa`): page background (light).
- **Surface** (`#ffffff`): cards, table, modals (light).
- **Surface 2 / 3** (`#f1f4f8` / `#e9edf3`): table header, hover states, nested panels.
- **Border / Border Strong** (`#e3e8ef` / `#d3dae4`): hairlines, input strokes.
- **Text / Text 2 / Text 3** (`#1a2233` / `#5b6678` / `#98a2b3`): primary copy, secondary/explanatory copy, and the lightest tier reserved for pure decoration (never for text a user must read — `text-3` sits under the 4.5:1 body-text contrast floor).

### Named Rules
**The Status-Owns-Color Rule.** `--st-idle` / `--st-filming` / `--st-editing` / `--st-done` / `--st-uploaded` (each with a paired `-bg` and `-text` tint) are reserved for clip status only. No other UI element borrows a status color, so a glance at any color on the board reliably means "this is a status."

**The Channel Palette Rule.** Content channels get their own four-color set — cyan (JS SPORT SHOP), rose (Me SPORT), warning-amber (เสื้อปุ๋ย), success-green (โฟมขัดรองเท้า) — reusing the semantic `--warning`/`--success` hues for channel identity is intentional (channel tags live in a different visual context than toasts/status, so the reuse doesn't collide in practice).

**The Gradient Accent Rule.** Flat color is the default everywhere except two deliberate exceptions, both 135° two-color gradients: person avatars (creators 1–3, uploader — `avatar-amber→avatar-red`, `avatar-blue→avatar-teal`, `avatar-green→avatar-mint`, `avatar-violet→avatar-pink`, for "whose face is this" at a glance) and the single app-logo icon badge in the header (`logo-gradient-start→logo-gradient-end`, `#7c5cf0→#a855f7`, its own violet pair distinct from `--brand`). Don't extend gradients to any other component — a third gradient family would dilute both.

## Typography

**Display/Body Font:** 'Noto Sans Thai', 'Manrope', -apple-system, sans-serif
**Numeral Font:** 'Manrope', 'Noto Sans Thai', sans-serif (tabular figures — `.num` class) for anything counted: stats, dates, KPI scores, table numerals.
**Icon Font:** 'Material Icons Round', loaded from Google Fonts — every icon in the app (nav, buttons, status, empty states) is this one font, at sizes ranging 13–26px depending on context. No other icon set is used.

**Character:** Thai-first, dense, and functional. This is not a display-type system — there is no dramatic hero scale. Sizes are chosen per-component from a continuous working range (~0.62rem to 1.5rem in the app chrome, up to 3.2rem only for the single KPI headline score) rather than a strict 4-step ramp; that density is intentional for an information-dense ops board, not drift.

### Hierarchy
- **Page title** (800, 1.5rem, -0.02em): the app header ("Clip Tracker").
- **Section title** (800, 1.05rem): calendar/table/KPI section headers, each paired with a Material icon.
- **Stat number** (800, 1.25–1.45rem, Manrope): the 5 stat-card counts and the KPI big score.
- **Body** (500–600, 0.82–0.9rem): table cells, form inputs, card copy.
- **Label** (700, 0.68–0.78rem): badges, chips, table headers, filter pills — usually paired with letter-spacing on all-caps table headers only.

## Layout

`.app-container` caps at 1360px, centered, with 24px/32px page padding (14px on mobile). Density is high but never cramped: cards and sections use 12–24px internal padding, table rows 12px/20px. Below 768px the layout collapses hard for a phone-in-hand team member — the data table becomes a stacked card list, the header actions wrap, the calendar shrinks its cell height and hides table chrome. Stat cards go from a 5-column grid to 3 (tablet) to 2 (mobile), never fewer than 2 — the counts are the first thing anyone should see.

## Elevation & Depth

Flat-by-default with a soft ambient shadow on raised surfaces, not a layered elevation system. Every card, dropdown, and stat tile carries the same `--shadow-sm` at rest; nothing escalates on hover except a 1px translateY nudge on stat cards. Modals get `--shadow-lg` plus a soft dark overlay (`rgba(23,28,40,0.45)` light / `rgba(4,6,10,0.62)` dark) — the only place depth signals "this blocks the page."

### Shadow Vocabulary
- **shadow-sm** (`0 1px 2px rgba(16,24,40,.05)` light / `0 1px 2px rgba(0,0,0,.3)` dark): default resting elevation for any card, chip, or button.
- **shadow-md** (`0 4px 12px -2px rgba(16,24,40,.08), 0 2px 4px -2px rgba(16,24,40,.04)`): stat-card hover only.
- **shadow-lg** (`0 20px 40px -12px rgba(16,24,40,.18)` light / `0 24px 48px -12px rgba(0,0,0,.6)` dark): modals, the day-view panel.

### Named Rules
**The One-Nudge Rule.** Hover states get exactly one physical response — a shadow step up or a 1px lift — never both plus a color shift. Motion stays quiet on a board people watch all day.

## Shapes

Soft-rounded throughout: `--radius-sm` (8px) on buttons/inputs/icon-buttons, `--radius-md` (12px) on cards and modals, `--radius-lg` (16px) on section shells, `--radius-full` (9999px) on every badge, pill, chip, and the theme toggle. Avatars and status dots are true circles. No sharp corners anywhere in this system — that flat, zero-radius language belongs to [[invest-hub-app]], not here.

A second, smaller micro-radius band (2–6px, not tokenized as a CSS custom property) covers compact detail chrome that sits below the `--radius-sm` floor: calendar mini-items and count badges (6px), the ghost "add link" button (5px), the description show-more/less text control (4px), and the active-tab underline bar (2px, matched to the bar's own 2px height). This is a deliberate second tier, not drift — promoting it to `--radius-sm` would make these small elements look heavier than the text they sit next to.

## Components

### Buttons
- **Shape:** 8px radius (`--radius-sm`), 10px/18px padding, `--shadow-sm` at rest.
- **Primary:** brand violet fill, white text, 2px `-strong` border shift + shadow bump on hover.
- **Ghost/default:** surface-colored fill with a hairline border; hovers to `surface-2`.
- **Danger:** same shape, `--danger` fill, used only in the delete-confirmation modal.
- **Icon-only (action-btn):** 34px square, `--radius-sm`, transparent at rest — used for row-level edit/delete.

### Chips & Badges
- **Status badge:** pill (`--radius-full`), status color's `-bg`/`-text` pair, a small leading dot in the solid status color. Click opens a same-shaped dropdown listing the other three statuses.
- **Channel tag:** pill, `surface-2` background, text colored by the channel's accent (cyan/rose/warning/success) — see the Channel Palette Rule.
- **Content-link chip:** pill, `brand-soft` background, `brand-text` label, a small link icon — appears under a clip's title for each named reference URL (script doc, drive folder, etc.), opens in a new tab.
- **Filter pill:** pill, ghost by default, brand-filled when the active filter.

### Cards & Containers
- **Corner style:** 16px (`--radius-lg`) for section shells (calendar, table); 12px (`--radius-md`) for stat cards and the mobile clip-card.
- **Background:** `--surface`, always with a 1px `--border` hairline — never border-less.
- **Shadow:** `--shadow-sm` at rest; stat cards lift to `--shadow-md` + 1px translateY on hover, and gain a 1px brand-colored ring when their filter is active.

### Inputs / Fields
- **Style:** `--surface` fill (KPI-tab inputs use `--surface-2` to read as "editable data" against a documented table), 1px border, `--radius-sm`.
- **Focus:** border shifts to brand, no glow — kept quiet for a form filled out many times a day.

### Toggle Switch
- **Style:** 40×22px track, `--radius-full`, `--surface-3` off / `--st-done` on, white circular knob with a small structural shadow (`0 1px 3px rgba(0,0,0,.3)`) independent of the shadow scale — this one shadow exists to sell the knob as a physical object, not as an elevation cue.

### Navigation (Tabs)
- **Style:** flat text buttons in a bottom-bordered bar; the active tab gets a 2px brand underline and brand-colored text, no background fill. Same shape/behavior for both the "ติดตามคลิป" and "KPI คอนเทนต์" tabs.

## Do's and Don'ts

### Do:
- **Do** keep every new status, channel, or badge color inside its owning palette (status colors never leak onto channel tags or vice versa).
- **Do** default new numeric displays to the Manrope/tabular `.num` treatment so columns of numbers stay aligned.
- **Do** keep every interactive surface circular, on the primary `--radius-sm`/`--radius-md`/`--radius-lg`/`--radius-full` scale, or on the documented 2–6px micro-radius band for compact chrome — no radius values outside those two tiers.
- **Do** ship both light and dark values together for any new color — this app is used at a desk and on a phone at night.

### Don't:
- **Don't** add drop shadows beyond the documented `shadow-sm/md/lg` scale, or use shadow as a hover effect on more than one property at once (see The One-Nudge Rule).
- **Don't** introduce a second brand accent — Clip Tracker has exactly one (`--brand`), used sparingly.
- **Don't** borrow Invest Hub's zero-radius, blur-free, mono-numeral aesthetic here — they are sibling projects with intentionally opposite visual languages; see the sibling app's own DESIGN.md.
- **Don't** treat every font-size in this file as exhaustive — the working range (~0.62rem–1.5rem, plus the 3.2rem KPI score) is a documented *range*, not a violation list; only flag a size that's wildly outside it with no component justification.
