import type { InjectionKey } from "vue";
export const pageNavigationKey: InjectionKey<
  (id: string, headingId?: string) => void
> = Symbol("orvyn.page-navigation");
