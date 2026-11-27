import { mkdir, readFile, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

const [categoriesPath, originsPath] = process.argv.slice(2);
if (!categoriesPath || !originsPath) throw new Error("用法：node scripts/pack-temu-taxonomy.mjs 分类.json 产地.json");

const directory = new URL("../extension/flows/temu/product-listing/taxonomy/", import.meta.url);
const readRows = async path => {
  const { data } = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(data)) throw new TypeError(`目录格式无效：${path}`);
  return data;
};
const [categories, origins] = await Promise.all([readRows(categoriesPath), readRows(originsPath)]);
await mkdir(directory, { recursive: true });

function category(node) {
  const children = node.children?.map(category) ?? [];
  return children.length ? [node.catId, node.catName, children] : [node.catId, node.catName];
}

const writeRows = (file, rows) => writeFile(new URL(file, directory), `[\n${rows.map(row => `  ${JSON.stringify(row)}`).join(",\n")}\n]\n`);
const packs = categories.map(category);
await Promise.all([
  writeRows("roots.json", packs.map(([id, label, children]) => children?.length ? [id, label] : [id, label, true])),
  writeRows("origins.json", origins.map(({ chineseName, name, shortName, provinces }) => {
    const country = chineseName || name;
    const aliases = [name, shortName].filter(alias => alias && alias !== country);
    const regions = (provinces ?? []).map(region => region.chineseName || region.name);
    return [country, aliases, regions];
  })),
  ...packs.map(row => writeFile(new URL(`category-${row[0]}.json.gz`, directory), gzipSync(JSON.stringify(row), { level: 9 }))),
]);
