// 12 Toasts and inline errors. Toasts stack at the bottom centre of the
// stage for transient results; an inline error sits next to the control
// that failed. Error codes are shown small and mono so support can read them.

import type { RegionProps, ToastMessage } from "../regions.ts";
import { AlertIcon, CheckCircleIcon, CloseIcon, InfoIcon } from "./icons.tsx";

export function Toast({ toast, onDismiss }: { toast: ToastMessage; onDismiss?: () => void }) {
  if (toast.tone === "progress") {
    const fraction =
      toast.progress === undefined || toast.progress.total === 0
        ? 0
        : toast.progress.done / toast.progress.total;

    return (
      <div className="mv-toast" data-tone="progress" role="status">
        <div className="mv-toast-row">
          <span className="mv-toast-title">{toast.title}</span>
          {toast.progress === undefined ? null : (
            <span className="mv-toast-count mv-mono">
              {toast.progress.done} of {toast.progress.total}
            </span>
          )}
        </div>
        <div className="mv-toast-bar">
          <i style={{ width: `${Math.round(fraction * 100)}%` }} />
        </div>
      </div>
    );
  }

  const error = toast.tone === "error";

  return (
    <div className="mv-toast" data-tone={toast.tone} role={error ? "alert" : "status"}>
      <span className="mv-toast-icon">{error ? <AlertIcon size={18} /> : <CheckCircleIcon />}</span>
      <div className="mv-toast-text">
        <span className="mv-toast-title">{toast.title}</span>
        {toast.body === undefined ? null : <span className="mv-toast-body">{toast.body}</span>}
        {toast.code === undefined ? null : (
          <span className="mv-toast-code mv-mono">{toast.code}</span>
        )}
      </div>
      {onDismiss === undefined ? null : (
        <button type="button" className="mv-toast-close" aria-label="Dismiss" onClick={onDismiss}>
          <CloseIcon />
        </button>
      )}
    </div>
  );
}

export function Toasts({ ui }: RegionProps & { progress?: ToastMessage }) {
  if (ui.toasts.length === 0) {
    return null;
  }

  return (
    <div className="mv-toasts" part="toasts" aria-live="polite">
      {ui.toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onDismiss={() => ui.dismiss(toast.id)} />
      ))}
    </div>
  );
}

export function InlineError(props: {
  title: string;
  body?: string;
  onRetry?: () => void;
  tone?: "danger" | "notice";
}) {
  const notice = props.tone === "notice";

  return (
    <div
      className="mv-inline"
      data-tone={notice ? "notice" : "danger"}
      role={notice ? "status" : "alert"}
    >
      {notice ? <InfoIcon /> : <AlertIcon size={16} />}
      <div className="mv-inline-text">
        <span className="mv-inline-title">{props.title}</span>
        {props.body === undefined ? null : <span className="mv-inline-body">{props.body}</span>}
      </div>
      {props.onRetry === undefined ? null : (
        <button type="button" className="mv-text-button" onClick={props.onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
