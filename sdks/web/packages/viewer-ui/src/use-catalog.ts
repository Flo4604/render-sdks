// Loads a catalog once per source for the pickers.

import { useEffect, useState } from "react";

import type { Catalog, CatalogSource } from "./catalog.ts";

export type CatalogState =
  | { status: "idle" | "loading"; catalog: undefined; error: undefined }
  | { status: "ready"; catalog: Catalog; error: undefined }
  | { status: "error"; catalog: undefined; error: Error };

export function useCatalog(source: CatalogSource | undefined): CatalogState {
  const [state, setState] = useState<CatalogState>({
    status: "idle",
    catalog: undefined,
    error: undefined,
  });

  useEffect(() => {
    if (source === undefined) {
      return;
    }

    const abort = new AbortController();
    setState({ status: "loading", catalog: undefined, error: undefined });
    source.load(abort.signal).then(
      (catalog) => {
        setState({ status: "ready", catalog, error: undefined });
      },
      (cause: unknown) => {
        if (abort.signal.aborted) {
          return;
        }

        setState({ status: "error", catalog: undefined, error: cause as Error });
      },
    );

    return () => abort.abort();
  }, [source]);

  return state;
}
