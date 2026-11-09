/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// main.rs -- process entry point

// no console window behind the app in release builds, DO NOT REMOVE
#![cfg_attr( not( debug_assertions ), windows_subsystem = "windows" )]

fn main() {
	laurel_lib::Sys_Run()
}
