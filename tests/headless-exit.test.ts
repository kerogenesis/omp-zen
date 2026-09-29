/**
 * Regression guard for the headless-exit bug.
 *
 * An interval that is never unref'd pins Node's event loop, so `pi -p` prints
 * its answer and then hangs forever rather than exiting. That is exactly how
 * pi-zen broke every non-interactive caller — including `fieldtheory classify
 * --engine pi`, where the child produced valid output and was then killed on
 * timeout, so classification failed 100% of the time.
 *
 * This asserts on the source text rather than importing index.ts: index.ts
 * imports "./shared.js", which only pi's loader resolves, so a plain
 * `node --test` process cannot import it. The invariant is narrow enough that
 * checking the source is honest — and it costs no network or subprocess.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

/** Index just past the `setInterval(...)` call whose opening paren is at `open`. */
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
