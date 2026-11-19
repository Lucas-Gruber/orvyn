import { defineComponent, h, type VNodeChild } from "vue";
export default defineComponent({
  props: { node: { type: Object, required: true } },
  setup(props) {
    return () => {
      const node = props.node;
      let value: VNodeChild =
        node.type === "hardBreak" ? h("br") : node.text || "";
      for (const mark of node.marks || []) {
        const tags: Record<string, string> = {
          bold: "strong",
          italic: "em",
          strike: "s",
          code: "code",
          underline: "u",
        };
        if (tags[mark.type]) value = h(tags[mark.type]!, {}, [value]);
        else if (mark.type === "link")
          value = h(
            "a",
            {
              href: mark.attrs.href,
              rel: "noopener noreferrer",
              ...(String(mark.attrs.href).startsWith("?page=")
                ? {}
                : { target: "_blank" }),
            },
            [value],
          );
      }
      return value;
    };
  },
});
