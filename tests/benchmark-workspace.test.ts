import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	loadFixture,
	prepareWorkspace,
	safeName,
} from "../benchmarks/workspace.js";

describe("benchmark workspace", () => {
	it("normalizes model names for paths", () => {
		expect(safeName("qwen3:8b")).toBe("qwen3-8b");
	});

	it("loads fixture manifests", async () => {
		const fixture = await loadFixture(
			path.join(process.cwd(), "benchmarks/fixtures/simple-ts-bug"),
		);
		expect(fixture.id).toBe("simple-ts-bug");
		expect(fixture.checks).toEqual(["npx vitest run"]);
	});

	it("copies fixture repo into isolated workspace", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "msga-bench-"));
		const workspace = await prepareWorkspace({
			runRoot: root,
			fixturePath: path.join(
				process.cwd(),
				"benchmarks/fixtures/simple-ts-bug",
			),
			fixtureId: "simple-ts-bug",
			runner: "msga",
			model: "qwen3:8b",
			repeat: 1,
		});
		const content = await fs.readFile(
			path.join(workspace, "src/calc.ts"),
			"utf-8",
		);
		expect(content).toContain("return min");
	});
});
