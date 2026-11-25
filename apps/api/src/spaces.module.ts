import {
  Module,
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Req,
  Body,
  Param,
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { db, hash, fail, text, mutation, user } from "./runtime.js";
import { transaction, audit, origin, rateLimit } from "./auth/security.js";
import { queueMail } from "./auth/mail.js";
import { spaceAccess, memberRole, roleRanks } from "./permissions/access.js";
import { appearanceInput } from "@orvyn/shared";
@Controller("api/v1")
class SpacesController {
  @Get("spaces") async spaces(@Req() req: any) {
    const uid = await user(req);
    return (
      await db.query(
        "SELECT s.id,s.name,s.kind,s.version,s.icon,s.cover_preset,s.appearance_version,CASE WHEN s.owner_id=$1 THEN 'Owner' ELSE m.role END AS role FROM spaces s LEFT JOIN space_members m ON m.space_id=s.id AND m.user_id=$1 WHERE s.owner_id=$1 OR m.user_id=$1 ORDER BY s.name",
        [uid],
      )
    ).rows;
  }
  @Post("spaces") async create(@Req() req: any, @Body() body: any) {
    mutation(req);
    const uid = await user(req);
    return transaction(async (c) => {
      const r = await c.query(
        "INSERT INTO spaces(owner_id,name) VALUES($1,$2) RETURNING id,name,kind,version,icon,cover_preset,appearance_version",
        [uid, text(body?.name, 120)],
      );
      await audit(c, uid, "space.created", { spaceId: r.rows[0].id });
      return { ...r.rows[0], role: "Owner" };
    });
  }
  @Get("spaces/:id/appearance") async appearance(
    @Req() req: any,
    @Param("id") id: string,
  ) {
    const s = await spaceAccess(db, await user(req), id);
    return {
      id: s.id,
      icon: s.icon,
      cover_preset: s.cover_preset,
      cover_file_id: null,
      appearance_version: s.appearance_version,
    };
  }
  @Patch("spaces/:id/appearance") async updateAppearance(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: any,
  ) {
    mutation(req);
    const uid = await user(req),
      parsed = appearanceInput.safeParse(body);
    if (!parsed.success || parsed.data.coverFileId !== null)
      fail(400, "Choose one emoji and a supported cover");
    const input = parsed.data!;
    return transaction(async (c) => {
      const s = await spaceAccess(c, uid, id, 40, true);
      if (s.appearance_version !== input.appearanceVersion)
        fail(409, "Appearance changed; reload before saving");
      const saved = await c.query(
        "UPDATE spaces SET icon=$2,cover_preset=$3,appearance_version=appearance_version+1 WHERE id=$1 RETURNING id,icon,cover_preset,appearance_version",
        [s.id, input.icon, input.coverPreset],
      );
      await audit(c, uid, "space.appearance_updated", { spaceId: s.id });
      return { ...saved.rows[0], cover_file_id: null };
    });
  }
  @Get("spaces/:id/team-preview") async preview(
    @Req() req: any,
    @Param("id") id: string,
  ) {
    const uid = await user(req);
    const s = await spaceAccess(db, uid, id, 50);
    const roots = await db.query(
      "SELECT id,title FROM pages WHERE space_id=$1 AND parent_id IS NULL ORDER BY title",
      [s.id],
    );
    return {
      version: s.version,
      kind: s.kind,
      privateRoots: roots.rows,
      message:
        "Existing root pages and descendants remain restricted to their current audience. New members only gain access to new shared pages.",
    };
  }
  @Post("spaces/:id/convert-to-team") async convert(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: any,
  ) {
    mutation(req);
    const uid = await user(req);
    if (body?.confirm !== true || !Number.isSafeInteger(body?.version))
      fail(400, "Explicit confirmation and preview version required");
    return transaction(async (c) => {
      const s = await spaceAccess(c, uid, id, 50, true);
      if (s.kind !== "personal" || s.version !== body.version)
        fail(409, "Preview changed; review again");
      await c.query(
        "UPDATE pages SET visibility='restricted' WHERE space_id=$1 AND parent_id IS NULL",
        [s.id],
      );
      const r = await c.query(
        "UPDATE spaces SET kind='team',version=version+1 WHERE id=$1 RETURNING id,name,kind,version",
        [s.id],
      );
      await audit(c, uid, "space.converted_to_team", {
        spaceId: s.id,
        minRank: 40,
      });
      return { ...r.rows[0], role: "Owner" };
    });
  }
  @Get("spaces/:id/directory") async directory(
    @Req() req: any,
    @Param("id") id: string,
  ) {
    const uid = await user(req),
      s = await spaceAccess(db, uid, id);
    return (
      await db.query(
        `SELECT u.id,u.display_name AS "displayName" FROM users u LEFT JOIN space_members m ON m.user_id=u.id AND m.space_id=$1 WHERE u.id=$2 OR m.space_id=$1 ORDER BY u.display_name,u.id`,
        [s.id, s.owner_id],
      )
    ).rows;
  }
  @Get("spaces/:id/members") async members(
    @Req() req: any,
    @Param("id") id: string,
  ) {
    const uid = await user(req);
    const s = await spaceAccess(db, uid, id, 40);
    return (
      await db.query(
        `SELECT u.id,u.display_name AS "displayName",CASE WHEN u.id=$2 THEN 'Owner' ELSE m.role END AS role FROM users u LEFT JOIN space_members m ON m.user_id=u.id AND m.space_id=$1 WHERE u.id=$2 OR m.space_id=$1 ORDER BY u.display_name,u.id`,
        [s.id, s.owner_id],
      )
    ).rows;
  }
  @Post("spaces/:id/invitations") async invite(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: any,
  ) {
    mutation(req);
    const uid = await user(req);
    await rateLimit("invite:" + uid, 20);
    const email = text(body?.email, 254).toLowerCase(),
      role = memberRole(body?.role);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, "Invalid email");
    return transaction(async (c) => {
      const s = await spaceAccess(c, uid, id, 40, true);
      const inviterAccount = await c.query(
        "SELECT email_verified FROM users WHERE id=$1",
        [uid],
      );
      if (!inviterAccount.rows[0]?.email_verified)
        fail(403, "Verify your email before inviting members");
      if (s.kind !== "team") fail(409, "Convert the space to a team first");
      if (s.role === "Admin" && role === "Admin")
        fail(403, "Only the owner may invite administrators");
      const token = randomBytes(32).toString("hex");
      await c.query(
        "DELETE FROM space_invitations WHERE space_id=$1 AND email=$2",
        [s.id, email],
      );
      await c.query(
        "INSERT INTO space_invitations(token_hash,space_id,email,role,invited_by,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '7 days')",
        [hash(token), s.id, email, role, uid],
      );
      const url = new URL("/", origin());
      url.hash = new URLSearchParams({
        action: "accept-invitation",
        token,
      }).toString();
      await queueMail(
        c,
        email,
        "Orvyn space invitation",
        `You have been invited to ${s.name} as ${role}.\n\n${url}\n\nSign in with this verified email address to accept. This invitation expires in 7 days. Existing private pages are not included.`,
      );
      await audit(c, uid, "space.invitation_created", {
        spaceId: s.id,
        minRank: 40,
      });
      return { ok: true };
    });
  }
  @Post("spaces/invitations/accept") async accept(
    @Req() req: any,
    @Body() body: any,
  ) {
    mutation(req);
    const uid = await user(req),
      token = text(body?.token, 64);
    return transaction(async (c) => {
      const found = await c.query(
        "SELECT space_id FROM space_invitations WHERE token_hash=$1 AND expires_at>now()",
        [hash(token)],
      );
      if (!found.rowCount) fail(400, "Invalid or expired invitation");
      const s = await c.query("SELECT * FROM spaces WHERE id=$1 FOR UPDATE", [
        found.rows[0].space_id,
      ]);
      const account = await c.query(
        "SELECT email,email_verified FROM users WHERE id=$1",
        [uid],
      );
      const invite = await c.query(
        "SELECT * FROM space_invitations WHERE token_hash=$1 AND expires_at>now() FOR UPDATE",
        [hash(token)],
      );
      if (!invite.rowCount) fail(400, "Invalid or expired invitation");
      if (
        !account.rows[0].email_verified ||
        account.rows[0].email !== invite.rows[0].email
      )
        fail(403, "Sign in with the invited verified email address");
      const inviter = await spaceAccess(
        c,
        invite.rows[0].invited_by,
        s.rows[0].id,
        40,
      );
      if (
        s.rows[0].kind !== "team" ||
        (invite.rows[0].role === "Admin" && inviter.role !== "Owner")
      )
        fail(409, "Invitation is no longer valid");
      // Accepting an old invitation cannot silently alter an existing member's role.
      if (uid !== s.rows[0].owner_id)
        await c.query(
          "INSERT INTO space_members VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [s.rows[0].id, uid, invite.rows[0].role],
        );
      await c.query("DELETE FROM space_invitations WHERE token_hash=$1", [
        hash(token),
      ]);
      await c.query("UPDATE spaces SET version=version+1 WHERE id=$1", [
        s.rows[0].id,
      ]);
      await audit(c, uid, "space.invitation_accepted", {
        spaceId: s.rows[0].id,
        minRank: 40,
      });
      return { ok: true };
    });
  }
  @Put("spaces/:id/members/:member") async change(
    @Req() req: any,
    @Param("id") id: string,
    @Param("member") member: string,
    @Body() body: any,
  ) {
    mutation(req);
    const uid = await user(req),
      role = memberRole(body?.role);
    return transaction(async (c) => {
      const s = await spaceAccess(c, uid, id, 50, true);
      if (member === s.owner_id) fail(400, "Owner role cannot be changed here");
      const r = await c.query(
        "UPDATE space_members SET role=$1 WHERE space_id=$2 AND user_id::text=$3 RETURNING user_id",
        [role, s.id, member],
      );
      if (!r.rowCount) fail(404, "Member not found");
      await c.query("UPDATE spaces SET version=version+1 WHERE id=$1", [s.id]);
      await audit(c, uid, "space.member_role_changed", {
        spaceId: s.id,
        minRank: 40,
      });
      return { ok: true };
    });
  }
  @Delete("spaces/:id/members/:member") async remove(
    @Req() req: any,
    @Param("id") id: string,
    @Param("member") member: string,
  ) {
    mutation(req);
    const uid = await user(req);
    return transaction(async (c) => {
      const s = await spaceAccess(c, uid, id, 40, true);
      if (member === s.owner_id) fail(400, "Owner cannot be removed");
      const target = await c.query(
        "SELECT role FROM space_members WHERE space_id=$1 AND user_id::text=$2",
        [s.id, member],
      );
      if (!target.rowCount) fail(404, "Member not found");
      if (s.role !== "Owner" && target.rows[0].role === "Admin")
        fail(403, "Only owner may remove administrators");
      await c.query(
        "DELETE FROM space_members WHERE space_id=$1 AND user_id::text=$2",
        [s.id, member],
      );
      await c.query(
        "DELETE FROM page_permissions WHERE user_id::text=$1 AND page_id IN(SELECT id FROM pages WHERE space_id=$2)",
        [member, s.id],
      );
      await c.query(
        "DELETE FROM space_invitations WHERE space_id=$1 AND (email=(SELECT email FROM users WHERE id::text=$2) OR invited_by::text=$2)",
        [s.id, member],
      );
      await c.query("UPDATE spaces SET version=version+1 WHERE id=$1", [s.id]);
      await audit(c, uid, "space.member_removed", {
        spaceId: s.id,
        minRank: 40,
      });
      return { ok: true };
    });
  }
}
@Module({ controllers: [SpacesController] })
export class SpacesModule {}
