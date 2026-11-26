import mermaid from "mermaid";

// This bundle runs only in an opaque-origin iframe with a restrictive CSP.
// Diagram text arrives as a message, never as HTML or a query parameter.
const parentOrigin = new URL((document.currentScript as HTMLScriptElement).src)
  .origin;
const output = document.getElementById("diagram")!;
type Request = {
  type: "orvyn-mermaid-render";
  id: string;
  sequence: number;
  source: string;
  dark: boolean;
  colors: Record<string, string>;
};
let pending: Request | undefined,
  rendering = false,
  current: Request | undefined;
let lastHeight = 0;
function send(type: string, extra: Record<string, unknown> = {}) {
  if (current)
    parent.postMessage(
      { type, id: current.id, sequence: current.sequence, ...extra },
      parentOrigin,
    );
}
function measure() {
  const height =
    Math.ceil(output.getBoundingClientRect().height) +
    32 +
    (output.scrollWidth > output.clientWidth ? 16 : 0);
  if (height !== lastHeight) {
    lastHeight = height;
    send("orvyn-mermaid-height", { height });
  }
}
new ResizeObserver(measure).observe(output);
async function draw() {
  if (rendering) return;
  rendering = true;
  while (pending) {
    const request = pending;
    pending = undefined;
    current = request;
    const color = (name: string, fallback: string) =>
      /^#[a-f\d]{3,8}$/i.test(request.colors?.[name] || "")
        ? request.colors[name]
        : fallback;
    document.documentElement.style.backgroundColor = color(
      "background",
      "#ffffff",
    );
    document.documentElement.style.colorScheme = request.dark
      ? "dark"
      : "light";
    document.body.style.color = color("text", "#2f2f31");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      maxTextSize: 20000,
      maxEdges: 500,
      theme: "base",
      htmlLabels: false,
      flowchart: { htmlLabels: false, useMaxWidth: true },
      secure: [
        "secure",
        "securityLevel",
        "startOnLoad",
        "maxTextSize",
        "maxEdges",
        "suppressErrorRendering",
        "theme",
        "themeCSS",
        "themeVariables",
        "fontFamily",
        "htmlLabels",
        "flowchart",
      ],
      themeVariables: {
        darkMode: request.dark,
        fontFamily:
          "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
        fontSize: "15px",
        background: color("background", "#ffffff"),
        primaryColor: color("surface", "#f5f5f3"),
        primaryTextColor: color("text", "#2f2f31"),
        primaryBorderColor: color("accent", "#7952c8"),
        secondaryColor: color("surface", "#f5f5f3"),
        tertiaryColor: color("background", "#ffffff"),
        lineColor: color("muted", "#777772"),
        textColor: color("text", "#2f2f31"),
        noteBkgColor: color("surface", "#f5f5f3"),
        noteTextColor: color("text", "#2f2f31"),
        actorBkg: color("surface", "#f5f5f3"),
        actorTextColor: color("text", "#2f2f31"),
        actorBorder: color("accent", "#7952c8"),
        signalColor: color("muted", "#777772"),
        signalTextColor: color("text", "#2f2f31"),
      },
    });
    const container = document.createElement("div");
    document.body.append(container);
    try {
      const { svg } = await mermaid.render(
        "diagram-" + crypto.randomUUID(),
        request.source,
        container,
      );
      if (pending) continue;
      output.innerHTML = svg;
      // Diagrams are visual content, with no navigation, remote images, form
      // controls or event binding. CSP also blocks requests during rendering.
      output
        .querySelectorAll(
          "script, foreignObject, image, iframe, object, embed, form",
        )
        .forEach((element) => element.remove());
      output.querySelectorAll("*").forEach((element) => {
        for (const attribute of [...element.attributes]) {
          if (
            /^on/i.test(attribute.name) ||
            (["href", "xlink:href"].includes(attribute.name) &&
              !attribute.value.startsWith("#"))
          )
            element.removeAttribute(attribute.name);
        }
      });
      const diagram = output.querySelector("svg");
      if (diagram?.viewBox.baseVal.width)
        diagram.style.minWidth =
          Math.min(640, diagram.viewBox.baseVal.width) + "px";
      lastHeight = 0;
      measure();
      send("orvyn-mermaid-rendered");
    } catch {
      if (!pending) {
        output.replaceChildren();
        send("orvyn-mermaid-error");
      }
    } finally {
      container.remove();
    }
  }
  rendering = false;
}
window.addEventListener("message", (event) => {
  const value = event.data;
  if (
    event.source !== parent ||
    event.origin !== parentOrigin ||
    value?.type !== "orvyn-mermaid-render" ||
    typeof value.id !== "string" ||
    !Number.isSafeInteger(value.sequence) ||
    typeof value.source !== "string" ||
    value.source.length > 20000
  )
    return;
  pending = value;
  void draw();
});
parent.postMessage({ type: "orvyn-mermaid-ready" }, parentOrigin);
