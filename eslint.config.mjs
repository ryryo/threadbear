import mikecannLint from "mikecann-lint";

// This repo's TypeScript, for the rules below the pack's.
const TS = ["{runner,relay,convex,web}/**/*.{ts,tsx,mts,cts}"];

// Visible Web copy goes through GT. Product names and code examples are
// rendered as written. Runtime data is passed through as JSX expressions.
const visibleAttributes = new Set(["title", "aria-label", "aria-description", "placeholder", "label", "description", "heading"]);
const originalWords = new Set(["Threadbear", "CPU", "OK", "English", "日本語"]);
const webCopy = {
  create(context) {
    function check(node, value) {
      const words = value.trim();
      if (/[A-Za-z]/.test(words) && !originalWords.has(words)) {
        context.report({ node, message: "Mark visible text for translation with T or msg." });
      }
    }
    return {
      JSXText(node) {
        for (let parent = node.parent; parent; parent = parent.parent) {
          if (parent.type !== "JSXElement") continue;
          const name = parent.openingElement.name.name;
          if (name === "T" || name === "code" || name === "pre" || name === "svg") return;
        }
        check(node, node.value);
      },
      JSXAttribute(node) {
        if (visibleAttributes.has(node.name.name) && node.value?.type === "Literal" && typeof node.value.value === "string") {
          check(node.value, node.value.value);
        }
      },
    };
  },
};

export default [
  // Lints the TypeScript in convex/, web/, relay/, runner/ and features/
  // (the GPUI specs' steps, typed by features/tsconfig.json). The rest is
  // Swift, Rust and the public site, each with checks of its own, and the
  // mock runner (plain JavaScript, never linted while it was in app/; check.sh
  // parses it). runner/
  // and features/ aren't React: their use... functions aren't hooks.
  ...(await mikecannLint({
    root: import.meta.dirname,
    ignores: [
      "app/**",
      "mock-runner/**",
      "desktop/**",
      "android-native/**",
      "ios/**",
      "dock/**",
      "site/**",
      "docs/**",
      "scripts/**",
      "runner/box/spike/**",
      // Byte-for-byte DS-Bot reference copies. Lint the executable ports in runner/.
      "third_party/dsbot/baseline/**",
    ],
    untyped: ["runner/scripts/**"],
    notReact: ["runner/**", "relay/**", "features/**"],
  })),
  {
    files: ["web/src/**/*.tsx"],
    plugins: { "threadbear-i18n": { rules: { "no-untranslated-copy": webCopy } } },
    rules: { "threadbear-i18n/no-untranslated-copy": "error" },
  },
  {
    // No any: use unknown and narrow it. (Floating and misused promises,
    // exhaustive switches and unused names come from mikecann-lint 0.2.)
    files: TS,
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    // Disables for rules this setup doesn't turn on, kept for editors that do.
    files: [
      "runner/src/adapters/acp/mcp-http.ts",
      "runner/src/adapters/codex/tools.ts",
      "runner/src/patch-trust.ts",
      "runner/test/unit/context-budget.test.ts",
      "web/src/link-policy.ts",
    ],
    linterOptions: { reportUnusedDisableDirectives: "off" },
  },
];
