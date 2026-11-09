/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// make_notices.mjs -- the third-party notices Laurel ships with
//
// MIT, BSD and Apache licenses ask that their copyright and license text
// travel with the software. This collects, for every package compiled
// into Laurel (Rust: `cargo tree -e normal`; the ui: npm's production
// tree), its license and its own license file, and writes:
//
//   THIRD_PARTY_NOTICES.md		for the source tree
//   src/generated/notices.json	for About > Licenses, loaded on demand
//
// With --check it only compares, and fails if either is stale, so a new
// dependency can't ship without its notice (`npm run check`).
//
//   node scripts/make_notices.mjs [--check]

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CHECK		= process.argv.includes( "--check" );
const MD_OUT	= "THIRD_PARTY_NOTICES.md";
const JSON_OUT	= "src/generated/notices.json";
const SELF		= new Set( [ "laurel", "laurel-engine" ] );		// our own code is under LICENSE

// dual-licensed crates: the permissive text people expect first
const LICENSE_FILES = [ "LICENSE-MIT", "LICENSE-MIT.md", "LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "COPYING", "LICENSE-APACHE", "LICENSE-APACHE.md", "LICENSE-BSD", "UNLICENSE" ];

/*
==================
LicenseText

The license file a package ships, or null. A crate in a workspace may
keep it one folder up (zingolib's does).
==================
*/
function LicenseText( dir ) {
	for ( const d of [ dir, dirname( dir ) ] ) {
		for ( const f of LICENSE_FILES ) {
			const p = join( d, f );
			if ( existsSync( p ) ) {
				return readFileSync( p, "utf8" ).replace( /\r\n/g, "\n" ).trim();
			}
		}
	}
	return null;
}

// the most permissive choice among a dual license's alternatives
const PREFERENCE = [ "MIT", "MIT-0", "Apache-2.0", "BSD-3-Clause", "BSD-2-Clause", "ISC", "Zlib", "0BSD", "Unlicense", "CC0-1.0" ];

const TEMPLATES = {
	"MIT": ( who ) => `Copyright (c) ${who}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,
	"BSD-3-Clause": ( who ) => `Copyright (c) ${who}

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`,
	"BSD-2-Clause": ( who ) => `Copyright (c) ${who}

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`,
	"ISC": ( who ) => `Copyright (c) ${who}

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`,
	"Zlib": ( who ) => `Copyright (c) ${who}

This software is provided 'as-is', without any express or implied
warranty. In no event will the authors be held liable for any damages
arising from the use of this software.

Permission is granted to anyone to use this software for any purpose,
including commercial applications, and to alter it and redistribute it
freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not
   claim that you wrote the original software. If you use this software
   in a product, an acknowledgment in the product documentation would be
   appreciated but is not required.
2. Altered source versions must be plainly marked as such, and must not be
   misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution.`,
};

// Apache-2.0 is long: its exact text is taken from a crate that ships it
function ApacheText( indexes ) {
	for ( const idx of indexes ) {
		for ( const d of readdirSync( idx ).filter( ( n ) => /^serde-1\./.test( n ) ) ) {
			const p = join( idx, d, "LICENSE-APACHE" );
			if ( existsSync( p ) ) {
				return readFileSync( p, "utf8" ).replace( /\r\n/g, "\n" ).trim();
			}
		}
	}
	return null;
}

/*
==================
FallbackText

For a package that ships no license file: the standard text of its
declared license (the most permissive alternative of a dual license),
with its authors named as the package names them
==================
*/
function FallbackText( pkg, apache ) {
	const ids = pkg.license.split( /\s+OR\s+|\/|\s+AND\s+/ ).map( ( s ) => s.replace( /[()]/g, "" ).trim() );
	const id = PREFERENCE.find( ( p ) => ids.includes( p ) );
	const who = `the ${pkg.name} authors`;
	if ( id && TEMPLATES[id] ) {
		return TEMPLATES[id]( who );
	}
	if ( id === "Apache-2.0" && apache ) {
		return apache;
	}
	return null;
}

/*
==================
RustPackages

Every crate compiled into Laurel on any platform: normal dependencies
only (build scripts and tests don't ship)
==================
*/
function RustPackages() {
	const registry = join( homedir(), ".cargo", "registry", "src" );
	const indexes = existsSync( registry ) ? readdirSync( registry ).map( ( d ) => join( registry, d ) ) : [];

	const out = execSync( 'cargo tree -e normal --target all --prefix none -f "{p}|{l}"', { cwd: "src-tauri", encoding: "utf8", maxBuffer: 64 << 20 } );
	const seen = new Map();
	for ( const line of out.split( "\n" ) ) {
		const [ spec, license = "" ] = line.trim().split( "|" );
		if ( !spec ) {
			continue;
		}
		// "name v1.2.3" or "name v1.2.3 (H:\path)"; a trailing "(*)" marks a repeat
		const m = /^(\S+) v(\S+)(?: \(([^)]+)\))?/.exec( spec );
		if ( !m || SELF.has( m[1] ) || seen.has( `${m[1]}@${m[2]}` ) ) {
			continue;
		}
		const path = m[3] && m[3] !== "*" && !m[3].startsWith( "proc-macro" ) ? m[3] : null;
		const dir = path ?? indexes.map( ( i ) => join( i, `${m[1]}-${m[2]}` ) ).find( existsSync );
		seen.set( `${m[1]}@${m[2]}`, { name: m[1], version: m[2], license: license || "unknown", text: dir ? LicenseText( dir ) : null, kind: "rust" } );
	}
	return [ ...seen.values() ];
}

/*
==================
UiPackages

Every package in the ui's production tree
==================
*/
function UiPackages() {
	const out = execSync( "npm ls --omit=dev --all --parseable", { encoding: "utf8", maxBuffer: 64 << 20 } );
	const seen = new Map();
	for ( const dir of out.split( "\n" ).map( ( l ) => l.trim() ).filter( ( l ) => l.includes( "node_modules" ) ) ) {
		const pkg = JSON.parse( readFileSync( join( dir, "package.json" ), "utf8" ) );
		const key = `${pkg.name}@${pkg.version}`;
		if ( !seen.has( key ) ) {
			const license = typeof pkg.license === "string" ? pkg.license : pkg.license?.type ?? "unknown";
			seen.set( key, { name: pkg.name, version: pkg.version, license, text: LicenseText( dir ), kind: "ui" } );
		}
	}
	return [ ...seen.values() ];
}

/*
==================
Build

Identical license texts are written once, with every package that uses
it listed above it
==================
*/
function Build() {
	const all = [ ...RustPackages(), ...UiPackages() ].sort( ( a, b ) => a.name.localeCompare( b.name ) || a.version.localeCompare( b.version ) );
	const registry = join( homedir(), ".cargo", "registry", "src" );
	const apache = ApacheText( existsSync( registry ) ? readdirSync( registry ).map( ( d ) => join( registry, d ) ) : [] );
	for ( const p of all ) {
		p.text ??= FallbackText( p, apache );
	}
	// still none (a license with no template, like MPL-2.0): the text another package
	// under the very same license ships
	for ( const p of all.filter( ( x ) => !x.text ) ) {
		p.text = all.find( ( x ) => x.text && x.license === p.license )?.text ?? null;
	}

	const texts = new Map();		// text -> index
	const packages = all.map( ( p ) => {
		let text = null;
		if ( p.text ) {
			if ( !texts.has( p.text ) ) {
				texts.set( p.text, texts.size );
			}
			text = texts.get( p.text );
		}
		return { name: p.name, version: p.version, license: p.license, kind: p.kind, text };
	} );
	const json = JSON.stringify( { packages, texts: [ ...texts.keys() ] } ) + "\n";

	let md = "# Third-party notices\n\nLaurel includes the following open-source software. Each package's license and notice follow, grouped where the text is the same.\n\n";
	md += "| Package | Version | License |\n|---|---|---|\n";
	for ( const p of packages ) {
		md += `| ${p.name} | ${p.version} | ${p.license} |\n`;
	}
	[ ...texts.keys() ].forEach( ( text, i ) => {
		const users = packages.filter( ( p ) => p.text === i ).map( ( p ) => `${p.name} ${p.version}` );
		md += `\n---\n\n### ${users.join( ", " )}\n\n\`\`\`\n${text}\n\`\`\`\n`;
	} );
	const missing = packages.filter( ( p ) => p.text === null );
	if ( missing.length ) {
		md += `\n---\n\n### Packages that ship no license file\n\nTheir license, as declared by the package, is listed in the table above.\n\n${missing.map( ( p ) => `- ${p.name} ${p.version} (${p.license})` ).join( "\n" )}\n`;
	}
	return { md, json, count: packages.length, texts: texts.size, missing: missing.length };
}

const built = Build();
if ( CHECK ) {
	const stale = [ [ MD_OUT, built.md ], [ JSON_OUT, built.json ] ].filter( ( [ f, want ] ) => !existsSync( f ) || readFileSync( f, "utf8" ) !== want );
	if ( stale.length ) {
		console.error( `make_notices: ${stale.map( ( [ f ] ) => f ).join( ", " )} out of date: run \`npm run notices\`` );
		process.exit( 1 );
	}
	console.log( `make_notices: up to date (${built.count} packages)` );
} else {
	mkdirSync( dirname( JSON_OUT ), { recursive: true } );
	writeFileSync( MD_OUT, built.md );
	writeFileSync( JSON_OUT, built.json );
	console.log( `make_notices: ${built.count} packages, ${built.texts} distinct license texts, ${built.missing} without a license file` );
}
