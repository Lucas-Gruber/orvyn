// Keep historical mention identities stable when a profile is renamed. Labels
// are snapshots of authored text, not authentication or notification targets.
export function commentPeopleSql(commentId: string) {
  return `(SELECT coalesce(jsonb_agg(jsonb_build_object('id',mentioned.id,'label',cm.label,'displayName',CASE WHEN (mentioned.id=s.owner_id OR EXISTS(SELECT 1 FROM space_members member WHERE member.space_id=s.id AND member.user_id=mentioned.id)) AND orvyn_page_role(p.id,mentioned.id)>=10 THEN mentioned.display_name ELSE NULL END)),'[]'::jsonb) FROM comment_mentions cm JOIN users mentioned ON mentioned.id=cm.user_id WHERE cm.comment_id=${commentId})`;
}
export function commentBody(body: string, mentions: any[] = []) {
  const labels = new Map<string, string>();
  for (const person of mentions) {
    if (!person.label) continue;
    const name = person.displayName || "Former member";
    labels.set(
      person.label,
      labels.has(person.label) && labels.get(person.label) !== name
        ? "Member"
        : name,
    );
  }
  if (!labels.size) return body;
  const pattern = [...labels.keys()]
    .sort((a, b) => b.length - a.length)
    .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return body.replace(
    new RegExp("@(" + pattern + ")", "gu"),
    (_match, label) => "@" + labels.get(label),
  );
}
