import type { Outcome as Result } from "../engine/lab";

type Props = { outcome: Result; variant: "broken" | "fixed"; onSwitch: () => void };

export function Outcome({ outcome, variant, onSwitch }: Props) {
  return (
    <div className={outcome.ok ? "outcome ok" : "outcome bad"} role="status">
      <strong>{outcome.ok ? "✔ Invariant holds." : "✘ Invariant broken."}</strong> {outcome.message}{" "}
      <button type="button" className="link" onClick={onSwitch}>
        {variant === "broken" ? "See the fix →" : "← See it break"}
      </button>
    </div>
  );
}
