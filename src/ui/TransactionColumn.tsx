import type { Session } from "../engine/lab";

type Props = {
  session: Session;
  index: number;
  waitingForName: string;
  onStep: () => void;
  disabled: boolean;
};

const STATE_LABEL: Record<Session["state"], string> = {
  ready: "running",
  waiting: "waiting",
  committed: "committed",
  "rolled back": "rolled back",
};

export function TransactionColumn({ session, index, waitingForName, onStep, disabled }: Props) {
  const done = session.state === "committed" || session.state === "rolled back";
  return (
    <section className={`panel tx tx-${index}`} aria-label={`Transaction ${session.name}`}>
      <div className="tx-head">
        <h2>
          <span className="dot" aria-hidden="true" /> {session.name}
        </h2>
        <span className={`badge state-${session.state.replace(" ", "-")}`}>
          {session.state === "waiting" ? `waiting for ${waitingForName}` : STATE_LABEL[session.state]}
        </span>
      </div>
      <ol className="steps">
        <li className="step done meta">BEGIN;</li>
        {session.steps.map((step, i) => {
          const status =
            i < session.pc ? "done" : i === session.pc && !done ? (session.state === "waiting" ? "waiting" : "current") : "later";
          const code = step.kind === "commit" ? "COMMIT;" : step.code;
          return (
            <li key={i} className={`step ${status} ${step.kind}`} aria-current={status === "current" ? "step" : undefined}>
              {step.kind === "app" && <span className="kind">app code</span>}
              <pre>{code}</pre>
            </li>
          );
        })}
      </ol>
      {session.note && <p className={`note note-${session.state.replace(" ", "-")}`}>{session.note}</p>}
      <button type="button" className="step-button" onClick={onStep} disabled={disabled || session.state !== "ready"}>
        {done ? "Finished" : session.state === "waiting" ? "Waiting..." : `Run next ${session.name} step`}
      </button>
    </section>
  );
}
