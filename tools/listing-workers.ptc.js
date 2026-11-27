// Use fieldAgent(name, instruction, params) to pass structured input and receive JSON.
// A custom program may await one worker and use its result as another worker's params.
if (input.mode === "verified") return;
const work = [
  fieldAgent("es", "Produce Mexican Spanish customer-facing copy."),
  fieldAgent("en", "Produce English input copy for the seller's translation fields."),
];
if (input.mode === "create") {
  work.push(fieldAgent("commerce",
    "Prepare a Mexican listing plan matching this exact JSON shape: {\"category\":{\"search\":\"<1-2 Simplified Chinese chars e.g. 蛋>\",\"label\":\"<category>\"},\"attributes\":{},\"salesAndShipping\":{\"brand\":\"<source brand or 无品牌>\",\"axis\":\"<Spanish axis e.g. Color>\",\"packagedWeightGrams\":100,\"packageCm\":{\"length\":15,\"width\":8,\"height\":6},\"evidence\":{\"brand\":{\"kind\":\"estimated\",\"basis\":\"short reason\"},\"weight\":{\"kind\":\"estimated\",\"basis\":\"short reason\"},\"box\":{\"kind\":\"estimated\",\"basis\":\"short reason\"}}}}. Use kind=\"source\" only when documented in input, else \"estimated\" with a <=5-word basis. Use 无品牌 if brand is null. Translate Japanese Kanji to Mainland Simplified Chinese for category.search (卵->蛋, 調理器具->厨具). Do not calculate prices or stock."
  ));
}
await Promise.all(work);
