import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
export interface CommentHighlight {
  id: string;
  from: number;
  to: number;
  changed: boolean;
}
const key = new PluginKey<CommentHighlight[]>("orvynCommentHighlights");
declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    orvynCommentHighlights: {
      setCommentHighlights: (ranges: CommentHighlight[]) => ReturnType;
    };
  }
}
export const CommentHighlights = Extension.create<{
  onOpen: null | ((id: string) => void);
  active: null | (() => string);
}>({
  name: "orvynCommentHighlights",
  addOptions() {
    return { onOpen: null, active: null };
  },
  addCommands() {
    return {
      setCommentHighlights:
        (ranges) =>
        ({ tr, dispatch }) => {
          if (dispatch) tr.setMeta(key, ranges);
          return true;
        },
    };
  },
  addProseMirrorPlugins() {
    const options = this.options;
    return [
      new Plugin<CommentHighlight[]>({
        key,
        state: {
          init: () => [],
          apply(tr, ranges) {
            if (tr.getMeta(key) !== undefined) return tr.getMeta(key);
            if (!tr.docChanged) return ranges;
            return ranges
              .map((range) => ({
                ...range,
                from: tr.mapping.map(range.from, 1),
                to: tr.mapping.map(range.to, -1),
              }))
              .filter((range) => range.to > range.from);
          },
        },
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];
            for (const range of key.getState(state) || []) {
              if (
                range.from < 0 ||
                range.to > state.doc.content.size ||
                range.from >= range.to
              )
                continue;
              decorations.push(
                Decoration.inline(range.from, range.to, {
                  class:
                    "comment-highlight" +
                    (options.active?.() === range.id ? " active" : "") +
                    (range.changed ? " changed" : ""),
                  "data-comment-thread": range.id,
                }),
              );
              decorations.push(
                Decoration.widget(
                  range.to,
                  () => {
                    const button = document.createElement("button");
                    button.type = "button";
                    button.className = "comment-marker";
                    button.setAttribute("aria-label", "Open comment thread");
                    button.setAttribute("data-comment-thread", range.id);
                    button.title = "Open discussion";
                    const svg = document.createElementNS(
                      "http://www.w3.org/2000/svg",
                      "svg",
                    );
                    svg.setAttribute("viewBox", "0 0 24 24");
                    svg.setAttribute("width", "14");
                    svg.setAttribute("height", "14");
                    svg.setAttribute("aria-hidden", "true");
                    const path = document.createElementNS(
                      "http://www.w3.org/2000/svg",
                      "path",
                    );
                    path.setAttribute(
                      "d",
                      "M20 15a3 3 0 0 1-3 3H8l-5 3V6a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3Z",
                    );
                    path.setAttribute("fill", "none");
                    path.setAttribute("stroke", "currentColor");
                    path.setAttribute("stroke-width", "1.7");
                    svg.append(path);
                    button.append(svg);
                    button.addEventListener("mousedown", (event) =>
                      event.preventDefault(),
                    );
                    button.addEventListener("click", (event) => {
                      event.preventDefault();
                      options.onOpen?.(range.id);
                    });
                    return button;
                  },
                  {
                    key: "comment-marker-" + range.id,
                    side: 1,
                    stopEvent: () => true,
                  },
                ),
              );
            }
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});
