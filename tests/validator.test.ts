import { describe, it, expect } from 'vitest';
import { validateToolCallArgs, validateToolCall } from '../src/core/validator.js';
import { z } from 'zod';

describe('OutputValidator', () => {
  describe('validateToolCallArgs', () => {
    it('should parse valid JSON', () => {
      const result = validateToolCallArgs('{"file": "src/test.ts", "name": "foo"}');
      expect(result.valid).toBe(true);
      expect(result.data).toEqual({ file: 'src/test.ts', name: 'foo' });
    });

    it('should fix trailing commas', () => {
      const result = validateToolCallArgs('{"file": "src/test.ts", "name": "foo",}');
      expect(result.valid).toBe(true);
      // trailing comma is fixed silently during parsing
    });

    it('should fix markdown code fences', () => {
      const result = validateToolCallArgs('```json\n{"file": "test.ts"}\n```');
      expect(result.valid).toBe(true);
    });

    it('should fix single quotes', () => {
      const result = validateToolCallArgs("{'file': 'test.ts'}");
      expect(result.valid).toBe(true);
    });

    it('should reject invalid JSON', () => {
      const result = validateToolCallArgs('not json at all {{{{');
      expect(result.valid).toBe(false);
    });

    it('should validate against Zod schema', () => {
      const schema = z.object({
        file: z.string(),
        name: z.string(),
      });
      const result = validateToolCallArgs('{"file": "test.ts"}', schema);
      // Validator auto-fills missing string fields with ''
      expect(result.valid).toBe(true);
      expect(result.fixed).toBe(true);
    });
  });

  describe('validateToolCall', () => {
    it('should fuzzy match tool names', () => {
      const schemas = new Map<string, z.ZodType>();
      schemas.set('read_function', z.object({ file: z.string(), name: z.string() }));

      const result = validateToolCall(
        { name: 'read_funciton', arguments: '{"file":"test.ts","name":"foo"}' },
        schemas
      );
      expect(result.valid).toBe(true);
      expect(result.name).toBe('read_function');
      expect(result.fixed).toBe(true);
    });
  });
});
