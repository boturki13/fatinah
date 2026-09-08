// Legacy question data stays available to repository audit tooling, but must
// never be embedded in the iOS 1.4 application bundle.
export const excludedQuestionDataFiles = Object.freeze([
  'approved-question-bank.js',
  'curated-image-options.js',
  'image-question-bank-commons.js',
  'image-question-bank.js',
  'question-bank.js',
  'reviewed-question-ledger.js',
  'reviewed-question-sources.js',
]);
