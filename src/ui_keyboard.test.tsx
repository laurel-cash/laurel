/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// ui_keyboard.test.tsx -- a sheet, as a keyboard meets it: opened with
// Enter, focus inside it and kept there (Tab never wanders behind it),
// Escape closes it, and focus goes back where it came from. Every sheet
// is a UI_Sheet, so this is every sheet.

import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { UI_Sheet, UI_SheetButtons } from "./ui_widgets";

afterEach( cleanup );

function Host() {
	const [ open, setOpen ] = useState( false );
	return (
		<>
			<button onClick={() => setOpen( true )}>Open</button>
			<button>Behind</button>
			<UI_Sheet open={open} onOpenChange={setOpen} title="A sheet">
				<label htmlFor="one">One</label>
				<input id="one" />
				<UI_SheetButtons action={{ label: "Do it", onRun: () => {} }} busy={false} onCancel={() => setOpen( false )} />
			</UI_Sheet>
		</>
	);
}

describe( "a sheet and the keyboard", () => {
	it( "keeps focus inside, closes on Escape, and gives focus back", async () => {
		const user = userEvent.setup();
		render( <Host /> );

		await user.tab();
		expect( document.activeElement ).toBe( screen.getByRole( "button", { name: "Open" } ) );
		await user.keyboard( "{Enter}" );

		const dialog = await screen.findByRole( "dialog", { name: "A sheet" } );
		expect( document.activeElement, "focus on its first field, to type into" ).toBe( screen.getByLabelText( "One" ) );
		for ( let i = 0; i < 8; i++ ) {
			await user.tab();
			expect( dialog.contains( document.activeElement ), `Tab ${i + 1} stays inside` ).toBe( true );
		}

		await user.keyboard( "{Escape}" );
		await waitFor( () => expect( screen.queryByRole( "dialog" ) ).toBeNull() );		// once it has animated out
		expect( document.activeElement, "focus back on what opened it" ).toBe( screen.getByRole( "button", { name: "Open" } ) );
	} );
} );
