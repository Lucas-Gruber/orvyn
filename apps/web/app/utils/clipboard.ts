export async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const input = document.createElement("textarea"),
    previous = document.activeElement as HTMLElement | null;
  input.value = value;
  Object.assign(input.style, {
    position: "fixed",
    opacity: "0",
    inset: "0 auto auto 0",
  });
  (document.querySelector("dialog:modal") || document.body).append(input);
  input.select();
  try {
    if (!document.execCommand("copy"))
      throw new Error("The link could not be copied.");
  } finally {
    input.remove();
    previous?.focus();
  }
}
