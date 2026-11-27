import { readTemuAttributeValue } from "./input.js";

const shippingTime = { inputKey: "handlingTime", label: "承诺发货时效" };
const freightTemplate = { inputKey: "freightTemplate", label: "运费模板" };
const byKey = new Map([["shipmentLimitSecond", shippingTime], ["freightTemplateId", freightTemplate]]);
const byLabel = new Map([shippingTime, freightTemplate].map(service => [service.label, service]));
const asText = value => typeof value === "string" ? value.trim() : Number.isFinite(value) ? String(value) : "";
const normalized = value => asText(value).normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
const placeholder = /^(?:请选择|请选择运费模板|请选择模板)$/u;
const byField = field => byKey.get(field?.key) || byLabel.get(normalized(field?.label).replace(/^[*＊]/u, ""));

export function isTemuServiceField(field) {
  return Boolean(byField(field));
}

function workdays(label) {
  // Avoid treating a range or calendar days as a seller's workday commitment.
  const days = /^(?:在)?(\d+)(?:个)?工作日(?:内(?:发货)?|发货)?$/u.exec(normalized(label))?.[1];
  return days ? Number(days) : undefined;
}

function namedChoices(options, name) {
  const wanted = normalized(name);
  const direct = options.filter(option => [option.value, option.label].some(value => normalized(value) === wanted));
  return direct.length ? direct : options.filter(option => option.aliases?.some(alias => normalized(alias) === wanted));
}

function optionsNote(options) {
  if (!options.length) return "当前 Temu 页面没有可选项。";
  const labels = [...new Set(options.map(option => option.label))];
  return `当前选项：${labels.slice(0, 6).join("、")}${labels.length > 6 ? "等" : ""}。`;
}

/** Plan each service field against live shop options. Preserve the platform's existing choice when input is absent. */
export async function planTemuServiceField(input, field, readOptions) {
  const service = byField(field);
  if (!service) return null;
  const declared = readTemuAttributeValue({ listingAttributes: input.listingAttributes }, field);
  const choice = asText(input[service.inputKey]) || asText(Array.isArray(declared) && declared.length === 1 ? declared[0] : declared);
  const shipDays = asText(input.shipDays);
  const requestedDays = service === shippingTime && !choice && /^\d+$/u.test(shipDays) ? Number(shipDays) : 0;
  const days = Number.isSafeInteger(requestedDays) && requestedDays > 0 ? requestedDays : 0;
  const existing = normalized(field.value);
  if (!choice && !days && existing && !placeholder.test(existing)) return { kind: "keep" };

  const live = await readOptions();
  if (!live?.ok) return { kind: "issue", code: live?.code || "SERVICE_OPTIONS_UNAVAILABLE",
    message: live?.message || "无法读取当前店铺的服务选项。" };
  const options = (Array.isArray(live.options) ? live.options : []).filter(option => asText(option?.value) && asText(option.label) &&
    !placeholder.test(normalized(option.label)));
  const enabled = options.filter(option => !option.disabled);
  let matches = choice ? namedChoices(options, choice) : enabled;
  const matchingDays = choice && service === shippingTime ? workdays(choice) : days;
  if (matchingDays && (!choice || !matches.length)) {
    matches = options.filter(option => [option.label, ...(option.aliases || [])].some(label => workdays(label) === matchingDays));
  }
  if (matches.length === 1 && !matches[0].disabled) return { kind: "select", value: matches[0].value };

  const note = optionsNote(enabled);
  if (choice || days) return { kind: "issue", code: "SERVICE_OPTION_MISSING",
    message: `「${(choice || `${days} 个工作日`).slice(0, 120)}」没有唯一匹配的可选项。${note}` };
  return { kind: "issue", code: enabled.length ? "SERVICE_CHOICE_REQUIRED" : "SERVICE_OPTIONS_UNAVAILABLE",
    message: enabled.length ? `请在商品资料中指定 temu.${service.inputKey}。${note}` : note };
}
