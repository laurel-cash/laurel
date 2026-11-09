/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_hooks.test.tsx -- a sheet's action starts each opening clean: the
// error it failed with last time is not on the fresh sheet

import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useAction } from "./ui_hooks";

describe( "useAction", () => {
	it( "forgets a failure when its sheet opens again", async () => {
		const { result, rerender } = renderHook( ( props: { open: boolean } ) => useAction( async () => { throw new Error( "wrong password" ); }, props.open ), { initialProps: { open: true } } );

		await act( async () => { await result.current.run(); } );
		expect( result.current.error?.message ).toBe( "wrong password" );

		rerender( { open: false } );
		expect( result.current.error?.message ).toBe( "wrong password" );		// still there while it closes
		rerender( { open: true } );
		expect( result.current.error ).toBeNull();
	} );
} );
