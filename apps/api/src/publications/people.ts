import type { PoolClient } from "pg";
import type { PublicationScope } from "@orvyn/shared";
import { publicPersonId } from "./security.js";
import { fail } from "../runtime.js";

export const publicIdentityTypes = new Set([
  "Person",
  "CreatedBy",
  "LastEditedBy",
]);
// These references remain private sidecars. Only explicitly authored labels and
// publication-root-scoped opaque identifiers enter the public projection.
export class PublicationPeople {
  private readonly selected: Map<string, string>;
  private readonly references = new Map<string, Set<string>>();
  readonly options: { id: string; label: string; color: string }[];
  constructor(
    private readonly root: string,
    scope: PublicationScope,
  ) {
    this.selected = new Map(
      scope.people.map((person) => [person.userId, person.label]),
    );
    this.options = scope.people.map((person) => ({
      id: publicPersonId(root, person.userId),
      label: person.label,
      color: "gray",
    }));
  }
  reference(userId: unknown, pageId: string): string | null {
    if (
      typeof userId !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        userId,
      )
    )
      return null;
    const pages = this.references.get(userId) || new Set<string>();
    pages.add(pageId);
    this.references.set(userId, pages);
    if (this.references.size > 500)
      return fail(
        400,
        "Choose content containing at most 500 people for this publication.",
      );
    return this.selected.has(userId) ? publicPersonId(this.root, userId) : null;
  }
  label(userId: unknown) {
    return typeof userId === "string" ? this.selected.get(userId) : undefined;
  }
  get omitted() {
    return [...this.references.keys()].filter((id) => !this.selected.has(id))
      .length;
  }
  async choices(c: PoolClient) {
    const pairs = [...this.references].flatMap(([userId, pages]) =>
      [...pages].map((pageId) => ({ userId, pageId })),
    );
    if (!pairs.length) return [];
    const result = await c.query(
      `
      SELECT reference.user_id AS id,max(CASE WHEN (s.owner_id=u.id OR EXISTS(SELECT 1 FROM space_members member WHERE member.space_id=s.id AND member.user_id=u.id))
        AND orvyn_page_role(p.id,u.id)>=10 THEN u.display_name END) AS display_name
      FROM unnest($1::uuid[],$2::uuid[]) reference(user_id,page_id)
      JOIN pages p ON p.id=reference.page_id JOIN spaces s ON s.id=p.space_id LEFT JOIN users u ON u.id=reference.user_id
      GROUP BY reference.user_id ORDER BY reference.user_id`,
      [pairs.map((pair) => pair.userId), pairs.map((pair) => pair.pageId)],
    );
    return result.rows.map((row) => ({
      id: row.id,
      privateLabel: row.display_name || "Person no longer on this page",
    }));
  }
}
