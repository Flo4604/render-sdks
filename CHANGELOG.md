# Changes

## Public image variants

| SDK | Version |
| --- | --- |
| TypeScript | 0.1.4 |
| Python | 0.1.4 |
| Go | 0.1.4 |
| C# | 0.1.2 |

All SDKs include a pure URL helper for the fixed `small`, `card` and `zoom` image variants. The helpers preserve custom image origins, validate canonical original image URLs and leave the lossless original unchanged. The render response remains a map of view names to original URLs.

## StatTrak overrides

| SDK | Version |
| --- | --- |
| TypeScript | 0.1.3 |
| Python | 0.1.3 |
| Go | 0.1.3 |
| C# | 0.1.1 |

All four SDKs accept an optional StatTrak kill counter for render requests. TypeScript uses `statTrak`, Python uses `stat_trak`, and Go and C# use `StatTrak`. The wire field is `statTrak` in every SDK.

The override accepts integers from 0 to 999999. Explicit zero renders a zero counter; omission preserves the inspected value. It changes the image only, and the API rejects items without a StatTrak kill counter. Changed counters use separate cached renders.
