import { buildDiff } from "./diffEngine";

self.onmessage = ({
  data,
}: MessageEvent<{ before: unknown; after: unknown }>) => {
  self.postMessage(buildDiff(data.before, data.after));
};
