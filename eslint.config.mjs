// @ts-check
import withNuxt from './.nuxt/eslint.config.mjs'

// Rule overrides copied from databus/frontend's eslint.config.mjs, so this
// repo lints the same way as the lab's other Nuxt apps. `singleline: 3`
// keeps short elements (e.g. an SVG <circle cx cy r>) on one line instead
// of exploding every attribute onto its own.
export default withNuxt({
  rules: {
    'vue/no-multiple-template-root': 'off',
    'vue/max-attributes-per-line': ['error', { singleline: 3 }]
  }
})
