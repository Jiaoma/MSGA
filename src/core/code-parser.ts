/**
 * MSGA Tree-sitter Code Parser
 * Provides AST-level code understanding for SLM-optimized tools
 * Replaces regex-based function/class extraction with precise parsing
 */

import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import Python from 'tree-sitter-python';

type LanguageName = 'typescript' | 'tsx' | 'python';

const LANGUAGES: Record<string, any> = {
  typescript: TypeScript.typescript,
  tsx: TypeScript.tsx,
  python: Python,
};

function detectLanguage(file: string): LanguageName | null {
  if (file.endsWith('.tsx')) return 'tsx';
  if (file.endsWith('.ts') || file.endsWith('.js')) return 'typescript';
  if (file.endsWith('.py')) return 'python';
  return null;
}

export interface SymbolInfo {
  name: string;
  kind: 'function' | 'class' | 'method' | 'variable' | 'import';
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
  text: string;
  children?: SymbolInfo[];
}

export interface CodeStructure {
  language: LanguageName;
  symbols: SymbolInfo[];
  imports: Array<{ module: string; items: string[] }>;
  exports: string[];
}

/**
 * Parse a file and extract its code structure
 */
export function parseFile(filePath: string, content: string): CodeStructure | null {
  const lang = detectLanguage(filePath);
  if (!lang) return null;

  const parser = new Parser();
  parser.setLanguage(LANGUAGES[lang]);

  const tree = parser.parse(content);
  if (!tree) return null;

  const symbols: SymbolInfo[] = [];
  const imports: Array<{ module: string; items: string[] }> = [];
  const exports: string[] = [];

  function walk(node: any, depth = 0) {
    if (depth > 20) return; // safety limit

    switch (node.type) {
      // Functions
      case 'function_declaration':
      case 'function_definition': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          symbols.push(makeSymbol(nameNode.text, 'function', node, content));
        }
        break;
      }
      case 'arrow_function':
      case 'lambda': {
        // Only capture named arrow functions (const name = () => ...)
        const parent = node.parent;
        if (parent?.type === 'variable_declarator') {
          const nameNode = parent.childForFieldName('name');
          if (nameNode) {
            symbols.push(makeSymbol(nameNode.text, 'function', node, content));
          }
        }
        break;
      }
      // Classes
      case 'class_declaration':
      case 'class_definition': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const classSym = makeSymbol(nameNode.text, 'class', node, content);
          // Extract methods
          const body = node.childForFieldName('body');
          if (body) {
            classSym.children = [];
            for (const child of body.children) {
              if (child.type === 'method_definition' || child.type === 'function_definition') {
                const methodName = child.childForFieldName('name');
                if (methodName) {
                  classSym.children.push(makeSymbol(methodName.text, 'method', child, content));
                }
              }
            }
          }
          symbols.push(classSym);
        }
        break;
      }
      // Imports
      case 'import_statement':
      case 'import_declaration': {
        const importInfo = extractImport(node, content);
        if (importInfo) imports.push(importInfo);
        break;
      }
      // Exports
      case 'export_statement':
      case 'export_default_declaration': {
        const name = findExportName(node);
        if (name) exports.push(name);
        break;
      }
    }

    for (const child of node.children) {
      walk(child, depth + 1);
    }
  }

  walk(tree.rootNode);

  return { language: lang, symbols, imports, exports };
}

/**
 * Find a specific function/class by name and return its text
 */
export function findSymbol(filePath: string, content: string, name: string): SymbolInfo | null {
  const structure = parseFile(filePath, content);
  if (!structure) return null;

  for (const sym of structure.symbols) {
    if (sym.name === name) return sym;
    if (sym.children) {
      for (const child of sym.children) {
        if (child.name === name) return child;
      }
    }
  }
  return null;
}

/**
 * Get all symbols that reference a given file or its symbols
 */
export function findReferences(filePath: string, content: string, symbolName: string): Array<{ file: string; line: number; text: string }> {
  const refs: Array<{ file: string; line: number; text: string }> = [];
  const lines = content.split('\n');
  const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  for (let i = 0; i < lines.length; i++) {
    if (new RegExp(`\\b${escaped}\\b`).test(lines[i])) {
      refs.push({ file: filePath, line: i + 1, text: lines[i].trim() });
    }
  }

  return refs;
}

// --- Helpers ---

function makeSymbol(name: string, kind: SymbolInfo['kind'], node: any, content: string): SymbolInfo {
  const startRow = node.startPosition.row;
  const endRow = node.endPosition.row;
  const lines = content.split('\n');
  const text = lines.slice(startRow, endRow + 1).join('\n');

  return {
    name,
    kind,
    startRow: startRow + 1, // 1-indexed
    endRow: endRow + 1,
    startCol: node.startPosition.column,
    endCol: node.endPosition.column,
    text,
  };
}

function extractImport(node: any, content: string): { module: string; items: string[] } | null {
  const text = node.text;

  // TS: import { a, b } from 'module'
  const tsMatch = text.match(/import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/);
  if (tsMatch) {
    return {
      module: tsMatch[2],
      items: tsMatch[1].split(',').map((s: any) => s.trim()).filter(Boolean),
    };
  }

  // TS: import X from 'module'
  const defaultMatch = text.match(/import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/);
  if (defaultMatch) {
    return { module: defaultMatch[2], items: [defaultMatch[1]] };
  }

  // Python: from module import a, b
  const pyMatch = text.match(/from\s+([\w.]+)\s+import\s+(.+)/);
  if (pyMatch) {
    return {
      module: pyMatch[1],
      items: pyMatch[2].split(',').map((s: any) => s.trim()).filter(Boolean),
    };
  }

  return null;
}

function findExportName(node: any): string | null {
  for (const child of node.children) {
    if (child.childForFieldName('name')) {
      return child.childForFieldName('name').text;
    }
  }
  return null;
}
