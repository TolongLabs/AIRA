export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'header-max-length': [2, 'always', 50]
  },
  // Dependabot titles cannot be shortened past 50 characters when package names or group counts are long.
  ignores: [
    (message) =>
      /^(build|ci)(\([^)]*\))?: (\[security\] )?bump (\S+ from \S+ to \S+|the \S+ group .*with \d+ updates?)/.test(
        message
      )
  ]
}
