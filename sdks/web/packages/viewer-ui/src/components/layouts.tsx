// The containers that place the controls: the floating glass panels of
// layout B (the default), the side panel of layout A and the phone's bottom
// sheet. Each region inside goes through RegionHost, so overrides, slots and
// parts apply in every layout.

import { type ReactNode, useState } from "react";

import type { RegionProps } from "../regions.ts";
import {
  CharmRow,
  FloatingStickerEditor,
  InlineStatTrak,
  RigSwitch,
  StatTrakToggle,
  StickerEditor,
} from "./attachments.tsx";
import { SplitDownload } from "./download.tsx";
import { RegionHost } from "./region.tsx";
import { SeedField } from "./seed-field.tsx";
import { WearSlider } from "./wear-slider.tsx";

function showStickers(props: RegionProps): boolean {
  return props.controls.visible.stickers && props.state.capabilities.attachments;
}

function showCharm(props: RegionProps): boolean {
  return props.controls.visible.charm && props.state.capabilities.attachments;
}

function showStatTrak(props: RegionProps): boolean {
  return props.controls.visible.stattrak && props.state.capabilities.attachments;
}

function showLighting(props: RegionProps): boolean {
  return props.controls.visible.lighting && props.state.capabilities.lighting;
}

// Layout B: StatTrak and paint bottom left, stickers and charm bottom right.
export function FloatingPanels(props: RegionProps) {
  const [tab, setTab] = useState<"stickers" | "charm">("stickers");
  const { controls } = props;
  const paint = controls.visible.seed || controls.visible.wear || showLighting(props);
  const stickers = showStickers(props);
  const charm = showCharm(props);
  const activeTab = !stickers ? "charm" : !charm ? "stickers" : tab;

  return (
    <>
      {showStatTrak(props) || paint ? (
        <div className="mv-float-stack" data-corner="bottom-left" part="panel">
          {showStatTrak(props) ? (
            <div className="mv-glass" data-row="true">
              <RegionHost name="stattrak" stock={InlineStatTrak} {...props} />
            </div>
          ) : null}
          {paint ? (
            <div className="mv-glass">
              {controls.visible.seed ? (
                <RegionHost name="seed-input" stock={SeedField} {...props} />
              ) : null}
              {controls.visible.wear ? (
                <RegionHost name="wear-slider" stock={WearSlider} {...props} />
              ) : null}
              {showLighting(props) ? (
                <RegionHost name="lighting" stock={RigSwitch} {...props} />
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {stickers || charm ? (
        <div className="mv-float-stack" data-corner="bottom-right" part="panel">
          <div className="mv-glass">
            {stickers && charm ? (
              <div className="mv-segments" data-size="tabs" role="tablist" aria-label="Attachments">
                <button
                  type="button"
                  role="tab"
                  className="mv-segment"
                  aria-selected={activeTab === "stickers"}
                  aria-checked={activeTab === "stickers"}
                  onClick={() => setTab("stickers")}
                >
                  Stickers
                  {props.state.stickers.length > 0 ? ` · ${props.state.stickers.length}` : ""}
                </button>
                <button
                  type="button"
                  role="tab"
                  className="mv-segment"
                  aria-selected={activeTab === "charm"}
                  aria-checked={activeTab === "charm"}
                  onClick={() => setTab("charm")}
                >
                  Charm
                </button>
              </div>
            ) : null}
            {activeTab === "stickers" ? (
              <RegionHost name="stickers" stock={FloatingStickerEditor} {...props} />
            ) : (
              <RegionHost name="charm" stock={CharmRow} {...props} />
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}

function Section(props: { title?: string; aside?: string; children: ReactNode; grow?: boolean }) {
  return (
    <section className="mv-section" data-grow={props.grow === true}>
      {props.title === undefined ? null : (
        <div className="mv-field-head">
          <span className="mv-label">{props.title}</span>
          {props.aside === undefined ? null : <span className="mv-hint">{props.aside}</span>}
        </div>
      )}
      {props.children}
    </section>
  );
}

// Layout A: the Customise panel beside an inset stage.
export function SidePanel(props: RegionProps) {
  const { controls, actions, state, display } = props;
  const slots = display.stickerSlots ?? 5;

  return (
    <aside className="mv-panel" part="panel" aria-label="Customise">
      <div className="mv-panel-head">
        <span className="mv-panel-title">Customise</span>
        {controls.readOnly ? null : (
          <button
            type="button"
            className="mv-text-button"
            data-tone="muted"
            onClick={actions.resetToInspected}
          >
            Reset to inspected
          </button>
        )}
      </div>
      {controls.visible.wear || controls.visible.seed ? (
        <section className="mv-section" data-gap="28">
          {controls.visible.wear ? (
            <RegionHost name="wear-slider" stock={WearSlider} {...props} />
          ) : null}
          {controls.visible.seed ? (
            <RegionHost name="seed-input" stock={SeedField} {...props} />
          ) : null}
        </section>
      ) : null}
      {showStickers(props) ? (
        <Section title="Stickers" aside={`${state.stickers.length} of ${slots} slots`}>
          <RegionHost name="stickers" stock={StickerEditor} {...props} />
        </Section>
      ) : null}
      {showStatTrak(props) || showCharm(props) ? (
        <section className="mv-section" data-gap="24">
          {showStatTrak(props) ? (
            <RegionHost name="stattrak" stock={StatTrakToggle} {...props} />
          ) : null}
          {showCharm(props) ? <RegionHost name="charm" stock={CharmRow} {...props} /> : null}
        </section>
      ) : null}
      <div className="mv-panel-foot">
        {showLighting(props) ? <RegionHost name="lighting" stock={RigSwitch} {...props} /> : null}
        {controls.visible.download ? (
          <RegionHost name="download" stock={SplitDownload} {...props} />
        ) : null}
      </div>
    </aside>
  );
}

// The phone's bottom sheet: Finish, Stickers and Extras tabs.
export function PhoneSheet(props: RegionProps) {
  const { controls, state } = props;
  const tabs: Array<{ id: string; label: string }> = [];

  if (controls.visible.wear || controls.visible.seed) {
    tabs.push({ id: "finish", label: "Finish" });
  }

  if (showStickers(props)) {
    tabs.push({
      id: "stickers",
      label: state.stickers.length > 0 ? `Stickers · ${state.stickers.length}` : "Stickers",
    });
  }

  if (showStatTrak(props) || showCharm(props) || showLighting(props)) {
    tabs.push({ id: "extras", label: "Extras" });
  }

  const [tab, setTab] = useState(tabs[0]?.id ?? "finish");
  const active = tabs.some((entry) => entry.id === tab) ? tab : tabs[0]?.id;

  if (tabs.length === 0) {
    return null;
  }

  return (
    <div className="mv-sheet" part="panel">
      <i className="mv-sheet-handle" />
      <div className="mv-tabs" role="tablist">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            className="mv-tab"
            aria-selected={entry.id === active}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <div className="mv-sheet-body" role="tabpanel">
        {active === "finish" ? (
          <>
            {controls.visible.wear ? (
              <RegionHost name="wear-slider" stock={WearSlider} {...props} />
            ) : null}
            {controls.visible.seed ? (
              <RegionHost name="seed-input" stock={SeedField} {...props} />
            ) : null}
          </>
        ) : null}
        {active === "stickers" ? (
          <RegionHost name="stickers" stock={StickerEditor} {...props} />
        ) : null}
        {active === "extras" ? (
          <>
            {showStatTrak(props) ? (
              <RegionHost name="stattrak" stock={StatTrakToggle} {...props} />
            ) : null}
            {showCharm(props) ? <RegionHost name="charm" stock={CharmRow} {...props} /> : null}
            {showLighting(props) ? (
              <RegionHost name="lighting" stock={RigSwitch} {...props} />
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
