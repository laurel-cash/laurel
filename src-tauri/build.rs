/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// build.rs -- tauri's build step, and the one windows manifest every
// binary gets

#![allow( unused_parens )]		// the codebase's if ( ... ), as in lib.rs

const MANIFEST_RC: &str = "windows-manifest.rc";

/*
==================
main

tauri-build would put its manifest (Common-Controls v6) into the app
binary only. The unit-test runner links the same webview code and needs
it too, or it dies at start with STATUS_ENTRYPOINT_NOT_FOUND. So tauri's
is switched off and embed-resource compiles the same manifest into
everything: one manifest per binary, app and tests alike, and no
dependency on mt.exe being on the path.
==================
*/
fn main() {
	let windows = tauri_build::WindowsAttributes::new_without_app_manifest();

	tauri_build::try_build( tauri_build::Attributes::new().windows_attributes( windows ) )
		.expect( "build.rs: tauri build step failed" );

	if ( std::env::var( "CARGO_CFG_TARGET_OS" ).as_deref() != Ok( "windows" ) ) {
		return;
	}
	println!( "cargo:rerun-if-changed={}", MANIFEST_RC );
	println!( "cargo:rerun-if-changed=windows-app-manifest.xml" );
	embed_resource::compile_for_everything( MANIFEST_RC, embed_resource::NONE )
		.manifest_optional()
		.expect( "build.rs: embedding the windows manifest failed" );
}
