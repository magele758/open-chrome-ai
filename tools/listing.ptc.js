// input contains the current product, its media, and any previously verified listing.
// generateFields runs the local create/rerun/verified cell with the same agent bindings.
const fields = await generateFields();
const draft = input.previous || {
  ...fields.commerce,
  gallery: input.gallery.slice(0, 9),
  details: input.details,
  missing: [],
};
if (input.mode !== "verified") {
  draft.title = fields.es.title.trim();
  draft.description = fields.es.description.trim();
  draft.enTitle = fields.en.title.trim();
  draft.enDescription = fields.en.description.trim();
}
return draft;
