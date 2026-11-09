/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// eslint.config.mjs -- only rules that are Laurel's own rules, each added
// after a bug the compiler couldn't see (npm run lint:ui, in npm run check)

import tseslint from "typescript-eslint";
import jsxA11y from "eslint-plugin-jsx-a11y";

export default tseslint.config(
	{
		files:				[ "src/**/*.{ts,tsx}" ],
		ignores:			[ "src/bindings.ts" ],
		languageOptions:	{
			parser:			tseslint.parser,
			parserOptions:	{ projectService: true, tsconfigRootDir: import.meta.dirname },
		},
		plugins:			{ "@typescript-eslint": tseslint.plugin, "jsx-a11y": jsxA11y },
		rules:				{
			// what a keyboard or a screen reader can't use, seen as the markup is written
			// (axe checks what tests render, test_setup.ts; this checks what they don't reach)
			...jsxA11y.flatConfigs.recommended.rules,
			// every autofocus is the one field of a sheet, a lock screen or a flow's step:
			// moving focus into a dialog is what the WAI-ARIA dialog pattern asks for
			"jsx-a11y/no-autofocus":	"off",
			// nothing becomes text by accident: an error object once showed as
			// "[object Object]" through join() and a template string
			"@typescript-eslint/no-base-to-string":				[ "error", { checkUnknown: true } ],
			// a rejected promise's reason is unknown, not any, so the rule above sees it
			"@typescript-eslint/use-unknown-in-catch-callback-variable":	"error",
			"@typescript-eslint/restrict-template-expressions":	[ "error", { allowNumber: true } ],
			// every case of a union is decided, never defaulted (STYLE.md)
			"@typescript-eslint/switch-exhaustiveness-check":	[ "error", { considerDefaultExhaustiveForUnions: true } ],
		},
	},
);
