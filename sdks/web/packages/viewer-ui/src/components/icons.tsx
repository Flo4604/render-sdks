// The design's icons, drawn with currentColor so states recolour them.

interface IconProps {
  size?: number;
}

function stroke(width: number) {
  return {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: width,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
}

export function CubeIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1.75 13.5 4.9v6.2L8 14.25 2.5 11.1V4.9L8 1.75Z" {...stroke(1.5)} />
      <path d="M2.5 4.9 8 8l5.5-3.1M8 8v6.25" {...stroke(1.5)} />
    </svg>
  );
}

export function AlertIcon({ size = 20 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="7.25" {...stroke(1.6)} />
      <path d="M10 6v4.5M10 13.5v.01" {...stroke(1.6)} />
    </svg>
  );
}

export function InfoIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" {...stroke(1.5)} />
      <path d="M8 7.25v3.5M8 5.25v.01" {...stroke(1.5)} />
    </svg>
  );
}

export function CheckCircleIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="9" cy="9" r="6.75" {...stroke(1.7)} />
      <path d="M6.25 9.25 8 11l3.75-4" {...stroke(1.7)} />
    </svg>
  );
}

export function RetryIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M13.25 8a5.25 5.25 0 1 1-1.54-3.71M13.25 2.5v3.25H10" {...stroke(1.5)} />
    </svg>
  );
}

export function ResetIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden="true">
      <path d="M3.5 9a5.5 5.5 0 1 0 1.6-3.9" {...stroke(1.5)} />
      <path d="M3.25 2.75v3h3" {...stroke(1.5)} />
    </svg>
  );
}

export function DownloadIcon({ size = 18, width = 1.5 }: IconProps & { width?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden="true">
      <path d="M9 2.75v8.5M5.5 8 9 11.5 12.5 8M3.25 14.75h11.5" {...stroke(width)} />
    </svg>
  );
}

export function FullscreenIcon({ size = 18, exit = false }: IconProps & { exit?: boolean }) {
  const path = exit
    ? "M6.5 2.75V6.5H2.75M15.25 6.5H11.5V2.75M11.5 15.25V11.5h3.75M2.75 11.5H6.5v3.75"
    : "M2.75 6.5V2.75H6.5M11.5 2.75h3.75V6.5M15.25 11.5v3.75H11.5M6.5 15.25H2.75V11.5";

  return (
    <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden="true">
      <path d={path} {...stroke(1.5)} />
    </svg>
  );
}

export function SearchIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="7" cy="7" r="4.75" {...stroke(1.6)} />
      <path d="m10.5 10.5 3 3" {...stroke(1.6)} />
    </svg>
  );
}

export function PlusIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3.5v9M3.5 8h9" {...stroke(1.6)} />
    </svg>
  );
}

export function ChevronIcon({ size = 14, up = false }: IconProps & { up?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path d={up ? "M4.5 9.5 8 6l3.5 3.5" : "M4.5 6.5 8 10l3.5-3.5"} {...stroke(1.6)} />
    </svg>
  );
}

export function StepIcon({ up }: { up: boolean }) {
  return (
    <svg width="16" height="11" viewBox="0 0 16 11" aria-hidden="true">
      <path d={up ? "M5 7l3-3 3 3" : "M5 4l3 3 3-3"} {...stroke(1.5)} />
    </svg>
  );
}

export function CheckIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.5 8.5 6.5 11.5 12.5 4.5" {...stroke(1.8)} />
    </svg>
  );
}

export function CloseIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" {...stroke(1.6)} />
    </svg>
  );
}

export function DiceIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden="true">
      <rect x="2.75" y="2.75" width="12.5" height="12.5" rx="3" {...stroke(1.5)} />
      <circle cx="6.5" cy="6.5" r="1.1" fill="currentColor" />
      <circle cx="11.5" cy="11.5" r="1.1" fill="currentColor" />
      <circle cx="9" cy="9" r="1.1" fill="currentColor" />
      <circle cx="11.5" cy="6.5" r="1.1" fill="currentColor" />
      <circle cx="6.5" cy="11.5" r="1.1" fill="currentColor" />
    </svg>
  );
}

export function OrbitIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <ellipse cx="8" cy="8" rx="6.25" ry="2.75" {...stroke(1.4)} />
      <circle cx="8" cy="8" r="1.25" fill="currentColor" />
    </svg>
  );
}
