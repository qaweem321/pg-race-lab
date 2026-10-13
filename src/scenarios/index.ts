import type { Database, Values } from "../engine/database";
import { AppError, type LabSetup, type Outcome, type Step } from "../engine/lab";

export type Variant = {
  title: string;
  explanation: string;
  transactions: { name: string; steps: Step[] }[];
};

export type Scenario = {
  id: string;
  title: string;
  story: string;
  invariant: string;
  tables: string[];
  seed: (db: Database) => void;
  check: (db: Database) => Outcome;
  broken: Variant;
  fixed: Variant;
  // The order that breaks the broken version (session indexes). Played with the fix too.
  dangerousOrder: number[];
};

export function setupFor(scenario: Scenario, variant: "broken" | "fixed"): LabSetup {
  return {
    seed: scenario.seed,
    transactions: scenario[variant].transactions,
    check: scenario.check,
  };
}

const commit: Step = { kind: "commit" };
const rows = (n: number) => `${n} row${n === 1 ? "" : "s"}`;

// 1. Keep at least one owner ----------------------------------------------------------------

function countOwners(): Step {
  return {
    kind: "sql",
    code: "SELECT count(*) FROM memberships\nWHERE role = 'owner';",
    run: ({ db, snap, vars }) => {
      vars.owners = db.scan(snap, "memberships", (r) => r.role === "owner").length;
      return `Sees ${vars.owners} owners (its snapshot).`;
    },
  };
}

function checkOwners(): Step {
  return {
    kind: "app",
    code: "if (owners <= 1) throw new Error('Keep one owner');",
    run: ({ vars }) => {
      if (Number(vars.owners) <= 1) throw new AppError("Refused: this is the last owner.");
      return `${vars.owners} owners, so removing one looks safe.`;
    },
  };
}

function deleteMember(id: string): Step {
  return {
    kind: "sql",
    code: `DELETE FROM memberships WHERE id = '${id}';`,
    run: ({ db, tx, snap }) => `Deleted ${rows(db.delete(tx, snap, "memberships", (r) => r.id === id))}.`,
  };
}

function removeKeepingOwner(target: string, actor: string): Step {
  return {
    kind: "sql",
    code: `WITH owners AS (
  SELECT id, user_id FROM memberships
  WHERE role = 'owner' FOR UPDATE
)
DELETE FROM memberships m
WHERE m.id = '${target}'
  AND EXISTS (SELECT 1 FROM owners WHERE id <> m.id)
  AND EXISTS (SELECT 1 FROM owners WHERE user_id = '${actor}')
RETURNING m.id;`,
    run: ({ db, tx, snap, vars }) => {
      const owners = db.lockRows(tx, snap, "memberships", (r) => r.role === "owner");
      const allowed =
        owners.some((o) => o.values.id !== target) && owners.some((o) => o.values.user_id === actor);
      const removed = allowed
        ? db.delete(tx, snap, "memberships", (r) => r.id === target)
        : 0;
      vars.removed = removed;
      const names = owners.map((o) => o.values.id).join(", ") || "none";
      return `Locked the owners it can still see (${names}). ${removed ? "Deleted 1 row." : "Deleted 0 rows: refused."}`;
    },
  };
}

function checkRemoved(): Step {
  return {
    kind: "app",
    code: "if (removed === 0) throw new Error('Keep one owner');",
    run: ({ vars }) => {
      if (vars.removed === 0) throw new AppError("Refused: the workspace needs an owner.");
      return "Removed.";
    },
  };
}

const lastOwner: Scenario = {
  id: "last-owner",
  title: "The last owner",
  story:
    "A workspace has two owners, Ana and Ben. At the same moment, Ana removes Ben and Ben removes Ana. Each request checks that another owner will remain.",
  invariant: "The workspace always keeps at least one owner.",
  tables: ["memberships"],
  seed: (db) =>
    db.seed("memberships", [
      { id: "ana", user_id: "ana", role: "owner" },
      { id: "ben", user_id: "ben", role: "owner" },
    ]),
  check: (db) => {
    const owners = db.committedRows("memberships").filter((r) => r.role === "owner").length;
    return owners >= 1
      ? { ok: true, message: `${owners} owner left. The workspace is safe.` }
      : { ok: false, message: "No owner left: nobody can manage or delete this workspace." };
  },
  broken: {
    title: "Count, then delete",
    explanation:
      "Both requests count the owners before either deletes. Each sees 2, each deletes the other.",
    transactions: [
      { name: "Ana", steps: [countOwners(), checkOwners(), deleteMember("ben"), commit] },
      { name: "Ben", steps: [countOwners(), checkOwners(), deleteMember("ana"), commit] },
    ],
  },
  fixed: {
    title: "Lock the owners, check and delete in one statement",
    explanation:
      "FOR UPDATE locks the owner rows. The second request waits, then sees that the first one's owner is gone, and the check fails.",
    transactions: [
      { name: "Ana", steps: [removeKeepingOwner("ben", "ana"), checkRemoved(), commit] },
      { name: "Ben", steps: [removeKeepingOwner("ana", "ben"), checkRemoved(), commit] },
    ],
  },
  dangerousOrder: [0, 1, 0, 1, 0, 0, 1, 1],
};

