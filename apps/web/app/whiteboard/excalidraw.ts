import { createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  Excalidraw,
  MainMenu,
  WelcomeScreen,
  CaptureUpdateAction,
  reconcileElements,
  exportToBlob,
  exportToSvg,
  serializeAsJSON,
  restoreElements,
} from "@excalidraw/excalidraw";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawProps,
} from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { WhiteboardScene } from "@orvyn/editor/whiteboards";
import "@excalidraw/excalidraw/index.css";
import "./orvyn.css";

export function mountWhiteboard(
  element: HTMLElement,
  options: {
    scene: WhiteboardScene;
    editable: boolean;
    theme: "light" | "dark";
    onChange: (
      elements: readonly OrderedExcalidrawElement[],
      state: AppState,
      files: BinaryFiles,
    ) => void;
    onPointer: ExcalidrawProps["onPointerUpdate"];
    onReady: () => void;
  },
) {
  let api: ExcalidrawImperativeAPI | undefined,
    editable = options.editable,
    theme = options.theme;
  const root = createRoot(element);
  const render = () =>
    root.render(
      createElement(
        Excalidraw,
        {
          initialData: {
            elements: options.scene.elements as OrderedExcalidrawElement[],
            appState: {
              viewBackgroundColor: options.scene.backgroundColor,
              gridSize: options.scene.gridSize ?? 20,
              gridModeEnabled: options.scene.gridSize !== null,
            },
          },
          excalidrawAPI(value) {
            api = value;
            options.onReady();
          },
          onChange: options.onChange,
          onPointerUpdate: options.onPointer,
          viewModeEnabled: !editable,
          theme,
          isCollaborating: true,
          handleKeyboardGlobally: false,
          autoFocus: false,
          validateEmbeddable: false,
          aiEnabled: false,
          UIOptions: {
            canvasActions: {
              loadScene: false,
              saveToActiveFile: false,
              saveAsImage: false,
              export: false,
              toggleTheme: false,
            },
            tools: { image: editable },
          },
        },
        createElement(
          MainMenu,
          { key: "canvas-menu" },
          createElement(MainMenu.DefaultItems.SearchMenu),
          createElement(MainMenu.DefaultItems.CommandPalette),
          createElement(MainMenu.DefaultItems.Help),
          createElement(MainMenu.Separator),
          createElement(MainMenu.DefaultItems.ClearCanvas),
          createElement(MainMenu.DefaultItems.ChangeCanvasBackground),
        ),
        createElement(
          WelcomeScreen,
          { key: "canvas-welcome" },
          createElement(
            WelcomeScreen.Center,
            null,
            createElement(
              "div",
              { className: "orvyn-canvas-welcome" },
              createElement(
                "span",
                { className: "orvyn-canvas-symbol", "aria-hidden": true },
                createElement("img", {
                  src: "/branding/icon-192.png",
                  alt: "",
                  width: 28,
                  height: 28,
                  draggable: false,
                }),
              ),
              createElement(
                "h2",
                null,
                editable ? "A canvas for your ideas" : "This canvas is empty",
              ),
              createElement(
                "p",
                null,
                editable
                  ? "Sketch a thought, connect the dots, or map out what’s next."
                  : "There’s nothing on this canvas yet.",
              ),
              editable
                ? createElement(
                    "p",
                    { className: "orvyn-canvas-keys" },
                    createElement("kbd", null, "R"),
                    " Rectangle ",
                    createElement("kbd", null, "A"),
                    " Arrow ",
                    createElement("kbd", null, "T"),
                    " Text",
                  )
                : null,
            ),
          ),
        ),
      ),
    );
  render();
  return {
    get api() {
      return api;
    },
    setEditable(value: boolean) {
      editable = value;
      render();
    },
    setTheme(value: "light" | "dark") {
      theme = value;
      render();
    },
    apply(scene: WhiteboardScene) {
      if (!api) return;
      const elements = reconcileElements(
        api.getSceneElementsIncludingDeleted(),
        scene.elements as any,
        api.getAppState(),
      );
      api.updateScene({
        elements,
        appState: {
          viewBackgroundColor: scene.backgroundColor,
          gridSize: scene.gridSize ?? 20,
          gridModeEnabled: scene.gridSize !== null,
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    },
    replace(scene: WhiteboardScene) {
      api?.updateScene({
        elements: restoreElements(scene.elements as any, null),
        appState: {
          viewBackgroundColor: scene.backgroundColor,
          gridSize: scene.gridSize ?? 20,
          gridModeEnabled: scene.gridSize !== null,
        },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    },
    normalize(elements: unknown[]) {
      return restoreElements(elements as any, null);
    },
    fit() {
      api?.scrollToContent(api.getSceneElements(), {
        fitToContent: true,
        animate: false,
        maxZoom: 1,
      });
    },
    async export(format: "png" | "svg" | "json") {
      if (!api) throw Error("The canvas is still loading.");
      const elements = api.getSceneElements(),
        appState = api.getAppState(),
        files = api.getFiles();
      if (format === "json")
        return new Blob([serializeAsJSON(elements, appState, files, "local")], {
          type: "application/json",
        });
      if (format === "svg")
        return new Blob(
          [
            (
              await exportToSvg({
                elements,
                appState,
                files,
                exportPadding: 20,
              })
            ).outerHTML,
          ],
          { type: "image/svg+xml" },
        );
      return exportToBlob({
        elements,
        appState,
        files,
        mimeType: "image/png",
        exportPadding: 20,
      });
    },
    destroy() {
      root.unmount();
      api = undefined;
    },
  };
}
export type WhiteboardAdapter = ReturnType<typeof mountWhiteboard>;
