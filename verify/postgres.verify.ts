// Runs every scenario on a real Postgres with two connections, in the same order the app shows,
// and checks that real Postgres gives the same result as the simulator (broken fails, fixed holds).
// The SQL is the exact text shown on screen. Uses a throwaway schema, dropped at the end.
//
//   DATABASE_URL=postgres://... npm run verify:postgres
import pg from "pg";
import { expect, test } from "vitest";
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
  create table coupons (code text primary key, max_uses int);
  create table redemptions (id text primary key, coupon text);`;

const seeds = {
  "last-owner": "insert into memberships values ('ana','ana','owner'), ('ben','ben','owner');",
  "lost-update": "insert into accounts values ('acme', 100);",
  "stored-counter": "insert into posts values ('p1', 0);",
  "usage-limit": "insert into coupons values ('LAUNCH', 1);",
};

const checks = {
  "last-owner": "select count(*) >= 1 as ok from memberships where role = 'owner'",
  "lost-update": "select balance = 180 as ok from accounts",
  "stored-counter": "select (select vote_count from posts) = (select count(*) from votes) as ok",
  "usage-limit": "select count(*) <= 1 as ok from redemptions",
};

// The application code between queries, as shown on screen.
const appSteps = {
  "if (owners <= 1) throw new Error('Keep one owner');": (v) => Number(v.count) <= 1,
  "if (removed === 0) throw new Error('Keep one owner');": (v) => v.rowCount === 0,
  "if (used >= coupon.max_uses) throw new Error('Used up');": (v) => Number(v.count) >= 1,
};

const WAIT_MS = 600;
const settle = (promise, ms) =>
  Promise.race([promise.then((r) => ({ done: true, r })), new Promise((ok) => setTimeout(() => ok({ done: false }), ms))]);

async function runVariant(scenario: Scenario, variant: "broken" | "fixed") {
  await admin.query(`drop schema if exists ${schema} cascade; create schema ${schema}; set search_path = ${schema};${tables}${seeds[scenario.id]}`);
  const sessions = await Promise.all(
    scenario[variant].transactions.map(async (t) => {
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      await client.query(`set search_path = ${schema}; begin;`);
      return { name: t.name, steps: t.steps, pc: 0, vars: {}, client, state: "ready", pending: null };
    }),
  );

  const finishStep = (s, result) => {
    s.vars.rowCount = result.rowCount;
    if (result.rows?.[0]?.count !== undefined) s.vars.count = result.rows[0].count;
    if (result.rows?.[0]?.balance !== undefined) s.vars.balance = result.rows[0].balance;
    s.pc++;
    s.state = s.pc >= s.steps.length ? "done" : "ready";
    s.pending = null;
  };

  const resumeWaiting = async () => {
    for (const s of sessions) {
      if (s.state !== "waiting") continue;
      const outcome = await settle(s.pending, 3000);
      if (outcome.done) finishStep(s, outcome.r);
    }
  };

  const step = async (s) => {
    const step = s.steps[s.pc];
    if (step.kind === "commit") {
      await s.client.query("commit");
      s.pc++;
      s.state = "done";
      await resumeWaiting();
      return;
    }
    if (step.kind === "app") {
      if (appSteps[step.code](s.vars)) {
        await s.client.query("rollback");
        s.state = "done";
        await resumeWaiting();
      } else s.pc++;
      return;
    }
    let sql = step.code;
    const amount = sql.match(/balance \+ (\d+)\n/);
    if (sql.includes(":newBalance")) sql = sql.replace(":newBalance", String(Number(s.vars.balance) + Number(amount[1])));
    s.pending = s.client.query(sql);
    const outcome = await settle(s.pending, WAIT_MS);
    if (outcome.done) finishStep(s, outcome.r);
    else s.state = "waiting";
  };

  for (const index of scenario.dangerousOrder) {
    const s = sessions[index];
    if (s.state === "ready") await step(s);
  }
  for (let guard = 0; sessions.some((s) => s.state !== "done") && guard < 50; guard++) {
    const s = sessions.find((x) => x.state === "ready");
    if (s) await step(s);
    else await resumeWaiting();
  }
  const { rows } = await admin.query(checks[scenario.id]);
  await Promise.all(sessions.map((s) => s.client.end()));
  return rows[0].ok;
}

test("real Postgres agrees with the simulator", { timeout: 120_000 }, async () => {
let failures = 0;
await admin.connect();
try {
  for (const scenario of scenarios) {
    for (const [variant, expected] of [["broken", false], ["fixed", true]]) {
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
