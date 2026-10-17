// 01 Viewer surface: the stage's states over the engine canvas. The stage
// itself (canvas, poster, focus and gestures) lives in MedalbotViewer because
// it owns the canvas the engine draws into.

import type { CSSProperties } from "react";

import type { RegionProps } from "../regions.ts";
import { AlertIcon, CubeIcon, InfoIcon, RetryIcon } from "./icons.tsx";

const phaseTitles = {
  closure: "Downloading item",
  files: "Downloading textures",
  pipelines: "Preparing shaders",
} as const;

export function phaseText(state: RegionProps["state"]): { title: string; detail: string } {
  const progress = state.progress;

  if (progress === undefined) {
    return {
      title: state.status === "checking" ? "Checking WebGPU" : "Downloading item",
      detail: "",
    };
  }

  const detail = progress.phase === "closure" ? "" : `${progress.done} of ${progress.total}`;

  return { title: phaseTitles[progress.phase], detail };
}

export function LoadingState({ state }: RegionProps) {
  const fraction = state.progress?.fraction ?? 0;
  const { title, detail } = phaseText(state);

  return (
    <div className="mv-loading" part="loading">
      <div
        className="mv-progress"
        role="progressbar"
        aria-label={title}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(fraction * 100)}
        style={{ "--mv-progress": fraction } as CSSProperties}
      >
        <div className="mv-progress-bar" />
      </div>
      <div className="mv-phase" aria-live="polite">
        <span className="mv-phase-title">{title}</span>
        {detail === "" ? null : <span className="mv-phase-detail mv-mono">{detail}</span>}
      </div>
    </div>
  );
}

export function IdleState({ actions }: RegionProps) {
  return (
    <button type="button" className="mv-view-3d" part="loading" onClick={actions.start}>
      <CubeIcon />
      <span>View in 3D</span>
    </button>
  );
}

const errorText: Record<string, { title: string; body: string }> = {
  load_failed: {
    title: "Couldn’t load this item",
    body: "The item files didn’t finish downloading. Check your connection and try again.",
  },
  device_lost: {
    title: "The GPU stopped responding",
    body: "The browser reset the graphics device. Load the item again to continue.",
  },
  invalid_item_data: {
    title: "This item can’t be shown",
    body: "The item data is outside what the game allows.",
  },
};

export function ErrorState({ state, actions }: RegionProps) {
  const code = state.error?.code ?? "load_failed";
  const text = errorText[code] ?? {
    title: "Couldn’t show this item",
    body: state.error?.message ?? "Something went wrong while rendering.",
  };

  return (
    <div className="mv-error" part="error" role="alert">
      <div className="mv-error-icon">
        <AlertIcon />
      </div>
      <div className="mv-error-text">
        <span className="mv-error-title">{text.title}</span>
        <span className="mv-error-body">{text.body}</span>
        <span className="mv-error-code mv-mono">{code}</span>
      </div>
      <button type="button" className="mv-button" onClick={actions.retry}>
        <RetryIcon />
        Try again
      </button>
    </div>
  );
}

export function UnsupportedState({ state, display }: RegionProps) {
  const missing = state.missing.length === 0 ? "" : ` Missing: ${state.missing.join(", ")}.`;

  return (
    <div className="mv-notice" part="unsupported" role="status">
      <InfoIcon />
      <div className="mv-notice-text">
        <span className="mv-notice-title">3D view needs WebGPU</span>
        <span className="mv-notice-body">
          Use Chrome or Edge 113+ on desktop with hardware acceleration on.{missing}
        </span>
      </div>
      {display.poster === undefined ? null : (
        <a href={display.poster} target="_blank" rel="noreferrer">
          Open image
        </a>
      )}
    </div>
  );
}
