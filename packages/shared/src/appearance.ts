import { z } from "zod";

export const coverIds = [
  "aurora",
  "dusk",
  "meadow",
  "ocean",
  "sand",
  "ink",
] as const;
export const covers: Record<
  (typeof coverIds)[number],
  { label: string; background: string }
> = {
  aurora: {
    label: "Aurora",
    background: "linear-gradient(120deg, #164e63, #427b83 45%, #8c78ab)",
  },
  dusk: {
    label: "Dusk",
    background: "linear-gradient(120deg, #713f5c, #b47678 50%, #d5a48a)",
  },
  meadow: {
    label: "Meadow",
    background: "linear-gradient(120deg, #294638, #66846a 50%, #b5bf94)",
  },
  ocean: {
    label: "Ocean",
    background: "linear-gradient(120deg, #243f62, #557e9a 50%, #9bbcc7)",
  },
  sand: {
    label: "Sand",
    background: "linear-gradient(120deg, #766754, #b6a58b 50%, #d8cbb5)",
  },
  ink: {
    label: "Ink",
    background: "linear-gradient(120deg, #222831, #4a5364 50%, #7f8799)",
  },
};
export const emojiChoices = [
  ["📄", "Document"],
  ["📝", "Notes"],
  ["📚", "Books"],
  ["🗂️", "Files"],
  ["💡", "Idea"],
  ["🎯", "Goal"],
  ["🚀", "Launch"],
  ["🧭", "Compass"],
  ["🌿", "Plant"],
  ["🌍", "World"],
  ["☀️", "Sun"],
  ["🌙", "Moon"],
  ["🎨", "Art"],
  ["🛠️", "Tools"],
  ["💻", "Computer"],
  ["🔬", "Research"],
  ["📅", "Calendar"],
  ["✅", "Checklist"],
  ["📌", "Pin"],
  ["⭐", "Star"],
  ["🏡", "Home"],
  ["👥", "Team"],
  ["🎵", "Music"],
  ["❤️", "Heart"],
] as const;
export function validEmoji(value: string | null) {
  if (value === null) return true;
  if (
    value.length > 64 ||
    !/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(value) ||
    /[\p{Cc}\p{Bidi_Control}]/u.test(value)
  )
    return false;
  return (
    [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(value)]
      .length === 1
  );
}
export function coverBackground(id: unknown) {
  return typeof id === "string" && Object.hasOwn(covers, id)
    ? covers[id as keyof typeof covers].background
    : "";
}
export const appearanceInput = z
  .object({
    icon: z.string().max(64).nullable().refine(validEmoji, "Choose one emoji"),
    coverPreset: z.enum(coverIds).nullable(),
    coverFileId: z.uuid().nullable(),
    appearanceVersion: z.number().int().min(1),
  })
  .strict()
  .refine(
    (value) => !(value.coverPreset && value.coverFileId),
    "Choose a cover or an image",
  );
