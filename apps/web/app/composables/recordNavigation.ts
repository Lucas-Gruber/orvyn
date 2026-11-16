import type { InjectionKey } from "vue";
import type { RecordOpenMode } from "@orvyn/shared";
export const recordNavigationKey: InjectionKey<
  (id: string, mode?: RecordOpenMode) => void
> = Symbol("record-navigation");
