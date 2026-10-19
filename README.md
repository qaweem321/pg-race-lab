# pg-race-lab

**Watch Postgres race conditions happen, one statement at a time. Then watch the fix hold.**

**[▶ Open the lab](https://qaweem321.github.io/pg-race-lab/)**: it runs in your browser, no
install and no database needed.

![Two transactions: Ben's statement waits for the row lock Ana holds](docs/screenshot.jpg)

Two requests hit the same database at the same moment. Each one checks something, then writes.
Each is correct on its own, passes every test, and works fine in development. Together, under real
traffic, they break the rule they were checking.

You can run the two transactions in any order, see which rows each one can see, who holds which
lock, who waits, and what ends up committed.

## The four scenarios

| Scenario | The usual code | What goes wrong | The fix |
| --- | --- | --- | --- |
| **The last owner** | count owners, then delete | Two owners remove each other: no owner left | Lock the owner rows and check in the same statement |
| **Lost update** | read balance, add in the app, write | Two top-ups, one is lost | `SET balance = balance + 30` |
| **Vote counter drift** | insert vote, then recount | The stored count ends one too low | Lock the post *before* inserting |
| **Coupon used twice** | count redemptions, then insert | A single-use coupon is used twice | Lock the coupon row first |

The vote counter one surprises most people: the second recount **does** wait for the first
transaction's lock, and it **does** update the newest row afterwards. But its `count(*)` subquery
still uses the snapshot from before the wait, so it can't see the other vote.

## How faithful is it?

The lab is a small model of Postgres at its default isolation level, `READ COMMITTED`:

- **Row versions (MVCC).** Updates write a new version; uncommitted ones are invisible to others.
- **A snapshot per statement.** Each statement sees what was committed when *it* started.
- **Row locks.** `UPDATE`, `DELETE` and `SELECT ... FOR UPDATE` lock rows; a second writer waits.
- **The re-check after a wait (EvalPlanQual).** After waiting, Postgres re-checks the *newest*
  version of the locked row against the `WHERE` clause and skips it if it was deleted, while the
  rest of the statement keeps its old snapshot.

It's checked three ways, on every push:

1. **Unit tests** for the model itself (visibility, locks, the re-check, rollback, unique keys).
2. **Every possible interleaving.** The tests run each fixed version in *all* orders its steps can
   be interleaved, and require the rule to hold and nothing to deadlock in every one. A fix that
   only works in the order shown on screen would fail here.
3. **Real Postgres.** CI starts Postgres 17 and runs every scenario with two real connections, in
   the order the app shows, using the exact SQL on screen. The run passes only when real Postgres
   agrees with the lab: each broken version breaks and each fix holds.

Not modelled: other isolation levels, deadlock detection, predicate locks and `SKIP LOCKED`.

## Run it locally

```bash
npm ci
npm run dev            # the lab at http://localhost:5173/pg-race-lab/
npm test               # model tests + every interleaving
npm run build          # type check + production build

# compare with a real Postgres (creates and drops a throwaway schema)
docker compose up -d   # Postgres 17, the version CI uses; or use your own DATABASE_URL
DATABASE_URL=postgres://lab:lab@localhost:5439/lab npm run verify:postgres
docker compose down
```

## Add a scenario

Scenarios live in `src/scenarios/index.ts`. Each one has a story, the rule that must always hold,
seed data, a check, a broken and a fixed version (each a list of SQL and application steps), and
the order that breaks the broken version. Add one there, and the tests check it in every
interleaving automatically.

## License

MIT
