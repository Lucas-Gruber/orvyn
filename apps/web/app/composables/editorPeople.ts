import type { InjectionKey, ShallowRef } from "vue";
export interface EditorPerson {
  id: string;
  displayName: string;
}
export const editorPeopleKey: InjectionKey<
  ShallowRef<Map<string, EditorPerson>>
> = Symbol("orvyn.editor-people");
