// Fixed read-only PTC program used by the extension's draft inspector.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createPtcExecTool } from "@mage-ai-lab/agent-loop/ptc";
import { commercialPlan, commercialDifferences } from "../tools/tiktok-mx-commerce.mjs";
import { check } from "../tools/tiktok-mx-editor.mjs";

const program = `
const reads = await Promise.all([expected_listing({}), saved_draft({})]);
for (const result of reads) if (!result.ok) throw Error(result.content);
return (await compare_fields({})).content;`;

export async function inspectWithPtc({ sourceId, draftId }, readSaved, readExpected = registeredListing) {
  if (![sourceId, draftId].every(id => typeof id === "string" && /^\d{12,22}$/.test(id)))
    throw Error("Invalid product or draft ID");
  const link = "https://seller.tiktokshopglobalselling.com/product/edit-draft/" + draftId + "?shop_region=MX";
  let expected, saved;
  const steps = [];
  const tool = (name, read) => ({ name, ptc: { kind: "read" }, async execute() {
    const step = { name, start: Date.now() };
    steps.push(step);
    try { return { ok: true, content: await read() }; }
    finally { step.end = Date.now(); }
  } });
  const executor = createPtcExecTool({
    getAuthorizedTools: () => [
      tool("expected_listing", async () => { expected = await readExpected(sourceId, draftId); return "ready"; }),
      tool("saved_draft", async () => { saved = await readSaved(); return "ready"; }),
      tool("compare_fields", () => {
        if (saved?.url !== link || saved.captcha) throw Error("Wrong draft or seller verification");
        check(saved, expected.copy);
        const normalize = s => (s || "").split(/\s+[-/>]\s+/).map(x => x.trim()).join("/");
        if (!saved.category || normalize(saved.category) !== normalize(expected.copy.category?.label))
          throw Error("Category mismatch");
        const differences = commercialDifferences(saved.salesAndShipping, commercialPlan(expected.copy, expected.source));
        if (differences.length) throw Error("Persisted fields differ: " + differences.join(", "));
        return "verified";
      }),
    ],
  });
  const result = await executor.execute({ session: { id: crypto.randomUUID(), metadata: { orchestrationEngine: "ptc" } } },
    { code: program, timeoutMs: 45000 });
  if (!result.ok || JSON.parse(result.content).result !== "verified") throw Error(result.content);
  const { skus, brand, packagedWeightGrams, packageCm } = saved.salesAndShipping;
  return { verified: true, executor: executor.name, steps, draftId, link, enTitle: saved.enTitle,
    gallery: saved.gallery, detailImages: saved.detailImages, skus: skus.map(({ label, stock, priceMXN }) => ({ label, stock, priceMXN })),
    brand, packagedWeightGrams, packageCm };
}

async function registeredListing(sourceId, draftId) {
  const json = async file => JSON.parse(await fs.readFile(file, "utf8"));
  const home = process.env.PAGELENS_HOME || path.join(os.homedir(), ".pagelens");
  const map = await json(path.join(home, "mx-draft-sources", sourceId + ".json"));
  if (map.id !== draftId) throw Error("Draft is not registered for this source");
  const root = await fs.realpath(os.tmpdir()), dir = await fs.realpath(map.dir);
  if (path.dirname(dir) !== root || !path.basename(dir).startsWith("pagelens-mx-" + sourceId + "-"))
    throw Error("Unexpected run directory");
  const [source, copy] = await Promise.all(["source.json", "listing.json"].map(file => json(path.join(dir, file))));
  if (source.id !== sourceId || copy.title !== map.title) throw Error("Registered source has changed");
  return { source, copy };
}
