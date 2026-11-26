/*
===========================================================================
Copyright (C) 2026 The Laurel authors

This file is part of Laurel source code.

Laurel source code is free software, released under the MIT License.
See the LICENSE file for details.
===========================================================================
*/
// w_ios.rs -- what iOS asks of an app that holds money: the page out to the
// screen's edges, a blank card in the app switcher, its folders kept out of
// iCloud backups, time to finish saving once it's out of sight, and a tapped
// notification that opens Laurel. Sys_Run calls Ios_KeepLocal, Ios_Notices
// and Ios_Prepare once; nothing else knows it's on an iPhone
use std::cell::Cell;
use std::path::Path;
use std::ptr::NonNull;
use std::rc::Rc;
use std::sync::atomic::{ AtomicUsize, Ordering };
use std::sync::Arc;

use block2::{ DynBlock, RcBlock };
use objc2::rc::Retained;
use objc2::runtime::{ AnyObject, NSObject, NSObjectProtocol, ProtocolObject };
use objc2::{ define_class, msg_send, ClassType, MainThreadMarker };
use objc2_foundation::{ NSNotification, NSNotificationCenter, NSNotificationName, NSNumber, NSOperationQueue, NSString, NSURL, NSURLIsExcludedFromBackupKey };
use objc2_user_notifications::{ UNNotification, UNNotificationPresentationOptions, UNNotificationResponse, UNUserNotificationCenter, UNUserNotificationCenterDelegate };
use objc2_ui_kit::{
	UIApplication, UIApplicationDidBecomeActiveNotification, UIApplicationDidEnterBackgroundNotification,
	UIApplicationWillResignActiveNotification, UIBackgroundTaskIdentifier, UIBackgroundTaskInvalid, UIColor,
	UIScreenCapturedDidChangeNotification, UIScrollView, UIScrollViewContentInsetAdjustmentBehavior, UIView,
	UIViewAutoresizing,
};

/*
==================
Ios_Prepare

Once, the window open (Sys_MainWindow): on the main thread, the page out
to the edges and the watching
==================
*/
pub fn Ios_Prepare( app: &tauri::AppHandle, window: &tauri::WebviewWindow ) {
	let app = app.clone();
	let prepared = window.with_webview( move |webview| {
		let Some( mtm ) = MainThreadMarker::new() else {
			log::warn!( "Ios_Prepare: not on the main thread" );
			return;
		};
		// SAFETY: on iOS the platform webview is a WKWebView (a UIView), alive with the window
		let Some( page ) = ( unsafe { Retained::retain( webview.inner().cast::< UIView >() ) } ) else {
			log::warn!( "Ios_Prepare: no webview" );
			return;
		};
		Ios_EdgeToEdge( &page );
		Ios_Watch( app, page, mtm );
	} );
	if let Err( e ) = prepared {
		log::warn!( "Ios_Prepare: {}", e.to_string() );
	}
}

/*
==================
Ios_KeepLocal

Out of iCloud and computer backups: a wallet belongs to this phone, and
its recovery phrase is the backup. The mark is on each folder, which
Start Over empties but keeps (Com_ShredTree)
==================
*/
pub fn Ios_KeepLocal( folders: &[ &Path ] ) {
	for folder in folders {
		Ios_KeepFolder( folder );
	}
}

fn Ios_KeepFolder( folder: &Path ) {
	if let Err( e ) = std::fs::create_dir_all( folder ) {
		log::warn!( "Ios_KeepLocal: {}", e.to_string() );
		return;
	}
	let url = NSURL::fileURLWithPath( &NSString::from_str( &folder.to_string_lossy() ) );
	let yes = NSNumber::numberWithBool( true );
	let value: &AnyObject = &yes;
	// SAFETY: the key's value is an NSNumber holding a bool, as Apple documents it
	if let Err( e ) = unsafe { url.setResourceValue_forKey_error( Some( value ), NSURLIsExcludedFromBackupKey ) } {
		log::warn!( "Ios_KeepLocal: {}", e.localizedDescription() );
	}
}

/*
==================
Ios_Notices

Laurel answers for its notifications, not the notification plugin: the
plugin keeps the ones it showed in memory only, and a tap on one after
iOS had ended Laurel found none there and stopped the app (TestFlight
0.3.3 (8): "crashed after idle and reopening"). Laurel only shows them
(N_Show): one while it's open shows as a banner, a tap opens it. Once,
in setup, after the plugin has made itself the delegate and before iOS
hands over the tap that launched the app
==================
*/
pub fn Ios_Notices() {
	// SAFETY: +new on an NSObject subclass with no ivars
	let notices: Retained< Ios_Notices_t > = unsafe { msg_send![ Ios_Notices_t::class(), new ] };
	UNUserNotificationCenter::currentNotificationCenter().setDelegate( Some( ProtocolObject::from_ref( &*notices ) ) );
	std::mem::forget( notices );		// the center holds its delegate weakly: Laurel's, for the life of the process
}

define_class!(
	// SAFETY: NSObject has no subclassing requirements, and this adds no ivars and no Drop
	#[unsafe( super( NSObject ) )]
	#[name = "LaurelNotices"]
	struct Ios_Notices_t;

	unsafe impl NSObjectProtocol for Ios_Notices_t {}

	unsafe impl UNUserNotificationCenterDelegate for Ios_Notices_t {
		#[unsafe( method( userNotificationCenter:willPresentNotification:withCompletionHandler: ) )]
		fn Present( &self, _center: &UNUserNotificationCenter, _notice: &UNNotification, done: &DynBlock< dyn Fn( UNNotificationPresentationOptions ) > ) {
			done.call( ( UNNotificationPresentationOptions::Banner | UNNotificationPresentationOptions::List | UNNotificationPresentationOptions::Sound, ) );
		}

		#[unsafe( method( userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler: ) )]
		fn Tapped( &self, _center: &UNUserNotificationCenter, _response: &UNNotificationResponse, done: &DynBlock< dyn Fn() > ) {
			done.call( () );		// iOS has opened Laurel; nothing more to do
		}
	}
);

