import {
  Body,
  Controller,
  Get,
  HttpCode,
  Module,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { z } from "@orvyn/shared";
import { mutation, user, fail } from "./runtime.js";
import { audit, readSnapshot, transaction } from "./auth/security.js";
import { parse } from "./databases/model.js";
import {
  conversionChoice,
  conversionContext,
  conversionPreview,
  decodeConversionToken,
  planConversion,
  type ConversionChoice,
} from "./databases/conversions.js";

@Controller("api/v1/databases/:id/properties/:property")
class PropertyConversionsController {
  @Get("type-history") async history(
    @Req() req: any,
    @Param("id") id: string,
    @Param("property") property: string,
  ) {
    const uid = await user(req);
    return readSnapshot(async (c) => {
      const context = await conversionContext(c, uid, id, property);
      return (
        await c.query(
          `SELECT id,from_type AS "fromType",to_type AS "toType",total_records AS "totalRecords",changed_values AS "changedValues",cleared_values AS "clearedValues",created_at AS "createdAt",restored_from AS "restoredFrom",to_type=$2 AS "canReviewRestore"
         FROM database_property_changes WHERE property_id=$1 ORDER BY created_at DESC,id LIMIT 20`,
          [context.property.id, context.property.type],
        )
      ).rows;
    });
  }
  @Post("conversion-preview")
  @HttpCode(200)
  async preview(
    @Req() req: any,
    @Param("id") id: string,
    @Param("property") property: string,
    @Body() body: unknown,
  ) {
    mutation(req);
    const uid = await user(req),
      choice = parse<ConversionChoice>(conversionChoice, body);
    return readSnapshot(async (c) => {
      const context = await conversionContext(c, uid, id, property);
      return conversionPreview(
        context,
        await planConversion(c, context, choice),
        uid,
      );
    });
  }
  @Post("convert")
  @HttpCode(200)
  async convert(
    @Req() req: any,
    @Param("id") id: string,
    @Param("property") property: string,
    @Body() body: unknown,
  ) {
    mutation(req);
    const schema = z
      .object({
        previewToken: z.string().min(1).max(2048),
        requestId: z.uuid(),
        confirm: z.literal(true),
        acceptEmpty: z.boolean().default(false),
      })
      .strict();
    const uid = await user(req),
      input = parse<z.infer<typeof schema>>(schema, body);
    return transaction(async (c) => {
      const context = await conversionContext(c, uid, id, property, true);
      const token = decodeConversionToken(input.previewToken);
      if (
        token.actor !== uid ||
        token.database !== context.page.id ||
        token.property !== context.property.id
      )
        fail(400, "This preview belongs to a different field or account");
      const previous = (
        await c.query(
          "SELECT id,actor_id,preview_digest FROM database_property_changes WHERE property_id=$1 AND request_id=$2",
          [context.property.id, input.requestId],
        )
      ).rows[0];
      if (previous) {
        if (
          previous.actor_id !== uid ||
          previous.preview_digest !== token.digest
        )
          fail(409, "This request was already used for another preview");
        return { id: previous.id, alreadyApplied: true };
      }
      if (token.expires <= Date.now())
        fail(409, "This preview expired. Review the conversion again.");
      const choice: ConversionChoice = token.historyId
        ? { historyId: token.historyId }
        : { toType: token.toType };
      const plan = await planConversion(c, context, choice, true);
      if (plan.digest !== token.digest || plan.target.type !== token.toType)
        fail(
          409,
          "The database changed after this preview. Review the conversion again.",
        );
      if (plan.cleared.length && !input.acceptEmpty)
        fail(
          400,
          "Confirm that incompatible values will become empty before applying this conversion.",
        );
      const changeId = randomUUID();
      await c.query(
        `INSERT INTO database_property_changes(id,property_id,request_id,preview_digest,actor_id,from_type,to_type,from_config,to_config,total_records,changed_values,cleared_values,restored_from)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          changeId,
          context.property.id,
          input.requestId,
          token.digest,
          uid,
          context.property.type,
          plan.target.type,
          context.property.config,
          plan.target.config,
          plan.items.length,
          plan.changed.length,
          plan.cleared.length,
          plan.historyId,
        ],
      );
      for (let offset = 0; offset < plan.items.length; offset += 250) {
        const batch = plan.items
          .slice(offset, offset + 250)
          .map((item) => ({
            id: item.row.id,
            original_present: item.before.present,
            original_value: item.before.value,
            converted_present: item.after.present,
            converted_value: item.after.value,
          }));
        await c.query(
          `INSERT INTO database_property_change_values(change_id,page_id,original_present,original_value,converted_present,converted_value)
           SELECT $1,x.id,x.original_present,coalesce(x.original_value,'null'::jsonb),x.converted_present,coalesce(x.converted_value,'null'::jsonb)
           FROM jsonb_to_recordset($2::jsonb) AS x(id uuid,original_present boolean,original_value jsonb,converted_present boolean,converted_value jsonb)`,
          [changeId, JSON.stringify(batch)],
        );
      }
      for (let offset = 0; offset < plan.changed.length; offset += 250) {
        const batch = plan.changed
          .slice(offset, offset + 250)
          .map((item) => ({
            id: item.row.id,
            present: item.after.present,
            value: item.after.value,
          }));
        await c.query(
          `UPDATE database_records record SET values=CASE WHEN x.present THEN jsonb_set(record.values,ARRAY[$1::text],coalesce(x.value,'null'::jsonb),true) ELSE record.values-$1::text END,version=version+1
           FROM jsonb_to_recordset($2::jsonb) AS x(id uuid,present boolean,value jsonb) WHERE record.page_id=x.id AND record.database_id=$3`,
          [context.property.id, JSON.stringify(batch), context.page.id],
        );
      }
      const changed = await c.query(
        "UPDATE database_properties SET type=$1,config=$2 WHERE id=$3 AND database_id=$4 AND deleted_at IS NULL AND type=$5 RETURNING id",
        [
          plan.target.type,
          plan.target.config,
          context.property.id,
          context.page.id,
          context.property.type,
        ],
      );
      if (!changed.rowCount)
        fail(409, "This field changed. Review the conversion again.");
      for (const view of plan.changedViews) {
        const saved = await c.query(
          "UPDATE database_views SET type=$1,config=$2,version=version+1 WHERE id=$3 AND database_id=$4 AND version=$5",
          [view.type, view.config, view.id, context.page.id, view.version],
        );
        if (!saved.rowCount)
          fail(409, "A view changed. Review the conversion again.");
      }
      if (plan.changed.length)
        await c.query(
          "UPDATE pages SET last_edited_by=$1 WHERE space_id=$2 AND id=ANY($3::uuid[])",
          [uid, context.page.space_id, plan.changed.map((item) => item.row.id)],
        );
      await audit(c, uid, "database.property_converted", {
        pageId: context.page.id,
      });
      return {
        id: changeId,
        alreadyApplied: false,
        property: {
          id: context.property.id,
          name: context.property.name,
          type: plan.target.type,
        },
        changedValues: plan.changed.length,
        clearedValues: plan.cleared.length,
      };
    });
  }
}
@Module({ controllers: [PropertyConversionsController] })
export class DatabasePropertyConversionsModule {}
