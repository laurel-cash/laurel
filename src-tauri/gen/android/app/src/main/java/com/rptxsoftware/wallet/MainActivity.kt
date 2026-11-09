package com.rptxsoftware.wallet

import android.os.Bundle
import android.view.WindowManager
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.activity.OnBackPressedCallback
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  // Back is Laurel's to answer (window.__laurelBack, ui_chrome.tsx Com_Back): wry's own
  // went to the web view's history, which a single-page app doesn't keep
  override val handleBackNavigation: Boolean = false
  private var web: WebView? = null

  override fun onWebViewCreate(webView: WebView) {
    web = webView
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    // protect recovery phrases, balances and the task-switcher preview
    window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // drop touches while another app's window covers Laurel (tapjacking: a fake
    // screen over Send). Android 12+ blocks most such overlays itself; minSdk 28 doesn't
    window.decorView.filterTouchesWhenObscured = true
    // Back closes what's open, then goes up a level; only from Home does it leave, and
    // then into the background, so the vault can finish saving before any teardown.
    // It once left from anywhere, a sheet open or not (and leaving locks)
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val view = web
        if (view == null) {
          moveTaskToBack(true)
          return
        }
        view.evaluateJavascript("(window.__laurelBack ? window.__laurelBack() : false) === true") { handled ->
          if (handled != "true") {
            moveTaskToBack(true)
          }
        }
      }
    })
    val content = findViewById<android.view.View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val space = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
      )
      view.setPadding(space.left, space.top, space.right, space.bottom)
      WindowInsetsCompat.CONSUMED
    }
    ViewCompat.requestApplyInsets(content)
  }
}
