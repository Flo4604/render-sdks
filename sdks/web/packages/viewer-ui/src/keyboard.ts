// Keyboard shortcuts inside a viewer. They fire only when focus is inside the
// viewer and not in a text field, so typing a seed never moves the camera.

export type ShortcutAction =
  | { kind: "view"; index: number }
  | { kind: "next-view"; step: 1 | -1 }
  | { kind: "orbit"; yaw: number; pitch: number }
  | { kind: "zoom"; factor: number }
  | { kind: "reset" }
  | { kind: "fullscreen" }
  | { kind: "hide-ui" }
  | { kind: "wear"; step: number };

export interface ShortcutContext {
  // Whether the stage itself has focus (arrow keys orbit only there).
  onStage: boolean;
  camera: boolean;
}

// Degrees per arrow press.
const orbitStep = 5;

export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable) {
    return true;
  }

  if (target instanceof HTMLTextAreaElement) {
    return true;
  }

  return (
    target instanceof HTMLInputElement && !["range", "checkbox", "button"].includes(target.type)
  );
}

export function shortcutFor(
  event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">,
  context: ShortcutContext,
): ShortcutAction | undefined {
  if (event.altKey || event.ctrlKey || event.metaKey) {
    return undefined;
  }

  // With a camera, 0 is 3D and 1 to 9 the presets; without one, 1 is the first preset.
  const digit = /^[0-9]$/.test(event.key) ? Number(event.key) : undefined;

  if (digit !== undefined) {
    if (!context.camera && digit === 0) {
      return undefined;
    }

    return { kind: "view", index: context.camera ? digit : digit - 1 };
  }

  switch (event.key) {
    case "f":
    case "F":
      return { kind: "fullscreen" };
    case "r":
    case "R":
      return { kind: "reset" };
    case "h":
    case "H":
      return { kind: "hide-ui" };
    case "[":
      return { kind: "wear", step: event.shiftKey ? -0.1 : -0.01 };
    case "]":
      return { kind: "wear", step: event.shiftKey ? 0.1 : 0.01 };
    case "+":
    case "=":
      return context.camera ? { kind: "zoom", factor: 1.1 } : undefined;
    case "-":
      return context.camera ? { kind: "zoom", factor: 1 / 1.1 } : undefined;
    default:
      break;
  }

  if (!context.onStage) {
    return undefined;
  }

  const horizontal = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
  const vertical = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;

  if (horizontal === 0 && vertical === 0) {
    return undefined;
  }

  if (!context.camera) {
    return horizontal === 0 ? undefined : { kind: "next-view", step: horizontal as 1 | -1 };
  }

  return { kind: "orbit", yaw: horizontal * orbitStep, pitch: vertical * orbitStep };
}
