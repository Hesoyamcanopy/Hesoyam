/* Mocks are instrumented too. They ship in the repo, they run in tests, and
   excluding them made the reported numbers disagree with the text reporter. */
module.exports = {
  istanbulReporter: ["text", "json-summary"],
};
