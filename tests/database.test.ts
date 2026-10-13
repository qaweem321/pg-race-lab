import { describe, expect, test } from "vitest";
import { Blocked, Database, UniqueViolation } from "../src/engine/database";

function setup() {
  const db = new Database();
  db.seed("t", [{ id: "a", n: 1 }]);
  return { db, t1: db.begin(1, "T1"), t2: db.begin(2, "T2") };
}

describe("READ COMMITTED model", () => {
  test("uncommitted changes are invisible to others, visible to yourself", () => {
    const { db, t1, t2 } = setup();
    db.update(t1, db.snapshot(t1), "t", () => true, () => ({ n: 2 }));
    expect(db.scan(db.snapshot(t1), "t")[0].values.n).toBe(2);
    expect(db.scan(db.snapshot(t2), "t")[0].values.n).toBe(1);
    db.commit(t1);
    expect(db.scan(db.snapshot(t2), "t")[0].values.n).toBe(2);
  });

  test("a writer waits for another writer's row lock", () => {
    const { db, t1, t2 } = setup();
    db.update(t1, db.snapshot(t1), "t", () => true, () => ({ n: 2 }));
    expect(() => db.update(t2, db.snapshot(t2), "t", () => true, () => ({ n: 3 }))).toThrow(Blocked);
  });

  test("after the wait, the newest version is re-checked (EvalPlanQual)", () => {
    const { db, t1, t2 } = setup();
    const snap2 = db.snapshot(t2); // taken before T1 commits, kept through the wait
    db.update(t1, db.snapshot(t1), "t", () => true, (r) => ({ n: Number(r.n) + 10 }));
    db.commit(t1);
    db.update(t2, snap2, "t", (r) => Number(r.n) > 0, (r) => ({ n: Number(r.n) + 1 }));
    db.commit(t2);
    expect(db.committedRows("t")[0].n).toBe(12);
  });

  test("a row changed so it no longer matches is skipped after the wait", () => {
    const { db, t1, t2 } = setup();
    const snap2 = db.snapshot(t2);
    db.update(t1, db.snapshot(t1), "t", () => true, () => ({ n: 5 }));
    db.commit(t1);
    expect(db.update(t2, snap2, "t", (r) => r.n === 1, () => ({ n: 99 }))).toBe(0);
  });

  test("a row deleted meanwhile is skipped after the wait", () => {
    const { db, t1, t2 } = setup();
    const snap2 = db.snapshot(t2);
    db.delete(t1, db.snapshot(t1), "t", () => true);
    db.commit(t1);
    expect(db.delete(t2, snap2, "t", () => true)).toBe(0);
  });

  test("rollback undoes everything and releases locks", () => {
    const { db, t1, t2 } = setup();
    db.update(t1, db.snapshot(t1), "t", () => true, () => ({ n: 2 }));
    db.insert(t1, "t", { id: "b", n: 1 });
    db.rollback(t1);
    expect(db.committedRows("t")).toEqual([{ id: "a", n: 1 }]);
    expect(db.update(t2, db.snapshot(t2), "t", () => true, () => ({ n: 3 }))).toBe(1);
  });

  test("duplicate keys wait for an uncommitted insert, then fail", () => {
    const { db, t1, t2 } = setup();
    db.insert(t1, "t", { id: "b", n: 1 });
    expect(() => db.insert(t2, "t", { id: "b", n: 2 })).toThrow(Blocked);
    db.commit(t1);
    expect(() => db.insert(t2, "t", { id: "b", n: 2 })).toThrow(UniqueViolation);
  });

  test("an insert waits for a transaction deleting the same key, then succeeds if the delete commits", () => {
    const { db, t1, t2 } = setup();
    db.delete(t1, db.snapshot(t1), "t", (r) => r.id === "a");
    expect(() => db.insert(t2, "t", { id: "a", n: 2 })).toThrow(Blocked);
    db.commit(t1);
    db.insert(t2, "t", { id: "a", n: 2 });
    db.commit(t2);
    expect(db.committedRows("t")).toEqual([{ id: "a", n: 2 }]);
  });

  test("an insert waits for a deleting transaction, then fails if it rolls back", () => {
    const { db, t1, t2 } = setup();
    db.delete(t1, db.snapshot(t1), "t", (r) => r.id === "a");
    expect(() => db.insert(t2, "t", { id: "a", n: 2 })).toThrow(Blocked);
    db.rollback(t1);
    expect(() => db.insert(t2, "t", { id: "a", n: 2 })).toThrow(UniqueViolation);
  });

  test("an insert waits for a transaction updating the same key, then fails", () => {
    const { db, t1, t2 } = setup();
    db.update(t1, db.snapshot(t1), "t", () => true, () => ({ n: 5 }));
    expect(() => db.insert(t2, "t", { id: "a", n: 2 })).toThrow(Blocked);
    db.commit(t1);
    expect(() => db.insert(t2, "t", { id: "a", n: 2 })).toThrow(UniqueViolation);
  });

  test("a transaction can delete a key and insert it again", () => {
    const { db, t1 } = setup();
    db.delete(t1, db.snapshot(t1), "t", (r) => r.id === "a");
    db.insert(t1, "t", { id: "a", n: 7 });
    db.commit(t1);
    expect(db.committedRows("t")).toEqual([{ id: "a", n: 7 }]);
  });

  test("but not insert a key it only updated", () => {
    const { db, t1 } = setup();
    db.update(t1, db.snapshot(t1), "t", () => true, () => ({ n: 5 }));
    expect(() => db.insert(t1, "t", { id: "a", n: 7 })).toThrow(UniqueViolation);
  });
});
