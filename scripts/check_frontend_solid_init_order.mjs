#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ts from '../frontend/node_modules/typescript/lib/typescript.js';

const eagerFactories = new Set(['createMemo', 'createComputed', 'createRenderEffect']);
const scriptDir = path.dirname(new URL(import.meta.url).pathname);
const frontendSrcDir = path.resolve(scriptDir, '..', 'frontend', 'src');
const issues = [];

main();

function main() {
  for (const filePath of collectSourceFiles(frontendSrcDir)) {
    analyzeFile(filePath);
  }

  if (issues.length === 0) {
    console.log('frontend init-order check passed');
    return;
  }

  console.error('Found eager Solid callbacks that reference later declarations in the same scope:');
  for (const issue of issues) {
    console.error(`- ${issue}`);
  }
  process.exitCode = 1;
}

function collectSourceFiles(dirPath) {
  const files = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
      continue;
    }

    if (!entry.isFile()) continue;
    if (!fullPath.endsWith('.ts') && !fullPath.endsWith('.tsx')) continue;
    if (fullPath.endsWith('.d.ts')) continue;
    files.push(fullPath);
  }

  return files.sort();
}

function analyzeFile(filePath) {
  const sourceText = fs.readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  visitContainers(sourceFile, sourceFile, filePath);
}

function visitContainers(node, sourceFile, filePath) {
  if (hasStatements(node)) {
    analyzeStatements(node.statements, sourceFile, filePath);
  }

  ts.forEachChild(node, (child) => {
    if (ts.isFunctionLike(child) && child.body) {
      visitContainers(child.body, sourceFile, filePath);
      return;
    }

    if (hasStatements(child)) {
      visitContainers(child, sourceFile, filePath);
      return;
    }

    visitContainers(child, sourceFile, filePath);
  });
}

function hasStatements(node) {
  return Boolean(node && 'statements' in node && Array.isArray(node.statements));
}

function analyzeStatements(statements, sourceFile, filePath) {
  for (let index = 0; index < statements.length; index += 1) {
    const laterDeclarations = collectLaterDeclarations(statements, index + 1);
    if (laterDeclarations.size === 0) continue;
    findEagerCalls(statements[index], laterDeclarations, sourceFile, filePath);
  }
}

function collectLaterDeclarations(statements, startIndex) {
  const names = new Set();

  for (let index = startIndex; index < statements.length; index += 1) {
    const statement = statements[index];

    if (ts.isVariableStatement(statement)) {
      const flags = ts.getCombinedNodeFlags(statement.declarationList);
      const isLexical = (flags & ts.NodeFlags.Const) !== 0 || (flags & ts.NodeFlags.Let) !== 0;
      if (!isLexical) continue;

      for (const declaration of statement.declarationList.declarations) {
        collectBindingNames(declaration.name, names);
      }
      continue;
    }

    if (ts.isClassDeclaration(statement) && statement.name) {
      names.add(statement.name.text);
    }
  }

  return names;
}

function collectBindingNames(bindingName, names) {
  if (ts.isIdentifier(bindingName)) {
    names.add(bindingName.text);
    return;
  }

  if (ts.isObjectBindingPattern(bindingName) || ts.isArrayBindingPattern(bindingName)) {
    for (const element of bindingName.elements) {
      if (ts.isOmittedExpression(element)) continue;
      collectBindingNames(element.name, names);
    }
  }
}

function findEagerCalls(node, laterDeclarations, sourceFile, filePath) {
  if (ts.isFunctionLike(node) && !ts.isSourceFile(node)) {
    return;
  }

  if (ts.isCallExpression(node) && isEagerFactory(node.expression)) {
    const callback = node.arguments[0];
    if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
      const referenced = collectReferencedLaterDeclarations(callback, laterDeclarations);
      if (referenced.length > 0) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.expression.getStart(sourceFile));
        const relativePath = path.relative(path.resolve(scriptDir, '..'), filePath);
        issues.push(
          `${relativePath}:${line + 1}:${character + 1} ${node.expression.getText(sourceFile)} callback references later declaration(s): ${referenced.join(', ')}. Move the declaration above the callback or move the callback below it.`,
        );
      }
    }
  }

  ts.forEachChild(node, (child) => findEagerCalls(child, laterDeclarations, sourceFile, filePath));
}

function isEagerFactory(expression) {
  return ts.isIdentifier(expression) && eagerFactories.has(expression.text);
}

function collectReferencedLaterDeclarations(callback, laterDeclarations) {
  const localNames = new Set();

  for (const parameter of callback.parameters) {
    collectBindingNames(parameter.name, localNames);
  }

  collectLocalNames(callback.body, localNames, callback.body);

  const referenced = new Set();
  collectReferencedNames(callback.body, referenced, laterDeclarations, localNames, callback.body);
  return Array.from(referenced).sort();
}

function collectLocalNames(node, localNames, rootBody) {
  if (node !== rootBody && ts.isFunctionLike(node)) {
    return;
  }

  if (ts.isVariableDeclaration(node)) {
    collectBindingNames(node.name, localNames);
  } else if (ts.isFunctionDeclaration(node) && node.name) {
    localNames.add(node.name.text);
  } else if (ts.isClassDeclaration(node) && node.name) {
    localNames.add(node.name.text);
  } else if (ts.isCatchClause(node) && node.variableDeclaration) {
    collectBindingNames(node.variableDeclaration.name, localNames);
  }

  ts.forEachChild(node, (child) => collectLocalNames(child, localNames, rootBody));
}

function collectReferencedNames(node, referenced, laterDeclarations, localNames, rootBody) {
  if (node !== rootBody && ts.isFunctionLike(node)) {
    return;
  }

  if (ts.isIdentifier(node)) {
    if (laterDeclarations.has(node.text) && !localNames.has(node.text) && !shouldIgnoreIdentifier(node)) {
      referenced.add(node.text);
    }
  }

  ts.forEachChild(node, (child) => collectReferencedNames(child, referenced, laterDeclarations, localNames, rootBody));
}

function shouldIgnoreIdentifier(node) {
  const parent = node.parent;
  if (!parent) return false;

  if (parent.kind >= ts.SyntaxKind.FirstTypeNode && parent.kind <= ts.SyntaxKind.LastTypeNode) {
    return true;
  }

  if ((ts.isPropertyAccessExpression(parent) || ts.isPropertyAccessChain(parent)) && parent.name === node) {
    return true;
  }

  if (ts.isQualifiedName(parent) && parent.right === node) {
    return true;
  }

  if (ts.isPropertyAssignment(parent) && parent.name === node) {
    return true;
  }

  if (ts.isMethodDeclaration(parent) && parent.name === node) {
    return true;
  }

  if (ts.isPropertyDeclaration(parent) && parent.name === node) {
    return true;
  }

  if (ts.isBindingElement(parent) && parent.name === node) {
    return true;
  }

  if (ts.isVariableDeclaration(parent) && parent.name === node) {
    return true;
  }

  if (ts.isFunctionDeclaration(parent) && parent.name === node) {
    return true;
  }

  if (ts.isClassDeclaration(parent) && parent.name === node) {
    return true;
  }

  if (ts.isParameter(parent) && parent.name === node) {
    return true;
  }

  if (ts.isImportClause(parent) || ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent) || ts.isImportEqualsDeclaration(parent)) {
    return true;
  }

  if (ts.isExportSpecifier(parent)) {
    return true;
  }

  if (ts.isJsxAttribute(parent) && parent.name === node) {
    return true;
  }

  if (ts.isLabeledStatement(parent) && parent.label === node) {
    return true;
  }

  return false;
}
