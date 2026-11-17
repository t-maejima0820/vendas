import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const ROOT = process.cwd();
const SCAN_ROOTS = [
  path.join(ROOT, 'src'),
  path.join(ROOT, 'scripts', 'etl'),
  path.join(ROOT, 'scripts', 'db'),
];

const ALLOWED_PG_FILES = new Set([
  path.normalize('src/lib/db/tenant-client.ts'),
  path.normalize('scripts/etl/migrate-tenant.ts'),
  path.normalize('scripts/db/migrate.ts'),
  path.normalize('scripts/db/verify-live-supabase.ts'),
]);

const ALLOWED_SUPABASE_FILES = new Set([
  path.normalize('src/lib/storage/storage-client.ts'),
]);

const PUBLIC_AUTH_ROUTES = new Set([
  'src/app/api/v1/auth/login/route.ts',
  'src/app/api/v1/auth/logout/route.ts',
]);

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const CALC_ENGINE_FILE = path.normalize('src/lib/domain/calculations.ts');
const TAX_LITERALS = new Set(['0.1', '0.10', '0.08', '1.1', '1.08']);
const ROUNDING_METHODS = new Set(['floor', 'round', 'ceil', 'trunc']);
const RAW_ERR_PROPS = new Set(['message', 'stack', 'detail']);

function collectFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      collectFiles(full, out);
    } else if (
      (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.test.tsx') &&
      !entry.name.endsWith('.d.ts') &&
      !entry.name.endsWith('.d.mts')
    ) {
      out.push(full);
    }
  }
  return out;
}

function isZeroLiteral(node) {
  if (ts.isNumericLiteral(node) && Number(node.text) === 0) return true;
  if (ts.isBigIntLiteral(node) && node.text === '0n') return true;
  return false;
}

function isProcessEnvAccess(node) {
  let cur = node;
  while (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
    const text = cur.getText();
    if (text.startsWith('process.env.')) return true;
    cur = cur.expression;
  }
  return false;
}

function isSwallowingReturnExpr(expr) {
  if (!expr) return true;
  if (isZeroLiteral(expr)) return true;
  if (expr.kind === ts.SyntaxKind.NullKeyword || expr.kind === ts.SyntaxKind.FalseKeyword) return true;
  if (ts.isIdentifier(expr) && expr.text === 'undefined') return true;
  if (ts.isStringLiteral(expr) && expr.text === '') return true;
  if (ts.isArrayLiteralExpression(expr) && expr.elements.length === 0) return true;
  if (ts.isObjectLiteralExpression(expr) && expr.properties.length === 0) return true;
  return false;
}

function hasValidCatchHandling(block) {
  let hasThrowOrExit = false;
  let hasValidReturn = false;
  let hasBadReturn = false;

  function walkBlock(node) {
    if (ts.isFunctionLike(node) && node !== block) return;
    if (ts.isThrowStatement(node)) {
      hasThrowOrExit = true;
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText() === 'process' &&
      node.expression.name.text === 'exit'
    ) {
      hasThrowOrExit = true;
    } else if (ts.isReturnStatement(node)) {
      if (isSwallowingReturnExpr(node.expression)) {
        hasBadReturn = true;
      } else {
        hasValidReturn = true;
      }
    }
    ts.forEachChild(node, walkBlock);
  }

  walkBlock(block);
  if (hasBadReturn) return false;
  return hasThrowOrExit || hasValidReturn;
}

function containsStorageCall(node) {
  let found = false;
  function walk(n) {
    if (found) return;
    if (
      ts.isPropertyAccessExpression(n) &&
      n.name.text === 'storage' &&
      n.parent &&
      ts.isPropertyAccessExpression(n.parent) &&
      n.parent.name.text === 'from'
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, walk);
  }
  walk(node);
  return found;
}

function enclosingBlockChecksError(varNames, startNode) {
  let cur = startNode.parent;
  while (cur && !ts.isBlock(cur) && !ts.isSourceFile(cur)) {
    cur = cur.parent;
  }
  if (!cur) return false;
  let checked = false;
  function walk(n) {
    if (checked) return;
    if (ts.isIfStatement(n)) {
      const condText = n.expression.getText();
      for (const name of varNames) {
        if (
          condText === name ||
          condText.includes(`${name}.error`) ||
          condText.includes(`${name} != null`) ||
          condText.includes(`${name} !== null`)
        ) {
          checked = true;
          return;
        }
      }
    }
    ts.forEachChild(n, walk);
  }
  walk(cur);
  return checked;
}

