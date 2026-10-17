// 15 Embed extras: the attribution badge, the disclaimer line and the
// shortcut strip. The badge and disclaimer are off by default.

import type { RegionProps } from "../regions.ts";
import { CubeIcon } from "./icons.tsx";

export function Badge(_: RegionProps) {
  return (
    <a
      className="mv-badge"
      part="badge"
      href="https://medalbot.cc"
      target="_blank"
      rel="noreferrer"
    >
      <CubeIcon size={14} />
      <span>Rendered by</span>
      <strong>Medalbot</strong>
    </a>
  );
}

export function Disclaimer({ display }: RegionProps) {
  return (
    <span className="mv-disclaimer" part="disclaimer">
      {display.disclaimer ??
        "Rendered from CS2 game files. May differ from the latest game update."}
    </span>
  );
}

export function Shortcuts({ state }: RegionProps) {
  // With a camera, 0 is 3D and 1 to n the presets; without one, 1 to n.
  const first = state.capabilities.camera ? 0 : 1;
  const items: Array<[string, string]> = [
    ...(state.capabilities.camera ? ([["R", "Reset"]] as Array<[string, string]>) : []),
    [`${first}–${state.views.length}`, "Views"],
    ["F", "Fullscreen"],
    ["H", "Hide UI"],
  ];

  return (
    <div className="mv-shortcuts" part="shortcuts" aria-hidden="true">
      {items.map(([key, label]) => (
        <span key={label} className="mv-shortcut">
          <kbd>{key}</kbd>
          {label}
        </span>
      ))}
    </div>
  );
}
