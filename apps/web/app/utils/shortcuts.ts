export function shortcutLabel(keys: string) {
  const mac =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad/.test(navigator.platform);
  return keys
    .replaceAll("Mod", mac ? "⌘" : "Ctrl")
    .replaceAll("Alt", mac ? "⌥" : "Alt")
    .replaceAll("Shift", mac ? "⇧" : "Shift")
    .replaceAll("+", mac ? " " : "+");
}
