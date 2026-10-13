// Runs every scenario on a real Postgres with two connections, in the same order the app shows,
// and checks that real Postgres gives the same result as the simulator (broken fails, fixed holds).
// The SQL is the exact text shown on screen. Uses a throwaway schema, dropped at the end.
//
//   DATABASE_URL=postgres://... npm run verify:postgres
import pg from "pg";
import { expect, test } from "vitest";
import type { Step } from "../src/engine/lab";
import { type Scenario, scenarios } from "../src/scenarios";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("Set DATABASE_URL");
const schema = `race_lab_${Date.now()}`;
const admin = new pg.Client({ connectionString: url });

const tables = `
  create table memberships (id text primary key, user_id text, role text);
  create table accounts (id text primary key, balance int);
  create table posts (id text primary key, vote_count int);
  create table votes (id text primary key, post_id text);
  create table coupons (id text primary key, max_uses int);
  create table redemptions (id text primary key, coupon text);`;

const seeds: Record<string, string> = {
  "last-owner": "insert into memberships values ('ana','ana','owner'), ('ben','ben','owner');",
  "lost-update": "insert into accounts values ('acme', 100);",
  "stored-counter": "insert into posts values ('p1', 0);",
  "usage-limit": "insert into coupons values ('LAUNCH', 1);",
};

const checks: Record<string, string> = {
  "last-owner": "select count(*) >= 1 as ok from memberships where role = 'owner'",
  "lost-update": "select balance = 180 as ok from accounts",
  "stored-counter": "select (select vote_count from posts) = (select count(*) from votes) as ok",
  "usage-limit": "select count(*) <= 1 as ok from redemptions",
};

type Vars = { rowCount?: number | null; count?: unknown; balance?: unknown };

// The application code between queries, as shown on screen: true means it throws (rollback).
const appSteps: Record<string, (v: Vars) => boolean> = {
  "if (owners <= 1) throw new Error('Keep one owner');": (v) => Number(v.count) <= 1,
  "if (removed === 0) throw new Error('Keep one owner');": (v) => v.rowCount === 0,
  "if (used >= 1) throw new Error('Used up'); // max_uses is 1": (v) => Number(v.count) >= 1,
};

type QueryOutcome = { ok: true; result: pg.QueryResult } | { ok: false; error: Error & { code?: string } };

type Session = {
  name: string;
  steps: Step[];
  pc: number;
  vars: Vars;
  client: pg.Client;
  pid: number;
  state: "ready" | "waiting" | "done";
  pending: Promise<QueryOutcome> | null;
};

const UNIQUE_VIOLATION = "23505";
const STATEMENT_LIMIT_MS = 10_000;
const delay = (ms: number) => new Promise<null>((resolve) => setTimeout(() => resolve(null), ms));

async function runVariant(scenario: Scenario, variant: "broken" | "fixed") {
  await admin.query(`drop schema if exists ${schema} cascade; create schema ${schema}; set search_path = ${schema};${tables}${seeds[scenario.id]}`);
  const sessions: Session[] = await Promise.all(
    scenario[variant].transactions.map(async (t) => {
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      const { rows } = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
      await client.query(`set search_path = ${schema}; begin;`);
      return { name: t.name, steps: t.steps, pc: 0, vars: {}, client, pid: rows[0].pid, state: "ready" as const, pending: null };
    }),
  );

  const end = async (s: Session, sql: "commit" | "rollback") => {
    await s.client.query(sql);
    s.state = "done";
    s.pending = null;
    await resumeWaiting();
  };

  const finishStep = async (s: Session, outcome: QueryOutcome) => {
    if (!outcome.ok) {
      // The simulator rolls back on a duplicate key, as a request that fails would. Anything
      // else is a broken scenario: fail loudly.
      if (outcome.error.code !== UNIQUE_VIOLATION) throw new Error(`${s.name}: ${outcome.error.message}`);
      return end(s, "rollback");
    }
    const { result } = outcome;
    s.vars.rowCount = result.rowCount;
    if (result.rows?.[0]?.count !== undefined) s.vars.count = result.rows[0].count;
    if (result.rows?.[0]?.balance !== undefined) s.vars.balance = result.rows[0].balance;
    s.pc++;
    s.state = "ready";
    s.pending = null;
  };

  // Waits until the session's statement finishes, or Postgres says it waits for a lock.
  const settle = async (s: Session) => {
    const pending = s.pending;
    if (!pending) throw new Error(`${s.name}: no statement running`);
    for (const started = Date.now(); ; ) {
      const outcome = await Promise.race([pending, delay(20)]);
      if (outcome) return finishStep(s, outcome);
      const { rows } = await admin.query<{ blocked: boolean }>(
        "select cardinality(pg_blocking_pids($1)) > 0 as blocked",
        [s.pid],
      );
      if (rows[0].blocked) {
        s.state = "waiting";
        return;
      }
      if (Date.now() - started > STATEMENT_LIMIT_MS) throw new Error(`${s.name}: statement neither finished nor waited`);
    }
  };

  const resumeWaiting = async () => {
    for (const s of sessions) if (s.state === "waiting") await settle(s);
  };

  const step = async (s: Session) => {
    const step = s.steps[s.pc];
    if (step.kind === "commit") return end(s, "commit");
    if (step.kind === "app") {
      const rule = appSteps[step.code];
      if (!rule) throw new Error(`No app step for: ${step.code}`);
      if (rule(s.vars)) return end(s, "rollback");
      s.pc++;
      return;
    }
    let sql = step.code;
    const amount = sql.match(/balance \+ (\d+)\n/);
    if (sql.includes(":newBalance") && amount) sql = sql.replace(":newBalance", String(Number(s.vars.balance) + Number(amount[1])));
    s.pending = s.client.query(sql).then(
      (result): QueryOutcome => ({ ok: true, result }),
      (error): QueryOutcome => ({ ok: false, error }),
    );
    await settle(s);
  };

  try {
    for (const index of scenario.dangerousOrder) {
      const s = sessions[index];
      if (s.state === "ready") await step(s);
    }
    for (let guard = 0; sessions.some((s) => s.state !== "done"); guard++) {
      if (guard >= 50) throw new Error(`${scenario.title} / ${variant}: transactions never finished`);
      const s = sessions.find((x) => x.state === "ready");
      if (s) await step(s);
      else await resumeWaiting();
    }
    const { rows } = await admin.query<{ ok: boolean }>(checks[scenario.id]);
    return rows[0].ok;
  } finally {
    await Promise.all(sessions.map((s) => s.client.end()));
  }
}

test("real Postgres agrees with the simulator", { timeout: 120_000 }, async () => {
  let failures = 0;
  await admin.connect();
  try {
    for (const scenario of scenarios) {
      for (const [variant, expected] of [["broken", false], ["fixed", true]] as const) {
        const ok = await runVariant(scenario, variant);
        const match = ok === expected;
        if (!match) failures++;
        console.log(`${match ? "MATCH" : "DIFFERENT"}  ${scenario.title} / ${variant}: Postgres says the invariant ${ok ? "holds" : "breaks"}`);
      }
    }
  } finally {
    await admin.query(`drop schema if exists ${schema} cascade`);
    await admin.end();
  }
  console.log(failures === 0 ? "Real Postgres agrees with the simulator on every scenario." : `${failures} difference(s)!`);
  expect(failures).toBe(0);
});
