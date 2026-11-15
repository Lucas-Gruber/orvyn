import type { InjectionKey } from "vue";
export const pageNavigationKey: InjectionKey<(id: string) => void> = Symbol(
  "orvyn.page-navigation",
);
