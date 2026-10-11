/**
 * Test dependencies
 */
var test = require("tape")

var utils = require("./utils")
var cssnext = require("..")
var postcss = require("postcss")

/**
 * cssnext options that only enable the customSelectors feature, so the tested
 * warnings can't come from another transformation
 *
 * @return {Object} cssnext options
 */
function customSelectorsOnly() {
  var options = {sourcemap: false, features: {}}
  Object.keys(cssnext.features).forEach(function(feature) {
    options.features[feature] = false
  })
  options.features.customSelectors = true
  return options
}

/**
 * Run `fn` while keeping console.warn() quiet
 *
 * @param {Function} fn
 * @return {Array} messages that have been passed to console.warn()
 */
function silenceConsoleWarn(fn) {
  var consoleWarn = console.warn
  var logged = []
  console.warn = function(message) {
    logged.push(message)
  }

  try {
    fn()
  }
  finally {
    console.warn = consoleWarn
  }

  return logged
}

/**
 * Process `css` & collect both postcss warnings & console.warn() output
 *
 * @param {String} css
 * @param {Object} options cssnext options
 * @return {Object} {css: String, warnings: Array, logged: Array}
 */
function process(css, options) {
  var output
  var warnings
  var logged = silenceConsoleWarn(function() {
    var result = postcss().use(cssnext(options)).process(css)

    // postcss is lazy: reading the css is what triggers the transformations
    output = result.css

    warnings = result.messages.filter(function(message) {
      return message.type === "warning"
    })
  })

  return {
    css: output,
    warnings: warnings,
    logged: logged,
  }
}

var deprecated = utils.readFixture("features/custom-selectors.deprecated")
var current = utils.readFixture("features/custom-selectors")

/**
 * Custom selectors must be prefixed by a colon (`:--name`).
 * The prefix-less syntax (`--name`) is still supported, but deprecated.
 * https://github.com/cssnext/cssnext/issues/97
 */
test("custom selectors deprecated syntax", function(t) {
  var options = customSelectorsOnly()

  silenceConsoleWarn(function() {
    utils.compareFixtures(
      t,
      "features/custom-selectors.deprecated",
      "should still transform custom selectors without the colon prefix",
      options
    )
  })

  var result = process(deprecated, customSelectorsOnly())

  t.equal(
    result.warnings.length,
    1,
    "should add a postcss warning for a custom selector without the colon"
  )
  t.ok(
    utils.contains(result.warnings[0].text, "use `:--heading`"),
    "should tell which syntax to use instead"
  )
  t.equal(
    result.logged.length,
    1,
    "should print the deprecation warning on the console"
  )
  t.ok(
    utils.contains(result.logged[0], "cssnext:"),
    "should prefix the console warning by the library name"
  )

  t.end()
})

test("custom selectors current syntax", function(t) {
  var result = process(current, customSelectorsOnly())

  t.equal(
    result.warnings.length,
    0,
    "should not warn for a custom selector prefixed by a colon"
  )
  t.equal(
    result.logged.length,
    0,
    "should not print anything on the console"
  )

  t.end()
})

test("custom selectors deprecation warning is not repeated", function(t) {
  var result = process(
    "@custom-selector --heading h1, h2;" +
    "@custom-selector --heading h3, h4;" +
    "@custom-selector :--link a;",
    customSelectorsOnly()
  )

  t.equal(
    result.warnings.length,
    1,
    "should warn only once for a given custom selector name"
  )

  t.end()
})

test("custom selectors defined from JS", function(t) {
  var options = customSelectorsOnly()
  options.features.customSelectors = {extensions: {"--heading": "h1, h2"}}

  var deprecatedFromJs = process("--heading{margin-top:0}", options)

  t.equal(
    deprecatedFromJs.warnings.length,
    1,
    "should warn for an extension name without the colon"
  )

  options.features.customSelectors = {extensions: {":--heading": "h1, h2"}}

  t.equal(
    process(":--heading{margin-top:0}", options).warnings.length,
    0,
    "should not warn for an extension name prefixed by a colon"
  )

  t.end()
})

test("custom selectors deprecation warning respects the feature flag",
function(t) {
  var options = customSelectorsOnly()
  options.features.customSelectors = false

  var result = process(deprecated, options)

  t.equal(
    result.warnings.length,
    0,
    "should not warn when the customSelectors feature is disabled"
  )

  t.end()
})
