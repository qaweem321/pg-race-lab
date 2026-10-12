// Runs two transactions step by step against the model database, the way two requests would hit
// Postgres at the same time. A step that has to wait keeps its snapshot and resumes by itself as
// soon as the transaction it waits for ends, exactly like a real lock wait.
import { Blocked, Database, type Snapshot, type Tx, UniqueViolation } from "./database";

export type Vars = Record<string, unknown>;

export type StepContext = {
  db: Database;
  tx: Tx;
  snap: Snapshot;
  vars: Vars;
};

export type Step =
  | { kind: "sql"; code: string; run: (ctx: StepContext) => string }
  // Application code between queries (the "if" that decides what to do next). Throwing an
  // AppError rolls the transaction back, as a request that fails would.
  | { kind: "app"; code: string; run: (ctx: StepContext) => string }
  | { kind: "commit" };

export class AppError extends Error {}

export type SessionState = "ready" | "waiting" | "committed" | "rolled back";

export type Session = {
  name: string;
  tx: Tx;
  steps: Step[];
  pc: number;
  vars: Vars;
  state: SessionState;
  waitingFor: number | null;
  // The snapshot of a statement that is waiting: it keeps it when it resumes.
  pendingSnapshot: Snapshot | null;
  note: string | null;
};

export type LogEntry = { session: string; text: string; tone: "info" | "wait" | "error" | "done" };

export type Outcome = { ok: boolean; message: string };

export type LabSetup = {
  seed: (db: Database) => void;
  transactions: { name: string; steps: Step[] }[];
  check: (db: Database) => Outcome;
};

export class Lab {
  readonly db = new Database();
  readonly sessions: Session[];
  readonly log: LogEntry[] = [];

  constructor(private readonly setup: LabSetup) {
    setup.seed(this.db);
    this.sessions = setup.transactions.map((t, index) => ({
      name: t.name,
      tx: this.db.begin(index + 1, t.name),
      steps: t.steps,
      pc: 0,
      vars: {},
      state: "ready",
      waitingFor: null,
      pendingSnapshot: null,
      note: null,
    }));
  }

  get finished() {
    return this.sessions.every((s) => s.state === "committed" || s.state === "rolled back");
  }

  // True when no session can move: they wait for each other. (Postgres would detect the deadlock
  // and cancel one; none of the scenarios here should ever get there.)
  get stuck() {
    return !this.finished && this.sessions.every((s) => s.state !== "ready");
  }

  canStep(index: number) {
    return this.sessions[index]?.state === "ready";
  }

  outcome(): Outcome | null {
    return this.finished ? this.setup.check(this.db) : null;
  }

  step(index: number) {
    const session = this.sessions[index];
    if (!session || session.state !== "ready") return;
    this.execute(session);
    this.resumeWaiting();
  }

  private execute(session: Session) {
    const step = session.steps[session.pc];
    if (!step) return;
    if (step.kind === "commit") {
      this.db.commit(session.tx);
      session.pc++;
      session.state = "committed";
      this.write(session, "COMMIT: its changes are now visible to new statements.", "done");
      return;
    }
    const snap = session.pendingSnapshot ?? this.db.snapshot(session.tx);
    try {
      const note = step.run({ db: this.db, tx: session.tx, snap, vars: session.vars });
      session.note = note;
      session.pc++;
      session.pendingSnapshot = null;
      session.waitingFor = null;
      session.state = "ready";
      this.write(session, note, "info");
    } catch (error) {
      if (error instanceof Blocked) {
        const blocker = this.db.tx(error.by).name;
        session.state = "waiting";
        session.waitingFor = error.by;
        session.pendingSnapshot = snap;
        session.note = `Waiting for ${blocker}: it holds a lock on ${error.table} row ${error.key}.`;
        this.write(session, session.note, "wait");
        return;
      }
      if (error instanceof AppError || error instanceof UniqueViolation) {
        this.db.rollback(session.tx);
        session.state = "rolled back";
        session.note = error.message;
        this.write(session, `${error.message} ROLLBACK: nothing it did is kept.`, "error");
        return;
      }
      throw error;
    }
  }

  // A transaction ended: the statements waiting for it run again (with their old snapshot).
  private resumeWaiting() {
    for (let changed = true; changed; ) {
      changed = false;
      for (const session of this.sessions) {
        if (session.state !== "waiting" || session.waitingFor === null) continue;
        if (this.db.tx(session.waitingFor).status === "active") continue;
        session.state = "ready";
        this.write(session, `${this.db.tx(session.waitingFor).name} ended, so the waiting statement goes on.`, "info");
        this.execute(session);
        changed = true;
      }
    }
  }

  private write(session: Session, text: string, tone: LogEntry["tone"]) {
    this.log.push({ session: session.name, text, tone });
  }
}

// Every order in which the sessions' steps can run (a waiting session can't be picked). Used by
// the tests to prove a fix holds in *all* interleavings, not just the one on screen.
export function allInterleavings(setup: LabSetup, limit = 100_000): number[][] {
  const results: number[][] = [];
  const explore = (prefix: number[]) => {
    if (results.length >= limit) return;
    const lab = replay(setup, prefix);
    if (lab.finished || lab.stuck) {
      results.push(prefix);
      return;
    }
    lab.sessions.forEach((_, index) => {
      if (lab.canStep(index)) explore([...prefix, index]);
    });
  };
  explore([]);
  return results;
}

export function replay(setup: LabSetup, order: number[]) {
  const lab = new Lab(setup);
  for (const index of order) lab.step(index);
  return lab;
}

// Plays an order (sessions that are waiting or done are skipped), then lets whatever can still
// move finish. This is what the "Play" button does.
export function play(lab: Lab, order: number[]) {
  for (const index of order) lab.step(index);
  while (!lab.finished && !lab.stuck) {
    const next = lab.sessions.findIndex((_, index) => lab.canStep(index));
    lab.step(next);
  }
  return lab;
}
