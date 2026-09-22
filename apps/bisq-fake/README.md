# `apps/bisq-fake/`: a static mock of Bisq's offer book

**What lives here.** A page that looks like Bisq 1's *Buy BTC* screen, written in this
repository to be filmed. **It is not Bisq and it is not a port.** It holds no Bisq code and runs
none. It opens no socket, holds no wallet and makes no trade. Bisq is a JavaFX desktop
application, so it has no web renderer that a port could build. This project is not affiliated
with the Bisq project.

| File | What it is |
|---|---|
| [`recipe.json`](recipe.json) | A `site` recipe: port 8885, served as `bisq.eth` |
| [`orivon.json`](orivon.json) | The manifest the consent dialog renders |
| [`site/index.html`](site/index.html) | The layout |
| [`site/bisq.css`](site/bisq.css) | Colours and geometry, measured off a 1914x994 screenshot of the real app |
| [`site/offers.js`](site/offers.js) | The offer book: 16 offers transcribed from that screenshot, the rest generated from a fixed seed |
| [`site/avatars.js`](site/avatars.js) | Seller avatars, one per seed |
| [`site/icons.js`](site/icons.js) | Every glyph, as inline SVG |
| [`site/app.js`](site/app.js) | Rendering, filters, sorting, and what keeps moving |

## Running it

```bash
orivon-port run bisq-fake     # prepares site/ into out/bisq-fake/static, serves 127.0.0.1:8885
orivon-port names             # writes out/names.json, which now maps bisq.eth
```

Then launch the shell from `orivon-mvp` with that file
(`ORIVON_ETH_NAMES_FILE=<absolute path>/out/names.json npm run dev`) and open `bisq.eth`. The
top-level [`README.md`](../../README.md)'s "Opening it by name instead of by port" has the full
command. The name is fake, not ENS, and like any plain-`http` grant it is scoped to the session.

There is no build. A change under `site/` is live on the next `orivon-port run bisq-fake`, which
prepares the tree again every time.

## What it does on screen

- **The screenshot's first screen, row for row.** The first 16 EUR offers are the ones the
  reference shows, with the same prices, amounts, methods, deposits and account ages. The
  remaining 59 continue the book upward in price.
- **Dimmed rows mean no matching account.** The profile has one payment account, CashByMail, so
  those offers are bright and every other offer is dimmed, as Bisq dims an offer you cannot take.
  *Offers matching my accounts* hides the dimmed ones.
- **The filters work.** The currency combo switches between EUR, USD, GBP and CHF books, the
  payment-method combo filters by method, and a column header sorts by that column.
- **Things move.** The market price walks by up to 0.06% every 8 to 15 seconds, and every
  market-based offer moves with it. The block download climbs from 12% and finishes after about
  three minutes. The peer counts rise.
- **Buttons answer the way Bisq would.** *BUY* on a dimmed offer asks you to set up a payment
  account. On a bright offer it says the block download is not finished, and once that is done,
  that the wallet holds no funds. Nothing leaves the page.

## Design notes

**The manifest declares what Bisq itself would need, and the page uses none of it.** Bisq talks
to Bitcoin and Bisq peers over Tor, which is `net.tcp.connect: ["*:*"]`, and keeps a data
directory of a few gigabytes, which is `fs.quotaBytes`. Declaring both makes the consent dialog
show the request a real Bisq would make. The page never calls `orivon.*`, so a grant it receives
reaches nothing. If this mock is ever changed to call `orivon.*`, this note has to change with it.

**The font is fetched from Google Fonts at runtime.** Bisq draws its interface in IBM Plex Sans.
A font file cannot be committed under `apps/`: `check:no-upstream` refuses binary assets even
in a `site` directory, because a font is somebody else's work. Offline, the page falls back to
the system sans-serif, and the layout holds, only less faithfully.

**The layout is fluid, but it was measured at 1914 pixels wide.** Column widths are the
screenshot's own, as fractions of the table, so the table rescales with the window. Below
about 1280 pixels the top bar starts to crowd, much as Bisq's own window does.
