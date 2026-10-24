# Wildcall Online

The online version of Wildcall: accounts, cloud saves, a server-run shop and pack opening, ranked matchmaking against real players, and an admin panel. It's free to play. There are no payments anywhere, and coins only come from playing.

## Run it on your computer

You need Node.js 20 or newer.

```bash
npm install
npm run dev
```

Open http://localhost:3000. Without a `DATABASE_URL` it uses a built-in Postgres-compatible database stored in `./data`, so there's nothing else to install.

To make yourself an admin, start it with your username:

```bash
ADMIN_USERNAMES=yourname npm run dev
```

Then sign up (or sign in) as `yourname`, and an **Admin** button appears on the title screen.

To try multiplayer locally, open a second browser (or a private window), sign up a second account, and press **Find a match** on the Ranked screen in both.

## How it fits together

```
client/wildcall.src.html   The whole game (same source as the offline artifact)
scripts/build.js           Builds public/index.html from it (adds the art list + online flag)
public/art/                Card and pack art
server/index.js            Express: accounts, saves, shop actions, story rewards, admin, static files
server/pvp.js              WebSockets: matchmaking queue, server-run ranked duels, Elo, rewards
server/game.js             Loads the game's own code into small Node "realms" so the server runs the real rules
server/db.js               Postgres (DATABASE_URL) or built-in PGlite for local dev
server/shared.js           Config, per-player save locking, helpers
test/                      api.mjs (31 API checks), e2e.py (two browsers, full ranked match), timeout.mjs, story.py
```

**The server is in charge of everything with value.** Coins, packs, the collection and story progress live in the database. When a player buys, opens a pack, claims a Bounty, buys from the Trail Market or sells extras, the browser asks the server, and the server runs the same game functions on its own copy of the save. Editing coins in the browser does nothing.

**Ranked duels run on the server.** Each match gets its own copy of the duel engine. Players send moves, the server checks and applies them, and each player only sees their own hand. It also handles turn timers, auto-picks a choice when one times out, and gives a 45-second reconnect window before a forfeit.

**Story duels against the AI run in the browser**, as before. The server only accepts a result for a duel it saw start, ignores instant "wins" under 30 seconds, and caps daily AI coins and packs. Both caps can be changed in the admin panel.

## Admin panel

- **Sales:** % off everything or per item, including theme decks and the Trail Market.
- **Prices** for every item, the theme decks and the Trail Market by rarity.
- **What's for sale:** turn any booster, theme deck, the Trail Market or trade-ins on or off.
- **Trail Market featured stock:** pick exact cards, or leave it blank for the daily random stock.
- **News banner** on the title screen and in the shop.
- **Ranked rewards:** win, loss and daily-first-win coins, turn length, and the daily caps for AI duels.
- **Stakes (coin wagers):** on/off, max stake, matches per day and blocked countries. Players also have to opt in, confirm they're 18+ and set a country.
- **Players:** search, grant coins or packs, ban or unban.
- **End season:** pays rewards by rank and moves ratings halfway back to 1000.

Every admin change is written to the `audit` table.

## Updating the game

Edit `client/wildcall.src.html`, then run `npm run build` (the deploy runs this for you). Card data, rules and the AI are shared, so a rules change applies to both the browser and server-run ranked duels.

## Tests

```bash
node test/api.mjs        # accounts, economy, anti-cheat, admin, stakes settings
node test/timeout.mjs    # idle turns time out; a disconnected player forfeits
python3 test/e2e.py      # needs Playwright: two players, shop, admin sale, a full staked ranked match
python3 test/story.py    # online story duel rewards
```

## Not built yet

- **Password reset and email verification.** These need an email service such as Resend, Postmark or SES. Until then, an admin can't reset a password from the panel either.
- **Terms of Service and Privacy Policy pages.** You'll want these before a public launch, especially with stakes.
- **Running more than one server.** The queue and live matches are held in memory, so it must run as **one instance**. That's fine for thousands of players. Horizontal scaling would need Redis.
- Friend challenges, chat, spectating and season scheduling (seasons are ended by hand from the admin panel).