/*
==================
Ios_EdgeToEdge

UIKit insets a scroll view's content from the safe areas by itself, and
the page does it too (env( safe-area-inset-* ), ui.css): twice, the page
ended a band short of the screen's bottom
==================
*/
fn Ios_EdgeToEdge( page: &UIView ) {
	// SAFETY: a WKWebView answers scrollView with its UIScrollView
	let scroll: Retained< UIScrollView > = unsafe { objc2::msg_send![ page, scrollView ] };
	scroll.setContentInsetAdjustmentBehavior( UIScrollViewContentInsetAdjustmentBehavior::Never );
}

/*
==================
Ios_Watch

A blank cover over the page while Laurel isn't the active app (the app
switcher takes its picture then; Control Center, a call) and while the
screen is recorded or mirrored: iOS can't refuse a screenshot as Android
does (FLAG_SECURE), but none of these show a balance or a phrase. Gone to
the background, Ios_Background
==================
*/
fn Ios_Watch( app: tauri::AppHandle, page: Retained< UIView >, mtm: MainThreadMarker ) {
	let cover = UIView::new( mtm );
	cover.setBackgroundColor( Some( &UIColor::systemBackgroundColor() ) );
	cover.setAutoresizingMask( UIViewAutoresizing::FlexibleWidth | UIViewAutoresizing::FlexibleHeight );
	let away = Cell::new( false );
	// leaving: Some( true ); active again: Some( false ); the capture changed: None
	let changed = Rc::new( move |leaving: Option< bool >| {
		if let Some( leaving ) = leaving {
			away.set( leaving );
		}
		Ios_Cover( &page, &cover, away.get() );
	} );
	// SAFETY: UIKit's own names, there for the life of the process
	let ( leaving, active, captured, background ) = unsafe {
		( UIApplicationWillResignActiveNotification, UIApplicationDidBecomeActiveNotification, UIScreenCapturedDidChangeNotification, UIApplicationDidEnterBackgroundNotification )
	};
	let c = changed.clone();
	Ios_On( leaving, move || c( Some( true ) ) );
	let c = changed.clone();
	Ios_On( active, move || c( Some( false ) ) );
	Ios_On( captured, move || changed( None ) );
	Ios_On( background, move || Ios_Background( &app, mtm ) );
}

/*
==================
Ios_Cover

The one place that decides: covered while away or while the screen is
captured, uncovered otherwise
==================
*/
fn Ios_Cover( page: &UIView, cover: &UIView, away: bool ) {
	let Some( window ) = page.window() else {
		return;
	};
	// isCaptured: iOS 18 prefers the scene's capture state, which iOS 15 doesn't have
	#[allow( deprecated )]
	let captured = window.screen().isCaptured();
	if ( away || captured ) {
		cover.setFrame( window.bounds() );
		window.addSubview( cover );
	} else {
		cover.removeFromSuperview();
	}
}

// run on the main thread whenever UIKit posts name, for the life of the process
fn Ios_On( name: &NSNotificationName, run: impl Fn() + 'static ) {
	let block = RcBlock::new( move |_: NonNull< NSNotification >| run() );
	// SAFETY: delivered on the main queue, the thread whose objects the block holds
	let watching = unsafe {
		NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock( Some( name ), None, Some( &NSOperationQueue::mainQueue() ), &block )
	};
	std::mem::forget( watching );		// never removed
}

/*
==================
Ios_Background

iOS ends a hidden app without a word (Sys_Close never runs there) and
gives it seconds: every wallet is written now (W_SaveAll), in a
background task so the system waits for it, and the lock timer starts as
on Android (M_Hidden)
==================
*/
fn Ios_Background( app: &tauri::AppHandle, mtm: MainThreadMarker ) {
	let task = Arc::new( AtomicUsize::new( Ios_NoTask() ) );
	let expired = task.clone();
	let ending = RcBlock::new( move || Ios_EndTask( &expired, mtm ) );		// out of time: saved or not, the system's to end
	let id = UIApplication::sharedApplication( mtm ).beginBackgroundTaskWithName_expirationHandler( Some( &NSString::from_str( "Saving" ) ), Some( &ending ) );
	task.store( id, Ordering::SeqCst );

	crate::w_mobile::M_Hidden( app.clone() );
	let app = app.clone();
	tauri::async_runtime::spawn( async move {
		crate::w_persist::W_SaveAll().await;
		let _ = app.run_on_main_thread( move || {
			if let Some( mtm ) = MainThreadMarker::new() {
				Ios_EndTask( &task, mtm );
			}
		} );
	} );
}

fn Ios_NoTask() -> UIBackgroundTaskIdentifier {
	// SAFETY: UIKit's constant
	unsafe { UIBackgroundTaskInvalid }
}

// once, whichever comes first: the save done, or the time out
fn Ios_EndTask( task: &AtomicUsize, mtm: MainThreadMarker ) {
	let id = task.swap( Ios_NoTask(), Ordering::SeqCst );
	if ( id != Ios_NoTask() ) {
		UIApplication::sharedApplication( mtm ).endBackgroundTask( id );
	}
}
