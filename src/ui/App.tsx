import { useEffect, useMemo, useRef, useState } from "react";
import { Lab } from "../engine/lab";
import { type Scenario, scenarios, setupFor } from "../scenarios";
import { Outcome } from "./Outcome";
import { TablesView } from "./TablesView";
import { TransactionColumn } from "./TransactionColumn";

type Variant = "broken" | "fixed";

const PLAY_DELAY_MS = 900;

function readHash(): { scenario: Scenario; variant: Variant } {
  const [id, variant] = window.location.hash.replace("#", "").split("/");
  return {
    scenario: scenarios.find((s) => s.id === id) ?? scenarios[0],
    variant: variant === "fixed" ? "fixed" : "broken",
  };
}

export function App() {
  const [{ scenario, variant }, setChoice] = useState(readHash);
  const [run, setRun] = useState(0); // a new number makes a new lab (Reset)
  const [, setTick] = useState(0); // re-render after a step changes the lab
  const [playing, setPlaying] = useState(false);
  const lab = useMemo(
    () => new Lab(setupFor(scenario, variant)),
    // `run` is only here to rebuild the lab on Reset.
    [scenario, variant, run],
  );
  const queue = useRef<number[]>([]);

  useEffect(() => {
    const onHash = () => setChoice(readHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    window.history.replaceState(null, "", `#${scenario.id}/${variant}`);
    setPlaying(false);
    queue.current = [];
  }, [scenario, variant]);

  // Play: one step at a time, in the order that breaks the broken version.
  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => {
      let next = queue.current.shift();
      while (next !== undefined && !lab.canStep(next)) next = queue.current.shift();
      if (next === undefined) next = lab.sessions.findIndex((_, i) => lab.canStep(i));
      if (next === -1 || lab.finished) {
        setPlaying(false);
        return;
      }
      lab.step(next);
      setTick((t) => t + 1);
      if (lab.finished || lab.stuck) setPlaying(false);
    }, PLAY_DELAY_MS);
    return () => window.clearTimeout(timer);
  });

  const choose = (next: Partial<{ scenario: Scenario; variant: Variant }>) =>
    setChoice((current) => ({ ...current, ...next }));

  const reset = () => {
    setPlaying(false);
    queue.current = [];
    setRun((r) => r + 1);
  };

  const play = () => {
    if (lab.finished || lab.log.length > 0) {
      // Start over so the race plays from the beginning.
      queue.current = [...scenario.dangerousOrder];
      setRun((r) => r + 1);
    } else {
      queue.current = [...scenario.dangerousOrder];
    }
    setPlaying(true);
  };

  const stepSession = (index: number) => {
    setPlaying(false);
    lab.step(index);
    setTick((t) => t + 1);
  };

  const outcome = lab.outcome();
  const details = scenario[variant];

  return (
    <div className="page">
      <header className="header">
        <h1>
          pg-race-lab <span className="muted">· watch Postgres race conditions happen</span>
        </h1>
        <p className="lead">
          Two requests hit the same database at the same moment. Step through them, statement by
          statement, and see the bug most code has. Then switch to the fix.
        </p>
      </header>

      <nav className="tabs" aria-label="Scenarios">
        {scenarios.map((s) => (
          <button
            key={s.id}
            type="button"
            className={s.id === scenario.id ? "tab active" : "tab"}
            aria-pressed={s.id === scenario.id}
            onClick={() => choose({ scenario: s })}
          >
            {s.title}
          </button>
        ))}
      </nav>

      <section className="story">
        <p>{scenario.story}</p>
        <p className="invariant">
          <strong>Must always hold:</strong> {scenario.invariant}
        </p>
      </section>

      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Version">
          {(["broken", "fixed"] as const).map((v) => (
            <button
              key={v}
              type="button"
              className={v === variant ? `seg active ${v}` : "seg"}
              aria-pressed={v === variant}
              onClick={() => choose({ variant: v })}
            >
              {v === "broken" ? "Broken" : "Fixed"}: {scenario[v].title}
            </button>
          ))}
        </div>
        <div className="actions">
          <button type="button" className="primary" onClick={play} disabled={playing}>
            {playing ? "Playing..." : "▶ Play the race"}
          </button>
          <button type="button" onClick={reset}>
            Reset
          </button>
        </div>
      </div>

      <p className="explanation">{details.explanation}</p>

      {outcome && <Outcome outcome={outcome} variant={variant} onSwitch={() => choose({ variant: variant === "broken" ? "fixed" : "broken" })} />}
      {lab.stuck && <p className="stuck">Both transactions wait for each other: a deadlock.</p>}

      <div className="columns">
        {lab.sessions.map((session, index) => (
          <TransactionColumn
            key={session.name}
            session={session}
            index={index}
            otherName={lab.sessions[1 - index]?.name ?? ""}
            onStep={() => stepSession(index)}
            disabled={playing}
          />
        ))}
      </div>

      <div className="bottom">
        <TablesView db={lab.db} tables={scenario.tables} sessions={lab.sessions} />
        <section className="panel log" aria-label="What happened">
          <h2>What happened</h2>
          {lab.log.length === 0 ? (
            <p className="muted">Press “Play the race”, or run the steps yourself in any order.</p>
          ) : (
            <ol>
              {lab.log.map((entry, i) => (
                <li key={i} className={`log-${entry.tone}`}>
                  <span className="who">{entry.session}</span> {entry.text}
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      <footer className="footer">
        <p>
          A faithful model of Postgres at its default isolation level (READ COMMITTED): row
          versions, per-statement snapshots, row locks and the re-check after a wait. Every
          scenario is also run against a real Postgres in CI.{" "}
          <a href="https://github.com/qaweem321/pg-race-lab">Source and details on GitHub</a>.
        </p>
      </footer>
    </div>
  );
}
