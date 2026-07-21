export type PatchLoopState =
	| "planning"
	| "validating"
	| "diagnosing"
	| "intent_reviewing"
	| "patching"
	| "diff_reviewing"
	| "revalidating"
	| "regression_checking"
	| "succeeded"
	| "failed"
	| "stopped";

export type FailureType =
	| "test_failure"
	| "type_error"
	| "lint_error"
	| "build_error"
	| "runtime_error"
	| "command_error"
	| "unknown";

export type PatchChangeType =
	| "bug_fix"
	| "type_fix"
	| "test_fix"
	| "lint_fix"
	| "build_fix"
	| "dependency_fix"
	| "unknown";

export type PatchOperation =
	| "edit_function"
	| "add_guard"
	| "adjust_type"
	| "update_import"
	| "add_test"
	| "update_test"
	| "update_config"
	| "rename_symbol"
	| "small_refactor"
	| "dependency_fix";

export type RiskLevel = "low" | "medium" | "high";
export type Confidence = "high" | "medium" | "low";
export type PatchIntentDecision =
	| "auto_approve"
	| "needs_confirmation"
	| "reject";
export type RegressionVerdict = "improved" | "unchanged" | "regressed";
export type PatchOutcome = "success" | "failed" | "stopped" | "regressed";

export interface PatchOptions {
	goal?: string;
	checks: string[];
	maxRounds: number;
	dryRun: boolean;
	nonInteractive: boolean;
	json: boolean;
	allowTestEdits: boolean;
	allowConfigEdits: boolean;
	allowDependencyEdits: boolean;
	cwd: string;
	maxChangedFiles: number;
	maxChangedLines: number;
	saveTrace: boolean;
}

export interface ValidationResult {
	command: string;
	success: boolean;
	exitCode: number | null;
	durationMs: number;
	stdoutSummary: string;
	stderrSummary: string;
	rawStdout?: string;
	rawStderr?: string;
	failingFiles: string[];
	failingTests: string[];
	primaryError: string;
}

export interface FailingTest {
	name: string;
	file?: string;
	line?: number;
	message?: string;
}

export interface Diagnostic {
	file?: string;
	line?: number;
	column?: number;
	code?: string;
	message: string;
	source:
		| "typescript"
		| "vitest"
		| "jest"
		| "biome"
		| "eslint"
		| "node"
		| "npm"
		| "unknown";
}

export interface FailureEvidence {
	kind: "stdout" | "stderr" | "stack" | "test" | "diagnostic";
	text: string;
}

export interface FailureModelSupplement {
	suspectedCause: string;
	repairHint: string;
	riskNotes: string[];
	candidateFiles?: Array<{
		file: string;
		reason: string;
		confidence: Confidence;
	}>;
}

export interface FailureReport {
	source: "rule" | "rule+model" | "model_fallback";
	failureType: FailureType;
	command: string;
	exitCode: number | null;
	primaryError: string;
	failingTests: FailingTest[];
	diagnostics: Diagnostic[];
	evidence: FailureEvidence[];
	suspectedFiles: string[];
	allowedFilesToEdit: string[];
	disallowedFiles: string[];
	disallowedActions: string[];
	modelSupplement?: FailureModelSupplement;
	confidence: Confidence;
}

export interface PatchIntent {
	targetFiles: string[];
	changeType: PatchChangeType;
	reason: string;
	expectedEffect: string;
	failureEvidence: string[];
	allowedOperations: PatchOperation[];
	forbiddenOperations: string[];
	riskLevel: RiskLevel;
	maxChangedFiles: number;
	maxChangedLines?: number;
}

export interface PatchIntentReview {
	decision: PatchIntentDecision;
	riskScore: number;
	reasons: string[];
	violations: string[];
	requiredFlags: Array<
		"allow_test_edits" | "allow_config_edits" | "allow_dependency_edits"
	>;
	normalizedIntent?: PatchIntent;
}

export interface ProposedPatch {
	edits: TextEdit[];
}

export interface TextEdit {
	file: string;
	oldText: string;
	newText: string;
	reason: string;
}

export interface AppliedPatch {
	changedFiles: string[];
	addedLines: number;
	deletedLines: number;
	dryRun: boolean;
}

export interface Snapshot {
	files: Map<string, string>;
}

export interface DiffGuardResult {
	approved: boolean;
	changedFiles: string[];
	addedLines: number;
	deletedLines: number;
	violations: string[];
}

export interface RegressionCheck {
	previousFailingCount: number;
	currentFailingCount: number;
	newFailures: string[];
	fixedFailures: string[];
	changedFilesDelta: string[];
	verdict: RegressionVerdict;
}

export interface PatchTraceIteration {
	round: number;
	state: PatchLoopState;
	validationResult?: ValidationResult;
	failureReport?: FailureReport;
	patchIntent?: PatchIntent;
	patchIntentReview?: PatchIntentReview;
	proposedPatch?: ProposedPatch;
	appliedPatch?: AppliedPatch;
	diffGuard?: DiffGuardResult;
	validationAfterPatch?: ValidationResult;
	regressionCheck?: RegressionCheck;
	changedFiles: string[];
	decision: "success" | "continue" | "stop" | "escalate";
	stopReason?: string;
}

export interface PatchTrace {
	goal?: string;
	checks: string[];
	baselineValidation: ValidationResult[];
	iterations: PatchTraceIteration[];
	finalOutcome: PatchOutcome;
	stopReason?: string;
	tracePath?: string;
}

export interface PatchCallbacks {
	onStatus?: (message: string) => void;
	onValidation?: (result: ValidationResult) => void;
	onFailureReport?: (report: FailureReport) => void;
	onIntent?: (intent: PatchIntent, review: PatchIntentReview) => void;
	onPatchApplied?: (applied: AppliedPatch, diffGuard: DiffGuardResult) => void;
	onStop?: (reason: string) => void;
	confirm?: (
		review: PatchIntentReview,
		intent: PatchIntent,
		report: FailureReport,
	) => Promise<boolean>;
}

export const DEFAULT_PATCH_CONFIG = {
	maxRounds: 3,
	maxChangedFiles: 2,
	maxChangedLines: 40,
	allowTestEdits: false,
	allowConfigEdits: false,
	allowDependencyEdits: false,
	saveTrace: true,
} as const;

export const SAFE_OPERATIONS: PatchOperation[] = [
	"edit_function",
	"add_guard",
	"adjust_type",
	"update_import",
];
