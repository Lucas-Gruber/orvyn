import type { InjectionKey } from "vue";
export interface CommentDraftState {
  body: string;
  replies: Map<string, string>;
  keys: Map<string, { body: string; key: string }>;
}
export const commentDraftsKey: InjectionKey<Map<string, CommentDraftState>> =
  Symbol("orvyn.comment-drafts");
