// 03 Preset segmented control and 06 control bar: camera mode, reset,
// download and fullscreen. Labels live in tooltips and aria-labels.

import { type KeyboardEvent, useRef } from "react";

import type { RegionProps } from "../regions.ts";
import { IconDownload } from "./download.tsx";
import { IconButton } from "./icon-button.tsx";
import { FullscreenIcon, ResetIcon } from "./icons.tsx";
import { RegionHost } from "./region.tsx";

const presetLabels: Record<string, string> = {
  preview: "Preview",
  front: "Front",
  back: "Back",
};

export function presetLabel(view: string): string {
  return presetLabels[view] ?? view.charAt(0).toUpperCase() + view.slice(1);
}

export function PresetControl({ state, actions }: RegionProps) {
  const group = useRef<HTMLDivElement>(null);
  const segments = state.capabilities.camera ? ["3d", ...state.views] : state.views;
  const selected = segments.includes(state.mode) ? state.mode : segments[0];

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;

    if (step === 0 || selected === undefined) {
      return;
    }

    event.preventDefault();
    const index = (segments.indexOf(selected) + step + segments.length) % segments.length;
    const next = segments[index] as string;
    actions.setMode(next);
    group.current?.querySelectorAll<HTMLButtonElement>("button")[index]?.focus();
  };

  return (
    <div
      ref={group}
      className="mv-segments"
      part="presets"
      role="radiogroup"
      aria-label="Camera"
      onKeyDown={onKeyDown}
    >
      {segments.map((segment) => {
        const checked = segment === selected;

        return (
          <button
            key={segment}
            type="button"
            role="radio"
            className="mv-segment"
            data-control="view"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            disabled={state.status !== "ready"}
            onClick={() => actions.setMode(segment)}
          >
            {segment === "3d" ? "3D" : presetLabel(segment)}
          </button>
        );
      })}
    </div>
  );
}

export function FullscreenButton({ ui }: RegionProps) {
  return (
    <IconButton
      label={ui.fullscreen ? "Exit fullscreen" : "Fullscreen"}
      shortcut="F"
      part="fullscreen"
      control="fullscreen"
      onClick={ui.toggleFullscreen}
    >
      <FullscreenIcon exit={ui.fullscreen} />
    </IconButton>
  );
}

export function ControlBar(props: RegionProps) {
  const { state, actions, controls } = props;
  const visible = controls.visible;
  const showReset = state.capabilities.camera;

  return (
    <div className="mv-control-bar" part="control-bar">
      {visible.presets ? <RegionHost name="presets" stock={PresetControl} {...props} /> : null}
      {visible.presets && (showReset || visible.download || visible.fullscreen) ? (
        <i className="mv-bar-rule" />
      ) : null}
      {showReset ? (
        <IconButton
          label="Reset to front"
          shortcut="R"
          control="reset"
          disabled={state.status !== "ready"}
          onClick={actions.resetCamera}
        >
          <ResetIcon />
        </IconButton>
      ) : null}
      {visible.download ? <RegionHost name="download" stock={IconDownload} {...props} /> : null}
      {visible.fullscreen ? (
        <RegionHost name="fullscreen" stock={FullscreenButton} {...props} />
      ) : null}
    </div>
  );
}
