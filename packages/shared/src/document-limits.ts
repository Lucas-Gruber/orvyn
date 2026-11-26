// The same bounded document budget applies to import, editing and collaboration.
// JSON includes node/mark metadata, so it needs more room than Markdown source.
export const documentMaxBytes = 2 * 1024 * 1024;
export const documentMaxNodes = 20000;
export const documentMaxDepth = 64;
export const documentStateMaxBytes = 4 * 1024 * 1024;
export const collaborationMessageMaxBytes = 8 * 1024 * 1024;