// 2. Lost update ----------------------------------------------------------------------------

function readBalance(): Step {
  return {
    kind: "sql",
    code: "SELECT balance FROM accounts WHERE id = 'acme';",
    run: ({ db, snap, vars }) => {
      vars.balance = db.scan(snap, "accounts", (r) => r.id === "acme")[0]?.values.balance;
      return `Reads balance = ${vars.balance}.`;
    },
  };
}

function writeBalance(amount: number): Step {
  return {
    kind: "sql",
    code: `-- app computed balance + ${amount}\nUPDATE accounts SET balance = :newBalance\nWHERE id = 'acme';`,
    run: ({ db, tx, snap, vars }) => {
      const value = Number(vars.balance) + amount;
      db.update(tx, snap, "accounts", (r) => r.id === "acme", () => ({ balance: value }));
      return `Writes balance = ${value} (computed from what it read).`;
    },
  };
}

function addToBalance(amount: number): Step {
  return {
    kind: "sql",
    code: `UPDATE accounts SET balance = balance + ${amount}\nWHERE id = 'acme';`,
    run: ({ db, tx, snap }) => {
      let value: unknown;
      db.update(tx, snap, "accounts", (r) => r.id === "acme", (row) => {
        value = Number(row.balance) + amount;
        return { balance: value as number };
      });
      return `Adds ${amount} to the newest balance: ${value}.`;
    },
  };
}

const lostUpdate: Scenario = {
  id: "lost-update",
  title: "Lost update",
  story:
    "An account holds 100 credits. Two top-ups arrive at once: +50 and +30. The app reads the balance, adds the amount, and writes the result.",
  invariant: "Every top-up is counted: the balance ends at 180.",
  tables: ["accounts"],
  seed: (db) => db.seed("accounts", [{ id: "acme", balance: 100 }]),
  check: (db) => {
    const balance = Number(db.committedRows("accounts")[0]?.balance);
    return balance === 180
      ? { ok: true, message: "Balance is 180: both top-ups counted." }
      : { ok: false, message: `Balance is ${balance}, not 180: a top-up was lost.` };
  },
  broken: {
    title: "Read, add in the app, write",
    explanation:
      "Both read 100. The second write overwrites the first with a total computed from the old value.",
    transactions: [
      { name: "+50", steps: [readBalance(), writeBalance(50), commit] },
      { name: "+30", steps: [readBalance(), writeBalance(30), commit] },
    ],
  },
  fixed: {
    title: "Let the database add",
    explanation:
      "balance = balance + 30 is computed on the newest row. The second update waits for the first, then re-reads the row it locked.",
    transactions: [
      { name: "+50", steps: [addToBalance(50), commit] },
      { name: "+30", steps: [addToBalance(30), commit] },
    ],
  },
  dangerousOrder: [0, 1, 0, 0, 1, 1],
};

// 3. Stored counter --------------------------------------------------------------------------

function lockPost(): Step {
  return {
    kind: "sql",
    code: "SELECT id FROM posts WHERE id = 'p1' FOR UPDATE;",
    run: ({ db, tx, snap }) => {
      db.lockRows(tx, snap, "posts", (r) => r.id === "p1");
      return "Locked post p1 until this transaction ends.";
    },
  };
}

function insertVote(voter: string): Step {
  return {
    kind: "sql",
    code: `INSERT INTO votes (id, post_id) VALUES ('${voter}', 'p1');`,
    run: ({ db, tx }) => {
      db.insert(tx, "votes", { id: voter, post_id: "p1" });
      return `Inserted ${voter}'s vote (not visible to others until COMMIT).`;
    },
  };
}

function recount(): Step {
  return {
    kind: "sql",
    code: "UPDATE posts SET vote_count =\n  (SELECT count(*) FROM votes WHERE post_id = 'p1')\nWHERE id = 'p1';",
    run: ({ db, tx, snap }) => {
      const votes = db.scan(snap, "votes", (r) => r.post_id === "p1").length;
      db.update(tx, snap, "posts", (r) => r.id === "p1", () => ({ vote_count: votes }));
      return `Counted ${votes} vote${votes === 1 ? "" : "s"} (with this statement's snapshot) and stored it.`;
    },
  };
}

