// 11 Download: renders the current pose at the compiled size or an exact
// downscale of it, never larger. The panel layout uses the split button; the
// control bar uses an icon that opens the same size menu.

import { useEffect, useId, useRef, useState } from "react";

import { exportSizes } from "../download.ts";
import type { RegionProps } from "../regions.ts";
import { IconButton } from "./icon-button.tsx";
import { CheckIcon, ChevronIcon, DownloadIcon } from "./icons.tsx";

const fractions: Record<number, string> = { 1: "Native", 0.5: "½", 0.25: "¼" };

type Phase = { kind: "idle" } | { kind: "rendering" } | { kind: "saved"; filename: string };

function sizeText(size: { width: number; height: number } | undefined, scale: number): string {
  if (size === undefined) {
    return scale === 1 ? "Full size" : `${fractions[scale] ?? scale} size`;
  }

  return `${Math.round(size.width * scale)} × ${Math.round(size.height * scale)}`;
}

function fileName(props: RegionProps): string {
  const finish = (props.display.finish ?? props.display.weapon ?? "item")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const seed = props.state.paint?.paintseed;

  return `${finish}${seed === undefined ? "" : `-${seed}`}.png`;
}

export function DownloadMenu(props: RegionProps & { variant: "icon" | "split" }) {
  const { state, actions, ui } = props;
  const [open, setOpen] = useState(false);
  const [scale, setScale] = useState(1);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const root = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const ready = state.status === "ready";
  const size = state.exportSize;

  useEffect(() => {
    if (!open) {
      return;
    }

    if (size === undefined && ready) {
      void actions.measure();
    }

    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.composedPath()[0] as Node)) {
        setOpen(false);
      }
    };

    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);

    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open, size, ready, actions]);

  const save = async (chosen: number) => {
    setOpen(false);
    setScale(chosen);
    setPhase({ kind: "rendering" });

    try {
      const filename = fileName(props);
      const blob = await actions.download(chosen, filename);

      if (blob === undefined) {
        setPhase({ kind: "idle" });

        return;
      }

      setPhase({ kind: "saved", filename });
      ui.notify({
        tone: "success",
        title: `Image saved · ${sizeText(state.exportSize ?? size, chosen)}`,
      });
      setTimeout(() => setPhase({ kind: "idle" }), 3000);
    } catch (cause) {
      setPhase({ kind: "idle" });
      ui.notify({
        tone: "error",
        title: "Couldn’t save the image",
        body: String((cause as Error).message ?? cause),
      });
    }
  };

  const copy = async () => {
    setOpen(false);

    try {
      const blob = await actions.renderPng(scale);

      if (blob === undefined) {
        return;
      }

      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      ui.notify({ tone: "success", title: "Image copied" });
    } catch (cause) {
      ui.notify({
        tone: "error",
        title: "Couldn’t copy the image",
        body: String((cause as Error).message ?? cause),
      });
    }
  };

  const menu = open ? (
    <div className="mv-menu" id={menuId} role="menu" data-variant={props.variant}>
      <span className="mv-menu-label">PNG, transparent</span>
      {exportSizes.map((option) => (
        <button
          key={option.scale}
          type="button"
          role="menuitemradio"
          aria-checked={option.scale === scale}
          className="mv-menu-item"
          onClick={() => void save(option.scale)}
        >
          <span className="mv-mono">{sizeText(size, option.scale)}</span>
          <span className="mv-menu-aside">
            <span data-native={option.scale === 1}>{fractions[option.scale]}</span>
            {option.scale === scale ? <CheckIcon /> : null}
          </span>
        </button>
      ))}
      <hr />
      <button type="button" role="menuitem" className="mv-menu-item" onClick={() => void copy()}>
        Copy image
      </button>
      <span className="mv-menu-note">Never upscaled: the largest size is the compiled view.</span>
    </div>
  ) : null;

  if (props.variant === "icon") {
    return (
      <div className="mv-menu-anchor" ref={root} part="download">
        <IconButton
          label="Download PNG"
          control="download"
          disabled={!ready || phase.kind === "rendering"}
          onClick={() => setOpen(!open)}
        >
          <DownloadIcon />
        </IconButton>
        {menu}
      </div>
    );
  }

  const label =
    phase.kind === "rendering" ? "Rendering…" : phase.kind === "saved" ? "Saved" : "Download PNG";
  const aside =
    phase.kind === "saved"
      ? phase.filename
      : phase.kind === "rendering"
        ? ""
        : sizeText(size, scale);

  return (
    <div className="mv-menu-anchor" ref={root} part="download">
      <div className="mv-split" data-phase={phase.kind}>
        <button
          type="button"
          className="mv-split-main"
          data-control="download"
          disabled={!ready || phase.kind === "rendering"}
          onClick={() => void save(scale)}
        >
          <DownloadIcon size={16} width={1.6} />
          <span className="mv-split-label">{label}</span>
          <span className="mv-split-aside mv-mono">{aside}</span>
        </button>
        <button
          type="button"
          className="mv-split-toggle"
          aria-label="Choose size"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          disabled={!ready || phase.kind === "rendering"}
          onClick={() => setOpen(!open)}
        >
          <ChevronIcon />
        </button>
      </div>
      {menu}
    </div>
  );
}

export function SplitDownload(props: RegionProps) {
  return <DownloadMenu {...props} variant="split" />;
}

export function IconDownload(props: RegionProps) {
  return <DownloadMenu {...props} variant="icon" />;
}
