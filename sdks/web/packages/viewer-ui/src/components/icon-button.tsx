// A square icon button with its label in a tooltip and an aria-label.

import type { ReactNode } from "react";

export function IconButton(props: {
  label: string;
  shortcut?: string;
  onClick: () => void;
  children: ReactNode;
  part?: string;
  control?: string;
  pressed?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="mv-icon-button"
      aria-label={props.label}
      data-control={props.control}
      part={props.part}
      aria-pressed={props.pressed}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
      <span className="mv-tooltip" role="presentation">
        {props.label}
        {props.shortcut === undefined ? null : <kbd>{props.shortcut}</kbd>}
      </span>
    </button>
  );
}
