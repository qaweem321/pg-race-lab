// A tiny model of how Postgres runs concurrent transactions at its default isolation level,
// READ COMMITTED. Just enough to show real race conditions faithfully:
//
// - Every row change makes a new row *version* (MVCC). A version records the transaction that
//   created it (xmin) and the one that updated or deleted it (xmax).
// - Each statement reads a *snapshot*: the transactions committed when the statement started.
// - Writes and SELECT ... FOR UPDATE lock the newest version of each row. A second writer waits
//   until the first transaction ends.
// - After waiting, Postgres re-checks the *newest* version of the locked row (EvalPlanQual), but
//   everything else in the statement still uses the old snapshot. Several famous bugs live here.

export type Value = string | number;
export type Values = Record<string, Value>;

export type Version = {
  vid: number;
  table: string;
  key: string;
  values: Values;
  xmin: number;
  xmax: number | null;
  next: Version | null;
  lockedBy: number | null;
};

export type TxStatus = "active" | "committed" | "aborted";
export type Tx = { id: number; name: string; status: TxStatus };
export type Snapshot = { txId: number; committed: ReadonlySet<number> };

export type Where = (values: Values) => boolean;

// Thrown when a statement has to wait for another transaction's lock.
export class Blocked extends Error {
  constructor(
    readonly by: number,
    readonly table: string,
    readonly key: string,
  ) {
    super(`waiting for transaction ${by} (row ${table}/${key})`);
  }
}

export class UniqueViolation extends Error {
  constructor(
    readonly table: string,
    readonly key: string,
  ) {
    super(`duplicate key ${key} in ${table}`);
  }
}

// The transaction that loaded the starting data. It's committed before anything else runs.
const SEED_TX = 0;

export class Database {
  private versions: Version[] = [];
  private txs = new Map<number, Tx>([[SEED_TX, { id: SEED_TX, name: "seed", status: "committed" }]]);
  private committed = new Set<number>([SEED_TX]);
  private nextVid = 1;

  seed(table: string, rows: Values[]) {
    for (const values of rows) {
      this.versions.push(this.newVersion(table, values, SEED_TX));
    }
  }

  begin(id: number, name: string): Tx {
    const tx: Tx = { id, name, status: "active" };
    this.txs.set(id, tx);
    return tx;
  }

  tx(id: number) {
    const tx = this.txs.get(id);
    if (!tx) throw new Error(`unknown transaction ${id}`);
    return tx;
  }

  // Taken at the start of every statement (READ COMMITTED).
  snapshot(tx: Tx): Snapshot {
    return { txId: tx.id, committed: new Set(this.committed) };
  }

  isVisible(v: Version, snap: Snapshot) {
    const created = v.xmin === snap.txId || snap.committed.has(v.xmin);
    const removed = v.xmax !== null && (v.xmax === snap.txId || snap.committed.has(v.xmax));
    return created && !removed;
  }

  // Rows a statement can see with its snapshot.
  scan(snap: Snapshot, table: string, where: Where = () => true) {
    return this.versions.filter(
      (v) => v.table === table && this.isVisible(v, snap) && where(v.values),
    );
  }

  // Locks the newest version of every row the statement targets. Waits (throws Blocked, having
  // locked nothing) if another active transaction holds one of them. Rows a committed transaction
  // changed meanwhile are followed to their newest version and checked against `where` again;
  // deleted ones are skipped.
  lockRows(tx: Tx, snap: Snapshot, table: string, where: Where) {
    const targets: Version[] = [];
    for (const seen of this.scan(snap, table, where)) {
      const newest = this.newestFor(tx, seen, where);
      if (newest) targets.push(newest);
    }
    for (const v of targets) v.lockedBy = tx.id;
    return targets;
  }

  update(tx: Tx, snap: Snapshot, table: string, where: Where, set: (row: Values) => Values) {
    const targets = this.lockRows(tx, snap, table, where);
    for (const old of targets) {
      const changed = this.newVersion(table, { ...old.values, ...set(old.values) }, tx.id);
      changed.lockedBy = tx.id;
      old.xmax = tx.id;
      old.next = changed;
      this.versions.push(changed);
    }
    return targets.length;
  }

  delete(tx: Tx, snap: Snapshot, table: string, where: Where) {
    const targets = this.lockRows(tx, snap, table, where);
    for (const old of targets) old.xmax = tx.id;
    return targets.length;
  }

  // The unique check looks at every version of the key, like Postgres's index check: a version
  // another transaction is still creating or removing makes the insert wait for it to end, then
  // look again (the waiting statement is run again).
  insert(tx: Tx, table: string, values: Values) {
    const key = String(values.id);
    for (const v of this.versions) {
      if (v.table !== table || v.key !== key || this.tx(v.xmin).status === "aborted") continue;
      const creator = this.tx(v.xmin);
      if (creator.status === "active" && creator.id !== tx.id) throw new Blocked(creator.id, table, key);
      if (v.xmax === null) throw new UniqueViolation(table, key);
      if (v.xmax === tx.id) continue; // this transaction deleted or replaced it (a replacement is its own version)
      const remover = this.tx(v.xmax);
      if (remover.status === "active") throw new Blocked(remover.id, table, key);
      if (remover.status !== "committed") throw new UniqueViolation(table, key);
    }
    this.versions.push(this.newVersion(table, values, tx.id));
  }

  commit(tx: Tx) {
    tx.status = "committed";
    this.committed.add(tx.id);
    this.releaseLocks(tx);
  }

  rollback(tx: Tx) {
    tx.status = "aborted";
    this.versions = this.versions.filter((v) => v.xmin !== tx.id);
    for (const v of this.versions) {
      if (v.xmax === tx.id) {
        v.xmax = null;
        v.next = null;
      }
    }
    this.releaseLocks(tx);
  }

  // What everyone sees after all transactions end: the committed rows.
  committedRows(table: string) {
    const snap: Snapshot = { txId: -1, committed: this.committed };
    return this.scan(snap, table).map((v) => v.values);
  }

  // Every version, for showing what's going on (including uncommitted and dead ones).
  allVersions() {
    return [...this.versions];
  }

  private newestFor(tx: Tx, seen: Version, where: Where): Version | null {
    let current = seen;
    for (;;) {
      if (current.xmax !== null && current.xmax !== tx.id) {
        const writer = this.tx(current.xmax);
        if (writer.status === "active") throw new Blocked(writer.id, current.table, current.key);
        if (writer.status === "committed") {
          if (!current.next) return null; // deleted meanwhile: skip it
          current = current.next; // updated meanwhile: re-check the newest version
          if (!where(current.values)) return null;
          continue;
        }
      }
      if (current.lockedBy !== null && current.lockedBy !== tx.id) {
        throw new Blocked(current.lockedBy, current.table, current.key);
      }
      return current;
    }
  }

  private releaseLocks(tx: Tx) {
    for (const v of this.versions) if (v.lockedBy === tx.id) v.lockedBy = null;
  }

  private newVersion(table: string, values: Values, xmin: number): Version {
    return {
      vid: this.nextVid++,
      table,
      key: String(values.id),
      values,
      xmin,
      xmax: null,
      next: null,
      lockedBy: null,
    };
  }
}
