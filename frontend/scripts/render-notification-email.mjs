import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { render } from "emailmd";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const assetsDir = resolve(scriptDir, "../../backend/assets/notifications");
const mode = process.argv[2];
const locales = ["zh-CN", "en-US"];

if (mode !== "--write" && mode !== "--check") {
  throw new Error("usage: render-notification-email.mjs --write|--check");
}

let hasMismatch = false;
for (const locale of locales) {
  const markdownPath = resolve(assetsDir, `report.${locale}.md`);
  const htmlPath = resolve(assetsDir, `report.${locale}.html`);
  const textPath = resolve(assetsDir, `report.${locale}.txt`);
  const markdown = await readFile(markdownPath, "utf8");
  const rendered = await render(markdown);
  const html = `${rendered.html
    .replaceAll(
      "<p>{{ provider_table_html | safe }}</p>",
      "{{ provider_table_html | safe }}",
    )
    .replaceAll(
      "<p>{{ client_key_table_html | safe }}</p>",
      "{{ client_key_table_html | safe }}",
    )
    .replace(/[ \t]+$/gm, "")
    .trim()}\n`;
  const text = `${rendered.text
    .replaceAll("{{ provider_table_html | safe }}", "{{ provider_table_text }}")
    .replaceAll(
      "{{ client_key_table_html | safe }}",
      "{{ client_key_table_text }}",
    )
    .replace(/[ \t]+$/gm, "")
    .trim()}\n`;

  const requiredHtmlTokens = [
    "{{ rule.name }}",
    "{% if server.database_ready %}",
    "{{ provider_table_html | safe }}",
    "{{ client_key_table_html | safe }}",
  ];
  const requiredTextTokens = [
    "{{ rule.name }}",
    "{% if server.database_ready %}",
    "{{ provider_table_text }}",
    "{{ client_key_table_text }}",
  ];
  if (
    requiredHtmlTokens.some((token) => !html.includes(token)) ||
    requiredTextTokens.some((token) => !text.includes(token))
  ) {
    throw new Error(
      `${locale} EmailMD render did not preserve the Minijinja template contract`,
    );
  }

  if (mode === "--write") {
    await Promise.all([
      writeFile(htmlPath, html, "utf8"),
      writeFile(textPath, text, "utf8"),
    ]);
    continue;
  }

  const [trackedHtml, trackedText] = await Promise.all([
    readFile(htmlPath, "utf8"),
    readFile(textPath, "utf8"),
  ]);
  if (trackedHtml !== html || trackedText !== text) {
    hasMismatch = true;
    process.stderr.write(
      `${locale} notification email assets are stale; run npm run email-templates:generate\n`,
    );
  }
}

if (hasMismatch) {
  process.exitCode = 1;
}
