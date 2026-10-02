import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const errors = [];
const removedComponents = new Set([
  "StatusBadge",
  "FilterBar",
  "ListPagination",
  "DetailDrawer",
  "ConfirmAction",
  "StatsGrid",
  "StatCard",
  "ResizableTable",
  "ScrollableTable",
]);
function check(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      check(file);
      continue;
    }
    if (!/\.tsx?$/.test(file) || /\.test\./.test(file)) continue;
    const source = fs.readFileSync(file, "utf8");
    const ast = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const report = (node, message) =>
      errors.push(
        `${path.relative(root, file)}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}: ${message}`,
      );
    function visit(node) {
      if (ts.isImportDeclaration(node)) {
        const module = node.moduleSpecifier.text;
        if (
          /tailwind|lucide-react/.test(module) ||
          removedComponents.has(module.split("/").at(-1))
        )
          report(node, "Use official MUI components directly.");
        if (module.endsWith(".css") && !module.startsWith("@fontsource/"))
          report(node, "Keep application styles in theme.ts and sx.");
      }
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const name = node.tagName.getText(ast);
        if (/^[a-z]/.test(name))
          report(node, "Use a MUI polymorphic component for semantic markup.");
        for (const attribute of node.attributes.properties) {
          if (!ts.isJsxAttribute(attribute)) continue;
          if (attribute.name.text === "className")
            report(attribute, "Use sx instead of CSS utility classes.");
          if (
            name === "Button" &&
            ts.isStringLiteral(attribute.initializer ?? {})
          ) {
            const allowed =
              attribute.name.text === "variant"
                ? ["contained", "outlined", "text"]
                : attribute.name.text === "size"
                  ? ["small", "medium", "large"]
                  : null;
            if (allowed && !allowed.includes(attribute.initializer.text))
              report(attribute, "Use the standard MUI Button API.");
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
}
check(path.join(root, "src"));
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
for (const dependency of Object.keys({
  ...manifest.dependencies,
  ...manifest.devDependencies,
})) {
  if (/tailwind|lucide/.test(dependency))
    errors.push(`package.json: remove ${dependency}`);
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    "Console UI check passed: direct MUI components, standard APIs, no legacy CSS utilities.",
  );
