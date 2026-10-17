// @medalbot/viewer-ui: styled React components over the headless
// @medalbot/viewer-engine. Import "@medalbot/viewer-ui/styles.css" once.

export { MedalbotViewer, type MedalbotViewerProps } from "./components/medalbot-viewer.tsx";

export {
  CharmRow,
  RigSwitch,
  StatTrakToggle,
  StickerEditor,
  Switch,
} from "./components/attachments.tsx";

export {
  ControlBar,
  FullscreenButton,
  PresetControl,
  presetLabel,
} from "./components/control-bar.tsx";

export { DownloadMenu } from "./components/download.tsx";

export { Badge, Disclaimer, Shortcuts } from "./components/embed-extras.tsx";

export { IconButton } from "./components/icon-button.tsx";

export { ChangeItem, ItemHeader, OrbitHint } from "./components/item-header.tsx";

export { FloatingPanels, PhoneSheet, SidePanel } from "./components/layouts.tsx";

export { Picker } from "./components/picker.tsx";

export { RegionContext, RegionHost } from "./components/region.tsx";

export { SeedField } from "./components/seed-field.tsx";

export { InlineError, Toast, Toasts } from "./components/toasts.tsx";

export {
  ErrorState,
  IdleState,
  LoadingState,
  UnsupportedState,
} from "./components/viewer-surface.tsx";

export { WearSlider } from "./components/wear-slider.tsx";

export {
  itemKey,
  useCanvasSize,
  useViewer,
  type ActionError,
  type LoadProgress,
  type UseViewerOptions,
  type ViewerActions,
  type ViewerMode,
  type ViewerState,
  type ViewerStatus,
} from "./use-viewer.ts";

export {
  attachmentsOf,
  cameraOf,
  capabilities,
  editSticker,
  type CameraPose,
  type CameraState,
  type Capabilities,
  type CharmPlacement,
  type StickerEdit,
  type StickerPlacement,
} from "./capabilities.ts";

export { exportSizes, renderPng, saveBlob, type ExportSize } from "./download.ts";

export { isTextEntry, shortcutFor, type ShortcutAction } from "./keyboard.ts";

export { useStageGestures } from "./gestures.ts";

export { fetcherFor, parseItem, type ViewerSource } from "./source.ts";

export { clampSeed, formatWear, seedRange, wearTier, wearTiers, type WearTier } from "./wear.ts";

export {
  categories,
  closureCatalog,
  inspectLinkIn,
  searchCharms,
  searchFinishes,
  searchStickers,
  stickerGroups,
  urlCatalog,
  weapons,
  type Catalog,
  type CatalogSource,
  type CharmEntry,
  type FinishEntry,
  type StickerEffect,
  type StickerEntry,
} from "./catalog.ts";

export { useCatalog, type CatalogState } from "./use-catalog.ts";

export {
  controlNames,
  regions,
  resolveControls,
  type ComponentOverrides,
  type ControlName,
  type ControlsConfig,
  type Density,
  type ItemDisplay,
  type Layout,
  type PickerKind,
  type Region,
  type RegionComponent,
  type RegionProps,
  type ResolvedControls,
  type ToastMessage,
  type ViewerUi,
} from "./regions.ts";
