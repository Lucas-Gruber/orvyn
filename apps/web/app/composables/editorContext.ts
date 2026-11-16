import type { InjectionKey } from "vue";
export const editorPageKey: InjectionKey<() => string> =
  Symbol("orvyn.editor-page");
