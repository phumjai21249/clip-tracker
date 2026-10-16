# New-product launch page ("สินค้าใหม่")

Date: 2026-10-16 · Status: approved ("โอเค ทำเลย 1")

## Goal

Every new shoe gets the same six-format content run the team planned by hand
for VORTEX / LEGENDA SL 2026 / ZOOM (claude.ai artifact Y553bgbqTZJPiUA7CHYxoC),
and the board schedules it on its own: the day stock arrives is day 1, and the
six clips land on the daily board so the run finishes inside a week.

## Decisions (from the brainstorm)

| Question | Answer |
|---|---|
| Scripts for a new product | Generated from a template filled with the product's details; every field editable afterwards. Unknown values show as `[highlighted]` placeholders, as in the artifact |
| Schedule | One clip a day from arrival, day 7 kept spare |
| Who makes the clips | One creator chosen per product; individual clips re-assignable on the board as usual |
| The artifact's 3 products | Imported with their full hand-written scripts, editable, waiting for "ของเข้าแล้ว" |
| Storage | Firestore through the server, cached by a snapshot listener like everything else (approach 1) |

## The six formats and the schedule

| Day | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| Format | 1 บอกของเข้า | 2 โปรโมท | 3 ภาพนิ่ง 7 รูป | 4 แนะนำคุณภาพ | 6 เปรียบเทียบ | 5 เหมาะกับใคร | spare |

Format 3 creates a clip of type `photo`; the rest `clip`.

## Data

One Firestore document per product at `clipTracker/products/items/{id}`:

```
{ id, name, code, intro, color, price, sizes, features: [3 strings], compareWith,
  creator, channel, arrivalDate: 'YYYY-MM-DD' | null,
  prep: [string], prepDone: { '<index>': true },
  specs: { '1'..'6': { len, who, goal, time, script: [{t, shot, vo, text}] | photos: [string],
                       caption, tags, cart, cover, kpi, note } },
  clipIds: { '1'..'6': clipId }, createdAt, _seq }
```

Script rows are objects, not arrays: Firestore cannot store an array of arrays.

Clips created for a product carry `productId` and `formatNo`. Their ids are
deterministic — `clip_<productId>_<formatNo>` — so two people pressing
"ของเข้าแล้ว" at once write the same six documents instead of twelve.

## Server (products.js, wired from server.js)

- `product:create {product}` → set the document. Acknowledged.
- `product:update {id, fields}` → `update()` with whitelisted field paths only:
  top-level details, or `specs.<n>`, `prepDone.<n>`, `clipIds.<n>`. One spec,
  one tick or one link per path, so two people editing different parts of the
  same product never overwrite each other. Acknowledged; broadcast to others.
- `product:delete id` → delete the product only. Its clips stay on the board.
- Snapshot listener → `productsCache`; `init:data` gains `products`. Opening the
  board still costs zero reads.

## Client

- Third tab **สินค้าใหม่**: a card per product (name, arrival, creator,
  "โพสต์แล้ว n/6"), click to open it.
- Product view: prep checklist, six format cards (stage badges, expandable
  script / photo list, caption + hashtags with copy buttons, cart, cover, KPI,
  note), the 7-day strip, and edit buttons for the product and for each spec.
- **เพิ่มรุ่นใหม่** modal: name, code, colour, price, sizes, three selling
  points, comparison model, creator, channel, prep list → specs generated from
  the template.
- **ของเข้าแล้ว** (date defaults to today): sets `arrivalDate`, creates any of
  the six clips that do not exist yet. Changing the date later offers to move
  the linked clips that are not posted yet.
- Progress is read from the linked clips, never ticked twice:
  shot = status editing or later · edited = done · posted = uploaded switch.

## Testing

- Server: `products.js` against an in-memory Firestore double — create, update
  with allowed and rejected paths, acks on failure, delete leaves clips.
- Client (browser, static server): template fill and placeholders, schedule
  dates across a month boundary, "ของเข้าแล้ว" twice creates six clips not
  twelve, stage mapping, date shift skips posted clips, import of the three
  artifact products. Then the existing duplicate-clip and queue suites.
