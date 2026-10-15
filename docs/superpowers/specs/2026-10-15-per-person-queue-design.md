# Per-person work queue + "พักไว้" status

Date: 2026-10-15 · Status: approved (owner: "1 แล้วก็ทำต่อเลย")

## Problem

Measured on production (518 clips, 2026-10-15):

- Nobody can see their own queue. เจม has 13 open clips, 8 past their posting date; อาย 6 open, 1 past.
- The "posted to TikTok" toggle stopped being used in October: 60 clips reached
  "อัปลงไดร์ฟแล้ว" this month but only 5 were marked posted (Jun–Sep: 96–98%).
  The owner confirmed the clips *were* posted — the toggle was simply forgotten.
- All 9 overdue clips are 22–50 days late — abandoned work nobody closed. Shown
  as "overdue" forever, they would teach everyone to ignore the queue.

## Decisions (from the brainstorm)

| Question | Answer |
|---|---|
| Where | A queue panel at the top of the Clips tab |
| Whose | Everyone side by side; click a person to expand. A browser may remember "this is me" and opens that person by default |
| Due date | The existing `date` (posting date). No new field |
| Stale work | New status **พักไว้** (`paused`) — leaves every queue, kept in the table |
| Architecture | Computed in the browser from the clips already loaded. No server change, zero extra Firestore reads |

## Queue rules — `buildQueues(clips, today)`

Pure function, no DOM, so it can later move to the server for Discord pings.

- **Creator queue**: `creator === id` and status in `idle | filming | editing`.
- **Uploader queue**: status `done` and `!uploaded`.
- `paused` is in no queue.
- Each queue splits into `overdue` (`date < today`), `soon` (`date` is today or
  tomorrow) and `later` (after tomorrow); each sorted by date, oldest first.
- `today` is the **local** calendar date (Thailand), never `toISOString()` — that
  is UTC and reads as yesterday between 00:00 and 07:00.

## UI

The existing team bar becomes the queue strip (it currently shows a lifetime
clip count, which nobody acts on). Each member chip shows non-zero badges:
red **เลย N**, amber **ด่วน N**, neutral **ถัดไป N**; the uploader's badges read
as posting work. Zero work shows a quiet ✓.

Clicking a chip expands a panel under the strip listing that person's queue,
grouped overdue → soon → later (later capped at 5, "+N more"). Each row: title,
relative due ("เลย 22 วัน", "วันนี้", "พรุ่งนี้", or the date), channel and type
tags, and the action:

- creator rows: the existing status dropdown (now including พักไว้)
- uploader rows: a **ลงแล้ว ✓** button

Panel header: "นี่คือฉัน" remembers the person (`localStorage clipTracker.me`,
per-viewer convenience only, try/catch guarded). The remembered person's panel
opens on load; clicking the open chip again collapses it.

**Bulk clean-up (uploader only):** when 2+ uploader items are overdue, the
header offers "ทำเครื่องหมายว่าลงแล้วทั้งหมด (N)" behind a confirm. It writes
one `clip:save` per clip — the existing per-clip path, so nothing can clobber a
teammate's edit. The owner runs it; nothing is changed on their behalf.

## พักไว้ status

Added to `STATUSES` (icon `pause_circle`). Grey family like idle but a dashed
border so the two never read as the same. Ripple:

- form select + status dropdown: new option
- filter pills: new "พักไว้" pill
- progress bar: paused clips leave the denominator
- calendar: `.cell-clip-item.st-paused` style; legend picks it up from STATUSES
- stats cards: unchanged (no sixth card)
- CSV: label comes from STATUSES automatically

## Testing

Browser tests against the static launch config with seeded clips and a fixed
`today`: bucket boundaries (yesterday / today / tomorrow / +2), paused and
posted clips excluded, uploader queue, local-date helper, bulk action writes
exactly the overdue items, remembered person survives reload and a blocked
localStorage. Re-run the duplicate-clip regression.

## Out of scope

Discord delivery (existing plan Tasks 6–7), month-scoped table (Task 5),
formatted report export (next brainstorm).
