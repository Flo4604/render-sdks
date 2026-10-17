// The sticker editor's compact slider: unipolar values fill from the
// minimum, bipolar values from the centre.

import { type CSSProperties, type KeyboardEvent, useRef, useState } from "react";

export function MiniSlider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  bipolar?: boolean;
  format: (value: number) => string;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const span = props.max - props.min;
  const position = (props.value - props.min) / span;
  const origin = props.bipolar === true ? 0.5 : 0;
  const clamp = (value: number) => Math.min(props.max, Math.max(props.min, value));
  const fromX = (x: number) => {
    const rect = track.current?.getBoundingClientRect();

    if (rect === undefined || rect.width === 0) {
      return props.value;
    }

    const raw = props.min + ((x - rect.left) / rect.width) * span;

    return clamp(Math.round(raw / props.step) * props.step);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const multiplier = event.shiftKey ? 10 : 1;
    const moves: Record<string, number> = {
      ArrowRight: props.step * multiplier,
      ArrowUp: props.step * multiplier,
      ArrowLeft: -props.step * multiplier,
      ArrowDown: -props.step * multiplier,
    };
    const move = moves[event.key];

    if (move === undefined) {
      return;
    }

    event.preventDefault();
    props.onChange(clamp(props.value + move));
  };

  return (
    <div className="mv-mini-row">
      <span className="mv-mini-label">{props.label}</span>
      <div
        ref={track}
        className="mv-mini-track"
        role="slider"
        tabIndex={props.disabled === true ? -1 : 0}
        aria-label={props.label}
        aria-valuemin={props.min}
        aria-valuemax={props.max}
        aria-valuenow={props.value}
        aria-valuetext={props.format(props.value)}
        aria-disabled={props.disabled}
        data-dragging={dragging}
        style={
          {
            "--mv-mini-from": Math.min(origin, position),
            "--mv-mini-to": Math.max(origin, position),
            "--mv-mini-at": position,
          } as CSSProperties
        }
        onKeyDown={props.disabled === true ? undefined : onKeyDown}
        onPointerDown={(event) => {
          if (props.disabled === true) {
            return;
          }

          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(true);
          props.onChange(fromX(event.clientX));
        }}
        onPointerMove={(event) => {
          if (dragging) {
            props.onChange(fromX(event.clientX));
          }
        }}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
      >
        <i className="mv-mini-rail" />
        <i className="mv-mini-fill" />
        <i className="mv-mini-thumb" />
      </div>
      <output className="mv-mini-value mv-mono">{props.format(props.value)}</output>
    </div>
  );
}
