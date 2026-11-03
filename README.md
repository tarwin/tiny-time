# Tiny Time

A local-only time tracker for the menu bar (macOS) or system tray (Windows, Linux), in the
spirit of Harvest. Built with
[tinyjs](https://tinyjs.app): plain JavaScript, zero dependencies, one SQLite file.

```sh
tinyjs dev      # run with hot reload
tinyjs build    # package dist/Tiny Time.app
```

## How it runs

`tinyjs.json` sets `"mainWindow": false` and `"activation": "accessory"`. At rest there is
**no WebView at all**: just the launcher, the JS backend and the tray item (about 26 MB
footprint, measured on the built app). Windows exist only while you use them:

- **Popover** (`popover.html`). Drops from the tray and shows the day, the week strip,
  start/stop, and a quick entry form. It hides when it loses focus and is **closed after
  45 s hidden**, so WebKit's memory is released too.
- **Dashboard** (`app.html`). Timesheet (day and week grid), reports with charts, and
  clients, projects, tasks and settings. While it's open, Tiny Time shows in the Dock and
  ⌘-Tab; closing it puts the app back in the menu bar only.

**Tear-off.** Drag the popover's green header away from the menu bar and it becomes its
own window: traffic lights appear, it's resizable (380–560 px wide), and it stays open
when you click elsewhere. Drag it back under the tray icon (the little pointer pokes out
to show it will snap) and let go to re-attach. The torn-off position and size survive
relaunch. Closing it hides it, and as with the popover the WebView is torn down 45 s later.

**Look.** Settings → Look picks the appearance (System, Light or Dark) and an accent color:
nine presets or any custom color. The accent recolors the popover header, buttons,
highlights and the menu-bar pill while a timer runs, live in every open window. Text
colors derived from the accent are adjusted automatically so they stay readable, even
for pale picks like yellow.

The tray item works the same way as in Till: we draw a fixed-width pill PNG ourselves.
Clicking **▶/‖** starts or stops the timer (restarting your last entry), and clicking the
**time** opens the popover. Right-click for the menu.

On Windows and Linux the tray icon is square: the accent color with ‖ while a timer runs,
gray with ▶ when idle, and the running time in its tooltip. A click opens the popover
(above the taskbar on Windows, top-right on Linux, which doesn't report the icon's
position) and right-click has the menu. In-window shortcuts use Ctrl instead of ⌘.
On Windows a hidden main window exists, so the at-rest memory saving is smaller there.

The backend keeps time, not the page. A running entry stores `started_at`, and its length
is always `seconds + (now − started_at)`, so the clock is right even with every window
closed. Restarting an entry from an earlier day starts a fresh copy today.

## Data model

| | fields |
|---|---|
| **Client** | name, address, currency, payment terms (Net 0/7/14/15/30/45/60/90 or custom days), tax %, discount % |
| **Project** | name, client, color, its tasks |
| **Task** | name, rate per hour, *common* (added automatically to every new project; optionally to all existing ones) |
| **Entry** | date, project, task, notes, seconds, started_at |
| **Invoice** | client, optional project, number, issue date, notes, the hours and amount billed (copied in when it's made), and the entries it covers |

Anything with time logged against it can be archived but not deleted. Amounts use the
task's rate in the client's currency. The report's billing summary applies each client's
discount and then tax.

Data lives in one SQLite file, `tinytime.db`, in the app's data folder
(`~/Library/Application Support/art.tarwin.tinytime/` on macOS). Settings → Your data shows
the path.

**Invoices.** Invoices (in the sidebar) shows what isn't invoiced yet for each project, and
since which invoice. An invoice here is only a record: *invoiced these entries, as number N,
on date D, for this amount*. Tiny Time doesn't make PDFs or track payments. Recording one
marks its entries as invoiced. Reports can filter by invoiced or not, and the Harvest export
fills in `Invoiced?`. Restarting a timer on an invoiced entry starts a fresh copy, so billed
time never grows. Deleting an invoice puts its time back to not invoiced.

**Tiny Tally.** *Save & Open in Tiny Tally* (or *Tiny Tally* on any invoice) writes a
`.tallyinvoice` file and opens it. Tiny Tally shows it as a new invoice, filled in with one
line per project · task (hours × rate, with the dates covered), the client's discount, and an
adjustment line if you typed a different amount. You check it and save it there. Neither app
reads the other's database. The file format is described in Tiny Tally's
`src/shared/invoiceHandoff.ts`.

**Harvest.** *Import & Export* (in the sidebar, above Settings) → *Import from Harvest…*
reads the CSV from Harvest's Reports → Detailed time → Export. It shows a preview first.
Clients, projects and tasks are matched by name or created, and entries already present are
skipped, so re-importing is safe. Tiny Time keeps one rate per task, so when Harvest used
different rates for the same task the preview tells you. Harvest's export marks which entries were
invoiced but not on which invoice, so after importing you're asked for each invoice's number
and issue date (from the PDFs). Entries are split between invoices by date. The same page exports all your
time as a Harvest CSV (same columns) or a plain Tiny Time CSV. Reports exports either format
for the current range and filters.

## Files

```
src/backend/main.js     tray, window lifecycle, api, idle detection, hotkeys
src/backend/db.js       sqlite schema + queries
src/backend/harvest.js  Harvest CSV parse + export
src/backend/tally.js    invoice → .tallyinvoice hand-off for Tiny Tally
src/backend/traypng.js  hand-rolled tray PNGs: the macOS pill (from Till), the square icon
src/frontend/popover.*  the tray popover
src/frontend/app.*      the dashboard
src/frontend/lib.js     shared page helpers + icon sprite
```

Dev shortcut: `TINYTIME_OPEN=reports tinyjs dev` (or `pop`, `time`, `clients`, …) opens a
window at launch.

Releasing: see [RELEASING.md](RELEASING.md).