const storedCounter: Scenario = {
  id: "stored-counter",
  title: "Vote counter drift",
  story:
    "A post stores its vote count so lists load fast. Two people vote at once. Each request inserts its vote, then recounts and stores the total.",
  invariant: "The stored count equals the number of votes.",
  tables: ["posts", "votes"],
  seed: (db) => db.seed("posts", [{ id: "p1", vote_count: 0 }]),
  check: (db) => {
    const stored = Number(db.committedRows("posts")[0]?.vote_count);
    const real = db.committedRows("votes").length;
    return stored === real
      ? { ok: true, message: `Stored count ${stored} matches the ${real} votes.` }
      : { ok: false, message: `Stored count says ${stored}, but there are ${real} votes.` };
  },
  broken: {
    title: "Insert, then recount",
    explanation:
      "The second recount waits for the first one's lock on the post. When it resumes, it updates the newest post row, but its count subquery still uses the snapshot from before the wait.",
    transactions: [
      { name: "Vote A", steps: [insertVote("a"), recount(), commit] },
      { name: "Vote B", steps: [insertVote("b"), recount(), commit] },
    ],
  },
  fixed: {
    title: "Lock the post first",
    explanation:
      "The second transaction waits at its very first statement. Its later statements take new snapshots, so the recount sees both votes.",
    transactions: [
      { name: "Vote A", steps: [lockPost(), insertVote("a"), recount(), commit] },
      { name: "Vote B", steps: [lockPost(), insertVote("b"), recount(), commit] },
    ],
  },
  dangerousOrder: [0, 1, 0, 1, 0, 1, 1, 0, 1],
};

// 4. Usage limit (check, then insert) --------------------------------------------------------

function countRedemptions(): Step {
  return {
    kind: "sql",
    code: "SELECT count(*) FROM redemptions\nWHERE coupon = 'LAUNCH';",
    run: ({ db, snap, vars }) => {
      vars.used = db.scan(snap, "redemptions", (r) => r.coupon === "LAUNCH").length;
      return `Sees ${vars.used} redemption${vars.used === 1 ? "" : "s"}.`;
    },
  };
}

function checkLimit(): Step {
  return {
    kind: "app",
    code: "if (used >= 1) throw new Error('Used up'); // max_uses is 1",
    run: ({ vars }) => {
      if (Number(vars.used) >= 1) throw new AppError("Refused: the coupon is used up.");
      return "Under the limit, so it redeems.";
    },
  };
}

function redeem(customer: string): Step {
  return {
    kind: "sql",
    code: `INSERT INTO redemptions (id, coupon)\nVALUES ('${customer}', 'LAUNCH');`,
    run: ({ db, tx }) => {
      db.insert(tx, "redemptions", { id: customer, coupon: "LAUNCH" });
      return `Redeemed for ${customer}.`;
    },
  };
}

function lockCoupon(): Step {
  return {
    kind: "sql",
    code: "SELECT id FROM coupons\nWHERE id = 'LAUNCH' FOR UPDATE;",
    run: ({ db, tx, snap }) => {
      db.lockRows(tx, snap, "coupons", (r) => r.id === "LAUNCH");
      return "Locked the coupon until this transaction ends.";
    },
  };
}

const usageLimit: Scenario = {
  id: "usage-limit",
  title: "Coupon used twice",
  story:
    "A launch coupon may be used once. Two customers check out at the same moment. Each request counts the redemptions, then redeems if the limit isn't reached.",
  invariant: "The coupon is redeemed at most once.",
  tables: ["coupons", "redemptions"],
  seed: (db) => db.seed("coupons", [{ id: "LAUNCH", max_uses: 1 }]),
  check: (db) => {
    const used = db.committedRows("redemptions").length;
    return used <= 1
      ? { ok: true, message: `Redeemed ${used} time${used === 1 ? "" : "s"}. The limit holds.` }
      : { ok: false, message: `Redeemed ${used} times, but the limit is 1.` };
  },
  broken: {
    title: "Count, then insert",
    explanation:
      "Neither transaction can see the other's uncommitted insert, so both count 0 and both redeem. No row was locked, so nothing waits.",
    transactions: [
      { name: "Kim", steps: [countRedemptions(), checkLimit(), redeem("kim"), commit] },
      { name: "Lee", steps: [countRedemptions(), checkLimit(), redeem("lee"), commit] },
    ],
  },
  fixed: {
    title: "Lock the coupon row first",
    explanation:
      "Both lock the same coupon row. The second waits until the first commits, then counts with a new snapshot and sees the redemption.",
    transactions: [
      { name: "Kim", steps: [lockCoupon(), countRedemptions(), checkLimit(), redeem("kim"), commit] },
      { name: "Lee", steps: [lockCoupon(), countRedemptions(), checkLimit(), redeem("lee"), commit] },
    ],
  },
  dangerousOrder: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1],
};

export const scenarios: Scenario[] = [lastOwner, lostUpdate, storedCounter, usageLimit];

export type { Values };
