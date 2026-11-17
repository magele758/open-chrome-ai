import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

// install embeds this checkout's directory in the Node bundle. The source
// entry and the installed entry read the same programs, from any working dir.
export function flowRoot() {
  return path.resolve(process.env.PAGELENS_MX_FLOW_DIR ||
    process.env.PAGELENS_MX_DEFAULT_FLOW_DIR ||
    fileURLToPath(new URL("../.pagelens-flows/tiktok-mx", import.meta.url)));
}

async function seed(file, body) {
  const tmp = file + "." + randomUUID() + ".tmp";
  await fs.writeFile(tmp, body, { mode: 0o600 });
  try {
    await fs.link(tmp, file);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  } finally {
    await fs.unlink(tmp);
  }
}

export async function loadFlow(name, workers) {
  const defaults = [
    "// Local PTC cell. Edit worker instructions and scheduling here.",
    "const workers = " + JSON.stringify(workers, null, 2) + ";",
    "const results = await Promise.all(workers.map(worker =>",
    "  agent({ task: JSON.stringify(worker), allowed_tools: [] })));",
    "for (const result of results) if (!result.ok) throw Error(result.error);",
    "return results.map(result => result.content);",
    ""
  ].join("\n");
  return loadProgram(name, defaults);
}

export async function loadListingProgram(mode = "listing") {
  const name = mode === "listing" ? "./listing.ptc.js" : "./listing-workers.ptc.js";
  const template = await fs.readFile(new URL(name, import.meta.url), "utf8");
  return loadProgram(mode, template);
}

async function loadProgram(name, defaults) {
  const root = flowRoot();
  const revisions = path.join(root, "revisions");
  await fs.mkdir(revisions, { recursive: true, mode: 0o700 });
  const file = path.join(root, name + ".ptc.js");
  let code;
  try {
    code = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await seed(file, defaults);
    code = await fs.readFile(file, "utf8");
  }
  const hash = createHash("sha256").update(code).digest("hex");
  const snapshot = path.join(revisions, hash + ".ptc.js");
  await seed(snapshot, code);
  return { code, file, hash, snapshot };
}

function planKey(source) {
  const facts = {};
  for (const key of ["id", "title", "seller", "brand", "categories", "specs", "description", "packageWeight", "packageDimensions"])
    facts[key] = source[key] ?? null;
  facts.skus = source.skus.map(({ stock, price, ...identity }) => identity);
  for (const key of ["gallery", "detail"])
    facts[key] = (source[key] || []).map(url => {
      const asset = new URL(url);
      return asset.origin + asset.pathname;
    });
  return createHash("sha256").update(JSON.stringify(facts)).digest("hex");
}

function planFile(source) {
  if (!/^\d{12,22}$/.test(source.id)) throw Error("Invalid source product ID");
  return path.join(flowRoot(), "verified", source.id + ".json");
}

export async function listingVersions() {
  const [workers, planner] = await Promise.all([loadListingProgram("create"), loadListingProgram()]);
  return { workers: workers.hash, planner: planner.hash };
}

export async function rememberPlan(source, copy, receipt, versions = null) {
  const page = new URL(receipt.link);
  if (!receipt.verified || page.origin !== "https://seller.tiktokshopglobalselling.com" ||
      page.searchParams.get("shop_region") !== "MX" || !/^\d+$/.test(receipt.id) ||
      page.pathname !== "/product/edit-draft/" + receipt.id ||
      receipt.readback.url !== receipt.link || receipt.readback.title !== copy.title ||
      receipt.readback.enTitle !== copy.enTitle) throw Error("Expected a verified MX draft receipt");
  const file = planFile(source);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + "." + randomUUID() + ".tmp";
  await fs.writeFile(tmp, JSON.stringify({ key: planKey(source), copy, versions }, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
}

// Preserve the revision that produced a reused plan if a cell is edited mid-run.
export const verifiedPlanVersions = new WeakMap();

export async function matchingPlan(source) {
  let record;
  try {
    record = JSON.parse(await fs.readFile(planFile(source), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (record.key !== planKey(source) || !Array.isArray(record.copy.salesAndShipping?.skus)) return null;
  if (!record.versions) return null;
  const versions = await listingVersions();
  if (record.versions.workers !== versions.workers || record.versions.planner !== versions.planner) return null;
  // Seller-entered prices/inventory belong to the original listing. Only
  // reuse plans whose numeric fields can be derived from today's source.
  for (const row of record.copy.salesAndShipping.skus) {
    const sku = source.skus.find(s => s.id === row.sourceSkuId);
    const origins = record.copy.salesAndShipping.origins;
    if (sku?.currency !== "JPY" || !Number.isInteger(sku.stock) || sku.stock < 0 ||
        origins[row.option + ".priceMXN"]?.kind !== "converted" ||
        !["source", "estimated"].includes(origins[row.option + ".stock"]?.kind)) return null;
    row.stock = sku.stock;
    origins[row.option + ".stock"] = { kind: "estimated", basis: "沿用当前来源库存 " + sku.stock + "，墨西哥库存待核。" };
  }
  verifiedPlanVersions.set(record.copy, record.versions);
  return record.copy;
}
