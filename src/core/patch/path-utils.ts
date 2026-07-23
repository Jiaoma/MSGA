import path from "node:path";

export function normalizeRelativePath(file: string, cwd: string): string {
	const normalized = file.replace(/\\/g, "/");
	if (path.isAbsolute(normalized)) {
		return path.relative(cwd, normalized).replace(/\\/g, "/");
	}
	return normalized.replace(/^\.\//, "");
}

export function resolveInsideCwd(file: string, cwd: string): string | null {
	const resolved = path.resolve(cwd, file);
	const relative = path.relative(cwd, resolved);
	if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
	return resolved;
}

export function unique<T>(items: T[]): T[] {
	return Array.from(new Set(items));
}

export function isTestFile(file: string): boolean {
	const f = file.replace(/\\/g, "/");
	return f.startsWith("tests/") || /\.(test|spec)\.[cm]?[tj]sx?$/.test(f);
}

export function isConfigFile(file: string): boolean {
	const f = file.replace(/\\/g, "/");
	return (
		f === "package.json" ||
		f === "package-lock.json" ||
		f === "tsconfig.json" ||
		f === "biome.json" ||
		f === ".eslintrc" ||
		f.startsWith(".github/") ||
		f.endsWith(".config.js") ||
		f.endsWith(".config.ts") ||
		f.endsWith(".config.mjs")
	);
}

export function isDependencyFile(file: string): boolean {
	const f = file.replace(/\\/g, "/");
	return (
		f === "package-lock.json" ||
		f === "yarn.lock" ||
		f === "pnpm-lock.yaml" ||
		f === "bun.lockb" ||
		f === "package.json"
	);
}

export function isGeneratedOrVendorPath(file: string): boolean {
	const f = file.replace(/\\/g, "/");
	return (
		f.startsWith("node_modules/") ||
		f.startsWith("dist/") ||
		f.startsWith("coverage/") ||
		f.startsWith(".git/")
	);
}

export function isSourceLikeFile(file: string): boolean {
	return (
		/\.[cm]?[tj]sx?$/.test(file) &&
		!isTestFile(file) &&
		!isGeneratedOrVendorPath(file)
	);
}

export function filterEditableFiles(
	files: string[],
	opts: {
		cwd: string;
		allowTestEdits: boolean;
		allowConfigEdits: boolean;
		allowDependencyEdits: boolean;
	},
): { allowed: string[]; disallowed: string[] } {
	const allowed: string[] = [];
	const disallowed: string[] = [];
	for (const file of unique(
		files.map((f) => normalizeRelativePath(f, opts.cwd)),
	).filter(Boolean)) {
		const forbidden =
			isGeneratedOrVendorPath(file) ||
			(!opts.allowTestEdits && isTestFile(file)) ||
			(!opts.allowConfigEdits && isConfigFile(file)) ||
			(!opts.allowDependencyEdits && isDependencyFile(file));
		if (forbidden) disallowed.push(file);
		else allowed.push(file);
	}
	return { allowed: unique(allowed), disallowed: unique(disallowed) };
}
