// @medalbot/viewer-engine: run a Medalbot item's compiled render plan in the
// browser over WebGPU. The engine has no UI; the caller owns the page.

export {
  createViewer,
  detectSupport,
  requiredFeatures,
  Viewer,
  ViewerError,
  type CameraState,
  type LoadedItem,
  type PaintAttributes,
  type StickerPlacement,
  type Pixels,
  type SceneRig,
  type StageImage,
  type ViewerErrorCode,
  type ViewerEvents,
  type ViewerOptions,
} from "./viewer.ts";

export type { CameraPose } from "./camera/rig.ts";

export type { ItemPose } from "./camera/orbit.ts";

export {
  closureLink,
  httpFetcher,
  requestAttachments,
  type AssetFetcher,
  type InspectAttachment,
  type ClosureFile,
  type ClosureManifest,
  type HttpFetcherOptions,
  type ItemRequest,
  type ItemSpec,
} from "./fetcher.ts";

export {
  apiFetcher,
  ApiAssetFetcher,
  ApiFetchError,
  closureItemSegment,
  closurePath,
  type ApiClosureManifest,
  type ApiFetcherOptions,
  type ApiFetchProgress,
} from "./api-fetcher.ts";

export {
  BindError,
  bindingSlice,
  bindRequest,
  mutableWrites,
  wearBits,
  wearFromBits,
  type BindErrorCode,
  type BindingSlice,
  type UniformUpdate,
} from "./bind/binding.ts";
