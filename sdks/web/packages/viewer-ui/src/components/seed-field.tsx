// 05 Seed field: pattern seed 0 to 1000. Arrows step by one, the dice picks a
// random seed, and setSeed runs on Enter, blur or a roll.

import { useId, useState } from "react";

import type { RegionProps } from "../regions.ts";
import { seedRange } from "../wear.ts";
import { DiceIcon, StepIcon } from "./icons.tsx";

export function SeedField({ state, actions, controls }: RegionProps) {
  const seed = state.paint?.paintseed ?? 0;
  const [typed, setTyped] = useState<string | undefined>(undefined);
  const labelId = useId();
  const bindable = state.bindable.includes("paintseed");
  const disabled = controls.readOnly || !bindable || state.status !== "ready";
  const value = typed === undefined ? seed : Number(typed);
  const invalid =
    typed !== undefined &&
    (!/^\d+$/.test(typed.trim()) || value < seedRange.min || value > seedRange.max);

  const commit = (next: number) => {
    setTyped(undefined);

    if (next !== seed) {
      actions.setSeed(next);
    }
  };

  const step = (delta: number) => {
    commit(Math.min(seedRange.max, Math.max(seedRange.min, seed + delta)));
  };

  let hint = `${seedRange.min} – ${seedRange.max}`;
  let tone: string | undefined;

  if (invalid) {
    hint = `Seed goes from ${seedRange.min} to ${seedRange.max}`;
    tone = "danger";
  } else if (!bindable && state.status === "ready") {
    hint = "Fixed for this item";
  }

  return (
    <div className="mv-seed" part="seed-input">
      <div className="mv-field-head">
        <span className="mv-label" id={labelId}>
          Pattern seed
        </span>
        <span className="mv-hint" data-tone={tone}>
          {hint}
        </span>
      </div>
      <div className="mv-seed-row">
        <div className="mv-seed-box" data-invalid={invalid} data-disabled={disabled}>
          <input
            aria-labelledby={labelId}
            inputMode="numeric"
            aria-invalid={invalid}
            disabled={disabled}
            value={typed ?? String(seed)}
            onChange={(event) => setTyped(event.target.value)}
            onBlur={() => {
              if (typed !== undefined && !invalid) {
                commit(value);
              }

              setTyped(undefined);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !invalid) {
                commit(value);
              }

              if (event.key === "Escape") {
                setTyped(undefined);
              }

              if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                event.preventDefault();
                step(event.key === "ArrowUp" ? 1 : -1);
              }
            }}
          />
          <div className="mv-stepper">
            <button
              type="button"
              aria-label="Next seed"
              tabIndex={-1}
              disabled={disabled}
              onClick={() => step(1)}
            >
              <StepIcon up />
            </button>
            <button
              type="button"
              aria-label="Previous seed"
              tabIndex={-1}
              disabled={disabled}
              onClick={() => step(-1)}
            >
              <StepIcon up={false} />
            </button>
          </div>
        </div>
        <button
          type="button"
          className="mv-square-button"
          aria-label="Random seed"
          data-control="dice"
          disabled={disabled}
          onClick={() => commit(Math.floor(Math.random() * (seedRange.max + 1)))}
        >
          <DiceIcon />
        </button>
      </div>
    </div>
  );
}
