// Renders one named region: the host's override when it gave one, otherwise
// the stock component. Inside the custom element the stock component sits in
// a named slot, so light-DOM children with that slot name replace it, and the
// region carries the `part` name for ::part() styling.

import { createContext, useContext } from "react";

import type { ComponentOverrides, Region, RegionComponent, RegionProps } from "../regions.ts";

export interface RegionContextValue {
  overrides: ComponentOverrides;
  // True inside <medalbot-viewer>, which renders into a shadow root.
  slots: boolean;
}

export const RegionContext = createContext<RegionContextValue>({ overrides: {}, slots: false });

export function RegionHost(props: { name: Region; stock: RegionComponent } & RegionProps) {
  const { overrides, slots } = useContext(RegionContext);
  const { name, stock, ...regionProps } = props;
  const Component = overrides[name] ?? stock;
  const content = <Component {...regionProps} />;

  if (!slots || overrides[name] !== undefined) {
    return content;
  }

  return <slot name={name}>{content}</slot>;
}
