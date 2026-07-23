import { describe, expect, it } from "vitest";
import { clamp } from "../src/calc.js";

describe("clamp", () => {
	it("keeps values inside the range", () => {
		expect(clamp(5, 0, 10)).toBe(5);
	});

	it("uses the minimum for values below range", () => {
		expect(clamp(-5, 0, 10)).toBe(0);
	});

	it("uses the maximum for values above range", () => {
		expect(clamp(15, 0, 10)).toBe(10);
	});
});
