import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

function callEnd(src: string, open: number): number {
	let depth = 0;
	for (let i = open; i < src.length; i += 1) {
		const ch = src[i];
		if (ch === "(") depth += 1;
		else if (ch === ")") {
			depth -= 1;
			if (depth === 0) return i + 1;
		}
	}
	throw new Error("unbalanced parentheses while scanning setInterval call");
}

test("every setInterval in index.ts is unref'd", () => {
	const calls = [...source.matchAll(/^[ \t]*setInterval\(/gm)];
	assert.ok(calls.length > 0, "expected at least one setInterval in index.ts");

	for (const call of calls) {
		const open = call.index + call[0].length - 1;
		const after = source.slice(callEnd(source, open)).trimStart();
		assert.ok(
			after.startsWith(".unref("),
			`setInterval at offset ${call.index} is not unref'd — this pins the event ` +
				`loop and makes headless runs hang instead of exiting`,
		);
	}
});
