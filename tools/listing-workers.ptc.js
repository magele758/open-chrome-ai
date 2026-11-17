// Use fieldAgent(name, instruction, params) to pass structured input and receive JSON.
// A custom program may await one worker and use its result as another worker's params.
if (input.mode === "verified") return;
const work = [
  fieldAgent("es", "Produce Mexican Spanish customer-facing copy."),
  fieldAgent("en", "Produce English input copy for the seller's translation fields."),
];
if (input.mode === "create") {
  work.push(fieldAgent("commerce",
    "Prepare a Mexican listing plan. Return JSON with category {search,label}, attributes {}, and salesAndShipping {brand,axis,packagedWeightGrams,packageCm:{length,width,height},evidence:{brand,weight,box}}. Each evidence value is {kind,basis}: use source for documented data or estimated for an inference with a concrete reason. Use 无品牌 if the brand is unknown and mark it estimated. Use grams and cm and estimate padding where needed. Use a Spanish variant axis. The host binds each SKU, stock and price to the source."
  ));
}
await Promise.all(work);
