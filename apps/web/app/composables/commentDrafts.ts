import type { InjectionKey } from "vue";
import type { CommentAnchor } from "@orvyn/editor/comments";
export interface CommentDraftState {
  body: string;
  anchor?: CommentAnchor | null;
  replies: Map<string, string>;
  keys: Map<string, { body: string; key: string }>;
}
export const commentDraftsKey: InjectionKey<Map<string, CommentDraftState>> =
  Symbol("orvyn.comment-drafts");
