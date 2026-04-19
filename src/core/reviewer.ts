/**
 * MSGA Code Reviewer - Structured code review with SLM-friendly output
 * Uses reviewer model role (14-30B) for deeper analysis
 */

import type { ModelProvider } from '../models/provider.js';
import { ContextManager, DEFAULT_BUDGET } from '../context/manager.js';
import type { Message } from '../context/manager.js';

const REVIEW_SYSTEM_PROMPT = `You are a code reviewer. Analyze the provided code and return a structured review.

Output ONLY valid JSON:
{
  "score": 1-10,
  "issues": [
    { "severity": "error|warning|info", "file": "path", "line": 0, "message": "description", "suggestion": "fix" }
  ],
  "strengths": ["what's good"],
  "summary": "brief overall assessment"
}

Focus on: bugs, security, performance, readability, error handling. Be specific.`;

export interface ReviewIssue {
  severity: 'error' | 'warning' | 'info';
  file: string;
  line: number;
  message: string;
  suggestion: string;
}

export interface ReviewResult {
  score: number;
  issues: ReviewIssue[];
  strengths: string[];
  summary: string;
}

export interface ReviewCallbacks {
  onProgress?: (message: string) => void;
  onFileReviewed?: (file: string, issues: ReviewIssue[]) => void;
}

/**
 * Review a single file
 */
export async function reviewFile(
  filePath: string,
  content: string,
  provider: ModelProvider,
  callbacks?: ReviewCallbacks
): Promise<ReviewResult> {
  callbacks?.onProgress?.(`Reviewing ${filePath}...`);

  const ctx = new ContextManager({ ...DEFAULT_BUDGET, total: 4000, fileContext: 2500 });
  const messages: Message[] = ctx.buildMessages(
    REVIEW_SYSTEM_PROMPT,
    `Review this file: ${filePath}`,
    content
  );

  const response = await provider.chat(messages, []);
  const raw = response.content || '';

  return parseReviewResult(raw, filePath);
}

/**
 * Review multiple files and aggregate results
 */
export async function reviewProject(
  files: Array<{ path: string; content: string }>,
  provider: ModelProvider,
  callbacks?: ReviewCallbacks
): Promise<ReviewResult> {
  const allIssues: ReviewIssue[] = [];
  const allStrengths: string[] = [];
  let totalScore = 0;

  // Review each file
  for (const file of files) {
    const result = await reviewFile(file.path, file.content, provider, callbacks);
    allIssues.push(...result.issues);
    allStrengths.push(...result.strengths);
    totalScore += result.score;
    callbacks?.onFileReviewed?.(file.path, result.issues);
  }

  const avgScore = files.length > 0 ? Math.round(totalScore / files.length) : 0;

  // Generate cross-file summary
  const crossFileSummary = await generateCrossFileSummary(allIssues, allStrengths, provider);

  return {
    score: avgScore,
    issues: allIssues.sort((a, b) => {
      const priority = { error: 0, warning: 1, info: 2 };
      return priority[a.severity] - priority[b.severity];
    }),
    strengths: allStrengths,
    summary: crossFileSummary,
  };
}

async function generateCrossFileSummary(
  issues: ReviewIssue[],
  strengths: string[],
  provider: ModelProvider
): Promise<string> {
  const errors = issues.filter(i => i.severity === 'error').length;
  const warnings = issues.filter(i => i.severity === 'warning').length;

  const parts: string[] = [];
  if (errors > 0) parts.push(`${errors} error(s)`);
  if (warnings > 0) parts.push(`${warnings} warning(s)`);
  if (parts.length === 0) parts.push('No critical issues');

  return parts.join(', ') + `. ${strengths.length} strength(s) noted.`;
}

function parseReviewResult(raw: string, filePath: string): ReviewResult {
  // Try to extract JSON
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return {
      score: 5,
      issues: [],
      strengths: [],
      summary: raw.slice(0, 300),
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      score: typeof parsed.score === 'number' ? parsed.score : 5,
      issues: (parsed.issues || []).map((i: any) => ({
        severity: i.severity || 'info',
        file: i.file || filePath,
        line: i.line || 0,
        message: i.message || '',
        suggestion: i.suggestion || '',
      })),
      strengths: parsed.strengths || [],
      summary: parsed.summary || '',
    };
  } catch {
    return { score: 5, issues: [], strengths: [], summary: raw.slice(0, 300) };
  }
}
