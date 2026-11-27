import assert from "node:assert/strict";
import { isTemuServiceField, planTemuServiceField } from "../service.js";

const freight = { key: "freightTemplateId", label: "运费模板" };
const shipping = { key: "shipmentLimitSecond", label: "承诺发货时效" };
const options = (...rows) => async () => ({ ok: true, options: rows });
const oneDay = { value: "86400", label: "在 1 个工作日内发货" };
const twoDays = { value: "172800", label: "2 个工作日内" };
const template = { value: "store-template-1", label: "美国站运费模板", aliases: ["美国站已配置模板"] };
const unavailable = { value: "store-template-2", label: "停用模板", disabled: true };

assert.ok(isTemuServiceField(shipping));
assert.ok(isTemuServiceField({ label: "*运费模板" }));
assert.equal(isTemuServiceField({ key: "productProperties[38]", label: "鞋带" }), false);
assert.deepEqual(await planTemuServiceField({}, { ...shipping, value: twoDays.label }, async () => {
  throw new Error("An existing platform choice need not be opened again.");
}), { kind: "keep" });

assert.deepEqual(await planTemuServiceField({}, freight, options(template, unavailable)), {
  kind: "select", value: template.value,
});
assert.deepEqual(await planTemuServiceField({ freightTemplate: "美国站已配置模板" }, freight, options(template)), {
  kind: "select", value: template.value,
});
assert.deepEqual(await planTemuServiceField({ listingAttributes: { [freight.key]: template.value } }, freight, options(template)), {
  kind: "select", value: template.value,
});
assert.equal((await planTemuServiceField({ freightTemplate: unavailable.label }, freight, options(template, unavailable))).code,
  "SERVICE_OPTION_MISSING");
assert.equal((await planTemuServiceField({ freightTemplate: "美国站" }, freight, options(template))).code,
  "SERVICE_OPTION_MISSING");
assert.equal((await planTemuServiceField({ attributes: { 运费模板: template.label } }, freight,
  options(template, { value: "another", label: "另一套运费模板" }))).code, "SERVICE_CHOICE_REQUIRED");
assert.equal((await planTemuServiceField({}, freight, options({ value: "", label: "请选择" }, unavailable))).code,
  "SERVICE_OPTIONS_UNAVAILABLE");
assert.equal((await planTemuServiceField({}, freight, async () => ({ ok: false, code: "MODAL_BLOCKED", message: "Temu 有弹窗。" }))).code,
  "MODAL_BLOCKED");

assert.deepEqual(await planTemuServiceField({ shipDays: "01" }, shipping, options(oneDay, twoDays)), {
  kind: "select", value: oneDay.value,
});
assert.deepEqual(await planTemuServiceField({ shipDays: "1", handlingTime: twoDays.label }, shipping, options(oneDay, twoDays)), {
  kind: "select", value: twoDays.value,
});
assert.deepEqual(await planTemuServiceField({ handlingTime: "1个工作日" }, shipping, options(oneDay, twoDays)), {
  kind: "select", value: oneDay.value,
});
assert.equal((await planTemuServiceField({ shipDays: "1" }, shipping,
  options({ value: "range", label: "1–2 个工作日内发货" }, { value: "calendar", label: "1 天内发货" }))).code,
  "SERVICE_OPTION_MISSING");

const liveTimes = [1, 2, 7, 9].map(days => ({ label: `${days}个工作日内发货`, value: `${days}个工作日内发货` }));
assert.equal((await planTemuServiceField({}, shipping, options(...liveTimes))).code, "SERVICE_CHOICE_REQUIRED");
assert.deepEqual(await planTemuServiceField({ shipDays: "7" }, shipping, options(...liveTimes)), {
  kind: "select", value: "7个工作日内发货",
});
assert.deepEqual(await planTemuServiceField({}, freight, options({ label: "当前店铺模板", value: "当前店铺模板" })), {
  kind: "select", value: "当前店铺模板",
});

console.log("Temu service fields use the existing or uniquely available live option, or a matching seller input.");
