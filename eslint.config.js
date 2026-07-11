import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/", "wiki/", "coverage/", "*.min.js"] },
  js.configs.recommended,
  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      // The engine intentionally embeds a zero-width space (U+200B) in string/
      // template literals to defang fence markers (scripts/lib/fence.mjs), and a
      // U+00A0 in a rendered template. Those are functional, not stray whitespace
      // in code tokens, so allow them inside strings/templates/comments.
      "no-irregular-whitespace": [
        "error",
        { skipStrings: true, skipTemplates: true, skipComments: true, skipRegExps: true },
      ],
    },
  },
];
