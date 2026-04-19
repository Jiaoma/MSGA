/**
 * MSGA Output Validator
 * Validates and auto-fixes SLM output to handle format compliance issues.
 * Research finding: SLM's biggest weakness is output format compliance, not semantic understanding.
 */

import { z } from 'zod';

export interface ValidationError {
  path: string;
  expected: string;
  actual: string;
  fixed: boolean;
}

export interface ValidationResult<T = unknown> {
  valid: boolean;
  data?: T;
  fixed: boolean;
  errors: ValidationError[];
  rawOutput: string;
}

/**
 * Common JSON fixes for SLM output
 */
function fixJsonSyntax(input: string): string {
  let fixed = input.trim();

  // Remove markdown code fences
  fixed = fixed.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');

  // Remove trailing commas before } or ]
  fixed = fixed.replace(/,\s*([}\]])/g, '$1');

  // Add missing quotes around keys
  fixed = fixed.replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":');

  // Fix single quotes to double quotes
  fixed = fixed.replace(/'/g, '"');

  // Fix missing closing braces
  const opens = (fixed.match(/{/g) || []).length;
  const closes = (fixed.match(/}/g) || []).length;
  if (opens > closes) {
    fixed += '}'.repeat(opens - closes);
  }

  const openBrackets = (fixed.match(/\[/g) || []).length;
  const closeBrackets = (fixed.match(/]/g) || []).length;
  if (openBrackets > closeBrackets) {
    fixed += ']'.repeat(openBrackets - closeBrackets);
  }

  return fixed;
}

/**
 * Extract JSON from text that may contain other content
 */
function extractJson(input: string): string {
  // Try to find JSON block in text
  const jsonMatch = input.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (jsonMatch) return jsonMatch[0];
  return input;
}

/**
 * Try to parse and validate tool call arguments
 */
export function validateToolCallArgs(
  argsString: string,
  schema?: z.ZodType
): ValidationResult {
  const errors: ValidationError[] = [];
  let data: unknown;
  let fixed = false;

  // Step 1: Fix common JSON issues
  let processed = fixJsonSyntax(argsString);

  // Step 2: Try parse
  try {
    data = JSON.parse(processed);
  } catch {
    // Step 3: Try extracting JSON from surrounding text
    processed = extractJson(processed);
    try {
      data = JSON.parse(processed);
      fixed = true;
    } catch (e) {
      return {
        valid: false,
        fixed: false,
        errors: [
          {
            path: '$',
            expected: 'valid JSON',
            actual: argsString.slice(0, 100),
            fixed: false,
          },
        ],
        rawOutput: argsString,
      };
    }
  }

  // Step 4: Schema validation if provided
  if (schema) {
    const result = schema.safeParse(data);
    if (!result.success) {
      for (const issue of result.error.issues) {
        errors.push({
          path: issue.path.join('.'),
          expected: 'valid',
          actual: 'invalid',
          fixed: false,
        });
      }

      // Try to auto-fix by providing defaults for missing fields
      if (data && typeof data === 'object') {
        const fixedData = applyDefaults(data as Record<string, unknown>, schema);
        const recheck = schema.safeParse(fixedData);
        if (recheck.success) {
          return {
            valid: true,
            data: recheck.data,
            fixed: true,
            errors: errors.map(e => ({ ...e, fixed: true })),
            rawOutput: argsString,
          };
        }
      }

      return { valid: false, fixed: false, errors, rawOutput: argsString };
    }
    data = result.data;
  }

  return {
    valid: true,
    data,
    fixed,
    errors: [],
    rawOutput: argsString,
  };
}

/**
 * Apply default values from Zod schema to fix missing fields
 */
function applyDefaults(
  data: Record<string, unknown>,
  schema: z.ZodType
): Record<string, unknown> {
  // Simple default application for object schemas
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape;
    const result = { ...data };
    for (const [key, fieldSchema] of Object.entries(shape)) {
      if (!(key in result)) {
        if (fieldSchema instanceof z.ZodString) {
          result[key] = '';
        } else if (fieldSchema instanceof z.ZodNumber) {
          result[key] = 0;
        } else if (fieldSchema instanceof z.ZodBoolean) {
          result[key] = false;
        } else if (fieldSchema instanceof z.ZodArray) {
          result[key] = [];
        } else if (fieldSchema instanceof z.ZodOptional) {
          result[key] = undefined;
        }
      }
    }
    return result;
  }
  return data;
}

/**
 * Validate a complete tool call response
 */
export function validateToolCall(
  toolCall: { name: string; arguments: string },
  toolSchemas: Map<string, z.ZodType>
): { valid: boolean; name: string; args: unknown; fixed: boolean } {
  const schema = toolSchemas.get(toolCall.name);

  if (!schema) {
    // Try fuzzy match on tool name
    const names = Array.from(toolSchemas.keys());
    const match = names.find(
      n =>
        n.toLowerCase() === toolCall.name.toLowerCase() ||
        levenshtein(n.toLowerCase(), toolCall.name.toLowerCase()) <= 2
    );
    if (match) {
      const result = validateToolCallArgs(toolCall.arguments, toolSchemas.get(match));
      return {
        valid: result.valid,
        name: match,
        args: result.data,
        fixed: true,
      };
    }
    return { valid: false, name: toolCall.name, args: null, fixed: false };
  }

  const result = validateToolCallArgs(toolCall.arguments, schema);
  return {
    valid: result.valid,
    name: toolCall.name,
    args: result.data,
    fixed: result.fixed,
  };
}

function levenshtein(a: string, b: string): number {
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      matrix[i][j] =
        b[i - 1] === a[j - 1]
          ? matrix[i - 1][j - 1]
          : Math.min(
              matrix[i - 1][j - 1] + 1,
              matrix[i][j - 1] + 1,
              matrix[i - 1][j] + 1
            );
    }
  }
  return matrix[b.length][a.length];
}
