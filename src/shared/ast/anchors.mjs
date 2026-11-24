// File-level prefilter anchors for the inline scan. Parsing only happens when
// one of these strings appears verbatim in the source.
//
// Migrated modules are selected by the anchors they declare. A module whose
// matcher inspects AST values must not narrow this list: acorn decodes string
// literals, so the text it matches can be spelled with escapes and never show
// up verbatim. Declaring the full list keeps the module on exactly the files
// the inline scan parses, which is also the file set the pre-migration branch
// saw.
export const anchors = ['external', 'isStandaloneExecutable', 'environmentOverridesParsed',
  'pixelValidation', 'ultraplan', 'tengu_amber_quartz_disabled', 's date is ',
  'Remote settings:', 'remote-settings.json', 'tengu_wiggly_dove',
  '[Tool result missing due to internal error]', 'firstParty', 'claude-sonnet-4-6'];