function hasExportModifier(node) {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  if (!mods) return false;
  return mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function unwrapTypeWrappers(expr) {
  let cur = expr;
  while (
    cur &&
    (ts.isParenthesizedExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isTypeAssertionExpression(cur) ||
      ts.isNonNullExpression(cur))
  ) {
    cur = cur.expression;
  }
  return cur;
}

function findRawErrorPropertyLeak(node, sourceFile) {
  let leaked = null;
  function walk(n) {
    if (leaked !== null) return;
    if (ts.isPropertyAccessExpression(n) && RAW_ERR_PROPS.has(n.name.text)) {
      const inner = unwrapTypeWrappers(n.expression);
      const targetText = inner.getText(sourceFile).toLowerCase();
      if (
        n.name.text === 'stack' ||
        n.name.text === 'detail' ||
        targetText === 'err' ||
        targetText === 'error' ||
        targetText === 'e' ||
        targetText.endsWith('err') ||
        targetText.endsWith('error')
      ) {
        leaked = n;
        return;
      }
    }
    ts.forEachChild(n, walk);
  }
  walk(node);
  return leaked;
}

export function scanSourceText(code, filePath) {
  const sourceFile = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true);
  const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(ROOT, filePath);
  const relNorm = path.normalize(path.relative(ROOT, absPath));
  const relUnix = relNorm.split(path.sep).join('/');
  const isCalcEngine = relNorm === CALC_ENGINE_FILE;
  const isApiRouteV1 = relUnix.startsWith('src/app/api/v1/') && relUnix.endsWith('/route.ts');
  const isAnyApiFile = relUnix.startsWith('src/app/api/');
  const violations = [];

  function report(node, rule, message) {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push({
      file: relNorm,
      line: line + 1,
      col: character + 1,
      rule,
      message,
    });
  }

  let isUseClient = false;
  if (sourceFile.statements.length > 0) {
    const first = sourceFile.statements[0];
    if (ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === 'use client') {
      isUseClient = true;
    }
  }

  // Rule G7: API v1 route handler wrapper enforcement
  if (isApiRouteV1) {
    const allowPublicWrapper = PUBLIC_AUTH_ROUTES.has(relUnix);
    for (const stmt of sourceFile.statements) {
      if (ts.isFunctionDeclaration(stmt) && hasExportModifier(stmt) && stmt.name && HTTP_METHODS.has(stmt.name.text)) {
        report(
          stmt,
          'G7',
          `APIハンドラ '${stmt.name.text}' を生関数で export せず withApiHandler でラップしてください`,
        );
      } else if (ts.isVariableStatement(stmt) && hasExportModifier(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && HTTP_METHODS.has(decl.name.text)) {
            const init = decl.initializer;
            const ok =
              init &&
              ts.isCallExpression(init) &&
              ts.isIdentifier(init.expression) &&
              (init.expression.text === 'withApiHandler' ||
                (allowPublicWrapper && init.expression.text === 'withPublicApiHandler'));
            if (!ok) {
              report(
                decl,
                'G7',
                `APIハンドラ '${decl.name.text}' は ${
                  allowPublicWrapper ? 'withPublicApiHandler / withApiHandler' : 'withApiHandler'
                } の戻り値である必要があります`,
              );
            }
          }
        }
      } else if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const spec of stmt.exportClause.elements) {
          if (HTTP_METHODS.has(spec.name.text)) {
            report(spec, 'G7', `APIハンドラ '${spec.name.text}' の名前付き再exportは禁止されています`);
          }
        }
      }
    }
  }

  function visit(node) {
    // Rule G1: No silent numeric fallback (?? 0, || 0, ?? 0n, || 0n) or process.env fallback
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      if (isZeroLiteral(node.right)) {
        report(node, 'G1', `暗黙のゼロフォールバック (${node.getText(sourceFile)}) は禁止されています`);
      }
      if (isProcessEnvAccess(node.left)) {
        report(
          node,
          'G1',
          `環境変数へのフォールバック (${node.getText(sourceFile)}) は禁止されています (requireEnv を使用してください)`,
        );
      }
    }

    // Rule G2: No empty or swallowing catch blocks
    if (ts.isCatchClause(node)) {
      if (node.block.statements.length === 0) {
        report(node, 'G2', '空の catch ブロックは禁止されています');
      } else if (!hasValidCatchHandling(node.block)) {
        report(
          node,
          'G2',
          '例外を握り潰す catch ブロックは禁止されています（再throw または明示的なエラー応答が必須）',
        );
      }
    }

    // Rule G3: No PostgREST .from() and mandatory error check on Supabase Storage calls
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const propName = node.expression.name.text;
      if (propName === 'from') {
        const receiver = node.expression.expression;
        const isStorageFrom = ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'storage';
        if (!isStorageFrom && receiver.getText(sourceFile).toLowerCase().includes('supabase')) {
          report(
            node,
            'G3',
            'PostgREST (.from) の使用は禁止されています。tenant-client.ts 経由の直接PG接続を使用してください',
          );
        }
      }

      // Rule G6: Strict static SQL first argument for .query(...)
      if (propName === 'query') {
        const arg0 = node.arguments[0];
        const receiverText = node.expression.expression.getText(sourceFile);
        const isTenantClientForwarder =
          relNorm === path.normalize('src/lib/db/tenant-client.ts') &&
          receiverText === 'client' &&
          arg0 !== undefined &&
          ts.isIdentifier(arg0) &&
          arg0.text === 'sql';
        const isMigrationFileRunner =
          relNorm === path.normalize('scripts/db/migrate.ts') &&
          arg0 !== undefined &&
          ts.isIdentifier(arg0) &&
          (arg0.text === 'sqlText' || arg0.text === 'fnSql' || arg0.text === 'seedSql');

        if (!isTenantClientForwarder && !isMigrationFileRunner) {
          const isStaticSql =
            arg0 !== undefined &&
            (ts.isStringLiteral(arg0) || ts.isNoSubstitutionTemplateLiteral(arg0));
          if (!isStaticSql) {
            report(
              arg0 === undefined ? node : arg0,
              'G6',
              'SQLインジェクション防止のため、.query() の第1引数は静的文字列リテラル＋$1,$2パラメータバインドのみ許可されます',
            );
          }
        }
      }

      // Rule G7: Block returning raw error messages/stacks/details in NextResponse.json / Response.json
      if (isAnyApiFile && propName === 'json') {
        const receiverName = node.expression.expression.getText(sourceFile);
        if (receiverName === 'NextResponse' || receiverName === 'Response') {
          for (const arg of node.arguments) {
            const leakedNode = findRawErrorPropertyLeak(arg, sourceFile);
            if (leakedNode !== null) {
              report(
                leakedNode,
                'G7',
                `APIレスポンスに生の例外プロパティ (${leakedNode.getText(sourceFile)}) を含めることは禁止されています`,
              );
            }
          }
        }
      }
    }

    if (ts.isVariableDeclaration(node) && node.initializer && containsStorageCall(node.initializer)) {
      if (ts.isObjectBindingPattern(node.name)) {
        const errBinding = node.name.elements.find(
          (el) => (el.propertyName ? el.propertyName.getText(sourceFile) : el.name.getText(sourceFile)) === 'error',
        );
        if (!errBinding) {
          report(node, 'G3', 'Supabase Storage 呼び出し結果から error を分割代入して検証してください');
        } else {
          const localErrName = errBinding.name.getText(sourceFile);
          if (!enclosingBlockChecksError([localErrName], node)) {
            report(node, 'G3', `Supabase Storage の '${localErrName}' チェックが見つかりません`);
          }
        }
      } else if (ts.isIdentifier(node.name)) {
        if (!enclosingBlockChecksError([node.name.text], node)) {
          report(node, 'G3', `Supabase Storage 戻り値 '${node.name.text}.error' の検証が見つかりません`);
        }
      }
    }

    // Rule G4: Single Calculation Engine
    if (!isCalcEngine) {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'Math' &&
        ROUNDING_METHODS.has(node.expression.name.text)
      ) {
        report(
          node,
          'G4',
          `calculations.ts 以外での Math.${node.expression.name.text} 使用は禁止されています`,
        );
      }

      if (
        ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.AsteriskToken ||
          node.operatorToken.kind === ts.SyntaxKind.SlashToken)
      ) {
        const leftLit = ts.isNumericLiteral(node.left) && TAX_LITERALS.has(node.left.text);
        const rightLit = ts.isNumericLiteral(node.right) && TAX_LITERALS.has(node.right.text);
        if (leftLit || rightLit) {
          report(
            node,
            'G4',
            `calculations.ts 以外での税率リテラル計算 (${node.getText(sourceFile)}) は禁止されています`,
          );
        }
      }
    }

    // Rule G5: Direct PG pool / Supabase client / Client boundary enforcement
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const mod = node.moduleSpecifier.text;
      if (mod === 'pg' && !ALLOWED_PG_FILES.has(relNorm)) {
        report(node, 'G5', `'pg' の直接インポートは禁止されています (tenant-client.ts 経由のみ許可)`);
      }
      if (mod === '@supabase/supabase-js' && !ALLOWED_SUPABASE_FILES.has(relNorm)) {
        report(
          node,
          'G5',
          `'@supabase/supabase-js' の直接インポートは storage-client.ts のみ許可されています`,
        );
      }
      if (
        isUseClient &&
        (mod.includes('/lib/db') ||
          mod.includes('/lib/crypto') ||
          mod.includes('/lib/api') ||
          mod === 'pg' ||
          mod === '@supabase/supabase-js')
      ) {
        report(
          node,
          'G5',
          `Client Component ('use client') からサーバー専用モジュール '${mod}' をインポートできません`,
        );
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { file: relNorm, violations };
}

function runCli() {
  const files = SCAN_ROOTS.flatMap((dir) => collectFiles(dir));
  const allViolations = [];
  for (const file of files) {
    const code = fs.readFileSync(file, 'utf8');
    const res = scanSourceText(code, file);
    allViolations.push(...res.violations);
  }

  if (allViolations.length > 0) {
    console.error(`\n[check-no-fallback] ${allViolations.length} 件のガードレール違反を検出しました:\n`);
    for (const v of allViolations) {
      console.error(`  ${v.file}:${v.line}:${v.col} [${v.rule}] ${v.message}`);
    }
    process.exit(1);
  }

  console.log(`[check-no-fallback] OK (${files.length} ファイルを検査、違反 0 件)`);
}

const isMainScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMainScript) {
  runCli();
}
